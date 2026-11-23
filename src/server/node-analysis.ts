import { z } from 'zod';
import { versionRef } from '../shared/domain.js';
import { executionSelectionSchema } from '../shared/models.js';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest } from './h3-guided.js';
import { projectNodeInputs } from './node-context.js';

export const analysisRequest = z
  .object({
    action: z.enum(['text_generate', 'rewrite', 'discuss', 'vision', 'transcribe']),
    model: executionSelectionSchema,
    instruction: z.string().trim().max(30000).default(''),
    images: z.array(versionRef).max(24).default([]),
    source: versionRef.optional(),
    start: z.number().nonnegative().default(0),
    end: z.number().positive().optional(),
    diarization: z.boolean().default(false),
    textRange: z
      .object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        expected: z.string(),
      })
      .optional(),
  })
  .strict();
export function prepareNodeAnalysis(store: Store, canvasId: string, nodeId: string, raw: unknown) {
  const r = analysisRequest.parse(raw),
    canvas = new CanvasService(store).get(canvasId),
    node = canvas.data.nodes.find((n: any) => n.id === nodeId);
  if (!node) throw new HttpError(404, '节点不存在');
  const execution = new ModelRegistry(store).resolveSelection(r.model),
    assets: any[] = [];
  const projected = projectNodeInputs(store, canvas.projectId, canvas.data, node);
  if (
    r.textRange &&
    (r.action !== 'rewrite' ||
      r.textRange.end <= r.textRange.start ||
      node.text.slice(r.textRange.start, r.textRange.end) !== r.textRange.expected)
  )
    throw new HttpError(409, '选区正文变化，请重新选择');
  if (r.action === 'transcribe') {
    if (execution.protocol !== 'tencent-asr')
      throw new HttpError(400, '请选择腾讯录音识别极速版连接');
    const edges = canvas.data.edges.filter(
      (e: any) => e.target === nodeId && e.relation === 'input',
    );
    const ref =
      r.source ||
      node.asset ||
      (edges.length === 1
        ? edges[0].asset || canvas.data.nodes.find((n: any) => n.id === edges[0].source)?.asset
        : null);
    if (!ref) throw new HttpError(400, '请选择音频或包含音轨的视频');
    const a = store.get(ref.id, ref.revision);
    if (
      a.projectId !== canvas.projectId ||
      a.kind !== 'asset' ||
      !['audio', 'video'].includes(a.data.mediaType) ||
      !a.data.hasAudio
    )
      throw new HttpError(400, '源媒体没有可用音频');
    r.end ??= a.data.duration;
    if (r.end! <= r.start || r.end! > a.data.duration + 0.001 || r.end! - r.start > 7200)
      throw new HttpError(400, '转写区间无效或超过 2 小时');
    assets.push({ id: a.id, revision: a.revision, data: a.data });
  } else {
    if (execution.capabilities.kind !== 'text') throw new HttpError(400, '请选择文字模型');
    if (
      r.action === 'vision' &&
      (execution.protocol !== 'chat-completions' || !execution.capabilities.imageInput)
    )
      throw new HttpError(400, '此连接没有明确启用图像输入能力');
    if (r.action !== 'vision' && r.images.length)
      throw new HttpError(400, '文字操作不能隐式附带图像');
    for (const ref of r.images) {
      const a = store.get(ref.id, ref.revision);
      if (
        a.projectId !== canvas.projectId ||
        a.kind !== 'asset' ||
        a.data.mediaType !== 'image' ||
        a.data.bytes > 20 * 1024 * 1024
      )
        throw new HttpError(400, '采样图片归属、类型或大小不适用');
      assets.push({ id: a.id, revision: a.revision, data: a.data });
    }
    if (r.action === 'vision' && !assets.length)
      throw new HttpError(400, '视觉分析需要明确选定采样图片');
    if (!r.instruction && !projected.text) throw new HttpError(400, '请输入写作或分析目标');
  }
  const input = {
    canvas: { id: canvas.id, revision: canvas.revision },
    canvasNodeId: nodeId,
    nodeOperation: r,
    modelExecution: execution,
    assets,
    dependencies: [
      ...projected.dependencies,
      ...assets.map((a) => ({ id: a.id, revision: a.revision })),
    ],
    text: projected.text,
    originalNodeText: node.text,
    name: `${node.title} · ${r.action}`,
  };
  const { canvas: ignored, ...semantic } = input;
  return {
    input,
    digest: generationDigest(semantic),
    usage:
      r.action === 'transcribe'
        ? { transcriptionRequests: 1, seconds: r.end! - r.start, estimatedCost: null }
        : { textRequests: 1, sampledImages: assets.length, estimatedCost: null },
    warnings:
      r.action === 'vision' ? ['只分析选定静态采样帧；不能代替完整观看、动作时序或听审'] : [],
    validation: { uploaded: false, submitted: false },
  };
}
export function submitNodeAnalysis(
  store: Store,
  canvasId: string,
  nodeId: string,
  raw: any,
  assistantRunId?: string,
) {
  const body = z
    .object({
      request: analysisRequest,
      digest: z.string().length(64),
      idempotencyKey: z.string().min(8),
    })
    .parse(raw);
  return store.transaction(() => {
    const prior = store.db
      .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
      .get(body.idempotencyKey);
    if (prior) {
      const job = store.job(String(prior.id));
      if (
        job.input.canvas?.id !== canvasId ||
        job.input.canvasNodeId !== nodeId ||
        job.input.previewDigest !== body.digest ||
        job.input.requestDigest !== generationDigest(body.request) ||
        job.input.assistantRunId !== assistantRunId
      )
        throw new HttpError(409, '已有回执与当前请求不同');
      return job;
    }
    const p = prepareNodeAnalysis(store, canvasId, nodeId, body.request);
    if (p.digest !== body.digest) throw new HttpError(409, '分析依据已变化，请重新准备');
    const canvas = store.get(canvasId);
    return store.createJob(
      body.request.action === 'transcribe' ? 'transcription' : 'media_analysis',
      canvas.projectId,
      canvas.data.episodeId || null,
      {
        ...p.input,
        previewDigest: p.digest,
        requestDigest: generationDigest(body.request),
        ...(assistantRunId ? { assistantRunId } : {}),
      },
      body.idempotencyKey,
    );
  });
}
