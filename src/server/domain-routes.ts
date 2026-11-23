import { extractFrameAsset } from './media-evidence.js';
import type express from 'express';
import type multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { CreationMediaService } from './creation-media.js';
import { DomainService } from './domain-service.js';
import { Store, HttpError } from './db.js';
import { config, inside } from './config.js';
import { ingestAsset, probeMedia, runProcess } from './media.js';
import { domainSchemas, versionRef, type DomainKind } from '../shared/domain.js';

export function registerDomainRoutes(
  app: express.Express,
  store: Store,
  root: string,
  upload: multer.Multer,
) {
  const domain = new DomainService(store);
  app.get('/api/records/:id/versions/:revision', (req, res) =>
    res.json(
      store.get(
        String(req.params.id),
        z.coerce.number().int().positive().parse(req.params.revision),
      ),
    ),
  );
  app.get('/api/domain/:id/diff', (req, res) => {
    const versions = z
      .object({ from: z.coerce.number().int().positive(), to: z.coerce.number().int().positive() })
      .parse(req.query);
    const before = store.get(String(req.params.id), versions.from),
      after = store.get(String(req.params.id), versions.to);
    const changes: any[] = [];
    const compare = (left: any, right: any, field: string) => {
      if (JSON.stringify(left) === JSON.stringify(right)) return;
      if (
        left &&
        right &&
        typeof left === 'object' &&
        typeof right === 'object' &&
        !Array.isArray(left) &&
        !Array.isArray(right)
      ) {
        for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
          compare(left[key], right[key], field ? `${field}.${key}` : key);
      } else changes.push({ field, before: left ?? null, after: right ?? null });
    };
    compare(before.data, after.data, '');
    res.json({ id: before.id, ...versions, changes });
  });
  app.post('/api/projects/:id/domain/:kind', (req, res) => {
    res
      .status(201)
      .json(domain.save(String(req.params.id), req.params.kind as DomainKind, req.body.data));
  });
  app.put('/api/domain/:id', (req, res) => {
    const doc = store.get(String(req.params.id));
    if (!(doc.kind in domainSchemas)) throw new HttpError(400, '不是可编辑领域对象');
    res.json(
      domain.save(
        doc.projectId,
        doc.kind as DomainKind,
        req.body.data,
        doc.id,
        z.number().int().positive().parse(req.body.revision),
      ),
    );
  });
  app.post('/api/domain/:id/publish', (req, res) =>
    res.json(
      domain.publish(
        String(req.params.id),
        z.number().int().positive().parse(req.body.revision),
        req.body.review,
      ),
    ),
  );
  app.get('/api/domain/:id/impact', (req, res) => res.json(domain.impact(String(req.params.id))));
  app.post('/api/domain/:id/correction', (req, res) => {
    const doc = store.get(String(req.params.id));
    if (doc.revision !== req.body.revision) throw new HttpError(409, '版本变化，请重新查看影响');
    res.json(domain.impact(doc.id, true, z.string().min(1).parse(req.body.reason)));
  });
  app.get('/api/asset-tasks/:id/package', (req, res) =>
    res.json(
      domain.exportTask(
        String(req.params.id),
        z.coerce.number().int().positive().parse(req.query.revision),
      ),
    ),
  );
  app.post('/api/asset-tasks/:id/delivery', upload.array('files', 32), async (req, res) => {
    const files = (req.files || []) as Express.Multer.File[];
    try {
      const result = await new CreationMediaService(store, root).deliver(
        String(req.params.id),
        JSON.parse(req.body.manifest),
        files,
      );
      res.status(result.replayed ? 200 : 201).json(result);
    } finally {
      await Promise.all(
        files.map((f) =>
          fs.unlink(f.path).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          }),
        ),
      );
    }
  });
  app.get('/api/library', (_req, res) =>
    res.json(store.db.prepare('SELECT * FROM library_items ORDER BY created_at DESC').all()),
  );
  app.get('/api/library/:id/versions/:revision', (req, res) =>
    res.json(
      domain.library(
        String(req.params.id),
        z.coerce.number().int().positive().parse(req.params.revision),
      ),
    ),
  );
  app.post('/api/projects/:id/library', (req, res) => {
    const body = z
      .object({
        references: z.array(versionRef),
        name: z.string().min(1),
        itemId: z.string().optional(),
        revision: z.number().int().positive().optional(),
      })
      .parse(req.body);
    res
      .status(201)
      .json(
        domain.publishLibrary(
          String(req.params.id),
          body.references,
          body.name,
          body.itemId,
          body.revision,
        ),
      );
  });
  app.post('/api/projects/:id/library/import', (req, res) => {
    const body = versionRef.parse(req.body);
    res.status(201).json(domain.copyLibrary(String(req.params.id), body.id, body.revision));
  });
  app.post('/api/projects/:id/shot-checks', (req, res) =>
    res.json(domain.shotChecks(String(req.params.id), z.array(z.any()).parse(req.body.shots))),
  );
  app.post('/api/projects/:id/reviews', (req, res) =>
    res
      .status(201)
      .json(domain.review(String(req.params.id), req.body.data, req.body.id, req.body.revision)),
  );
  app.post('/api/projects/:id/selections', (req, res) =>
    res.status(201).json(domain.select(String(req.params.id), req.body.data, req.body.revision)),
  );
  app.get('/api/episodes/:id/assemble', (req, res) => {
    const ep = store.get(String(req.params.id));
    res.json(domain.assemble(ep.projectId, ep.id));
  });
  app.post('/api/projects/:id/canon', (req, res) =>
    res
      .status(201)
      .json(domain.confirmCanon(String(req.params.id), req.body.data, req.body.revision)),
  );
  app.post('/api/assets/:id/evidence', async (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive(), frameIndex: z.number().int().nonnegative() })
      .parse(req.body);
    const asset = await extractFrameAsset(
      store,
      root,
      String(req.params.id),
      body.revision,
      body.frameIndex,
    );
    res.status(201).json(asset);
  });
  app.post('/api/assets/:id/crop', async (req, res) => {
    const body = z
      .object({
        revision: z.number().int().positive(),
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .parse(req.body);
    const original = store.get(String(req.params.id), body.revision);
    if (
      original.kind !== 'asset' ||
      original.data.mediaType !== 'image' ||
      body.x + body.width > original.data.width ||
      body.y + body.height > original.data.height
    )
      throw new HttpError(400, '图片裁剪区域无效');
    const dir = inside(root, `jobs/crop-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'crop.png');
    try {
      await runProcess(config.ffmpeg, [
        '-y',
        '-v',
        'error',
        '-i',
        inside(root, original.data.path),
        '-vf',
        `crop=${body.width}:${body.height}:${body.x}:${body.y}:exact=1`,
        '-frames:v',
        '1',
        file,
      ]);
      const { revision, ...parameters } = body;
      res.status(201).json(
        await ingestAsset(store, root, original.projectId, file, {
          name: `${original.data.name} · 裁剪候选`,
          category: 'reference',
          sourceAssetIds: [original.id],
          derivedSource: {
            jobId: null,
            media: { id: original.id, revision },
            kind: 'crop',
            frameIndex: null,
            interval: null,
            parameters,
          },
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
}
