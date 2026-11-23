import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { WorkspaceService } from './workspace.js';
import { scopeInputSchema } from '../shared/workspace.js';
import { productionMetrics } from './production-metrics.js';

export function registerWorkspaceRoutes(app: Express, store: Store) {
  const service = new WorkspaceService(store);
  const version = z.number().int().positive();
  app.get('/api/creation-runs/:id/metrics', (req, res) =>
    res.json(productionMetrics(store, String(req.params.id))),
  );
  app.get('/api/projects/:id/workspace-records/:recordId', (req, res) => {
    const revision = z.coerce.number().int().positive().parse(req.query.revision);
    const doc = store.get(String(req.params.recordId), revision);
    if (doc.projectId !== String(req.params.id)) throw new HttpError(400, '记录不属于项目');
    if (req.query.detail !== 'true') return res.json(doc);
    const results: Record<string, any> = {};
    const missing: string[] = [];
    for (const ref of doc.data.context?.dependencies || []) {
      try {
        const dependency = store.get(ref.id, ref.revision);
        if (dependency.projectId !== doc.projectId) throw new HttpError(400, '引用不属于项目');
        if (dependency.kind === 'authoring_result') results[dependency.data.stage] = dependency;
      } catch (error: any) {
        missing.push(error.message);
      }
    }
    if (doc.kind === 'authoring_result') results[doc.data.stage] = doc;
    const run = doc.parentId ? store.get(doc.parentId) : null;
    const isCurrent =
      run?.kind === 'creation_run' &&
      Object.values(run.data.results || {}).some(
        (r: any) => r.id === doc.id && r.revision === doc.revision,
      );
    const snapshot = isCurrent ? service.snapshot(doc.projectId, run!.id) : null;
    if (snapshot)
      for (const [stage, result] of Object.entries(snapshot.results)) results[stage] ??= result;
    const assets: any[] = [];
    for (const ref of [...(doc.data.result?.audio || []).map((a: any) => a.asset)]) {
      try {
        const asset = store.get(ref.id, ref.revision);
        if (asset.projectId !== doc.projectId) throw new HttpError(400, '音频引用归属错误');
        assets.push(asset);
      } catch (error: any) {
        missing.push(error.message);
      }
    }
    res.json({
      record: doc,
      results,
      requirements: snapshot?.requirements || [],
      candidates: snapshot?.candidates || [],
      assets,
      missing,
      current: !!isCurrent,
    });
  });
  app.get('/api/creation-runs/:id/history', (req, res) => {
    const run = store.get(String(req.params.id));
    if (run.kind !== 'creation_run') throw new HttpError(400, '不是创作运行');
    res.json(store.list('authoring_result', run.projectId).filter((d) => d.parentId === run.id));
  });
  app.get('/api/projects/:id/workspace', (req, res) => {
    const query = z
      .object({
        runId: z.string().optional(),
        episodeId: z.string().optional(),
        seriesId: z.string().optional(),
      })
      .parse(req.query);
    res.json(service.snapshot(String(req.params.id), query.runId, query.episodeId, query.seriesId));
  });
  app.get('/api/projects/:id/workspace-layout', (req, res) =>
    res.json(service.layout(String(req.params.id))),
  );
  app.put('/api/projects/:id/workspace-layout', (req, res) => {
    const body = z
      .object({ revision: z.number().int().nonnegative(), layout: z.unknown() })
      .strict()
      .parse(req.body);
    res.json(service.saveLayout(String(req.params.id), body.revision, body.layout));
  });
  app.post('/api/creation-runs/:id/scopes', (req, res) => {
    const { runRevision, activate, ...input } = scopeInputSchema
      .extend({ runRevision: version, activate: z.boolean().default(true) })
      .parse(req.body);
    res.status(201).json(service.saveScope(String(req.params.id), runRevision, input, activate));
  });
  app.put('/api/creation-scopes/:id', (req, res) => {
    const { revision, runRevision, activate, ...input } = scopeInputSchema
      .extend({ revision: version, runRevision: version, activate: z.boolean().default(false) })
      .parse(req.body);
    const scope = store.get(String(req.params.id));
    if (scope.kind !== 'creation_scope') throw new HttpError(400, '不是执行范围');
    res.json(service.saveScope(scope.parentId!, runRevision, input, activate, scope.id, revision));
  });
  app.post('/api/creation-scopes/:id/preview', (req, res) => {
    const body = z.object({ revision: version, runRevision: version }).strict().parse(req.body);
    res.json(service.preview(String(req.params.id), body.revision, body.runRevision));
  });
  app.post('/api/creation-scopes/:id/submit', (req, res) => {
    const body = z
      .object({
        revision: version,
        runRevision: version,
        digest: z.string().length(64),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(req.body);
    res.json(
      service.submit(
        String(req.params.id),
        body.revision,
        body.runRevision,
        body.digest,
        body.idempotencyKey,
      ),
    );
  });
}
