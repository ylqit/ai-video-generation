import { HttpError } from './db.js';
import type { SpeechAdapter, SpeechContext, VoiceResult } from './speech-transport.js';
import { doubaoSpeech, tencentSpeech } from './speech-volc-tencent.js';
import type { SpeechProtocol } from '../shared/speech.js';

function minimaxResponse(data: any) {
  if (!data || data.base_resp?.status_code !== 0)
    throw new HttpError(422, `MiniMax 拒绝：${data?.base_resp?.status_msg || '响应缺少成功回执'}`);
  return data;
}
const minimaxSpeech: SpeechAdapter = {
  async clone(c, i, bytes) {
    let fileId = c.checkpoint.fileId;
    if (!fileId) {
      const form = new FormData();
      form.set('purpose', 'voice_clone');
      form.set('file', new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }), 'sample.wav');
      const r = minimaxResponse((await c.call('/v1/files/upload', undefined, { form })).data);
      fileId = r.file?.file_id;
      if (!fileId) throw new Error('MiniMax 上传回执缺少 file_id');
      c.saveCheckpoint({ fileId });
    }
    c.beforeSubmit();
    minimaxResponse(
      (await c.call('/v1/voice_clone', { file_id: fileId, voice_id: i.providerOptions.voiceId }))
        .data,
    );
    return {
      state: 'ready',
      remoteId: i.providerOptions.voiceId,
      voiceId: i.providerOptions.voiceId,
      providerStatus: 'cloned_unused',
      expiresAt: Date.now() + 7 * 86400000,
    };
  },
  async query(c, id) {
    const r = minimaxResponse((await c.call('/v1/get_voice', { voice_type: 'all' })).data);
    const voice = [
      ...(r.system_voice || []),
      ...(r.voice_cloning || []),
      ...(r.voice_generation || []),
    ].find((v: any) => v.voice_id === id);
    return {
      state: voice ? 'ready' : 'failed',
      voiceId: id,
      remoteId: id,
      providerStatus: voice ? 'available' : 'not_found',
    };
  },
  async synthesize(c, i) {
    c.beforeSubmit();
    const p = i.performance;
    const r = minimaxResponse(
      (
        await c.call('/v1/t2a_v2', {
          model: c.modelId,
          text: i.text,
          stream: false,
          output_format: 'hex',
          voice_setting: {
            voice_id: i.voice.data.handle.voiceId,
            speed: p.speed ?? 1,
            vol: p.volume ?? 1,
            pitch: p.pitch ?? 0,
            ...(p.emotion ? { emotion: p.emotion } : {}),
          },
          audio_setting: { sample_rate: 24000, format: 'wav', channel: 1 },
        })
      ).data,
    );
    if (!r.data?.audio || !/^(?:[0-9a-f]{2})+$/i.test(r.data.audio))
      throw new Error('MiniMax 未返回有效音频');
    return {
      state: 'ready',
      providerStatus: 'completed',
      audio: { bytes: Buffer.from(r.data.audio, 'hex'), ext: 'wav' },
      usage: r.extra_info,
    };
  },
};
const cosyvoice: SpeechAdapter = {
  async clone(c, i, bytes) {
    c.beforeSubmit();
    const { data } = await c.call('/api/v1/services/audio/tts/customization', {
      model: 'voice-enrollment',
      input: {
        action: 'create_voice',
        target_model: c.modelId,
        prefix: i.providerOptions.prefix,
        audio: `data:audio/wav;base64,${bytes.toString('base64')}`,
      },
    });
    if (!data?.output?.voice_id) throw new Error('CosyVoice 缺少创建身份；请核对原请求');
    return {
      state: 'pending',
      remoteId: data.output.voice_id,
      voiceId: data.output.voice_id,
      providerStatus: 'DEPLOYING',
    };
  },
  async query(c, id) {
    const { data } = await c.call('/api/v1/services/audio/tts/customization', {
      model: 'voice-enrollment',
      input: { action: 'query_voice', voice_id: id },
    });
    const v = data?.output;
    if (!v || (v.target_model && v.target_model !== c.modelId))
      throw new Error('CosyVoice 查询目标模型不符');
    return {
      remoteId: id,
      voiceId: id,
      state: v.status === 'OK' ? 'ready' : v.status === 'UNDEPLOYED' ? 'failed' : 'pending',
      providerStatus: v.status,
    };
  },
  async synthesize(c, i) {
    c.beforeSubmit();
    const p = i.performance;
    const { data } = await c.call('/api/v1/services/audio/tts/SpeechSynthesizer', {
      model: c.modelId,
      input: {
        text: i.text,
        voice: i.voice.data.handle.voiceId,
        format: 'wav',
        sample_rate: 24000,
        rate: p.speed ?? 1,
        volume: p.volume ?? 50,
        pitch: p.pitch ?? 1,
      },
    });
    if (data?.output?.finish_reason !== 'stop' || !data.output.audio?.url)
      throw new Error('CosyVoice 没有完整音频回执');
    return {
      state: 'ready',
      providerStatus: 'completed',
      audio: { url: data.output.audio.url, ext: 'wav' },
      usage: data.usage,
    };
  },
};
const baiduSpeech: SpeechAdapter = {
  async clone(c, i, bytes) {
    c.beforeSubmit();
    const { data } = await c.call('/rest/2.0/speech/publiccloudspeech/v1/voice/clone/create', {
      voice_name: i.providerOptions.voiceName,
      voice_desc: i.voice.data.description,
      lang: i.voice.data.language,
      audio_file: bytes.toString('base64'),
      ...(i.providerOptions.textId ? { text_id: i.providerOptions.textId } : {}),
    });
    if (data?.status !== 0)
      throw new HttpError(422, `百度复刻失败：${data?.message || '缺少成功回执'}`);
    if (!data.data?.voice_id) throw new Error('百度复刻成功但缺少音色 ID');
    return {
      state: 'ready',
      remoteId: String(data.data.voice_id),
      voiceId: String(data.data.voice_id),
      providerStatus: 'available',
    };
  },
  async query(c, id) {
    const { data } = await c.call('/rest/2.0/speech/publiccloudspeech/v1/voice/clone/detail', {
      voice_id: Number(id),
    });
    return {
      state: data?.status === 0 && String(data.data?.voice_id) === id ? 'ready' : 'failed',
      remoteId: id,
      voiceId: id,
      providerStatus: String(data?.status ?? 'invalid_response'),
    };
  },
  async synthesize(c, i) {
    c.beforeSubmit();
    const p = i.performance;
    const r = await c.call('/rest/2.0/speech/publiccloudspeech/v1/voice/clone/tts', {
      voice_id: Number(i.voice.data.handle.voiceId),
      text: i.text,
      lang: i.voice.data.language,
      media_type: 'wav',
      sample_rate: 24000,
      pitch: p.pitch ?? 5,
      volume: p.volume ?? 5,
      speed: p.speed ?? 5,
      ...(p.emotion ? { emotion: p.emotion } : {}),
    });
    if (!r.contentType.startsWith('audio/') || !r.bytes.length) {
      if (typeof r.data?.status === 'number' && r.data.status !== 0)
        throw new HttpError(422, `百度合成失败：${r.data?.message || r.data.status}`);
      throw new Error('百度未返回音频或明确拒绝；受理情况需要核对');
    }
    return { state: 'ready', providerStatus: 'completed', audio: { bytes: r.bytes, ext: 'wav' } };
  },
};

// Registry owns protocol choice. No name guessing, scripts or provider fallback.
export const speechAdapters: Record<SpeechProtocol, SpeechAdapter> = {
  'minimax-speech': minimaxSpeech,
  cosyvoice,
  'doubao-speech': doubaoSpeech,
  'baidu-speech': baiduSpeech,
  'tencent-speech': tencentSpeech,
};
