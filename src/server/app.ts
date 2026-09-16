import { extractFrameAsset } from './media-evidence.js';
import { registerMediaLibraryRoutes } from './media-library.js';
import { fileCleared } from './media-retention.js';
import { prepareContinuation } from './continuation.js';
import { SeriesProductionService, predecessorCanon } from './series-production.js';
import { AssemblyService } from './assembly.js';
import { saveDialogueTake } from './voices.js';
import { registerPrevisRoutes } from './previs.js';
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { StudioService } from './service.js';
import { ComfyClient, compileH3 } from './comfy.js';
import { config, inside, prepareData } from './config.js';
import { ingestAsset, probeMedia, runProcess } from './media.js';
import { codexExecutable } from './codex.js';
import {
  shotSchema,
  segmentSchema,
  timelineDuration,
  type ComfyProfile,
} from '../shared/contracts.js';
import { registerDomainRoutes } from './domain-routes.js';
import { registerWorkbenchRoutes, validateExecutionPreview } from './workbench-routes.js';
import { ReadinessService } from './readiness.js';
import { storyBlueprintSchema } from '../shared/creative-modules.js';
import { registerCreationRoutes } from './creation-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { registerCreationMediaRoutes } from './creation-media-routes.js';

export function createApp(store: Store, root: string) {
  prepareData(root);
  const app = express(),
    service = new StudioService(store);
  if (!store.setting('comfy', null))
    store.setSetting('comfy', { baseUrl: config.comfyUrl, instanceId: randomUUID() });
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin) {
      let host;
      try {
        host = new URL(origin).hostname;
      } catch {
        return res.status(403).json({ error: '来源无效' });
      }
      if (!['localhost', '127.0.0.1', '[::1]'].includes(host))
        return res.status(403).json({ error: '首版仅允许本机创作台来源' });
    }
    next();
  });
  app.use((req, res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (
        store.setting('maintenance', false) &&
        !req.path.endsWith('/media-cleanup') &&
        !req.path.endsWith('/restore')
      )
        return res.status(503).json({ error: '正在维护媒体，写入暂不可用' });
      store.inFlightMutations++;
      let completed = false;
      const release = () => {
        if (!completed) store.inFlightMutations--;
        completed = true;
      };
      res.once('finish', release);
      res.once('close', release);
    }
    next();
  });
  app.use(express.json({ limit: '20mb' }));
  registerMediaLibraryRoutes(app, store, root);
  registerCreationRoutes(app, store, root);
  registerWorkspaceRoutes(app, store);
  const upload = multer({
    storage: multer.diskStorage({
      destination: path.join(root, 'incoming'),
      filename: (_req, file, cb) =>
        cb(null, randomUUID() + path.extname(file.originalname).toLowerCase()),
    }),
    limits: { fileSize: 512 * 1024 * 1024, files: 32, fieldSize: 2 * 1024 * 1024 },
  });
  const seriesService = new SeriesProductionService(store),
    assembly = new AssemblyService(store);
  app.post('/api/projects/:id/series', (req, res) => {
    service.project(String(req.params.id));
    res
      .status(201)
      .json(
        store.create(
          'series',
          String(req.params.id),
          { title: z.string().min(1).parse(req.body.title), bible: {}, approved: false },
          String(req.params.id),
        ),
      );
  });
  app.post('/api/series/:id/plan/preview', (req, res) =>
    res.json(seriesService.preview(String(req.params.id), req.body.data)),
  );
  app.post('/api/series/:id/plan/apply', (req, res) =>
    res.json(seriesService.apply(String(req.params.id), req.body)),
  );
  app.get('/api/series/:id/progress', (req, res) =>
    res.json(seriesService.progress(String(req.params.id))),
  );
  app.get('/api/episodes/:id/series-facts', (req, res) =>
    res.json(predecessorCanon(store, store.get(String(req.params.id)), true)),
  );
  app.post('/api/episodes/:id/continuation/preview', (req, res) => {
    const ep = store.get(String(req.params.id));
    const segment = segmentSchema.parse(req.body.segment),
      shots = z.array(shotSchema).parse(req.body.shots);
    if (
      !ep.data.segments.some((s: any) => s.id === segment.id) ||
      shots.some((s) => !ep.data.shots.some((v: any) => v.id === s.id))
    )
      throw new HttpError(400, '接续草稿归属错误');
    res.json(prepareContinuation(store, { ...ep, data: { ...ep.data, shots } }, segment));
  });
  app.post('/api/projects/:id/dialogue-takes', (req, res) =>
    res.status(201).json(saveDialogueTake(store, String(req.params.id), req.body.data)),
  );
  app.get('/api/edls/:id/assembly', (req, res) =>
    res.json(assembly.inspect(String(req.params.id))),
  );
  app.post('/api/assembly-reviews', (req, res) =>
    res.status(201).json(assembly.review(req.body.data)),
  );
  app.post('/api/edls/:id/release/preview', (req, res) =>
    res.json(assembly.previewRelease(String(req.params.id), req.body)),
  );
  app.post('/api/edls/:id/release/confirm', (req, res) => {
    if (store.get(String(req.params.id)).data.owner?.deliveryPlanId)
      throw new HttpError(409, '此时间线由交付计划管理，请确认对应整片交付版本');
    res.status(201).json(assembly.release(String(req.params.id), req.body));
  });
  registerDomainRoutes(app, store, root, upload);
  registerCreationMediaRoutes(app, store, root);
  registerPrevisRoutes(app, store, root, upload);
  registerWorkbenchRoutes(app, store, root);
  app.get('/api/health', (_req, res) =>
    res.json({
      ok: true,
      version: '0.1.0',
      databaseVersion: store.db.prepare('PRAGMA user_version').get()?.user_version,
      authoringVersion: 9,
      dataDir: root,
      codex: codexExecutable(),
      imageAutomation: false,
      sshStartup: false,
    }),
  );
  app.get('/api/state', (req, res) => {
    const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : undefined;
    res.json({
      projects: store.list('project'),
      documents: projectId ? store.list(undefined, projectId) : [],
      jobs: projectId ? store.jobs(projectId) : [],
      profile: store.setting('comfy', {}),
      discovery: store.setting('discovery', null),
    });
  });
  app.post('/api/projects', (req, res) => {
    const data = z
      .object({
        title: z.string().trim().min(1).max(160),
        mode: z.enum(['series', 'short']),
        brief: z.string().max(100000),
      })
      .parse(req.body);
    res.status(201).json(service.createProject(data));
  });
  app.post('/api/projects/:id/episodes', (req, res) => {
    res.status(201).json(service.createEpisode(req.params.id, req.body));
  });
  app.post('/api/projects/:id/arcs', (req, res) => {
    service.project(req.params.id);
    const data = z.object({ title: z.string().min(1), seriesId: z.string() }).parse(req.body);
    service.owned(data.seriesId, req.params.id, 'series');
    res.status(201).json(store.create('arc', req.params.id, data, data.seriesId));
  });
  app.post('/api/projects/:id/novel', (req, res) => {
    res
      .status(201)
      .json(
        service.importNovel(req.params.id, z.string().min(1).max(4000000).parse(req.body.text)),
      );
  });
  app.post('/api/projects/:id/scripts', (req, res) => {
    res
      .status(201)
      .json(
        service.importScripts(req.params.id, z.string().min(1).max(1000000).parse(req.body.text)),
      );
  });
  app.post('/api/projects/:id/sources', (req, res) => {
    const project = service.project(String(req.params.id));
    const data = z
      .object({
        title: z.string().trim().min(1).max(200),
        text: z.string().trim().min(1).max(1000000),
      })
      .strict()
      .parse(req.body);
    res.status(201).json(
      store.create(
        'chapter',
        project.id,
        {
          ...data,
          sourceHash: createHash('sha256').update(data.text).digest('hex'),
          sourceType: 'user_import',
        },
        project.id,
      ),
    );
  });
  app.put('/api/records/:id', (req, res) => {
    const d = store.get(req.params.id),
      revision = z.number().int().parse(req.body.revision);
    let data: any;
    if (d.kind === 'episode') return res.json(service.saveEpisode(d.id, revision, req.body.data));
    if (d.kind === 'project')
      data = z
        .object({ title: z.string().min(1), mode: z.enum(['series', 'short']), brief: z.string() })
        .parse(req.body.data);
    else if (d.kind === 'series') {
      if (req.body.data.production) throw new HttpError(400, '系列制作计划通过影响预览与应用保存');
      data = z
        .object({
          title: z.string().min(1),
          bible: z.record(z.string(), z.unknown()),
          approved: z.boolean(),
          storyBlueprint: storyBlueprintSchema.optional(),
        })
        .parse({ ...d.data, ...req.body.data });
      if (d.data.production) data.production = d.data.production;
    } else if (d.kind === 'chapter')
      data = {
        ...d.data,
        ...z
          .object({ title: z.string(), text: z.string(), event: z.string() })
          .parse(req.body.data),
      };
    else throw new HttpError(400, '此记录应通过专用审核接口修改');
    res.json(
      store.transaction(() => {
        const next = store.update(d.id, revision, data);
        service.invalidate(d.id);
        return next;
      }),
    );
  });
  app.post('/api/episodes/:id/approve', (req, res) =>
    res.json(service.approveEpisode(req.params.id, z.number().int().parse(req.body.revision))),
  );
  app.post('/api/episodes/:id/continuity', (req, res) => {
    const body = z
      .object({
        revision: z.number().int(),
        facts: z.record(z.string(), z.unknown()),
        openLoops: z.array(z.string()),
        references: z.array(z.object({ id: z.string(), revision: z.number().int() })).default([]),
      })
      .parse(req.body);
    res.json(service.confirmContinuity(req.params.id, body.revision, body));
  });
  app.get('/api/records/:id/history', (req, res) => {
    const current = store.get(req.params.id);
    res.json(Array.from({ length: current.revision }, (_, i) => store.get(current.id, i + 1)));
  });
  app.post('/api/projects/:id/assets', upload.array('files', 32), async (req, res) => {
    const files = req.files as Express.Multer.File[];
    try {
      service.project(String(req.params.id));
      const manifest = req.body.manifest
        ? z
            .object({
              assets: z.array(
                z.object({
                  file: z.string(),
                  name: z.string(),
                  category: z.string(),
                  entityId: z.string().optional(),
                  variant: z.string().optional(),
                  sourceAssetIds: z.array(z.string()).default([]),
                  prompt: z.string().default(''),
                }),
              ),
            })
            .parse(JSON.parse(req.body.manifest))
        : null;
      if (!files?.length) throw new HttpError(400, '请选择图片、视频或音频');
      if (manifest && manifest.assets.length !== files.length)
        throw new HttpError(400, '资产清单与文件数量不一致');
      if (new Set(files.map((f) => f.originalname)).size !== files.length)
        throw new HttpError(400, '上传文件名不能重复');
      for (const f of files) {
        const item = manifest?.assets.find((a) => a.file === f.originalname);
        if (manifest && !item) throw new HttpError(400, `清单缺少 ${f.originalname}`);
        for (const id of item?.sourceAssetIds || [])
          service.owned(id, String(req.params.id), 'asset');
        await probeMedia(f.path);
      }
      const assets = [];
      for (const f of files) {
        const item = manifest?.assets.find((a) => a.file === f.originalname);
        assets.push(
          await ingestAsset(
            store,
            root,
            String(req.params.id),
            f.path,
            item
              ? {
                  name: item.name,
                  category: item.category,
                  entityId: item.entityId,
                  variant: item.variant,
                  sourceAssetIds: item.sourceAssetIds,
                  prompt: item.prompt,
                }
              : {
                  name: req.body.name || f.originalname,
                  category: req.body.category || 'reference',
                  entityId: req.body.entityId,
                  variant: req.body.variant,
                  prompt: req.body.prompt,
                },
          ),
        );
      }
      res.status(201).json(assets);
    } finally {
      await Promise.all((files || []).map((f) => fs.unlink(f.path).catch(() => {})));
    }
  });
  app.post('/api/assets/:id/adopt', (req, res) => {
    const d = store.get(req.params.id);
    if (d.kind !== 'asset') throw new HttpError(400, '不是资产');
    const body = z.object({ revision: z.number().int(), adopted: z.boolean() }).parse(req.body);
    res.json(store.update(d.id, body.revision, { ...d.data, adopted: body.adopted }));
  });
  app.post('/api/assets/:id/last-frame', async (req, res) => {
    const frame = await extractFrameAsset(
      store,
      root,
      String(req.params.id),
      z.number().int().positive().parse(req.body.revision),
      'last',
    );
    res.status(201).json(frame);
  });
  app.get('/api/assets/:id/file', (req, res) => {
    const d = store.get(req.params.id, req.query.revision ? Number(req.query.revision) : undefined);
    if (d.kind !== 'asset') throw new HttpError(404, '不是素材');
    // The managed data root may be named .data; only DB-owned, validated asset paths reach here.
    if (fileCleared(store, d.data.path))
      return res.status(410).json({ error: '文件已清理，可从过程附件记录显式恢复' });
    res.sendFile(inside(root, d.data.path), { dotfiles: 'allow' });
  });
  app.post('/api/generations', (req, res) => {
    new ReadinessService(store).generation(
      req.body,
      store.setting<ComfyProfile>('comfy', null as any),
    );
    res
      .status(201)
      .json(service.generation(req.body, store.setting<ComfyProfile>('comfy', null as any)));
  });
  app.post('/api/generations/preview', async (req, res) => {
    const preview = new ReadinessService(store).generation(
      req.body,
      store.setting<ComfyProfile>('comfy', null as any),
    );
    res.json(await validateExecutionPreview(preview, root));
  });
  app.get('/api/jobs/:id', (req, res) => res.json(store.job(req.params.id)));
  app.get('/api/jobs/:id/log', async (req, res) => {
    const job = store.job(req.params.id);
    const archivedPath = store.setting<Record<string, string>>('archivedJobLogs', {})[job.id];
    const log = await fs
      .readFile(
        archivedPath
          ? inside(root, archivedPath)
          : job.output.executionDir
            ? inside(root, path.relative(root, job.output.executionDir)) + path.sep + 'runner.log'
            : inside(root, `jobs/${req.params.id}/runner.log`),
        'utf8',
      )
      .catch(() => '暂无本机日志');
    res.type('text/plain').send(log.slice(-24000));
  });
  app.post('/api/jobs/:id/cancel', (req, res) => {
    const j = store.job(req.params.id);
    if (['succeeded', 'failed', 'cancelled'].includes(j.state))
      throw new HttpError(409, '任务已经结束');
    res.json(
      store.patchJob(j.id, {
        cancelRequested: true,
        ...(j.state === 'queued' ? { state: 'cancelled' as const } : {}),
      }),
    );
  });
  app.post('/api/jobs/:id/retry', (req, res) => {
    const j = store.job(req.params.id);
    if (j.state !== 'failed') throw new HttpError(409, '仅失败任务可以恢复；未知提交需先核对');
    if (
      (j.kind === 'creative' && j.input.context?.schemaVersion !== 9) ||
      (j.kind === 'generation' &&
        j.input.creationRunId &&
        store.get(j.input.creationRunId).data.schemaVersion !== 9 &&
        !j.output.descriptor)
    )
      throw new HttpError(409, '不支持旧作者任务；请使用匹配的离线备份程序处理');
    if (j.kind === 'generation' && j.input.creationCharge && !j.output.descriptor)
      throw new HttpError(409, '已计额度的生成需要创建新的重做尝试；不能重置旧任务绕过额度');
    if (j.batchId && j.kind === 'generation' && !j.output.descriptor)
      throw new HttpError(409, '本批次只确认一次生成；请新建重做条目并审核');
    if (j.kind === 'generation' && j.promptId && !j.output.descriptor)
      throw new HttpError(409, '云端生成已经失败，重新生成需在分镜界面确认新尝试');
    res.json(
      store.patchJob(j.id, {
        state: j.output.descriptor ? 'archiving' : 'queued',
        cancelRequested: false,
        error: null,
      }),
    );
  });
  app.post('/api/jobs/:id/suspend-tracking', (req, res) => {
    const j = store.job(req.params.id);
    if (j.kind !== 'generation' || !['unknown', 'submitted', 'running'].includes(j.state))
      throw new HttpError(409, '只能停止已提交或待核对任务的本机跟踪');
    res.json(
      store.patchJob(j.id, {
        state: 'cancelled',
        cancelRequested: false,
        output: { ...j.output, waitSuspended: true },
        error: '本机跟踪已暂停；云端任务可能继续。输入与回执已保留，可恢复跟踪，不会重新提交。',
      }),
    );
  });
  app.post('/api/jobs/:id/resume-tracking', (req, res) => {
    const j = store.job(req.params.id);
    if (j.kind !== 'generation' || j.state !== 'cancelled' || !j.output.waitSuspended)
      throw new HttpError(409, '此任务没有暂停跟踪');
    res.json(
      store.patchJob(j.id, {
        state: j.promptId ? 'submitted' : 'unknown',
        cancelRequested: false,
        output: { ...j.output, waitSuspended: false },
        error: null,
      }),
    );
  });
  app.post('/api/jobs/:id/reconcile', async (req, res) => {
    const job = store.job(req.params.id);
    if (job.state !== 'unknown') throw new HttpError(409, '此任务不是未知提交');
    const promptId = z.string().min(1).parse(req.body.promptId),
      client = new ComfyClient(job.input.profile.baseUrl);
    const h = await client.json('/history/' + encodeURIComponent(promptId)),
      q = await client.json('/queue');
    const prompt =
      h[promptId]?.prompt ||
      [...q.queue_running, ...q.queue_pending].find((p: any) => p[1] === promptId);
    if (
      prompt?.[3]?.studio?.job_id !== job.id ||
      prompt?.[3]?.studio?.instance_id !== job.input.profile.instanceId
    )
      throw new HttpError(400, '任务标记不匹配，拒绝关联');
    res.json(store.patchJob(job.id, { promptId, state: 'submitted', error: null }));
  });
  app.post('/api/projects/:id/edl', (req, res) =>
    res.json(
      service.saveEdl(
        req.params.id,
        req.body.data,
        req.body.revision,
        req.body.edlId ? { id: req.body.edlId } : undefined,
      ),
    ),
  );
  app.post('/api/edls/:id/export', (req, res) => {
    const edl = store.get(req.params.id);
    if (edl.kind !== 'edl' || edl.revision !== req.body.revision)
      throw new HttpError(409, '时间线已变化');
    if (edl.data.owner) throw new HttpError(409, '请通过所属交付计划预览并导出');
    service.validateEdl(edl.projectId, edl.data);
    const episode = service.owned(edl.parentId!, edl.projectId, 'episode');
    const target = episode.data.seriesProduction
      ? undefined
      : episode.data.dramaturgy?.targetFrames;
    if (
      target &&
      req.body.allowPartial !== true &&
      Math.round(timelineDuration(edl.data) * 24) !== target
    )
      throw new HttpError(
        409,
        `正式成片需要 ${target} 帧；当前为 ${Math.round(timelineDuration(edl.data) * 24)} 帧。局部导出请明确选择时间线草稿。`,
      );
    const assets = [...edl.data.clips, ...edl.data.audio].map((c) =>
      service.owned(c.assetId, edl.projectId, 'asset', c.revision),
    );
    res.status(201).json(
      store.createJob(
        'export',
        edl.projectId,
        edl.parentId,
        {
          edl: edl.data,
          edlRevision: edl.revision,
          assets,
          name:
            (episode.data.seriesProduction
              ? '[审核版] '
              : req.body.allowPartial === true
                ? '[时间线草稿] '
                : '') + (req.body.name || '成片'),
          partial: req.body.allowPartial === true,
        },
        z.string().min(8).parse(req.body.idempotencyKey),
      ),
    );
  });
  app.get('/api/settings', (_req, res) => res.json(store.setting('comfy', {})));
  app.put('/api/settings', (req, res) => {
    const body = z.object({ baseUrl: z.string().url(), newInstance: z.boolean() }).parse(req.body);
    const client = new ComfyClient(body.baseUrl);
    const old = store.setting<ComfyProfile>('comfy', null as any);
    const p = {
      baseUrl: client.baseUrl,
      instanceId:
        body.newInstance || old.baseUrl !== client.baseUrl ? randomUUID() : old.instanceId,
    };
    store.setSetting('comfy', p);
    store.setSetting('discovery', null);
    res.json(p);
  });
  app.post('/api/settings/probe', async (_req, res) => {
    const p = store.setting<ComfyProfile>('comfy', null as any),
      result = await new ComfyClient(p.baseUrl).discover();
    const { nodes, ...summary } = result;
    store.setSetting('discovery', summary);
    res.json(summary);
  });
  app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.flushHeaders();
    let cursor = Number(req.headers['last-event-id']) || Number(req.query.after) || 0;
    const timer = setInterval(() => {
      for (const e of store.events(cursor)) {
        res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
        cursor = Number(e.seq);
      }
      res.write(': keepalive\n\n');
    }, 1500);
    req.on('close', () => clearInterval(timer));
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API 不存在' }));
  app.use(express.static(path.resolve('dist/web')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/web/index.html')));
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof z.ZodError ? 400 : err.status || 500;
    res.status(status).json({
      error:
        err instanceof z.ZodError
          ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
          : err.message || '服务错误',
    });
  });
  return app;
}
