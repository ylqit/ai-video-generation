import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { VoiceLibrary } from './voice-library.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest } from './h3-guided.js';
import { executionSelectionSchema } from '../shared/models.js';
import {
  voiceRefSchema,
  performanceSchema,
  isSpeechProtocol,
  speechCapabilities,
  type SpeechProtocol,
  voiceHandleIdentity,
} from '../shared/speech.js';

const cloneSchema = z
  .object({
    voice: voiceRefSchema,
    selection: executionSelectionSchema,
    sampleIndex: z.number().int().nonnegative(),
    authorized: z.literal(true),
    providerOptions: z
      .object({
        voiceId: z.string().optional(),
        prefix: z.string().optional(),
        voiceName: z.string().optional(),
        slotMode: z.enum(['prepaid', 'postpaid']).optional(),
        textId: z.string().optional(),
        gender: z.number().int().min(1).max(2).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export const synthesizeSchema = z
  .object({
    voice: voiceRefSchema,
    selection: executionSelectionSchema,
    text: z.string().min(1).max(10000),
    speaker: z.string().trim().min(1).max(160).optional(),
    performance: performanceSchema.default({ instructions: '' }),
    line: z
      .object({
        episode: voiceRefSchema,
        shotId: z.string(),
        lineId: z.string(),
        instanceId: z.string(),
        voiceProfile: voiceRefSchema,
      })
      .strict()
      .optional(),
    activateTemporaryVoice: z.boolean().default(false),
  })
  .strict();

export function prepareSpeech(
  store: Store,
  projectId: string | null,
  operation: 'voice_clone' | 'speech',
  raw: unknown,
) {
  const data = operation === 'voice_clone' ? cloneSchema.parse(raw) : synthesizeSchema.parse(raw);
  if (operation === 'voice_clone' && projectId)
    throw new HttpError(400, '克隆身份归全局库；作品固定选用其版本');
  const library = new VoiceLibrary(store),
    original = library.voice(data.voice.id, data.voice.revision);
  if (!original.enabled) throw new HttpError(409, '音色已停用');
  const voice = { id: original.id, revision: original.revision, data: original.data };
  const availability = voice.data.handle
    ? store.setting<any>(
        `voice_probe:${generationDigest(voiceHandleIdentity(voice.data.handle))}`,
        null,
      )
    : null;
  const modelExecution = new ModelRegistry(store).resolveSelection(data.selection);
  if (!isSpeechProtocol(modelExecution.protocol)) throw new HttpError(400, '需要已实现的语音协议');
  const protocol = modelExecution.protocol,
    limits = speechCapabilities[protocol];
  const dependencies: any[] = [],
    warnings: string[] = [];
  let input: any = {
    version: 1,
    operation,
    voice,
    modelExecution,
    dependencies,
    name: voice.data.name,
  };
  if (operation === 'voice_clone') {
    const d = data as z.infer<typeof cloneSchema>,
      p = d.providerOptions;
    if (original.headRevision !== original.revision)
      throw new HttpError(409, '请使用最新草稿准备新的克隆');
    const sample = voice.data.samples[d.sampleIndex];
    if (!sample || sample.purpose !== 'clone')
      throw new HttpError(400, '需要明确为克隆用途的样本区间');
    const media = library.get(sample.media.id, sample.media.revision),
      seconds = sample.out - sample.in;
    if (media.kind !== 'voice_media' || sample.out > media.data.duration)
      throw new HttpError(400, '样本超出实际媒体');
    if (
      seconds < limits.minSampleSeconds ||
      seconds > limits.maxSampleSeconds ||
      seconds * 24000 * 2 + 44 > limits.maxSampleBytes
    )
      throw new HttpError(
        400,
        `所选样本不满足当前适配范围：${limits.minSampleSeconds}–${limits.maxSampleSeconds} 秒及字节限制`,
      );
    if (protocol === 'minimax-speech' && !/^[A-Za-z][\w-]{6,254}[A-Za-z0-9]$/.test(p.voiceId || ''))
      throw new HttpError(400, 'MiniMax 需要 8–256 位且首尾合法的唯一音色 ID');
    if (protocol === 'cosyvoice' && !/^[A-Za-z0-9]{1,10}$/.test(p.prefix || ''))
      throw new HttpError(400, 'CosyVoice 需要 1–10 位英数字前缀');
    if (
      protocol === 'doubao-speech' &&
      (!p.slotMode ||
        !p.voiceId ||
        (p.slotMode === 'prepaid'
          ? !p.voiceId.startsWith('S_')
          : !/^[A-Za-z][\w-]{6,254}[A-Za-z0-9]$/.test(p.voiceId)))
    )
      throw new HttpError(400, '豆包需要明确槽位方式及有效音色 ID');
    if (protocol === 'baidu-speech' && !p.voiceName?.trim())
      throw new HttpError(400, '百度需要账户内唯一音色名称');
    if (
      protocol === 'tencent-speech' &&
      (!p.textId || !p.gender || seconds <= 5 || seconds >= 15 || voice.data.language !== 'zh')
    )
      throw new HttpError(400, '腾讯一句话复刻需要训练文本 ID、性别、中文及 5–15 秒内样本');
    input = {
      ...input,
      sample,
      sampleMedia: { id: media.id, revision: media.revision, data: media.data },
      providerOptions: p,
      authorized: true,
      sampleConversion: {
        container: 'wav',
        sampleRate: 24000,
        channels: 1,
        sampleFormat: 's16',
        sourceInterval: [sample.in, sample.out],
      },
    };
  } else {
    const d = data as z.infer<typeof synthesizeSchema>,
      handle = voice.data.handle;
    if (!handle || !['auditionable', 'confirmed'].includes(voice.data.state))
      throw new HttpError(409, '声音身份尚不可合成');
    if (availability && availability.state !== 'ready')
      throw new HttpError(409, '最近查询音色未就绪或已失效，请核对远端状态');
    const expiresAt = availability ? availability.expiresAt : handle.expiresAt;
    if (expiresAt && expiresAt <= Date.now())
      throw new HttpError(409, '音色有效期已到；先查询远端状态');
    if (
      handle.connection.id !== modelExecution.connection.id ||
      handle.connection.revision !== modelExecution.connection.revision ||
      handle.modelId !== modelExecution.modelId ||
      handle.region !== (modelExecution.connection.data.region || '')
    )
      throw new HttpError(409, '声音句柄与连接、账户地域或目标模型不匹配');
    const maxCharacters =
      protocol === 'tencent-speech' && /^[\x00-\x7F]*$/.test(d.text) ? 500 : limits.maxCharacters;
    if (Array.from(d.text).length > maxCharacters)
      throw new HttpError(400, `台词超过当前协议 ${maxCharacters} 字符，请先明确拆分或修订`);
    if (protocol === 'doubao-speech' && handle.providerStatus === '2' && !d.activateTemporaryVoice)
      throw new HttpError(409, '首次合成可能激活后付费音色槽位；请明确确认此项用量');
    if (protocol === 'doubao-speech' && !modelExecution.connection.data.speechResourceId)
      throw new HttpError(400, '豆包需要明确计费产品 Resource ID');
    for (const [key, value] of Object.entries(d.performance))
      if (
        value !== undefined &&
        value !== '' &&
        !(limits.controls as readonly string[]).includes(key)
      )
        warnings.push(`${key} 仅作制作说明，当前协议未接入此控制`);
    validatePerformance(protocol, d.performance);
    if (projectId && d.line) {
      const ep = store.get(d.line.episode.id, d.line.episode.revision),
        profile = store.get(d.line.voiceProfile.id, d.line.voiceProfile.revision);
      const shot = ep.data.shots?.find((s: any) => s.id === d.line!.shotId),
        line = shot?.directing?.sound?.dialogue?.find((l: any) => l.id === d.line!.lineId);
      if (
        ep.projectId !== projectId ||
        ep.kind !== 'episode' ||
        store.get(ep.id).revision !== ep.revision ||
        !line ||
        line.text !== d.text ||
        line.instanceId !== d.line.instanceId ||
        profile.projectId !== projectId ||
        profile.kind !== 'voice_profile' ||
        profile.data.version !== 2 ||
        generationDigest(profile.data.globalVoice) !== generationDigest(d.voice) ||
        generationDigest(line.voiceProfile) !== generationDigest(d.line.voiceProfile) ||
        profile.data.route !== 'tts'
      )
        throw new HttpError(409, '采用台词、说话者或作品声音应用版本不匹配');
      dependencies.push(d.line.episode, d.line.voiceProfile);
      for (const [key, label] of [
        ['pronunciation', '发音规范'],
        ['performance', '默认表演'],
      ] as const)
        if (profile.data[key])
          warnings.push(
            `${label}作为制作／听审依据：${profile.data[key]}。未擅自改写台词或转换供应商参数。`,
          );
      input.voiceApplication = { id: profile.id, revision: profile.revision, data: profile.data };
    } else if (!projectId && d.line) throw new HttpError(400, '全局试听不能携带作品台词');
    input = {
      ...input,
      text: d.text,
      speaker: d.speaker || d.line?.instanceId || '旁白',
      performance: d.performance,
      line: d.line || null,
      activateTemporaryVoice: d.activateTemporaryVoice,
      name: d.line ? `${d.line.shotId}／${d.line.lineId} 配音` : `${voice.data.name} 试听`,
    };
  }
  const digest = generationDigest(input);
  return {
    operation,
    projectId,
    input,
    digest,
    warnings,
    usage: {
      voiceCreations: operation === 'voice_clone' ? 1 : 0,
      speechRequests: operation === 'speech' ? 1 : 0,
      characters: input.text ? Array.from(input.text).length : 0,
      estimatedCost: null,
    },
    validation: { uploaded: false, submitted: false },
  };
}

export function submitSpeech(
  store: Store,
  projectId: string | null,
  operation: 'voice_clone' | 'speech',
  raw: any,
  assistant?: { runId?: string; canvas: { id: string; revision: number }; nodeId: string },
) {
  const body = z
    .object({
      request: z.unknown(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey: z.string().min(8),
      approved: z.literal(true),
    })
    .strict()
    .parse(raw);
  return store.transaction(() => {
    const existing = store.db
      .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
      .get(body.idempotencyKey);
    if (existing) {
      const job = store.job(String(existing.id));
      if (
        job.projectId !== projectId ||
        job.kind !== operation ||
        job.input.preparationDigest !== body.digest ||
        job.input.requestDigest !== generationDigest(body.request)
      )
        throw new HttpError(409, '幂等回执与请求不符');
      return job;
    }
    const p = prepareSpeech(store, projectId, operation, body.request);
    if (p.digest !== body.digest) throw new HttpError(409, '准备结果变化，请重新预览');
    return store.createJob(
      operation,
      projectId,
      p.input.line?.episode.id || null,
      {
        ...p.input,
        preparationDigest: p.digest,
        requestDigest: generationDigest(body.request),
        ...(assistant
          ? {
              assistantRunId: assistant.runId,
              canvas: assistant.canvas,
              canvasNodeId: assistant.nodeId,
            }
          : {}),
      },
      body.idempotencyKey,
    );
  });
}

function validatePerformance(protocol: SpeechProtocol, p: z.infer<typeof performanceSchema>) {
  for (const [key, [min, max]] of Object.entries(speechCapabilities[protocol].ranges)) {
    const value = p[key as 'speed' | 'pitch' | 'volume'];
    if (value !== undefined && (value < min || value > max))
      throw new HttpError(400, `${key} 使用此供应商原生参数范围 ${min}–${max}`);
  }
}
