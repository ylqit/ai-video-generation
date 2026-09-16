import { creationCapabilities } from './capabilities.js';
import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CreationService } from './creation.js';
import { DeliveryService } from './delivery.js';
import { deliveryTargetSchema } from '../shared/delivery.js';
import { authoringStages, creationRefSchema } from '../shared/creation.js';
import { generationDigest } from './h3-guided.js';
import { ReadinessService } from './readiness.js';
import { CreationMediaService } from './creation-media.js';
import { resolveScope } from './workspace.js';

export function registerCreationRoutes(app: Express, store: Store, root: string) {
  const service = new CreationService(store);
  app.post('/api/creation-runs/:id/reference-confirmations', async (req, res) =>
    res.json(
      await new CreationMediaService(store, root).confirmReferences(
        String(req.params.id),
        req.body,
      ),
    ),
  );
  app.post('/api/creation-runs/:id/activate', (req, res) =>
    res.json(service.activate(String(req.params.id), req.body)),
  );
  app.get('/api/projects/:id/capabilities', (req, res) => {
    service.settings(String(req.params.id));
    res.json(creationCapabilities(store));
  });
  const delivery = new DeliveryService(store, root);
  app.post('/api/creation-runs/:id/delivery-plans', (req, res) =>
    res.json(delivery.create(String(req.params.id), req.body)),
  );
  app.get('/api/creation-runs/:id/delivery-preview', (req, res) => {
    const target = deliveryTargetSchema.parse(
      req.query.mode === 'scope'
        ? {
            mode: 'scope',
            scope: { id: req.query.scopeId, revision: Number(req.query.scopeRevision) },
          }
        : { mode: 'work' },
    );
    res.json(delivery.draft(String(req.params.id), target));
  });
  app.get('/api/delivery-plans/:id', (req, res) =>
    res.json(
      delivery.inspect(
        String(req.params.id),
        req.query.revision === undefined
          ? undefined
          : z.coerce.number().int().positive().parse(req.query.revision),
      ),
    ),
  );
  app.put('/api/delivery-plans/:id', (req, res) =>
    res.json(delivery.update(String(req.params.id), req.body)),
  );
  app.post('/api/delivery-plans/:id/export', (req, res) =>
    res.json(delivery.export(String(req.params.id), req.body)),
  );
  const version = z.number().int().nonnegative();
  app.get('/api/projects/:id/creation-settings', (req, res) =>
    res.json({
      settings: service.settings(String(req.params.id)),
      allowance: service.allowance(String(req.params.id)),
    }),
  );
  app.put('/api/projects/:id/creation-settings', (req, res) =>
    res.json(
      service.saveSettings(
        String(req.params.id),
        version.parse(req.body.revision),
        req.body.policy,
      ),
    ),
  );
  app.get('/api/projects/:id/creation-runs', (req, res) => {
    service.settings(String(req.params.id));
    res.json(
      store.list('creation_run', String(req.params.id)).map((d) => ({
        ...d,
        data: {
          episodeId: d.data.episodeId,
          request: d.data.request.slice(0, 200),
          stage: d.data.stage,
          state: d.data.state,
          paused: d.data.paused,
        },
      })),
    );
  });
  app.post('/api/projects/:id/creation-runs', (req, res) =>
    res.status(201).json(service.create(String(req.params.id), req.body)),
  );
  app.get('/api/creation-runs/:id', (req, res) => res.json(service.inspect(String(req.params.id))));
  app.post('/api/creation-runs/:id/messages', (req, res) =>
    res.json(new CreationMediaService(store, root).message(String(req.params.id), req.body)),
  );
  app.post('/api/creation-runs/:id/results', (req, res) => {
    const body = z
      .object({
        revision: version,
        stage: z.enum(authoringStages),
        result: z.unknown(),
        baseline: creationRefSchema.optional(),
        scope: z
          .object({
            shotIds: z.array(z.string()).default([]),
            sceneIds: z.array(z.string()).default([]),
            subjectKeys: z.array(z.string()).default([]),
          })
          .strict()
          .optional(),
      })
      .strict()
      .parse(req.body);
    if (body.scope && !body.baseline) throw new HttpError(400, '局部编辑必须指定采用版本');
    res
      .status(201)
      .json(
        body.baseline
          ? service.editResult(
              String(req.params.id),
              body.stage,
              body.result,
              body.revision,
              body.baseline,
              body.scope,
            )
          : service.saveResult(String(req.params.id), body.stage, body.result, body.revision),
      );
  });
  app.post('/api/creation-runs/:id/approve', (req, res) => {
    const body = z
      .object({ result: creationRefSchema, idempotencyKey: z.string().min(8) })
      .strict()
      .parse(req.body);
    res.json(
      service.approve(
        String(req.params.id),
        body.result.id,
        body.result.revision,
        body.idempotencyKey,
      ),
    );
  });
  app.post('/api/creation-runs/:id/pause', (req, res) => {
    const body = z.object({ revision: version, paused: z.boolean() }).strict().parse(req.body);
    res.json(service.pause(String(req.params.id), body.revision, body.paused));
  });
  app.post('/api/creation-runs/:id/assets', (req, res) =>
    res.json(service.bindAsset(String(req.params.id), req.body)),
  );
  app.post('/api/creation-runs/:id/production/approve', (req, res) => {
    const body = z
      .object({ revision: version, digest: z.string().length(64) })
      .strict()
      .parse(req.body);
    res.json(
      store.transaction(() => {
        const run = service.get(String(req.params.id));
        if (run.data.productionApproval === body.digest) return run;
        if (
          run.revision !== body.revision ||
          run.data.paused ||
          run.data.productionPreview?.digest !== body.digest
        )
          throw new HttpError(409, '生成预览已变化');
        if (run.data.productionPreview.heldJobIds) {
          const jobs = run.data.productionPreview.heldJobIds.map((id: string) => store.job(id));
          if (
            jobs.some(
              (j: any) => j.state !== 'queued' || j.holdReason !== 'creation_mode_review',
            ) ||
            generationDigest(jobs.map((j: any) => ({ id: j.id, input: j.input }))) !== body.digest
          )
            throw new HttpError(409, '待恢复任务已变化');
          service.adopted(run);
          for (const job of jobs) store.patchJob(job.id, { holdReason: null });
          return store.update(run.id, run.revision, {
            ...run.data,
            productionApproval: body.digest,
            productionPreview: null,
            state: 'active',
          });
        }
        return store.update(run.id, run.revision, {
          ...run.data,
          productionApproval: body.digest,
          state: 'active',
        });
      }),
    );
  });
  app.post('/api/creation-runs/:id/retry', (req, res) => {
    const body = z
      .object({ revision: version, jobId: z.string(), idempotencyKey: z.string().min(8) })
      .strict()
      .parse(req.body);
    res.json(
      store.transaction(() => {
        const run = service.get(String(req.params.id)),
          job = store.job(body.jobId);
        const row = store.db
          .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
          .get(body.idempotencyKey);
        const prior = row ? store.job(String(row.id)) : null;
        if (prior) {
          if (prior.input.retryOf !== job.id || prior.input.creationRunId !== run.id)
            throw new HttpError(409, '重做幂等键用于其他任务');
          return prior;
        }
        if (run.revision !== body.revision || run.data.paused || job.input.creationRunId !== run.id)
          throw new HttpError(409, '重做任务不属于当前运行版本');
        if (job.state !== 'failed')
          throw new HttpError(409, '仅明确失败可以重做；受理不明先核对，归档失败恢复原任务');
        if (job.output.descriptor)
          return store.patchJob(job.id, {
            state: 'archiving',
            error: null,
            cancelRequested: false,
          });
        if (job.kind === 'export')
          return store.patchJob(job.id, { state: 'queued', error: null, cancelRequested: false });
        if (job.kind !== 'generation') throw new HttpError(409, '文字任务通过修订指令重新发起');
        const scope = resolveScope(store, run);
        if (
          job.input.creationScope?.id !== scope.id ||
          job.input.creationScope?.revision !== scope.revision ||
          !scope.data.groupIds.includes(job.input.segment.id)
        )
          throw new HttpError(409, '重做需要当前范围内的准确任务版本；其他范围请重新预览提交');
        service.adopted(run);
        const episode = store.get(run.data.episodeId);
        const prepared = new ReadinessService(store).generation(
          {
            episodeId: episode.id,
            episodeRevision: episode.revision,
            segmentId: job.input.segment.id,
            width: job.input.width,
            height: job.input.height,
            steps: job.input.steps,
            seed: job.input.seed,
          },
          store.setting('comfy', null as any),
          { id: scope.id, revision: scope.revision },
        );
        return store.createJob(
          'generation',
          run.projectId,
          episode.id,
          {
            ...prepared.input,
            creationRunId: run.id,
            creationEpoch: run.data.epoch,
            creationScope: { id: scope.id, revision: scope.revision },
            retryOf: job.id,
          },
          body.idempotencyKey,
        );
      }),
    );
  });
  app.post('/api/creation-runs/:id/final-confirmation', (req, res) =>
    res.json(delivery.confirm(String(req.params.id), req.body)),
  );
}
