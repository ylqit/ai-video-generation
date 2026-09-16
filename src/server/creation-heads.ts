import { Store, HttpError } from './db.js';
import type { RecordDoc } from '../shared/contracts.js';

export function productionHead(store: Store, episodeId: string) {
  const saved = store.db
    .prepare('SELECT run_id,revision FROM creation_heads WHERE episode_id=?')
    .get(episodeId);
  if (saved)
    return { runId: String(saved.run_id), revision: Number(saved.revision), conflict: false };
  const runs = store.db
    .prepare(
      "SELECT id FROM documents WHERE kind='creation_run' AND json_extract(data,'$.episodeId')=? AND COALESCE(json_extract(data,'$.archived'),0)=0",
    )
    .all(episodeId);
  return {
    runId: runs.length === 1 ? String(runs[0].id) : null,
    revision: 0,
    conflict: runs.length > 1,
  };
}

export function assertProductionHead(store: Store, run: RecordDoc) {
  const head = productionHead(store, run.data.episodeId);
  if (head.conflict || head.runId !== run.id)
    throw new HttpError(409, '此运行不是当前制作头，请在完成前置确认后显式激活');
}

export function activateProductionHead(
  store: Store,
  run: RecordDoc,
  expected: number,
  previous: string | null,
) {
  return store.transaction(() => {
    const head = productionHead(store, run.data.episodeId);
    if (head.revision !== expected || head.runId !== previous)
      throw new HttpError(409, '当前制作头已变化，请刷新');
    const pending = store.db
      .prepare(
        "SELECT id FROM jobs WHERE episode_id=? AND (state NOT IN ('succeeded','failed','cancelled') OR json_extract(output,'$.waitSuspended')=1 OR (state='failed' AND kind='generation' AND json_extract(output,'$.descriptor') IS NOT NULL)) LIMIT 1",
      )
      .get(run.data.episodeId);
    if (pending) throw new HttpError(409, '分集仍有活动、受理不明或待归档作业，请先处理');
    store.db
      .prepare(
        'INSERT INTO creation_heads(episode_id,run_id,revision) VALUES(?,?,?) ON CONFLICT(episode_id) DO UPDATE SET run_id=excluded.run_id,revision=excluded.revision',
      )
      .run(run.data.episodeId, run.id, expected + 1);
    return productionHead(store, run.data.episodeId);
  });
}
