import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { directorSceneSchema } from '../shared/director-scene.js';
import { projectNodeInputs } from './node-context.js';

export function directorDraft(store: Store, canvasId: string, nodeId: string) {
  const canvas = new CanvasService(store).get(canvasId),
    node = canvas.data.nodes.find((n: any) => n.id === nodeId);
  if (!node || node.type !== 'director') throw new HttpError(400, '需要导演节点');
  const projected = projectNodeInputs(store, canvas.projectId, canvas.data, node),
    spec = projected.shot,
    scene = directorSceneSchema.parse({});
  if (!spec?.directing) return { scene, sources: [], note: '独立预演，可添加场景和人物代理' };
  const d = spec.directing;
  scene.frames = Math.max(1, Math.min(7200, spec.frames));
  const transform = (k: any) => ({
    frame: Math.min(scene.frames - 1, k.frame),
    position: { x: (k.position.x - 0.5) * 10, y: 0, z: (k.position.y - 0.5) * 10 },
    rotation: { x: 0, y: k.heading || 0, z: 0 },
  });
  scene.objects = d.proxies.map((p) => {
    const path = d.paths.find((v) => v.instanceId === p.instanceId),
      start = spec.state?.start?.find((v: any) => v.instanceId === p.instanceId);
    return {
      id: p.instanceId,
      name: p.instanceId,
      shape: p.shape === 'capsule' ? 'person' : p.shape,
      color: p.color,
      size: { x: p.width, y: p.height, z: p.depth },
      keys: (
        path?.keys || [
          {
            frame: 0,
            position: start?.position || { x: 0.5, y: 0.5 },
            heading: start?.heading || 0,
          },
        ]
      ).map(transform),
    };
  });
  if (d.camera.keys.length)
    scene.camera.keys = d.camera.keys.map((k) => ({
      ...transform(k),
      position: { ...transform(k).position, y: k.height || 1.6 },
    }));
  return {
    scene: directorSceneSchema.parse(scene),
    sources: projected.dependencies,
    note: '从固定镜头映射的示意空间：归一化平面映射到 10×10 单位，代理尺寸来自导演资料。可编辑后另存预演方案。',
  };
}
import { generationDigest } from './h3-guided.js';

export function prepareDirector(store: Store, canvasId: string, nodeId: string, raw: unknown) {
  const request = z
    .object({
      action: z.enum(['previs_image', 'previs_video']),
      frame: z.number().int().nonnegative().default(0),
    })
    .parse(raw);
  const canvas = new CanvasService(store).get(canvasId),
    node = canvas.data.nodes.find((n: any) => n.id === nodeId);
  if (!node || node.type !== 'director' || !node.binding)
    throw new HttpError(400, '请先保存导演预演方案');
  const doc = store.get(node.binding.id, node.binding.revision);
  if (doc.kind !== 'director_scene' || doc.projectId !== canvas.projectId)
    throw new HttpError(400, '预演方案归属不符');
  const scene = directorSceneSchema.parse(doc.data.scene);
  if (request.frame >= scene.frames) throw new HttpError(400, '预演帧超出范围');
  const input = {
    canvas: { id: canvas.id, revision: canvas.revision },
    canvasNodeId: nodeId,
    nodeOperation: request,
    scene,
    source: { id: doc.id, revision: doc.revision },
    dependencies: [{ id: doc.id, revision: doc.revision }],
    name: node.title + ' · 预演',
  };
  return {
    input,
    digest: generationDigest({ nodeId, request, source: input.source, scene }),
    usage: {
      local: true,
      paidRequests: 0,
      frames: request.action === 'previs_image' ? 1 : scene.frames,
    },
    warnings: ['基础代理预演，不是真实动作或表演证据'],
  };
}
export function submitDirector(
  store: Store,
  canvasId: string,
  nodeId: string,
  raw: any,
  assistantRunId?: string,
) {
  return store.transaction(() => {
    const body = z
        .object({
          request: z.unknown(),
          digest: z.string().length(64),
          idempotencyKey: z.string().min(8),
        })
        .parse(raw),
      prior = store.db
        .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
        .get(body.idempotencyKey);
    if (prior) {
      const job = store.job(String(prior.id));
      if (
        job.input.previewDigest !== body.digest ||
        job.input.canvas?.id !== canvasId ||
        job.input.canvasNodeId !== nodeId ||
        job.input.assistantRunId !== assistantRunId
      )
        throw new HttpError(409, '回执冲突');
      return job;
    }
    const p = prepareDirector(store, canvasId, nodeId, body.request);
    if (p.digest !== body.digest) throw new HttpError(409, '预演方案变化，请重新准备');
    const canvas = store.get(canvasId);
    return store.createJob(
      'previs',
      canvas.projectId,
      canvas.data.episodeId || null,
      { ...p.input, previewDigest: p.digest, ...(assistantRunId ? { assistantRunId } : {}) },
      body.idempotencyKey,
    );
  });
}
