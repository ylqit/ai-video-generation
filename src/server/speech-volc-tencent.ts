import { HttpError } from './db.js';
import type { SpeechAdapter, VoiceResult } from './speech-transport.js';

function doubaoResult(data: any, id: string): VoiceResult {
  if (!data || !Number.isInteger(data.status)) throw new Error('豆包音色回执缺少状态');
  const ready = [2, 4].includes(data.status),
    demo = data.speaker_status?.find((v: any) => v.model_type === 5)?.demo_audio;
  return {
    state: ready ? 'ready' : [0, 3].includes(data.status) ? 'failed' : 'pending',
    voiceId: id,
    remoteId: id,
    providerStatus: String(data.status),
    expiresAt:
      data.status === 2 && !id.startsWith('S_')
        ? (data.create_time
            ? Number(data.create_time) * (Number(data.create_time) < 100000000000 ? 1000 : 1)
            : Date.now()) +
          7 * 86400000
        : null,
    ...(demo && ready ? { audio: { url: demo, ext: 'mp3' } } : {}),
  };
}
export const doubaoSpeech: SpeechAdapter = {
  async clone(c, i, sample) {
    const p = i.providerOptions;
    c.beforeSubmit();
    const { data } = await c.call('/api/v3/tts/voice_clone', {
      speaker_id: p.slotMode === 'postpaid' ? 'custom_speaker_id' : p.voiceId,
      ...(p.slotMode === 'postpaid' ? { custom_speaker_id: p.voiceId } : {}),
      audio: { data: sample.toString('base64'), format: 'wav' },
      text: i.sample.transcript || undefined,
      language: i.voice.data.language === 'en' ? 1 : i.voice.data.language === 'ja' ? 2 : 0,
    });
    return doubaoResult(data, p.voiceId);
  },
  async query(c, id, i) {
    const custom = i.providerOptions?.slotMode === 'postpaid' || !id.startsWith('S_');
    const { data } = await c.call('/api/v3/tts/get_voice', {
      speaker_id: custom ? 'custom_speaker_id' : id,
      ...(custom ? { custom_speaker_id: id } : {}),
    });
    return doubaoResult(data, id);
  },
  async synthesize(c, i) {
    c.beforeSubmit();
    const p = i.performance;
    const r = await c.call(
      '/api/v3/tts/unidirectional',
      {
        user: { uid: c.requestId },
        req_params: {
          text: i.text,
          model: c.modelId,
          speaker: i.voice.data.handle.voiceId,
          audio_params: {
            format: 'mp3',
            sample_rate: 24000,
            speech_rate: p.speed ?? 0,
            loudness_rate: p.volume ?? 0,
          },
          additions: JSON.stringify({ disable_markdown_filter: true }),
        },
      },
      { headers: { 'X-Control-Require-Usage-Tokens-Return': '*' } },
    );
    const events = r.bytes
      .toString('utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('event:'))
      .map((s) => JSON.parse(s.startsWith('data:') ? s.slice(5) : s));
    const chunks: Buffer[] = [];
    let finished = false,
      usage;
    for (const e of events) {
      if (e.code !== 0 && e.code !== 20000000)
        throw new HttpError(422, `豆包合成失败：${e.message || e.code}`);
      if (e.data) chunks.push(Buffer.from(e.data, 'base64'));
      if (e.code === 20000000) {
        finished = true;
        usage = e.usage;
      }
    }
    if (!finished || !chunks.length) throw new Error('豆包音频流未完整结束；不重新提交');
    return {
      state: 'ready',
      providerStatus: 'completed',
      audio: { bytes: Buffer.concat(chunks), ext: 'mp3' },
      usage,
    };
  },
};

export const tencentSpeech: SpeechAdapter = {
  async clone(c, i, sample) {
    let audioId = c.checkpoint.audioId;
    if (!audioId) {
      const { data } = await c.call(
        '/',
        {
          TextId: i.providerOptions.textId,
          AudioData: sample.toString('base64'),
          TypeId: 2,
          Codec: 'wav',
          SampleRate: 24000,
          TaskType: 5,
        },
        { action: 'DetectEnvAndSoundQuality' },
      );
      const result = data?.Response?.Data;
      if (result?.DetectionCode !== 0 || !result.AudioId)
        throw new HttpError(422, `腾讯样本检测未通过：${result?.DetectionMsg || '回执缺失'}`);
      audioId = result.AudioId;
      c.saveCheckpoint({ audioId, detection: result });
    }
    c.beforeSubmit();
    const { data } = await c.call(
      '/',
      {
        SessionId: c.requestId,
        VoiceName: i.voice.data.name,
        VoiceGender: i.providerOptions.gender,
        VoiceLanguage: 1,
        AudioIdList: [audioId],
        Codec: 'wav',
        SampleRate: 24000,
        ModelType: 1,
        TaskType: 5,
        EngineType: c.modelId,
      },
      { action: 'CreateVRSTask' },
    );
    const id = data?.Response?.Data?.TaskId;
    if (!id) throw new Error('腾讯复刻缺少 TaskId；需要核对原任务');
    return { state: 'pending', remoteId: id, providerStatus: 'processing' };
  },
  async query(c, id, i) {
    if (i.operation === 'voice_query') {
      const { data } = await c.call(
        '/',
        {
          VoiceType: /^\d+$/.test(id) ? Number(id) : 200000000,
          ...(!/^\d+$/.test(id) ? { TaskType: 5, FastVoiceType: id } : {}),
        },
        { action: 'GetVRSVoiceTypeInfo' },
      );
      const v = data?.Response?.Data;
      if (!v || String(v.FastVoiceType || v.VoiceType) !== id)
        throw new Error('腾讯查询缺少匹配音色信息');
      return {
        state: v.IsDeployed ? 'ready' : 'verification_required',
        voiceId: id,
        remoteId: id,
        providerStatus: v.IsDeployed ? 'available' : 'not_deployed',
        expiresAt: v.ExpireTime ? Date.parse(v.ExpireTime) : null,
      };
    }
    const { data } = await c.call('/', { TaskId: id }, { action: 'DescribeVRSTaskStatus' });
    const r = data?.Response?.Data;
    if (!r || r.TaskId !== id) throw new Error('腾讯返回了不同的任务身份');
    return {
      state: r.Status === 2 ? 'ready' : r.Status === 3 ? 'failed' : 'pending',
      remoteId: id,
      ...(r.FastVoiceType || r.VoiceType
        ? { voiceId: String(r.FastVoiceType || r.VoiceType) }
        : {}),
      expiresAt: r.ExpireTime ? Date.parse(r.ExpireTime) : null,
      providerStatus: `${r.Status}:${r.StatusStr || r.ErrorMsg || ''}`,
    };
  },
  async synthesize(c, i) {
    const id = i.voice.data.handle.voiceId,
      p = i.performance;
    c.beforeSubmit();
    const { data } = await c.call(
      '/',
      {
        Text: i.text,
        SessionId: c.requestId,
        VoiceType: /^\d+$/.test(id) ? Number(id) : 200000000,
        ...(!/^\d+$/.test(id) ? { FastVoiceType: id } : {}),
        Codec: 'wav',
        SampleRate: 24000,
        ModelType: 1,
        Speed: p.speed ?? 0,
        Volume: p.volume ?? 0,
      },
      { action: 'TextToVoice', service: 'tts' },
    );
    const r = data?.Response;
    if (!r?.Audio || r.SessionId !== c.requestId)
      throw new Error('腾讯音频回执或 SessionId 不匹配');
    return {
      state: 'ready',
      providerStatus: 'completed',
      audio: { bytes: Buffer.from(r.Audio, 'base64'), ext: 'wav' },
      usage: { requestId: r.RequestId },
    };
  },
};
