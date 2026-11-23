import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';
import { productionHead } from './creation-heads.js';
import { catalogOffers } from '../shared/model-catalog.js';
import { modelParameterFields } from '../shared/model-parameters.js';
import {
  connectionDataSchema,
  executionConfigSchema,
  executionSelectionSchema,
  modelCapabilities,
  promptProfiles,
  modelAvailable,
  type ModelConnection,
  type ModelExecution,
} from '../shared/models.js';

export class ModelRegistry {
  constructor(public store: Store) {}
  catalog() {
    const offers = catalogOffers();
    return {
      offers,
      models: this.connections().flatMap((connection) =>
        connection.data.models.map((model) => {
          const offer = offers.find((o) => o.protocol === connection.data.protocol)!;
          return {
            ...model,
            kind: offer.kind,
            family: offer.family,
            familyName: offer.name,
            connection: {
              id: connection.id,
              revision: connection.revision,
              name: connection.data.name,
            },
            protocol: connection.data.protocol,
            enabled: model.enabled !== false,
            available: modelAvailable(connection.data, model.id),
            capabilities: modelCapabilities(model.preset, model.imageInput),
            parameterFields: modelParameterFields(
              connection.data.protocol,
              modelCapabilities(model.preset, model.imageInput),
            ),
            promptProfiles: offer.promptProfiles,
            probe: this.store.setting(`model_probe:${connection.id}:${connection.revision}`, null),
            executionEvidence: this.store.db
              .prepare(
                "SELECT count(*) attempts, count(CASE WHEN state='succeeded' THEN 1 END) completed FROM jobs WHERE json_extract(input,'$.modelExecution.connection.id')=? AND json_extract(input,'$.modelExecution.connection.revision')=? AND json_extract(input,'$.modelExecution.modelId')=?",
              )
              .get(connection.id, connection.revision, model.id),
          };
        }),
      ),
    };
  }
  connections(): ModelConnection[] {
    return this.store.db
      .prepare('SELECT * FROM model_connections ORDER BY created_at,id')
      .all()
      .map((r) => ({
        id: String(r.id),
        revision: Number(r.revision),
        data: JSON.parse(String(r.data)),
        createdAt: Number(r.created_at),
      }));
  }
  connection(id: string, revision?: number): ModelConnection {
    const row =
      revision === undefined
        ? this.store.db.prepare('SELECT * FROM model_connections WHERE id=?').get(id)
        : this.store.db
            .prepare('SELECT * FROM model_connection_versions WHERE id=? AND revision=?')
            .get(id, revision);
    if (!row) throw new HttpError(404, '固定模型连接版本不存在');
    return {
      id,
      revision: Number(row.revision),
      data: connectionDataSchema.parse(JSON.parse(String(row.data))),
      createdAt: Number(row.created_at),
    };
  }
  saveConnection(raw: unknown, id?: string) {
    const body = z
      .object({
        revision: z.number().int().nonnegative(),
        data: connectionDataSchema,
        idempotencyKey: z.string().min(8).max(160).optional(),
      })
      .strict()
      .parse(raw);
    const data = body.data;
    const host = new URL(data.baseUrl).hostname;
    const speechHosts: Record<string, string[]> = {
      'minimax-speech': ['api.minimax.io', 'api.minimaxi.com'],
      cosyvoice: [
        'dashscope.aliyuncs.com',
        'dashscope-intl.aliyuncs.com',
        'dashscope-us.aliyuncs.com',
      ],
      'doubao-speech': ['openspeech.bytedance.com'],
      'baidu-speech': ['aip.baidubce.com'],
      'tencent-speech': ['vrs.tencentcloudapi.com'],
      'tencent-asr': ['asr.cloud.tencent.com'],
      'sync-lipsync': ['api.sync.so'],
    };
    const official = speechHosts[data.protocol]
      ? speechHosts[data.protocol].includes(host) &&
        (!data.ttsBaseUrl || new URL(data.ttsBaseUrl).hostname === 'tts.tencentcloudapi.com')
      : data.protocol === 'minimax-video'
        ? ['api.minimax.io', 'api.minimaxi.com'].includes(host)
        : data.protocol === 'ark-video'
          ? host.endsWith('.volces.com')
          : ['responses', 'chat-completions', 'openai-images'].includes(data.protocol)
            ? host === 'api.openai.com'
            : true;
    if (data.enabled && !official && !data.compatible)
      throw new HttpError(400, '自定义服务需明确确认协议兼容；配置确认不等于真实生成验证');
    return this.store.transaction(() => {
      const receiptKey = body.idempotencyKey && `model_connection_save:${body.idempotencyKey}`;
      const receipt = receiptKey ? this.store.setting<any>(receiptKey, null) : null;
      const digest = generationDigest({ id: id || null, revision: body.revision, data });
      if (receipt) {
        if (receipt.digest !== digest)
          throw new HttpError(409, '保存回执与本次内容不同，请核对已保存版本');
        return this.connection(receipt.id, receipt.revision);
      }
      const old = id ? this.connection(id) : null;
      if ((old?.revision || 0) !== body.revision)
        throw new HttpError(409, '连接已变化，请比较后重新保存');
      const next = {
        id: id || randomUUID(),
        revision: body.revision + 1,
        data,
        createdAt: old?.createdAt || Date.now(),
      };
      this.store.db
        .prepare('INSERT INTO model_connection_versions VALUES(?,?,?,?)')
        .run(next.id, next.revision, JSON.stringify(data), next.createdAt);
      this.store.db
        .prepare(
          'INSERT INTO model_connections VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,data=excluded.data',
        )
        .run(next.id, next.revision, JSON.stringify(data), next.createdAt);
      this.store.event(null, 'model_connection_saved', {
        id: next.id,
        revision: next.revision,
        enabled: data.enabled,
      });
      if (receiptKey)
        this.store.setSetting(receiptKey, { id: next.id, revision: next.revision, digest });
      return next;
    });
  }
  config(projectId: string, ownerId = projectId) {
    this.owner(projectId, ownerId);
    return (
      this.store.list('model_execution_config', projectId).find((d) => d.parentId === ownerId) ||
      null
    );
  }
  owner(projectId: string, ownerId: string) {
    const project = this.store.get(projectId);
    const owner = this.store.get(ownerId);
    if (
      project.kind !== 'project' ||
      (owner.id !== projectId && owner.projectId !== projectId) ||
      !['project', 'series', 'episode'].includes(owner.kind)
    )
      throw new HttpError(400, '模型配置归属不匹配');
    return owner;
  }
  groups(projectId: string, ownerId: string) {
    const owner = this.owner(projectId, ownerId);
    if (owner.kind !== 'episode') return [];
    const head = productionHead(this.store, owner.id);
    if (head.conflict) throw new HttpError(409, '请先明确当前分集制作头，再选择生成组模型');
    const run = head.runId ? this.store.get(head.runId) : null;
    const adopted = run?.data.results?.director;
    return adopted
      ? this.store.get(adopted.id, adopted.revision).data.result.groups
      : owner.data.segments || [];
  }
  saveConfig(projectId: string, ownerId: string, raw: unknown) {
    const owner = this.owner(projectId, ownerId);
    const body = z
      .object({ revision: z.number().int().nonnegative(), data: executionConfigSchema })
      .strict()
      .parse(raw);
    if (ownerId !== projectId && body.data.allowance)
      throw new HttpError(400, '模型额度由项目统一管理');
    for (const [slot, selection] of Object.entries(body.data.slots)) {
      const resolved = this.resolveSelection(selection, false);
      if (
        !slot.startsWith(
          resolved.protocol === 'sync-lipsync' ? 'lipsync' : resolved.capabilities.kind,
        )
      )
        throw new HttpError(400, '模型种类与用途不匹配：' + slot);
      if (slot.startsWith('video:') && owner.kind !== 'episode')
        throw new HttpError(400, '生成组覆盖必须保存在所属分集');
      if (
        slot.startsWith('video:') &&
        !this.groups(projectId, ownerId).some((s: any) => s.id === slot.slice(6))
      )
        throw new HttpError(400, '生成组不属于当前分集');
    }
    for (const ref of body.data.allowance?.connections || []) this.connection(ref.id, ref.revision);
    return this.store.transaction(() => {
      const old = this.config(projectId, ownerId);
      if ((old?.revision || 0) !== body.revision)
        throw new HttpError(409, '执行配置已变化，请重新读取');
      return old
        ? this.store.update(old.id, body.revision, body.data)
        : this.store.create('model_execution_config', projectId, body.data, ownerId);
    });
  }
  resolveSelection(raw: unknown, requireEnabled = true): ModelExecution {
    const selection = executionSelectionSchema.parse(raw);
    const connection = this.connection(selection.connection.id, selection.connection.revision);
    const current = this.connection(connection.id);
    if (requireEnabled && !modelAvailable(current.data, selection.modelId))
      throw new HttpError(409, '模型或连接已停用／移除；已受理任务仍可恢复归档');
    const model = connection.data.models.find((m) => m.id === selection.modelId);
    if (!model) throw new HttpError(400, '模型不属于固定连接版本');
    if (requireEnabled && model.enabled === false)
      throw new HttpError(409, '所选固定版本未启用此模型，请明确选择已启用版本');
    const capabilities = modelCapabilities(model.preset, model.imageInput);
    if (
      selection.promptProfile !== 'automatic' &&
      !promptProfiles.some((p) => p.id === selection.promptProfile && p.family === model.preset)
    )
      throw new HttpError(400, 'Prompt 方案与模型不匹配');
    if (connection.data.protocol === 'codex' && Object.keys(selection.parameters).length)
      throw new HttpError(400, 'Codex CLI 当前仅固定模型与连接，不支持这些 API 参数');
    const allowed = modelParameterFields(connection.data.protocol, capabilities).map((f) => f.key);
    for (const key of Object.keys(selection.parameters))
      if (!allowed.includes(key)) throw new HttpError(400, '当前模型不支持参数：' + key);
    const p = selection.parameters;
    for (const [key, values] of [
      ['resolution', capabilities.resolutions],
      ['ratio', capabilities.ratios],
      ['size', capabilities.sizes],
      ['quality', capabilities.qualities],
    ] as const)
      if (p[key] && !values?.includes(p[key]!))
        throw new HttpError(400, '模型不支持参数值：' + key);
    const snapshot = {
      version: 1 as const,
      connection,
      modelId: model.id,
      protocol: connection.data.protocol,
      adapterVersion: connection.data.protocol + '-v1',
      selection,
      capabilities,
      dependencies: [],
      promptProfile: selection.promptProfile,
    };
    return { ...snapshot, digest: generationDigest(snapshot) };
  }
  resolve(
    projectId: string,
    episodeId: string | null,
    kind: 'text' | 'image' | 'video' | 'speech' | 'lipsync',
    detail?: string,
    requireEnabled = true,
  ): ModelExecution | null {
    const owners = [projectId];
    if (episodeId) {
      const ep = this.owner(projectId, episodeId);
      if (ep.kind !== 'episode' && !(ep.kind === 'series' && kind === 'text'))
        throw new HttpError(400, '需要明确分集；系列只允许整季文字准备');
      if (ep.data.seriesId) {
        this.owner(projectId, ep.data.seriesId);
        owners.push(ep.data.seriesId);
      }
      owners.push(ep.id);
    }
    let chosen: { selection: unknown; config: any } | undefined;
    for (const owner of owners) {
      const config = this.config(projectId, owner);
      if (!config) continue;
      const selection =
        (detail && config.data.slots[kind + ':' + detail]) || config.data.slots[kind];
      if (selection) chosen = { selection, config };
    }
    if (!chosen) return null;
    const result = this.resolveSelection(chosen.selection, requireEnabled);
    if ((result.protocol === 'sync-lipsync' ? 'lipsync' : result.capabilities.kind) !== kind)
      throw new HttpError(400, '执行模型种类不匹配');
    result.dependencies = [{ id: chosen.config.id, revision: chosen.config.revision }];
    const { digest: _digest, ...content } = result;
    return { ...content, digest: generationDigest(content) };
  }
}
