import { HttpError, type Store } from './db.js';
import { speechAllowanceSchema } from '../shared/speech.js';
import { modelAvailable, type ModelExecution } from '../shared/models.js';
import { generationDigest } from './h3-guided.js';

export function speechUsage(store: Store, projectId: string | null) {
  return store.db
    .prepare(
      `SELECT
    count(CASE WHEN kind='voice_clone' THEN 1 END) voiceCreations,
    count(CASE WHEN kind='speech' THEN 1 END) speechRequests,
    COALESCE(sum(json_extract(input,'$.speechCharge.characters')),0) speechCharacters,
    count(CASE WHEN kind='lipsync' THEN 1 END) lipSyncRequests,
    COALESCE(sum(CASE WHEN kind='lipsync' THEN json_extract(input,'$.speechCharge.seconds') END),0) lipSyncSeconds,
    count(CASE WHEN kind='transcription' THEN 1 END) transcriptionRequests,
    COALESCE(sum(CASE WHEN kind='transcription' THEN json_extract(input,'$.speechCharge.seconds') END),0) transcriptionSeconds
    FROM jobs WHERE project_id IS ? AND json_extract(input,'$.speechCharge') IS NOT NULL`,
    )
    .get(projectId) as Record<string, number>;
}
export function saveSpeechAllowance(store: Store, projectId: string | null, raw: any) {
  const data = speechAllowanceSchema.parse(raw.data);
  if (projectId && store.get(projectId).kind !== 'project') throw new HttpError(400, '需要作品');
  for (const ref of data.connections) {
    const row = store.db
      .prepare('SELECT data FROM model_connection_versions WHERE id=? AND revision=?')
      .get(ref.id, ref.revision);
    if (!row) throw new HttpError(400, '额度引用的固定连接不存在');
  }
  return store.transaction(() => {
    const key = projectId ? `speech_allowance:project:${projectId}` : 'speech_allowance:workspace';
    const old = store.setting<any>(key, { revision: 0 });
    if (old.revision !== raw.revision) throw new HttpError(409, '额度版本已变化');
    const next = { revision: old.revision + 1, data };
    store.setSetting(key, next);
    return next;
  });
}
export function reserveSpeechUsage(
  store: Store,
  projectId: string | null,
  kind: string,
  input: any,
) {
  const execution: ModelExecution = input.modelExecution;
  const { digest, ...content } = execution;
  if (digest !== generationDigest(content)) throw new HttpError(400, '执行快照不一致');
  const fixed = store.db
    .prepare('SELECT data FROM model_connection_versions WHERE id=? AND revision=?')
    .get(execution.connection.id, execution.connection.revision);
  const current = store.db
    .prepare('SELECT data FROM model_connections WHERE id=?')
    .get(execution.connection.id);
  if (
    !fixed ||
    generationDigest(JSON.parse(String(fixed.data))) !==
      generationDigest(execution.connection.data) ||
    !current ||
    !modelAvailable(JSON.parse(String(current.data)), execution.modelId) ||
    !modelAvailable(execution.connection.data, execution.modelId)
  )
    throw new HttpError(409, '固定连接不匹配或模型已停用');
  if (
    kind === 'transcription'
      ? execution.protocol !== 'tencent-asr'
      : kind === 'lipsync'
        ? execution.protocol !== 'sync-lipsync'
        : execution.capabilities.kind !== 'speech'
  )
    throw new HttpError(400, '操作与协议不匹配');
  const policy = store.setting<any>(
    projectId ? `speech_allowance:project:${projectId}` : 'speech_allowance:workspace',
    { revision: 0, data: {} },
  );
  const a = speechAllowanceSchema.parse(policy.data);
  if (
    !a.enabled ||
    !a.connections.some(
      (r) => r.id === execution.connection.id && r.revision === execution.connection.revision,
    )
  )
    throw new HttpError(409, '请明确此归属的声音连接版本与额度');
  const characters = kind === 'speech' ? Array.from(input.text as string).length : 0;
  const seconds =
    kind === 'transcription'
      ? input.nodeOperation.end - input.nodeOperation.start
      : kind === 'lipsync'
        ? (input.range.outFrame - input.range.inFrame) / 24
        : 0;
  const used = speechUsage(store, projectId);
  if (
    (kind === 'transcription' &&
      (!Number.isFinite(seconds) ||
        seconds <= 0 ||
        used.transcriptionRequests + 1 > a.maxTranscriptionRequests ||
        used.transcriptionSeconds + seconds > a.maxTranscriptionSeconds)) ||
    (kind === 'voice_clone' && used.voiceCreations + 1 > a.maxVoiceCreations) ||
    (kind === 'speech' &&
      (used.speechRequests + 1 > a.maxSpeechRequests ||
        used.speechCharacters + characters > a.maxSpeechCharacters)) ||
    (kind === 'lipsync' &&
      (used.lipSyncRequests + 1 > a.maxLipSyncRequests ||
        used.lipSyncSeconds + seconds > a.maxLipSyncSeconds))
  )
    throw new HttpError(409, '此归属的声音额度不足；失败、取消、受理不明不自动返还');
  return {
    policyRevision: policy.revision,
    owner: projectId ? { projectId } : { workspace: true },
    characters,
    seconds,
    estimatedCost: null,
    connection: execution.selection.connection,
  };
}
