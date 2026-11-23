import { z } from 'zod';
import { canvasSchema } from '../shared/canvas.js';
import { nodeDefinitions } from '../shared/node-catalog.js';
import { CanvasService } from './canvas.js';
import { Store, HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';

const patchSchema = z
  .object({
    revision: z.number().int().positive(),
    idempotencyKey: z.string().min(8),
    operations: z
      .array(
        z
          .object({
            target: z.enum(['node', 'edge', 'canvas']),
            id: z.string().optional(),
            action: z.enum(['add', 'update', 'remove']),
            values: z.record(z.string(), z.unknown()).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(5000),
  })
  .strict();

// Compares only touched fields. Layout updates cannot overwrite content or a new candidate.
export function patchCanvas(store: Store, id: string, raw: unknown) {
  const body = patchSchema.parse(raw),
    service = new CanvasService(store);
  return store.transaction(() => {
    const head = service.get(id),
      base = store.get(id, body.revision),
      digest = generationDigest(body);
    const key = `canvas_patch:${id}:${body.idempotencyKey}`;
    const receipt = store.setting<any>(key, null);
    if (receipt) {
      if (receipt.digest !== digest) throw new HttpError(409, '操作幂等键已用于其他内容');
      return store.get(id, receipt.revision);
    }
    const next = canvasSchema.parse(head.data),
      original = canvasSchema.parse(base.data);
    for (const op of body.operations) {
      if (op.target === 'canvas') {
        if (
          op.action !== 'update' ||
          Object.keys(op.values || {}).some((k) => !['title', 'viewport', 'episodeId'].includes(k))
        )
          throw new HttpError(400, '画布属性不可通过此操作修改');
        for (const [k, v] of Object.entries(op.values || {})) {
          if (
            generationDigest((head.data as any)[k] ?? null) !==
            generationDigest((base.data as any)[k] ?? null)
          )
            throw new HttpError(409, `画布 ${k} 已变化`);
          (next as any)[k] = v;
        }
        continue;
      }
      const list = op.target === 'node' ? next.nodes : next.edges,
        oldList = op.target === 'node' ? original.nodes : original.edges;
      const current = list.find((v) => v.id === op.id),
        before = oldList.find((v) => v.id === op.id);
      if (op.action === 'add') {
        if (!op.id || current) throw new HttpError(409, '新对象 ID 已存在或缺失');
        if ((op.values?.outputs as any[])?.length)
          throw new HttpError(400, '执行结果只能由任务回填');
        (list as any[]).push({ ...op.values, id: op.id });
        continue;
      }
      if (!current || !before) throw new HttpError(409, '对象已移除或不在基线中');
      if (op.action === 'remove') {
        if (generationDigest(current) !== generationDigest(before))
          throw new HttpError(409, '删除对象已有新内容');
        list.splice(list.indexOf(current as any), 1);
        if (op.target === 'node')
          next.edges = next.edges.filter((e) => e.source !== op.id && e.target !== op.id);
        continue;
      }
      for (const [k, v] of Object.entries(op.values || {})) {
        if (['id', 'outputs'].includes(k))
          throw new HttpError(400, '对象标识和执行输出不能手工改写');
        if (
          generationDigest((current as any)[k] ?? null) !==
          generationDigest((before as any)[k] ?? null)
        )
          throw new HttpError(409, `${op.id} 的 ${k} 已变化，本机修改保留`);
        if (v === null) delete (current as any)[k];
        else (current as any)[k] = v;
      }
    }
    validateCanvasPorts(next);
    const saved = service.save(id, head.revision, next);
    store.setSetting(key, { digest, revision: saved.revision });
    return saved;
  });
}

export function validateCanvasPorts(data: ReturnType<typeof canvasSchema.parse>) {
  for (const e of data.edges.filter(
    (e) => e.relation === 'input' && e.sourceHandle && e.targetHandle,
  )) {
    const a = data.nodes.find((n) => n.id === e.source)!,
      b = data.nodes.find((n) => n.id === e.target)!;
    if (!a || !b) throw new HttpError(400, '连线对象不存在');
    const source = nodeDefinitions
      .find((d) => d.type === a.type)
      ?.outputs.find((p) => p.id === e.sourceHandle);
    const target = nodeDefinitions
      .find((d) => d.type === b.type)
      ?.inputs.find((p) => p.id === e.targetHandle);
    if (!source || !target || !target.accepts.includes(source.type))
      throw new HttpError(400, '节点端口类型不匹配');
    if (
      !target.multiple &&
      data.edges.filter(
        (v) => v.relation === 'input' && v.target === e.target && v.targetHandle === e.targetHandle,
      ).length > 1
    )
      throw new HttpError(400, '此输入仅允许一个来源');
  }
  for (const n of data.nodes) {
    const seen = new Set([n.id]);
    let parent = n.groupId;
    while (parent) {
      if (seen.has(parent)) throw new HttpError(400, '分组不能循环');
      seen.add(parent);
      const group = data.nodes.find((x) => x.id === parent);
      if (group?.type !== 'group') throw new HttpError(400, '分组不存在');
      parent = group.groupId;
    }
  }
}

export function canvasConversion(store: Store, id: string, apply = false, revision?: number) {
  const service = new CanvasService(store),
    head = service.get(id),
    data = canvasSchema.parse(head.data);
  if (revision !== undefined && head.revision !== revision) throw new HttpError(409, '画布已变化');
  const changes: string[] = [];
  for (const n of data.nodes) {
    if (n.generation && ['image', 'video'].includes(n.type)) {
      n.type = n.type + '_generate';
      changes.push(n.id);
    }
  }
  data.edges.forEach((e, i) => {
    e.order ??= i;
    if (e.relation === 'input' && !e.asset)
      e.asset = data.nodes.find((n) => n.id === e.source)?.asset;
  });
  data.version = 2;
  return apply
    ? service.save(id, head.revision, data)
    : { canvas: head.id, revision: head.revision, changes, data, mediaChanged: false };
}
