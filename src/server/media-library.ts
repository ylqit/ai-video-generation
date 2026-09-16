import type { Express } from 'express';
import { z } from 'zod';
import fs from 'node:fs/promises';
import { inside } from './config.js';
import { Store, HttpError } from './db.js';
import { candidateDetail } from './candidate-media.js';
import { cleanupPlan, executeCleanup, fileCleared, restoreMedia } from './media-retention.js';
export function libraryPage(store: Store, projectId: string, query: any = {}) {
  if (store.get(projectId).kind !== 'project') throw new HttpError(400, '不是项目');
  const q = z
    .object({
      view: z
        .enum(['core', 'reference', 'candidate', 'export', 'attachment', 'cleared'])
        .default('core'),
      offset: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(100).default(36),
      mediaType: z.enum(['image', 'video', 'audio']).optional(),
    })
    .parse(query);
  // Both aggregate counts and page rows share classification and media filters.
  const cte = `WITH bindings AS (
    SELECT json_extract(b.value,'$.asset.id') AS id, json_extract(b.value,'$.asset.revision') AS revision
    FROM documents r, json_each(r.data,'$.bindings') b WHERE r.project_id=? AND r.kind='creation_run'
  ), classified AS (
    SELECT a.*, COALESCE(f.status='cleared',0) AS cleared,
      CASE WHEN json_extract(a.data,'$.category')='generated' THEN 'candidate'
           WHEN json_extract(a.data,'$.category')='export' THEN 'export'
           WHEN json_extract(a.data,'$.category') IN ('review_frame','keyframe','original_audio')
             AND NOT EXISTS(SELECT 1 FROM bindings b WHERE b.id=a.id AND b.revision=a.revision) THEN 'attachment'
           ELSE 'reference' END AS role
    FROM documents a LEFT JOIN media_file_state f ON f.path=json_extract(a.data,'$.path')
    WHERE a.project_id=? AND a.kind='asset' AND (? IS NULL OR json_extract(a.data,'$.mediaType')=?)
  )`;
  const parameters = [projectId, projectId, q.mediaType || null, q.mediaType || null];
  const filter =
    q.view === 'cleared'
      ? 'cleared=1'
      : q.view === 'core'
        ? "cleared=0 AND role IN ('reference','candidate')"
        : 'cleared=0 AND role=?';
  const pageParams = ['cleared', 'core'].includes(q.view) ? parameters : [...parameters, q.view];
  return store.transaction(() => {
    const stats = store.db
      .prepare(cte + ' SELECT role,cleared,COUNT(*) AS n FROM classified GROUP BY role,cleared')
      .all(...parameters);
    const counts = Object.fromEntries(
      ['reference', 'candidate', 'export', 'attachment'].map((role) => [
        role,
        stats.filter((r) => !r.cleared && r.role === role).reduce((n, r) => n + Number(r.n), 0),
      ]),
    );
    const total = Number(
      store.db
        .prepare(cte + ` SELECT COUNT(*) n FROM classified WHERE ${filter}`)
        .get(...pageParams)!.n,
    );
    const rows = store.db
      .prepare(
        cte + ` SELECT * FROM classified WHERE ${filter} ORDER BY created_at,id LIMIT ? OFFSET ?`,
      )
      .all(...pageParams, q.limit, q.offset);
    // One batched lookup returns only display metadata, never frozen job inputs.
    const jobIds = rows
      .filter((r) => r.role === 'candidate')
      .map((r) => JSON.parse(String(r.data)).jobId)
      .filter(Boolean);
    const metadata = jobIds.length
      ? store.db
          .prepare(
            `SELECT j.id,j.state,json_extract(j.input,'$.segment.id') AS segmentId,json_extract(j.input,'$.segment.shotIds') AS shotIds,json_extract(j.input,'$.creationEpoch') AS epoch,json_extract(j.input,'$.creationScope') AS scope
      FROM jobs j WHERE j.project_id=? AND j.kind='generation' AND j.id IN (${jobIds.map(() => '?').join(',')})`,
          )
          .all(projectId, ...jobIds)
      : [];
    const items = rows.map((r) => {
      const asset = store.decode(r),
        job = metadata.find((j) => j.id === asset.data.jobId);
      const candidate = job
        ? {
            id: String(job.id),
            label: `${job.segmentId || '候选'} · ${String(job.id).slice(0, 8)}`,
            segmentId: job.segmentId || '',
            shotIds: JSON.parse(String(job.shotIds || '[]')),
            state: job.state,
            epoch: job.epoch,
            scope: JSON.parse(String(job.scope || 'null')),
            video: asset,
            audio: null,
            review: null,
            exports: [],
            evidence: [],
            detailPending: true,
          }
        : undefined;
      return {
        asset,
        role: r.role,
        cleared: !!r.cleared,
        candidate,
        label: candidate?.label || asset.data.name,
      };
    });
    return {
      items,
      total,
      offset: q.offset,
      limit: q.limit,
      counts,
      clearedCount: stats.filter((r) => r.cleared).reduce((n, r) => n + Number(r.n), 0),
    };
  });
}
export function registerMediaLibraryRoutes(app: Express, store: Store, root: string) {
  app.get('/api/projects/:id/candidates/:jobId', (req, res) =>
    res.json(candidateDetail(store, String(req.params.id), String(req.params.jobId))),
  );
  app.get('/api/assets/:id/storage', async (req, res) => {
    const asset = store.get(
      String(req.params.id),
      z.coerce.number().int().positive().parse(req.query.revision),
    );
    if (asset.kind !== 'asset') throw new HttpError(400, '不是素材');
    if (fileCleared(store, asset.data.path)) return res.json({ status: 'cleared' });
    const exists = await fs.stat(inside(root, asset.data.path)).then(
      (s) => s.isFile(),
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
    res.json({ status: exists ? 'available' : 'missing' });
  });
  app.get('/api/projects/:id/media-library', (req, res) =>
    res.json(libraryPage(store, String(req.params.id), req.query)),
  );
  app.get('/api/projects/:id/media-cleanup', (req, res) =>
    res.json(cleanupPlan(store, String(req.params.id))),
  );
  app.post('/api/projects/:id/media-cleanup', async (req, res) => {
    const b = z
      .object({ digest: z.string().length(64), batchId: z.string().uuid() })
      .strict()
      .parse(req.body);
    res.json(await executeCleanup(store, root, String(req.params.id), b.digest, b.batchId));
  });
  app.post('/api/assets/:id/restore', async (req, res) => {
    const b = z.object({ revision: z.number().int().positive() }).strict().parse(req.body);
    res.json(await restoreMedia(store, root, String(req.params.id), b.revision));
  });
}
