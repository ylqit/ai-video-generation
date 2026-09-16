import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { DomainService } from './domain-service.js';
import { previsManifest, authoringPrevisManifest } from './previs-manifest.js';
import { ingestAsset } from './media.js';

const request = z.object({
  revision: z.coerce.number().int().positive(),
  frame: z.coerce.number().int().nonnegative().default(0),
  width: z.coerce.number().int().min(128).max(2048).default(576),
  height: z.coerce.number().int().min(128).max(2048).default(1024),
});
export function registerPrevisRoutes(app: Express, store: Store, root: string, upload: any) {
  app.get('/api/authoring-results/:id/shots/:shotId/previs', (req, res) => {
    const p = request.parse(req.query);
    res.json(
      authoringPrevisManifest(
        store,
        String(req.params.id),
        p.revision,
        String(req.params.shotId),
        p.frame,
        p.width,
        p.height,
      ),
    );
  });
  app.post(
    '/api/authoring-results/:id/shots/:shotId/previs-image',
    upload.single('file'),
    async (req, res) => {
      try {
        if (!req.file || path.extname(req.file.path) !== '.png')
          throw new HttpError(400, '需要 PNG 预演图片');
        const p = request.parse(req.body);
        const prepared = authoringPrevisManifest(
          store,
          String(req.params.id),
          p.revision,
          String(req.params.shotId),
          p.frame,
          p.width,
          p.height,
        );
        const record = store.get(String(req.params.id));
        if (
          record.revision !== p.revision ||
          record.data.stale ||
          prepared.digest !== req.body.digest
        )
          throw new HttpError(409, '导演或预演依据已变化');
        res.status(201).json(
          await ingestAsset(store, root, prepared.projectId, req.file.path, {
            name: `导演预演 ${prepared.manifest.shotId} · 帧 ${p.frame}`,
            category: 'previsualization',
            previsualSource: prepared.manifest,
          }),
        );
      } finally {
        if (req.file)
          await fs.unlink(req.file.path).catch((e: any) => {
            if (e.code !== 'ENOENT') throw e;
          });
      }
    },
  );
  app.get('/api/episodes/:id/shot-checks', (req, res) => {
    const ep = store.get(
      String(req.params.id),
      req.query.revision ? Number(req.query.revision) : undefined,
    );
    if (ep.kind !== 'episode') throw new HttpError(400, '需要分集');
    res.json({
      episode: { id: ep.id, revision: ep.revision },
      issues: new DomainService(store).shotChecks(ep.projectId, ep.data.shots),
    });
  });
  app.get('/api/episodes/:id/shots/:shotId/previs', (req, res) => {
    const p = request.parse(req.query);
    res.json(
      previsManifest(
        store,
        String(req.params.id),
        p.revision,
        String(req.params.shotId),
        p.frame,
        p.width,
        p.height,
      ),
    );
  });
  app.post(
    '/api/episodes/:id/shots/:shotId/previs-image',
    upload.single('file'),
    async (req, res) => {
      const file = req.file;
      try {
        if (!file || path.extname(file.path) !== '.png')
          throw new HttpError(400, '需要 PNG 预演图片');
        const p = request.parse(req.body),
          episodeId = String(req.params.id);
        const prepared = previsManifest(
          store,
          episodeId,
          p.revision,
          String(req.params.shotId),
          p.frame,
          p.width,
          p.height,
        );
        if (store.get(episodeId).revision !== p.revision || prepared.digest !== req.body.digest)
          throw new HttpError(409, '预演依据已变化，请重新保存和预演');
        if (
          prepared.manifest.layout &&
          store.get(prepared.manifest.layout.id).revision !== prepared.manifest.layout.revision
        )
          throw new HttpError(409, '布局已更新，请重新确认固定版本');
        res.status(201).json(
          await ingestAsset(store, root, prepared.projectId, file.path, {
            name: `预演 ${prepared.manifest.shotId} · 帧 ${p.frame}`,
            category: 'previsualization',
            episodeId,
            previsualSource: prepared.manifest,
          }),
        );
      } finally {
        if (file)
          await fs.unlink(file.path).catch((e: any) => {
            if (e.code !== 'ENOENT') throw e;
          });
      }
    },
  );
}
