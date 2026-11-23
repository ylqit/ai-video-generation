import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { executionSelectionSchema } from '../shared/models.js';
import { voiceRefSchema } from '../shared/speech.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest } from './h3-guided.js';
import { productionHead } from './creation-heads.js';

export const lipsyncSchema = z
  .object({
    selection: executionSelectionSchema,
    video: voiceRefSchema,
    take: voiceRefSchema.optional(),
    audio: voiceRefSchema.optional(),
    audioRange: z.object({ in: z.number().nonnegative(), out: z.number().positive() }).optional(),
    range: z
      .object({ inFrame: z.number().int().nonnegative(), outFrame: z.number().int().positive() })
      .strict(),
    face: z
      .object({
        frame: z.number().int().nonnegative(),
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        instanceId: z.string().min(1),
        inspected: z.boolean().default(false),
      })
      .strict(),
    originalAudio: z.literal('replace'),
    singleSpeaker: z.literal(true),
  })
  .strict()
  .refine((v) => !!v.take !== !!v.audio, '请选择选用对白或直接音频中的一种');

export function prepareLipSync(store: Store, projectId: string, raw: unknown) {
  const d = lipsyncSchema.parse(raw),
    modelExecution = new ModelRegistry(store).resolveSelection(d.selection);
  if (modelExecution.protocol !== 'sync-lipsync') throw new HttpError(400, '需要 Sync 口型模型');
  if (d.audio) {
    const video = store.get(d.video.id, d.video.revision),
      audio = store.get(d.audio.id, d.audio.revision),
      frames = d.range.outFrame - d.range.inFrame;
    const audioRange = d.audioRange || { in: 0, out: audio.data.duration };
    if (
      video.projectId !== projectId ||
      audio.projectId !== projectId ||
      video.kind !== 'asset' ||
      audio.kind !== 'asset' ||
      video.data.mediaType !== 'video' ||
      audio.data.mediaType !== 'audio'
    )
      throw new HttpError(400, '需要本作品固定视频和音频');
    const fps = video.data.streams?.find((s: any) => s.type === 'video')?.frameRate;
    if (fps && !['24/1', '24', '24000/1000'].includes(fps))
      throw new HttpError(400, '请选择 24 fps 工作视频');
    if (
      frames <= 0 ||
      d.range.outFrame > (video.data.frameCount || Math.floor(video.data.duration * 24)) ||
      d.face.frame < d.range.inFrame ||
      d.face.frame >= d.range.outFrame ||
      d.face.x >= video.data.width ||
      d.face.y >= video.data.height
    )
      throw new HttpError(400, '视频区间或脸部位置无效');
    if (
      audioRange.out <= audioRange.in ||
      audioRange.out > audio.data.duration + 0.001 ||
      audioRange.out - audioRange.in > frames / 24 + 1e-6
    )
      throw new HttpError(400, '音频区间无效或长于处理画面');
    const input = {
      version: 2,
      operation: 'lipsync',
      name: `${video.data.name} · ${d.face.instanceId} 口型`,
      modelExecution,
      video,
      audio,
      audioRange,
      range: d.range,
      face: d.face,
      originalAudio: d.originalAudio,
      silencePaddingSeconds: frames / 24 - (audioRange.out - audioRange.in),
      requestOptions: {
        sync_mode: 'silence',
        active_speaker_detection: {
          auto_detect: false,
          frame_number: d.face.frame - d.range.inFrame,
          coordinates: [d.face.x, d.face.y],
        },
      },
      dependencies: [d.video, d.audio],
      episode: null,
    };
    return {
      input,
      digest: generationDigest(input),
      usage: { requests: 1, seconds: frames / 24, estimatedCost: null },
      warnings: ['独立试作保留原片；口型和身份效果尚未检查'],
      validation: { uploaded: false, submitted: false },
    };
  }
  const video = store.get(d.video.id, d.video.revision),
    take = store.get(d.take!.id, d.take!.revision);
  if (
    video.kind !== 'asset' ||
    video.projectId !== projectId ||
    video.data.mediaType !== 'video' ||
    take.kind !== 'dialogue_take' ||
    take.projectId !== projectId
  )
    throw new HttpError(400, '需要本作品固定视频及选用对白');
  const audio = store.get(take.data.asset.id, take.data.asset.revision),
    frames = d.range.outFrame - d.range.inFrame;
  if (audio.kind !== 'asset' || audio.projectId !== projectId || audio.data.mediaType !== 'audio')
    throw new HttpError(400, '采用声音不可用');
  const sourceFps = video.data.streams?.find((s: any) => s.type === 'video')?.frameRate;
  if (sourceFps && !['24/1', '24', '24000/1000'].includes(sourceFps))
    throw new HttpError(400, '先选择 24 fps 工作媒体，保留原始视频');
  if (
    frames <= 0 ||
    d.range.outFrame > (video.data.frameCount || Math.floor(video.data.duration * 24)) ||
    d.face.frame < d.range.inFrame ||
    d.face.frame >= d.range.outFrame ||
    d.face.x >= video.data.width ||
    d.face.y >= video.data.height ||
    d.face.instanceId !== take.data.instanceId
  )
    throw new HttpError(400, '处理区间、脸部位置或说话者不匹配');
  if (take.data.out - take.data.in > frames / 24 + 1e-6)
    throw new HttpError(409, '对白超出画面范围；请修改台词、合成或剪辑，不自动变速截断');
  const ep = store.get(take.parentId!);
  const segment = ep.data.segments?.find((s: any) => s.shotIds.includes(take.data.shotId));
  if (!segment) throw new HttpError(409, '请先把本句镜头安排到明确生成组；口型候选沿用此制作归属');
  const line = ep.data.shots
    ?.find((s: any) => s.id === take.data.shotId)
    ?.directing?.sound?.dialogue?.find((l: any) => l.id === take.data.lineId);
  if (
    !line ||
    line.text !== take.data.actualText ||
    generationDigest(line.voiceProfile) !== generationDigest(take.data.voice)
  )
    throw new HttpError(409, '对白采用依据已变化');
  const input = {
    version: 1,
    operation: 'lipsync',
    name: `${take.data.shotId}／${take.data.lineId} 口型`,
    modelExecution,
    video,
    audio,
    take,
    range: d.range,
    face: d.face,
    originalAudio: d.originalAudio,
    silencePaddingSeconds: frames / 24 - (take.data.out - take.data.in),
    requestOptions: {
      sync_mode: 'silence',
      active_speaker_detection: {
        auto_detect: false,
        frame_number: d.face.frame - d.range.inFrame,
        coordinates: [d.face.x, d.face.y],
      },
    },
    segment,
    creationRunId: productionHead(store, ep.id).runId,
    dependencies: [d.video, d.take, take.data.asset, take.data.voice],
    episode: { id: ep.id, revision: ep.revision },
  };
  return {
    input,
    digest: generationDigest(input),
    usage: { requests: 1, seconds: frames / 24, estimatedCost: null },
    warnings: ['可检查口型、身份、动作、声音及两侧接点；尚无真实质量验证'],
    validation: { uploaded: false, submitted: false },
  };
}
export function submitLipSync(
  store: Store,
  projectId: string,
  raw: any,
  assistant?: { runId?: string; canvas: { id: string; revision: number }; nodeId: string },
) {
  const body = z
    .object({
      request: lipsyncSchema,
      digest: z.string(),
      idempotencyKey: z.string().min(8),
      approved: z.literal(true),
    })
    .strict()
    .parse(raw);
  return store.transaction(() => {
    const old = store.db
      .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
      .get(body.idempotencyKey);
    if (old) {
      const job = store.job(String(old.id));
      if (
        job.projectId !== projectId ||
        job.kind !== 'lipsync' ||
        job.input.preparationDigest !== body.digest ||
        job.input.requestDigest !== generationDigest(body.request)
      )
        throw new HttpError(409, '幂等输入不符');
      return job;
    }
    const p = prepareLipSync(store, projectId, body.request);
    if (p.digest !== body.digest) throw new HttpError(409, '口型准备依据已变化');
    return store.createJob(
      'lipsync',
      projectId,
      p.input.episode?.id || null,
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
