import type { Express } from 'express';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { ModelRegistry } from './model-registry.js';
import {
  modelCapabilities,
  modelProtocols,
  promptProfiles,
  protocolLabels,
} from '../shared/models.js';
import { protectCredential, resolveCredential } from './model-credentials.js';
import { modelRequest } from './model-http.js';
import { modelUsage } from './model-usage.js';
import { ComfyClient } from './comfy.js';
import { codexExecutable } from './codex.js';
import { prepareImageTask, submitImageTask } from './image-production.js';
import { imageTaskBasis } from './image-preparation.js';
import { inside } from './config.js';
import { hashFile } from './media.js';
import { isSpeechProtocol } from '../shared/speech.js';
import { speechContext } from './speech-transport.js';

export function registerModelRoutes(app: Express, store: Store, root: string) {
  const registry = new ModelRegistry(store);
  app.get('/api/model-catalog', (_req, res) => res.json(registry.catalog()));
  app.get('/api/model-connection-saves/:key', (req, res) => {
    const key = z.string().min(8).max(160).parse(req.params.key);
    const receipt = store.setting<any>(`model_connection_save:${key}`, null);
    res.json({ connection: receipt ? registry.connection(receipt.id, receipt.revision) : null });
  });
  app.get('/api/model-connections', (_req, res) =>
    res.json({
      connections: registry.connections().map((c) => ({
        ...c,
        currentlyEnabled: c.data.enabled,
        models: c.data.models.map((m) => ({
          ...m,
          capabilities: modelCapabilities(m.preset, m.imageInput),
        })),
        probe: store.setting(`model_probe:${c.id}:${c.revision}`, null),
        executionEvidence: store.db
          .prepare(
            "SELECT count(*) attempts, count(CASE WHEN state='succeeded' THEN 1 END) completed FROM jobs WHERE json_extract(input,'$.modelExecution.connection.id')=? AND json_extract(input,'$.modelExecution.connection.revision')=?",
          )
          .get(c.id, c.revision),
      })),
      protocols: modelProtocols.map((id) => ({ id, name: protocolLabels[id] })),
      promptProfiles,
      legacyComfy: store.setting('comfy', null),
    }),
  );
  app.post('/api/model-connections', (req, res) =>
    res.status(201).json(registry.saveConnection(req.body)),
  );
  app.put('/api/model-connections/:id', (req, res) =>
    res.json(registry.saveConnection(req.body, String(req.params.id))),
  );
  app.get('/api/model-connections/:id/versions/:revision', (req, res) => {
    const c = registry.connection(
      String(req.params.id),
      z.coerce.number().int().positive().parse(req.params.revision),
    );
    res.json({
      ...c,
      currentlyEnabled: registry.connection(c.id).data.enabled,
      models: c.data.models.map((m) => ({
        ...m,
        capabilities: modelCapabilities(m.preset, m.imageInput),
      })),
    });
  });
  app.post('/api/model-credentials', async (req, res) => {
    const body = z
      .object({ secret: z.string().min(1).max(16384) })
      .strict()
      .parse(req.body);
    res.status(201).json(await protectCredential(store, body.secret));
  });
  app.post('/api/model-connections/:id/probe', async (req, res) => {
    const connection = registry.connection(
      String(req.params.id),
      z.number().int().positive().parse(req.body.revision),
    );
    const protocol = connection.data.protocol;
    let probe: any;
    try {
      if (protocol === 'comfy-h3')
        probe = {
          status: 'capabilities_observed',
          discovery: await new ComfyClient(connection.data.baseUrl).discover(),
        };
      else if (protocol === 'codex') {
        await resolveCredential(store, connection.data.credential);
        const executable = codexExecutable();
        if (executable.includes('/') || executable.includes('\\')) await fs.access(executable);
        probe = {
          status: 'local_configuration_checked',
          message: '本机执行文件及凭据引用可读取；未调用模型',
        };
      } else if (isSpeechProtocol(protocol) || protocol === 'tencent-asr') {
        if (['tencent-speech', 'tencent-asr'].includes(protocol)) {
          await resolveCredential(store, connection.data.credentials!.secretId);
          await resolveCredential(store, connection.data.credentials!.secretKey);
        } else await resolveCredential(store, connection.data.credential);
        probe = {
          status: 'local_configuration_checked',
          message: '凭据引用可读取；请在音色中查询具体远端身份。未合成、未训练。',
        };
      } else if (protocol === 'sync-lipsync') {
        const ctx = speechContext(
          store,
          connection,
          connection.data.models[0].id,
          crypto.randomUUID(),
          {
            checkpoint: {},
            beforeSubmit() {
              throw new Error('只读探测不能生成');
            },
            saveCheckpoint() {
              throw new Error('只读探测不保存执行回执');
            },
          },
        );
        const result = await ctx.call('/v2/models');
        probe = { status: 'capabilities_observed', models: result.data, generated: false };
      } else {
        const result = await modelRequest(
          store,
          connection,
          protocol === 'minimax-video' ? '/v1/models' : '/models',
        );
        const list = result.data.data || result.data.models || [];
        probe = {
          status: 'connection_observed',
          modelIds: Array.isArray(list)
            ? list
                .map((m: any) => m.id)
                .filter((v: any) => typeof v === 'string')
                .slice(0, 1000)
            : [],
          requestId: result.requestId,
          message: '只读连接检查；模型清单不能证明生成模式可用',
        };
      }
    } catch (error: any) {
      probe = { status: 'unverified', message: error.message };
    }
    const saved = {
      ...probe,
      at: Date.now(),
      generated: false,
      connection: { id: connection.id, revision: connection.revision },
    };
    store.setSetting(`model_probe:${connection.id}:${connection.revision}`, saved);
    res.json(saved);
  });
  app.get('/api/projects/:id/model-config', (req, res) => {
    const projectId = String(req.params.id);
    const ownerId = String(req.query.ownerId || projectId);
    const pinned = store
      .list('model_execution_config', projectId)
      .flatMap((c) => [
        ...Object.values(c.data.slots).map((s: any) => s.connection),
        ...(c.data.allowance?.connections || []),
      ]);
    res.json({
      config: registry.config(projectId, ownerId),
      pinnedConnections: pinned,
      usage: modelUsage(store, projectId),
      owners: [
        store.get(projectId),
        ...store.list('series', projectId),
        ...store.list('episode', projectId),
      ].map((d) => ({
        id: d.id,
        kind: d.kind,
        name: d.data.title || d.data.name,
        seriesId: d.data.seriesId,
      })),
      segments: registry.groups(projectId, ownerId),
    });
  });
  app.put('/api/projects/:id/model-config', (req, res) =>
    res.json(
      registry.saveConfig(
        String(req.params.id),
        z.string().parse(req.query.ownerId || req.params.id),
        req.body,
      ),
    ),
  );
  app.get('/api/projects/:id/model-capabilities', (req, res) => {
    const kind = z.enum(['text', 'image', 'video']).parse(req.query.kind);
    res.json(
      registry.resolve(
        String(req.params.id),
        req.query.episodeId ? String(req.query.episodeId) : null,
        kind,
        req.query.detail ? String(req.query.detail) : undefined,
      ),
    );
  });
  app.get('/api/prompt-profiles', (_req, res) => res.json(promptProfiles));
  app.get('/api/asset-tasks/:id/preparation', (req, res) => {
    const task = store.get(String(req.params.id));
    if (task.kind !== 'asset_task') throw new HttpError(400, '需要素材任务');
    res.json(imageTaskBasis(store, task, String(req.query.viewId || task.data.views[0]?.id)));
  });
  app.post('/api/asset-tasks/:id/model-preview', async (req, res) => {
    const prepared = prepareImageTask(store, String(req.params.id), req.body);
    for (const entry of prepared.input.assets)
      if ((await hashFile(inside(root, entry.asset.data.path))) !== entry.asset.data.sha256)
        throw new HttpError(409, '固定图片内容已变化');
    res.json({
      ...prepared,
      validation: { uploaded: false, submitted: false, verification: 'offline_contract' },
    });
  });
  app.post('/api/asset-tasks/:id/model-generate', (req, res) =>
    res.status(201).json(submitImageTask(store, String(req.params.id), req.body)),
  );
}
