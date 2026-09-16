import { creativeCatalog } from './creative-catalog.js';
import { resolveCreativeBrief, selectedProfile } from './creative-brief.js';
import type { Express } from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { inside } from './config.js';
import { ReadinessService } from './readiness.js';
import { DomainService } from './domain-service.js';

import { BatchService } from './batches.js';
import { creationPresets, workspaceKinds } from '../shared/workbench.js';
import { compileH3, ComfyClient } from './comfy.js';
import { productionProgress } from './production.js';
import { buildReviewEvaluation } from './review-evidence.js';
import { versionRef } from '../shared/domain.js';

// Owns read-only media/capability checks. It never uploads or creates a job.
export async function validateExecutionPreview(prepared: any, root: string) {
  const mappings = new Map<string, string>();
  for (const a of prepared.input.assets) {
    const stat = await fs.stat(inside(root, a.asset.data.path)).catch(() => null);
    if (!stat?.isFile() || !stat.size) throw new HttpError(400, '参考文件缺失或为空');
    mappings.set(
      prepared.input.prepared
        ? `${a.reference.assetId}:${a.reference.revision}`
        : a.reference.assetId,
      `studio_${a.asset.data.sha256}${path.extname(a.asset.data.path)}`,
    );
  }
  const graph = compileH3(prepared.input, mappings, 'preview');
  await new ComfyClient(prepared.input.profile.baseUrl).validate(graph);
  return { ...prepared, graph, validation: { valid: true, uploaded: false, submitted: false } };
}
const pageSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(250).default(50),
});
export function registerWorkbenchRoutes(app: Express, store: Store, root: string) {
  app.get('/api/episodes/:id/production', (req, res) =>
    res.json(productionProgress(store, req.params.id)),
  );
  const readiness = new ReadinessService(store),
    domain = new DomainService(store),
    batches = new BatchService(store);
  app.get('/api/creative-modules', (_req, res) => res.json(creativeCatalog));
  app.post('/api/projects/:id/review-basis/preview', (req, res) => {
    const basis = versionRef.parse(req.body.episode);
    res.json(
      buildReviewEvaluation(
        store,
        String(req.params.id),
        store.job(z.string().parse(req.body.jobId)),
        basis,
      ),
    );
  });
  app.post('/api/projects/:id/creative-modules/import', (req, res) => {
    const entry = creativeCatalog.find(
      (m) => m.key === req.body.key && m.catalogVersion === req.body.catalogVersion,
    );
    if (!entry) throw new HttpError(404, '模块目录版本不存在');
    const doc = domain.save(String(req.params.id), 'creative_module', entry.data);
    res.status(201).json(
      store.update(doc.id, doc.revision, {
        ...doc.data,
        originCatalog: { key: entry.key, version: entry.catalogVersion },
      }),
    );
  });
  app.post('/api/projects/:id/creative-brief/preview', (req, res) => {
    const pid = String(req.params.id);
    const profile = req.body.profile
      ? domain.owned(pid, req.body.profile, 'creation_profile')
      : selectedProfile(store, pid);
    res.json(resolveCreativeBrief(store, pid, profile, req.body.scope || {}));
  });
  app.get('/api/runtime', (_req, res) =>
    res.json({
      profile: store.setting('comfy', {}),
      discovery: store.setting('discovery', null),
      eventCursor: Number(store.db.prepare('SELECT max(seq) n FROM events').get()?.n || 0),
    }),
  );
  app.get('/api/project-index', (req, res) => {
    const { offset, limit } = pageSchema.parse(req.query);
    const items = store.db
      .prepare(
        "SELECT id,revision,project_id,parent_id,created_at,updated_at,json_object('title',json_extract(data,'$.title'),'mode',json_extract(data,'$.mode'),'brief',json_extract(data,'$.brief')) data,'project' kind FROM documents WHERE kind='project' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(limit, offset)
      .map((r) => store.decode(r));
    res.json({
      items,
      total: Number(
        store.db.prepare("SELECT count(*) n FROM documents WHERE kind='project'").get()?.n,
      ),
      offset,
      limit,
    });
  });
  app.get('/api/projects/:id/record-index', (req, res) => {
    const { offset, limit } = pageSchema.parse(req.query),
      projectId = String(req.params.id),
      kind = String(req.query.kind || ''),
      q = String(req.query.q || '').slice(0, 200);
    if (store.get(projectId).kind !== 'project') throw new HttpError(400, '不是项目');
    const where =
      "project_id=? AND (?='' OR kind=?) AND (?='' OR instr(lower(COALESCE(json_extract(data,'$.name'),json_extract(data,'$.title'),id)),lower(?))>0)";
    const args = [projectId, kind, kind, q, q];
    res.json({
      items: store.db
        .prepare(
          `SELECT id,revision,kind,COALESCE(json_extract(data,'$.name'),json_extract(data,'$.title'),id) name FROM documents WHERE ${where} ORDER BY created_at,id LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset),
      total: Number(
        store.db.prepare(`SELECT count(*) n FROM documents WHERE ${where}`).get(...args)?.n,
      ),
      offset,
      limit,
    });
  });
  app.get('/api/workbench', (req, res) => {
    const { offset, limit } = pageSchema.parse(req.query);
    const total = Number(
      store.db.prepare("SELECT count(*) n FROM documents WHERE kind='project'").get()?.n,
    );
    const projects = store.db
      .prepare(
        "SELECT * FROM documents WHERE kind='project' ORDER BY updated_at DESC,id LIMIT ? OFFSET ?",
      )
      .all(limit, offset)
      .map((r) => store.decode(r));
    const items = projects.map((project) => {
      const ready = readiness.project(project.id),
        jobs = store.db
          .prepare('SELECT state,count(*) n FROM jobs WHERE project_id=? GROUP BY state')
          .all(project.id);
      const film = store.db
        .prepare(
          "SELECT id,revision,json_extract(data,'$.name') name FROM documents WHERE project_id=? AND kind='asset' AND json_extract(data,'$.category')='export' ORDER BY updated_at DESC LIMIT 1",
        )
        .get(project.id);
      return {
        project,
        steps: ready.steps,
        pending: ready.issues.length,
        todos: ready.issues.slice(0, 8),
        jobs,
        film,
      };
    });
    res.json({ items, total, offset, limit });
  });
  app.get('/api/projects/:id/readiness', (req, res) =>
    res.json(readiness.project(String(req.params.id))),
  );
  app.get('/api/projects/:id/records', (req, res) => {
    const { offset, limit } = pageSchema.parse(req.query),
      kind = typeof req.query.kind === 'string' ? req.query.kind : null;
    if (store.get(String(req.params.id)).kind !== 'project') throw new HttpError(400, '不是项目');
    const exclude = typeof req.query.exclude === 'string' ? req.query.exclude : null;
    const workspace = typeof req.query.workspace === 'string' ? req.query.workspace : '';
    if (workspace && !(workspace in workspaceKinds)) throw new HttpError(400, '未知工作区');
    const kinds = workspace
      ? ['episode', ...workspaceKinds[workspace], ...(kind === 'asset' ? ['asset'] : [])]
      : [];
    const where =
      'project_id=? AND (? IS NULL OR kind=?) AND (? IS NULL OR kind<>?)' +
      (workspace ? ` AND kind IN (${kinds.map(() => '?').join(',')})` : '');
    const linkedJob = typeof req.query.jobId === 'string' ? req.query.jobId : null;
    const mediaType = req.query.mediaType
      ? z.enum(['image', 'video', 'audio']).parse(req.query.mediaType)
      : null;
    const filtered =
      where +
      (linkedJob ? " AND json_extract(data,'$.jobId')=?" : '') +
      (mediaType ? " AND json_extract(data,'$.mediaType')=?" : '');
    const args = [
      String(req.params.id),
      kind,
      kind,
      exclude,
      exclude,
      ...kinds,
      ...(linkedJob ? [linkedJob] : []),
      ...(mediaType ? [mediaType] : []),
    ];
    // Episode lists carry only labels; the selected version is fetched independently.
    const columns = workspace
      ? `id,revision,kind,project_id,parent_id,created_at,updated_at,CASE WHEN kind='episode' THEN json_object('title',json_extract(data,'$.title'),'number',json_extract(data,'$.number'),'seriesId',json_extract(data,'$.seriesId'),'seriesProduction',json_extract(data,'$.seriesProduction'),'summaryOnly',1) ELSE data END data`
      : '*';
    res.json({
      items: store.db
        .prepare(
          `SELECT ${columns} FROM documents WHERE ${filtered} ORDER BY created_at,id LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset)
        .map((r) => store.decode(r)),
      total: Number(
        store.db.prepare(`SELECT count(*) n FROM documents WHERE ${filtered}`).get(...args)?.n,
      ),
      offset,
      limit,
    });
  });
  app.get('/api/records/:id', (req, res) =>
    res.json(
      store.get(
        String(req.params.id),
        req.query.revision === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(req.query.revision),
      ),
    ),
  );
  app.get('/api/jobs', (req, res) => {
    const { offset, limit } = pageSchema.parse(req.query),
      project = String(req.query.projectId || '') || null,
      batch = String(req.query.batchId || '') || null,
      state = String(req.query.state || '') || null;
    const where =
        '(? IS NULL OR project_id=?) AND (? IS NULL OR batch_id=?) AND (? IS NULL OR state=?)',
      args = [project, project, batch, batch, state, state];
    const columns =
      req.query.summary === '1'
        ? `id,project_id,episode_id,kind,state,prompt_id,error,cancel_requested,created_at,updated_at,batch_id,batch_item_id,hold_reason,
      json_object('segment',json_object('id',json_extract(input,'$.segment.id'),'duration',json_extract(input,'$.segment.duration')),'name',json_extract(input,'$.name'),'context',json_object('request',substr(json_extract(input,'$.context.request'),1,80))) input,
      json_object('lastReconciledAt',json_extract(output,'$.lastReconciledAt'),'basisCorrectionMessage',json_extract(output,'$.basisCorrectionMessage'),'reconciliationIncomplete',json_extract(output,'$.reconciliationIncomplete')) output`
        : '*';
    res.json({
      items: store.db
        .prepare(
          `SELECT ${columns} FROM jobs WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
        )
        .all(...args, limit, offset)
        .map((r) => store.decodeJob(r)),
      total: Number(store.db.prepare(`SELECT count(*) n FROM jobs WHERE ${where}`).get(...args)?.n),
      offset,
      limit,
    });
  });
  app.get('/api/creation-presets', (_req, res) => res.json(creationPresets));
  app.post('/api/projects/:id/creation-profile', (req, res) =>
    res.json(
      domain.save(
        String(req.params.id),
        'creation_profile',
        req.body.data,
        req.body.id,
        req.body.revision,
      ),
    ),
  );
  app.post('/api/reference-plans/suggest', (req, res) =>
    res.json(
      readiness.suggest(z.string().parse(req.body.episodeId), z.string().parse(req.body.segmentId)),
    ),
  );
  app.get('/api/batches', (req, res) => {
    const { offset, limit } = pageSchema.parse(req.query);
    res.json({
      items: store.db
        .prepare('SELECT id FROM work_batches ORDER BY updated_at DESC LIMIT ? OFFSET ?')
        .all(limit, offset)
        .map((r) => batches.get(String(r.id))),
      total: Number(store.db.prepare('SELECT count(*) n FROM work_batches').get()?.n),
      offset,
      limit,
    });
  });
  app.post('/api/batches', (req, res) => res.status(201).json(batches.save(req.body)));
  app.get('/api/batches/:id', (req, res) => res.json(batches.get(String(req.params.id))));
  app.put('/api/batches/:id', (req, res) =>
    res.json(
      batches.save(req.body.data, String(req.params.id), z.number().int().parse(req.body.revision)),
    ),
  );
  app.post('/api/batches/:id/preview', async (req, res) => {
    const preview = batches.preview(String(req.params.id));
    const validated = [];
    for (const item of preview.included) validated.push(await validateExecutionPreview(item, root));
    res.json({ ...preview, included: validated });
  });
  app.post('/api/batches/:id/confirm', (req, res) =>
    res.json(
      batches.confirm(
        String(req.params.id),
        z.number().int().parse(req.body.revision),
        z.string().parse(req.body.digest),
        z.string().min(8).parse(req.body.idempotencyKey),
      ),
    ),
  );
  for (const action of ['pause', 'resume', 'cancel'] as const)
    app.post(`/api/batches/:id/${action}`, (req, res) =>
      res.json(batches.control(String(req.params.id), action)),
    );
}
