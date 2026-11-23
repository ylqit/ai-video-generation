import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { resolveNodeContext } from './node-context.js';
import { directorSceneSchema } from '../shared/director-scene.js';
import { DomainService } from './domain-service.js';
import { domainSchemas, type DomainKind } from '../shared/domain.js';
import { StudioService } from './service.js';
import { generationDigest } from './h3-guided.js';
import { directorDraft } from './director-production.js';

// Edits the original domain record and advances only this view's binding atomically.
export function saveCanvasObject(store: Store, canvasId: string, nodeId: string, raw: unknown) {
  const body = z
    .object({
      canvasRevision: z.number().int().positive(),
      objectRevision: z.number().int().nonnegative(),
      data: z.record(z.string(), z.unknown()),
      idempotencyKey: z.string().min(8).optional(),
    })
    .parse(raw);
  return store.transaction(() => {
    const key = body.idempotencyKey
        ? `object-edit:${canvasId}:${nodeId}:${body.idempotencyKey}`
        : null,
      digest = generationDigest(body.data);
    const prior = key ? store.setting<any>(key, null) : null;
    if (prior) {
      if (prior.digest !== digest) throw new HttpError(409, '对象编辑回执冲突');
      return { object: store.get(prior.id, prior.revision), canvas: store.get(canvasId) };
    }
    const canvas = new CanvasService(store).get(canvasId),
      nodes = structuredClone(canvas.data.nodes),
      node = nodes.find((n: any) => n.id === nodeId);
    if (canvas.revision !== body.canvasRevision || !node) throw new HttpError(409, '画布已变化');
    const object = resolveNodeContext(store, canvas.projectId, node);
    let saved;
    if (node.type === 'director') {
      const data = {
        title: node.title,
        scene: directorSceneSchema.parse(body.data.scene),
        sources: directorDraft(store, canvasId, nodeId).sources,
      };
      if (node.binding) {
        const old = store.get(node.binding.id);
        if (old.kind !== 'director_scene') throw new HttpError(400, '预演对象类型不匹配');
        saved = store.update(old.id, body.objectRevision, data);
      } else {
        if (body.objectRevision) throw new HttpError(409, '预演对象不存在');
        saved = store.create('director_scene', canvas.projectId, data, canvas.id);
      }
    } else if (!object && ['entity', 'appearance', 'scene'].includes(node.type)) {
      if (body.objectRevision) throw new HttpError(409, '业务对象尚不存在');
      const kind = node.type === 'scene' ? 'layout' : node.type;
      saved = new DomainService(store).save(canvas.projectId, kind as DomainKind, body.data);
    } else {
      if (!object) throw new HttpError(400, '请先关联业务对象');
      const old = store.get(object.source.id);
      if (old.revision !== body.objectRevision || node.binding.revision !== body.objectRevision)
        throw new HttpError(409, '业务对象有新版本，请比较后再编辑');
      if (node.binding.shotId && old.kind === 'episode') {
        const data = structuredClone(old.data),
          index = data.shots.findIndex((s: any) => s.id === node.binding.shotId);
        data.shots[index] = body.data;
        saved = new StudioService(store).saveEpisode(old.id, old.revision, data);
      } else if (old.kind in domainSchemas)
        saved = new DomainService(store).save(
          old.projectId,
          old.kind as DomainKind,
          body.data,
          old.id,
          old.revision,
        );
      else if (old.kind === 'node_analysis') {
        if (node.binding.path) {
          const match = /^shots\.(\d+)$/.exec(node.binding.path);
          if (!match || !old.data.shots?.[Number(match[1])])
            throw new HttpError(400, '仅支持编辑现有拉片镜头的文字说明');
          const description = z.string().parse(body.data.description),
            shots = structuredClone(old.data.shots);
          shots[Number(match[1])] = {
            ...shots[Number(match[1])],
            description,
            descriptionSource: 'user_edit',
          };
          saved = store.update(old.id, old.revision, { ...old.data, shots });
        } else {
          const edit = z
            .object({
              content: z.string(),
              segments: z
                .array(
                  z.object({
                    start: z.number().nonnegative(),
                    end: z.number().positive(),
                    text: z.string(),
                  }),
                )
                .optional(),
            })
            .parse(body.data);
          if (edit.segments?.some((s) => s.end <= s.start))
            throw new HttpError(400, '编辑时间区间无效');
          saved = store.update(old.id, old.revision, {
            ...old.data,
            content: edit.content,
            editedSegments: edit.segments,
          });
        }
      } else throw new HttpError(400, '该对象请通过其专用编辑器保存；画布引用保持不变');
    }
    node.binding = { ...node.binding, id: saved.id, revision: saved.revision };
    store.update(canvas.id, canvas.revision, { ...canvas.data, nodes });
    if (key) store.setSetting(key, { digest, id: saved.id, revision: saved.revision });
    return { object: saved, canvas: store.get(canvas.id) };
  });
}
export function registerCanvasObjectRoutes(app: Express, store: Store) {
  app.get('/api/canvases/:id/nodes/:node/director-draft', (req, res) =>
    res.json(directorDraft(store, String(req.params.id), String(req.params.node))),
  );
  app.get('/api/canvases/:id/nodes/:node/object', (req, res) => {
    const canvas = new CanvasService(store).get(String(req.params.id)),
      node = canvas.data.nodes.find((n: any) => n.id === req.params.node);
    if (!node) throw new HttpError(404, '节点不存在');
    res.json(resolveNodeContext(store, canvas.projectId, node));
  });
  app.put('/api/canvases/:id/nodes/:node/object', (req, res) =>
    res.json(saveCanvasObject(store, String(req.params.id), String(req.params.node), req.body)),
  );
}
