import { z } from 'zod';
import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import { contextReferencesSchema } from '../shared/workbench-context.js';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { resolveWorkbenchContext } from './workbench-context.js';
import { patchCanvas } from './canvas-patches.js';
import { generationDigest } from './h3-guided.js';

export function bindNodeReferences(store: Store, canvasId: string, nodeId: string, raw: unknown) {
  const body = z
    .object({
      revision: z.number().int().positive(),
      references: contextReferencesSchema,
      purpose: z.enum([
        'identity',
        'style',
        'scene',
        'prop',
        'composition',
        'first_frame',
        'last_frame',
        'motion',
        'audio',
      ]),
      idempotencyKey: z.string().min(8),
    })
    .parse(raw);
  return store.transaction(() => {
    const c = new CanvasService(store).get(canvasId),
      key = 'reference_bind:' + canvasId + ':' + body.idempotencyKey,
      digest = generationDigest({ nodeId, ...body });
    const prior = store.setting<any>(key, null);
    if (prior) {
      if (prior.digest !== digest) throw new HttpError(409, '参考绑定回执冲突');
      return prior;
    }
    const base = store.get(canvasId, body.revision),
      n = base.data.nodes.find((n: any) => n.id === nodeId);
    if (!n || !c.data.nodes.some((n: any) => n.id === nodeId))
      throw new HttpError(409, '目标节点已变化或不存在');
    const p = resolveWorkbenchContext(store, c.projectId, body.references),
      ops: any[] = [];
    let order = c.data.edges.filter(
      (e: any) => e.target === nodeId && e.relation === 'input',
    ).length;
    for (const i of p.items) {
      const r = i.reference;
      let source =
        r.kind === 'node' &&
        r.canvas.id === canvasId &&
        !r.range &&
        !r.textRange &&
        generationDigest(
          store.get(canvasId, r.canvas.revision).data.nodes.find((v: any) => v.id === r.nodeId),
        ) === generationDigest(c.data.nodes.find((v: any) => v.id === r.nodeId)) &&
        c.data.nodes.some((v: any) => v.id === r.nodeId)
          ? r.nodeId
          : '';
      if (source === nodeId) throw new HttpError(400, '节点不能引用自己作为输入');
      if (!source) {
        source = randomUUID();
        ops.push({
          target: 'node',
          id: source,
          action: 'add',
          values: {
            type: i.media ? i.media.type : 'note',
            title: i.title,
            text: i.text,
            x: n.x - 360,
            y: n.y + order * 60,
            ...(i.media ? { asset: { id: i.media.id, revision: i.media.revision } } : {}),
            ...(i.media?.range ? { range: i.media.range } : {}),
            settings: { contextSource: r },
          },
        });
      }
      const context = c.data.nodes.find((v: any) => v.id === source)?.binding;
      const id = randomUUID();
      ops.push({
        target: 'edge',
        id,
        action: 'add',
        values: {
          source,
          target: nodeId,
          relation: 'input',
          sourceHandle: i.media?.type || (context ? 'context' : 'text'),
          targetHandle: i.media ? 'references' : context ? 'context' : 'text',
          order: order++,
          instruction: '',
          ...(i.media
            ? { purpose: body.purpose, asset: { id: i.media.id, revision: i.media.revision } }
            : {}),
        },
      });
    }
    if (!ops.length) throw new HttpError(400, '请选择输入');
    const saved = patchCanvas(store, canvasId, {
      revision: body.revision,
      idempotencyKey: body.idempotencyKey,
      operations: ops,
    });
    const result = {
      digest,
      canvas: { id: canvasId, revision: saved.revision },
      edges: ops.filter((o) => o.target === 'edge').map((o) => o.id),
    };
    store.setSetting(key, result);
    return result;
  });
}
export function registerNodeReferenceRoutes(app: Express, store: Store) {
  app.post('/api/canvases/:id/nodes/:node/references', (req, res) =>
    res.json(bindNodeReferences(store, String(req.params.id), String(req.params.node), req.body)),
  );
}
