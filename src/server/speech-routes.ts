import type { Express } from 'express';
import type multer from 'multer';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { VoiceLibrary } from './voice-library.js';
import { prepareSpeech, submitSpeech } from './speech-production.js';
import { prepareLipSync, submitLipSync } from './sync-lipsync.js';
import { speechUsage, saveSpeechAllowance } from './speech-usage.js';
import { speechContext } from './speech-transport.js';
import { speechAdapters } from './speech-providers.js';
import { isSpeechProtocol, voiceApplicationSchema, voiceHandleIdentity } from '../shared/speech.js';
import { generationDigest } from './h3-guided.js';
import { ModelRegistry } from './model-registry.js';
import { DomainService } from './domain-service.js';
import { inside } from './config.js';
import { taskSummary, taskScopes } from './task-summary.js';
import { updateVoiceDependents } from './voice-impact.js';

export function registerSpeechRoutes(
  app: Express,
  store: Store,
  root: string,
  upload: multer.Multer,
) {
  const library = new VoiceLibrary(store);
  app.get('/api/tasks', (req, res) => res.json(taskSummary(store, req.query)));
  app.get('/api/task-scopes', (req, res) => res.json(taskScopes(store, req.query)));
  app.get('/api/voices', (req, res) =>
    res.json(
      library.list({
        folderId: req.query.folderId === undefined ? undefined : String(req.query.folderId) || null,
        search: String(req.query.search || ''),
        favorite: req.query.favorite === '1',
        offset: z.coerce.number().int().nonnegative().default(0).parse(req.query.offset),
        limit: z.coerce.number().int().min(1).max(100).default(25).parse(req.query.limit),
      }),
    ),
  );
  app.get('/api/voice-folders', (req, res) =>
    res.json(library.folders(String(req.query.parentId || '') || null)),
  );
  app.post('/api/voice-folders', (req, res) => res.status(201).json(library.folder(req.body)));
  app.get('/api/voice-folders/:id/path', (req, res) =>
    res.json(library.folderPath(String(req.params.id))),
  );
  app.put('/api/voice-folders/:id', (req, res) =>
    res.json(library.folder(req.body, String(req.params.id))),
  );
  app.delete('/api/voice-folders/:id', (req, res) => {
    library.deleteFolder(
      String(req.params.id),
      z.number().int().positive().parse(req.body.revision),
    );
    res.json({ deleted: true });
  });
  app.get('/api/voices/:id', (req, res) =>
    res.json(
      library.voice(
        String(req.params.id),
        req.query.revision ? Number(req.query.revision) : undefined,
      ),
    ),
  );
  app.post('/api/voices', (req, res) =>
    res
      .status(201)
      .json(
        library.save(
          req.body.data,
          undefined,
          0,
          z.string().min(8).optional().parse(req.body.idempotencyKey),
        ),
      ),
  );
  app.put('/api/voices/:id', (req, res) =>
    res.json(
      library.save(
        req.body.data,
        String(req.params.id),
        z.number().int().positive().parse(req.body.revision),
        z.string().min(8).optional().parse(req.body.idempotencyKey),
      ),
    ),
  );
  app.put('/api/voices/:id/metadata', (req, res) =>
    res.json(library.metadata(String(req.params.id), req.body)),
  );
  app.post('/api/voices/:id/register', (req, res) =>
    res.json(library.register(String(req.params.id), req.body.revision, req.body.handle)),
  );
  app.post('/api/voices/:id/confirm', (req, res) =>
    res.json(library.confirm(String(req.params.id), req.body.revision, req.body.review)),
  );
  app.post('/api/voice-media', upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, '请选择音频文件');
    try {
      res
        .status(201)
        .json(
          await library.importAudio(
            root,
            req.file.path,
            String(req.body.name || req.file.originalname),
            undefined,
            req.file.originalname,
          ),
        );
    } finally {
      await fs.unlink(req.file.path).catch(() => {});
    }
  });
  app.get('/api/voice-media/:id', (req, res) =>
    res.json(library.get(String(req.params.id), Number(req.query.revision) || undefined)),
  );
  app.get('/api/voice-media/:id/file', (req, res) => {
    const media = library.get(
      String(req.params.id),
      z.coerce.number().int().positive().parse(req.query.revision),
    );
    if (media.kind !== 'voice_media') throw new HttpError(400, '不是全局音频');
    res.sendFile(inside(root, media.data.path));
  });
  app.get('/api/speech-allowance', (req, res) => {
    const projectId = String(req.query.projectId || '') || null;
    res.json({
      policy: store.setting(
        projectId ? `speech_allowance:project:${projectId}` : 'speech_allowance:workspace',
        { revision: 0, data: {} },
      ),
      usage: speechUsage(store, projectId),
    });
  });
  app.put('/api/speech-allowance', (req, res) =>
    res.json(saveSpeechAllowance(store, String(req.query.projectId || '') || null, req.body)),
  );
  for (const operation of ['voice_clone', 'speech'] as const) {
    app.post(`/api/${operation}/preview`, (req, res) =>
      res.json(
        prepareSpeech(store, String(req.query.projectId || '') || null, operation, req.body),
      ),
    );
    app.post(`/api/${operation}/submit`, (req, res) =>
      res
        .status(201)
        .json(submitSpeech(store, String(req.query.projectId || '') || null, operation, req.body)),
    );
  }
  app.post('/api/projects/:id/lipsync/preview', (req, res) =>
    res.json(prepareLipSync(store, String(req.params.id), req.body)),
  );
  app.post('/api/projects/:id/lipsync/submit', (req, res) =>
    res.status(201).json(submitLipSync(store, String(req.params.id), req.body)),
  );
  app.post('/api/projects/:id/voice-applications', (req, res) => {
    const data = voiceApplicationSchema.parse(req.body.data),
      domain = new DomainService(store);
    res.status(201).json(domain.save(String(req.params.id), 'voice_profile', data));
  });
  app.post('/api/voice-profiles/:id/conversion-preview', (req, res) => {
    const old = store.get(
      String(req.params.id),
      z.number().int().positive().parse(req.body.revision),
    );
    if (old.kind !== 'voice_profile' || old.data.version !== 1)
      throw new HttpError(400, '需要旧项目声音资料');
    res.json({
      source: { id: old.id, revision: old.revision },
      proposal: {
        name: old.data.name,
        language: old.data.language,
        description: old.data.timbre,
        performance: old.data.performance,
        pronunciation: old.data.pronunciation,
      },
      samples: old.data.samples,
      changes: [
        '新建全局草稿后明确导入样本或登记远端身份',
        '完成试听后选择固定全局版本并新建作品声音应用',
        '旧对白采用、任务与历史证据保留原版本',
      ],
      modifiesHistory: false,
    });
  });
  app.put('/api/episodes/:id/line-production', (req, res) => {
    const body = z
      .object({
        revision: z.number().int().positive(),
        shotId: z.string(),
        lineId: z.string(),
        voiceProfile: z.object({ id: z.string(), revision: z.number().int().positive() }),
        route: z.enum(['native', 'imported', 'tts']),
      })
      .strict()
      .parse(req.body);
    store.transaction(() => {
      const ep = store.get(String(req.params.id)),
        data = structuredClone(ep.data),
        profile = store.get(body.voiceProfile.id, body.voiceProfile.revision);
      const line = data.shots
        ?.find((s: any) => s.id === body.shotId)
        ?.directing?.sound?.dialogue?.find((l: any) => l.id === body.lineId);
      if (
        ep.kind !== 'episode' ||
        !line ||
        profile.kind !== 'voice_profile' ||
        profile.projectId !== ep.projectId ||
        !profile.data.published ||
        profile.data.route !== body.route
      )
        throw new HttpError(400, '台词或声音应用不符');
      const entity = store.get(profile.data.entity.id, profile.data.entity.revision);
      if (!entity.data.instances.some((i: any) => i.id === line.instanceId))
        throw new HttpError(400, '声音角色不属于说话实例');
      line.voiceProfile = body.voiceProfile;
      line.production = body.route;
      line.requireVoiceIdentity = profile.data.requireVoiceIdentity;
      const updated = store.update(ep.id, body.revision, data);
      updateVoiceDependents(store, ep.id);
      res.json(updated);
    });
  });
  app.post('/api/voice-profiles/:id/convert', async (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive(), confirmed: z.literal(true) })
      .strict()
      .parse(req.body);
    res.status(201).json(await library.convertProfile(root, String(req.params.id), body.revision));
  });
  app.post('/api/voices/:id/query', async (req, res) => {
    const voice = library.voice(String(req.params.id), Number(req.body.revision)),
      h = voice.data.handle;
    if (!h) throw new HttpError(400, '尚未登记远端音色');
    const e = new ModelRegistry(store).resolveSelection(
      { connection: h.connection, modelId: h.modelId },
      false,
    );
    if (!isSpeechProtocol(e.protocol)) throw new HttpError(400, '不是语音协议');
    const ctx = speechContext(store, e.connection, e.modelId, crypto.randomUUID(), {
      beforeSubmit() {
        throw new Error('查询不能生成');
      },
      checkpoint: {},
      saveCheckpoint() {},
    });
    const result = await speechAdapters[e.protocol].query(ctx, h.voiceId, {
      operation: 'voice_query',
    });
    store.setSetting(`voice_probe:${generationDigest(voiceHandleIdentity(h))}`, {
      ...result,
      audio: result.audio ? { url: result.audio.url, ext: result.audio.ext } : null,
      at: Date.now(),
    });
    res.json({ ...result, generated: false });
  });
  app.post('/api/speech-jobs/:id/reconcile', async (req, res) => {
    const job = store.job(String(req.params.id)),
      body = z
        .object({
          remoteTaskId: z.string().min(1).max(256),
          inspected: z.literal(true),
          evidence: z.string().min(5),
        })
        .strict()
        .parse(req.body);
    if (job.state !== 'unknown' || !['voice_clone', 'lipsync'].includes(job.kind))
      throw new HttpError(409, '此任务没有可查询的异步身份；保留受理不明记录');
    if (
      store
        .jobs()
        .some(
          (j) =>
            j.id !== job.id &&
            j.output.remoteId === body.remoteTaskId &&
            j.input.modelExecution?.connection.id === job.input.modelExecution.connection.id,
        )
    )
      throw new HttpError(409, '远端身份已绑定其他任务');
    const e = job.input.modelExecution,
      ctx = speechContext(store, e.connection, e.modelId, job.id, {
        beforeSubmit() {
          throw new Error('核对不能生成');
        },
        checkpoint: {},
        saveCheckpoint() {},
      });
    if (job.kind === 'lipsync') {
      const r = await ctx.call('/v2/generate/' + encodeURIComponent(body.remoteTaskId));
      if (r.data?.id !== body.remoteTaskId) throw new HttpError(409, '身份不符');
    } else {
      const protocol: string = e.protocol;
      if (isSpeechProtocol(protocol))
        await speechAdapters[protocol].query(ctx, body.remoteTaskId, job.input);
    }
    if (store.job(job.id).state !== 'unknown') throw new HttpError(409, '任务状态已变化');
    res.json(
      store.patchJob(job.id, {
        state: 'submitted',
        promptId: body.remoteTaskId,
        output: {
          ...store.job(job.id).output,
          remoteId: body.remoteTaskId,
          manualAssociation: { ...body, inputVerifiedByProvider: false, at: Date.now() },
        },
        error: null,
      }),
    );
  });
}
