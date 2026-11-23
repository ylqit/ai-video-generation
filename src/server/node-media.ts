import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { generationDigest } from './h3-guided.js';
import { mediaOperationSchema } from '../shared/node-operations.js';
import { nodeDefinitions } from '../shared/node-catalog.js';

export function prepareMediaOperation(
  store: Store,
  canvasId: string,
  nodeId: string,
  raw: unknown,
) {
  const op = mediaOperationSchema.parse(raw),
    canvas = new CanvasService(store).get(canvasId),
    node = canvas.data.nodes.find((n: any) => n.id === nodeId);
  if (!node) throw new HttpError(404, '节点不存在');
  const def = nodeDefinitions.find((d) => d.type === node.type);
  if (!def?.actions.includes(op.action)) throw new HttpError(400, '节点不支持此操作');
  const edges = canvas.data.edges.filter((e: any) => e.target === nodeId && e.relation === 'input');
  const sourceRef =
    op.source ||
    node.asset ||
    (edges.length === 1
      ? edges[0].asset || canvas.data.nodes.find((n: any) => n.id === edges[0].source)?.asset
      : null);
  if (!sourceRef) throw new HttpError(400, '请在节点选择固定素材或连接一个素材输入');
  const source = store.get(sourceRef.id, sourceRef.revision);
  if (source.projectId !== canvas.projectId || source.kind !== 'asset' || source.data.fileCleared)
    throw new HttpError(400, '素材不属于当前作品或文件已清理');
  const type = source.data.mediaType;
  const allowed: Record<string, string[]> = {
    image: ['crop', 'mark', 'grid'],
    video: ['frame', 'trim', 'extract_audio', 'separate', 'analyze'],
    audio: ['trim', 'speed'],
  };
  if (!allowed[type]?.includes(op.action)) throw new HttpError(400, '实际媒体不支持此操作');
  if (['crop', 'mark'].includes(op.action) && !op.box)
    throw new HttpError(400, '请框选有效图片区域');
  if (
    op.box &&
    (op.box.x + op.box.width > source.data.width || op.box.y + op.box.height > source.data.height)
  )
    throw new HttpError(400, '处理区域超出图片');
  if (
    op.action === 'grid' &&
    (op.rows * op.columns > 64 || op.rows > source.data.height || op.columns > source.data.width)
  )
    throw new HttpError(400, '拆图数量或尺寸无效（最多 64 张）');
  if (type !== 'image') {
    op.end ??= source.data.duration;
    if (op.start >= op.end! || op.end! > source.data.duration + 0.001)
      throw new HttpError(400, '媒体区间超出源文件');
    if (typeof op.frame === 'number' && op.frame >= source.data.frameCount)
      throw new HttpError(400, '帧号超出源视频');
    if (['extract_audio', 'separate'].includes(op.action) && !source.data.hasAudio)
      throw new HttpError(400, '源视频没有音轨');
  }
  const input = {
    canvas: { id: canvas.id, revision: canvas.revision },
    canvasNodeId: nodeId,
    nodeOperation: op,
    assets: [{ id: source.id, revision: source.revision, data: source.data }],
    dependencies: [{ id: source.id, revision: source.revision }],
    name: `${node.title} · ${op.action}`,
  };
  const { canvas: ignored, ...semantic } = input;
  return {
    input,
    digest: generationDigest(semantic),
    usage: { local: true, paidRequests: 0 },
    warnings: op.action === 'analyze' ? ['切镜检测依据画面变化，不代表已理解剧情或听审'] : [],
    validation: { uploaded: false, submitted: false },
  };
}

export function submitMediaOperation(
  store: Store,
  canvasId: string,
  nodeId: string,
  raw: any,
  assistantRunId?: string,
) {
  const body = z
    .object({
      request: z.unknown(),
      digest: z.string().length(64),
      idempotencyKey: z.string().min(8),
    })
    .parse(raw);
  return store.transaction(() => {
    const row = store.db
      .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
      .get(body.idempotencyKey);
    if (row) {
      const job = store.job(String(row.id));
      if (
        job.input.canvas?.id !== canvasId ||
        job.input.canvasNodeId !== nodeId ||
        job.input.previewDigest !== body.digest ||
        job.input.requestDigest !== generationDigest(body.request) ||
        job.input.assistantRunId !== assistantRunId
      )
        throw new HttpError(409, '幂等键已用于不同操作');
      return job;
    }
    const p = prepareMediaOperation(store, canvasId, nodeId, body.request);
    if (p.digest !== body.digest) throw new HttpError(409, '输入已变化，请重新准备');
    const canvas = store.get(canvasId);
    return store.createJob(
      'media_process',
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
