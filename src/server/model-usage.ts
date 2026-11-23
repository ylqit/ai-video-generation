import type { Store } from './db.js';
import { HttpError } from './db.js';
import { modelAllowanceSchema, modelAvailable, type ModelExecution } from '../shared/models.js';
import { generationDigest } from './h3-guided.js';

export function modelUsage(store: Store, projectId: string) {
  const row = store.db
    .prepare(
      `SELECT count(CASE WHEN kind IN ('creative','media_analysis') THEN 1 END) AS textRequests,
    count(CASE WHEN kind='image' THEN 1 END) AS imageRequests,
    COALESCE(sum(json_extract(input,'$.modelCharge.images')),0) AS images,
    count(CASE WHEN kind='generation' THEN 1 END) AS videoRequests,
    COALESCE(sum(json_extract(input,'$.modelCharge.seconds')),0) AS videoSeconds
    FROM jobs WHERE project_id=? AND json_extract(input,'$.modelCharge') IS NOT NULL`,
    )
    .get(projectId)!;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)]));
}
// Called inside Store.createJob's existing transaction, after idempotency lookup.
export function reserveModelUsage(store: Store, projectId: string, kind: string, input: any) {
  const execution: ModelExecution = input.modelExecution;
  const { digest, ...content } = execution;
  if (digest !== generationDigest(content)) throw new HttpError(400, '模型执行快照摘要不匹配');
  const fixed = store.db
    .prepare('SELECT data FROM model_connection_versions WHERE id=? AND revision=?')
    .get(execution.connection.id, execution.connection.revision);
  if (
    !fixed ||
    generationDigest(JSON.parse(String(fixed.data))) !== generationDigest(execution.connection.data)
  )
    throw new HttpError(409, '执行连接与登记的固定版本不一致');
  if (
    !modelAvailable(execution.connection.data, execution.modelId) ||
    execution.protocol !== execution.connection.data.protocol ||
    execution.capabilities.kind !==
      (['creative', 'media_analysis'].includes(kind)
        ? 'text'
        : kind === 'generation'
          ? 'video'
          : kind)
  )
    throw new HttpError(400, '执行快照与任务种类不匹配');
  const current = store.db
    .prepare('SELECT data FROM model_connections WHERE id=?')
    .get(execution.connection.id);
  if (!current || !modelAvailable(JSON.parse(String(current.data)), execution.modelId))
    throw new HttpError(409, '模型连接已停用');
  const row = store.list('model_execution_config', projectId).find((d) => d.parentId === projectId);
  const allowance = modelAllowanceSchema.parse(row?.data.allowance || {});
  if (
    !allowance.enabled ||
    !allowance.connections.some(
      (r) => r.id === execution.connection.id && r.revision === execution.connection.revision,
    )
  )
    throw new HttpError(409, '请在项目模型设置确认此连接版本与额度');
  const seconds = kind === 'generation' ? Number(input.segment.duration) : 0;
  const images = kind === 'image' ? Number(execution.selection.parameters.n || 1) : 0;
  if (
    (kind === 'generation' && (!Number.isFinite(seconds) || seconds <= 0)) ||
    !Number.isInteger(images)
  )
    throw new HttpError(400, '模型请求用量无效');
  const used = modelUsage(store, projectId);
  if (
    (['creative', 'media_analysis'].includes(kind) &&
      used.textRequests + 1 > allowance.maxTextRequests) ||
    (kind === 'image' &&
      (used.imageRequests + 1 > allowance.maxImageRequests ||
        used.images + images > allowance.maxImages)) ||
    (kind === 'generation' &&
      (used.videoRequests + 1 > allowance.maxVideoRequests ||
        used.videoSeconds + seconds > allowance.maxVideoSeconds))
  )
    throw new HttpError(409, '项目模型额度不足；失败、取消及受理不明请求不自动返还');
  return {
    seconds,
    images,
    policy: { id: row!.id, revision: row!.revision },
    connection: execution.selection.connection,
  };
}
