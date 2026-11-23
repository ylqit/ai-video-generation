import type { Express } from 'express';
import type multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { StudioService } from './service.js';
import { hashFile, ingestAsset } from './media.js';
import { generationDigest } from './h3-guided.js';
import { patchCanvas } from './canvas-patches.js';
import { scheduleMediaPreview, registerMediaPreviewRoutes } from './media-preview.js';

export const importTargetSchema = z
  .object({
    kind: z.enum(['canvas', 'reference', 'assistant', 'library']),
    canvasId: z.string().optional(),
    nodeId: z.string().optional(),
    purpose: z
      .enum([
        'identity',
        'style',
        'scene',
        'prop',
        'composition',
        'first_frame',
        'last_frame',
        'audio',
        'motion',
      ])
      .optional(),
    position: z.object({ x: z.number().finite(), y: z.number().finite() }).optional(),
  })
  .strict();
/** One file has one durable receipt. Binding is a separate atomic stage, so a lost response can be reconciled without another asset. */
export async function importWorkbenchFile(
  store: Store,
  root: string,
  projectId: string,
  file: { path: string; originalname: string },
  raw: unknown,
) {
  new StudioService(store).project(projectId);
  const body = z
      .object({ idempotencyKey: z.string().min(8).max(160), target: importTargetSchema })
      .parse(raw),
    key = 'workbench_import:' + projectId + ':' + body.idempotencyKey;
  const c = body.target.canvasId ? new CanvasService(store).get(body.target.canvasId) : null;
  if (body.target.kind !== 'library' && (!c || c.projectId !== projectId))
    throw new HttpError(400, '请选择当前作品中的目标画布');
  if (
    body.target.kind === 'reference' &&
    (!body.target.nodeId ||
      !body.target.purpose ||
      !c!.data.nodes.some((n: any) => n.id === body.target.nodeId))
  )
    throw new HttpError(400, '参考上传需要已有目标节点与用途');
  const ext = path.extname(file.originalname).toLowerCase(),
    hash = await hashFile(file.path),
    digest = generationDigest({ hash, name: file.originalname, target: body.target });
  let receipt = store.setting<any>(key, null);
  if (receipt && receipt.digest !== digest)
    throw new HttpError(409, '导入标识已用于不同文件或目标');
  if (receipt?.status === 'ready') return receipt;
  if (!receipt) {
    if (['.txt', '.md'].includes(ext)) {
      const stat = await fs.stat(file.path);
      if (stat.size > 2 * 1024 * 1024) throw new HttpError(400, '文本上限 2 MiB，请按章节拆分');
      const content = new TextDecoder('utf-8', { fatal: true }).decode(
        await fs.readFile(file.path),
      );
      if (content.length > 100000) throw new HttpError(400, '文档超过 100000 字符，请按章节拆分');
      if (body.target.kind === 'reference')
        throw new HttpError(400, '文本应通过文字端口引用，不能作为媒体参考');
      store.transaction(() => {
        if (store.setting(key, null)) return;
        const doc = store.create(
          'chapter',
          projectId,
          {
            title: file.originalname,
            content,
            importSource: { sha256: hash, fileName: file.originalname },
          },
          projectId,
        );
        store.setSetting(key, {
          digest,
          status: 'archived',
          object: { id: doc.id, revision: doc.revision },
          kind: 'document',
        });
      });
    } else {
      await ingestAsset(store, root, projectId, file.path, {
        name: file.originalname,
        category: 'source',
        importReceipt: { key, digest },
      });
    }
    receipt = store.setting<any>(key, null);
  }
  const result = store.transaction(() => {
    receipt = store.setting<any>(key, null);
    if (receipt.status === 'ready') return receipt;
    const object = store.get(receipt.object.id, receipt.object.revision);
    let nodeId: string | null = null;
    if (body.target.kind === 'canvas' || body.target.kind === 'reference') {
      const head = new CanvasService(store).get(body.target.canvasId!);
      nodeId = randomUUID();
      const p = body.target.position || {
        x: 80 + (head.data.nodes.length % 4) * 350,
        y: 80 + Math.floor(head.data.nodes.length / 4) * 310,
      };
      const node = {
        id: nodeId,
        type: object.kind === 'chapter' ? 'document' : object.data.mediaType,
        title: file.originalname,
        text: object.kind === 'chapter' ? object.data.content : '',
        ...p,
        ...(object.kind === 'chapter' ? { document: receipt.object } : { asset: receipt.object }),
      };
      const operations: any[] = [{ target: 'node', id: nodeId, action: 'add', values: node }];
      if (body.target.kind === 'reference')
        operations.push({
          target: 'edge',
          id: randomUUID(),
          action: 'add',
          values: {
            source: nodeId,
            target: body.target.nodeId,
            relation: 'input',
            purpose: body.target.purpose,
            asset: receipt.object,
            sourceHandle: object.data.mediaType,
            targetHandle: 'references',
            order: head.data.edges.filter(
              (e: any) => e.target === body.target.nodeId && e.relation === 'input',
            ).length,
            instruction: '',
          },
        });
      patchCanvas(store, head.id, {
        revision: head.revision,
        idempotencyKey: body.idempotencyKey + ':bind',
        operations,
      });
    }
    const final = {
      ...receipt,
      status: 'ready',
      nodeId,
      canvasId: body.target.canvasId || null,
      reference: {
        kind: receipt.kind === 'asset' ? 'asset' : 'document',
        object: receipt.object,
        imageHandling: 'image',
      },
      name: file.originalname,
    };
    store.setSetting(key, final);
    return final;
  });
  if (receipt.kind === 'asset') scheduleMediaPreview(store, projectId, receipt.object);
  return result;
}
export function registerWorkbenchImportRoutes(
  app: Express,
  store: Store,
  root: string,
  upload: ReturnType<typeof multer>,
) {
  registerMediaPreviewRoutes(app, store, root);
  app.get('/api/projects/:id/imports/:key', (req, res) =>
    res.json(
      store.setting('workbench_import:' + req.params.id + ':' + req.params.key, {
        status: 'missing',
      }),
    ),
  );
  app.post('/api/projects/:id/imports', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, '请选择一个文件');
    try {
      res.status(201).json(
        await importWorkbenchFile(store, root, String(req.params.id), req.file, {
          idempotencyKey: req.body.idempotencyKey,
          target: JSON.parse(req.body.target || '{}'),
        }),
      );
    } finally {
      await fs.unlink(req.file.path).catch((e: any) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  });
}
