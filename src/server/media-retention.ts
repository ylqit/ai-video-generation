import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Store, HttpError } from './db.js';
import { inside } from './config.js';
import { hashFile } from './media.js';

export function fileCleared(store: Store, file: string) {
  return !!store.db
    .prepare("SELECT 1 FROM media_file_state WHERE path=? AND status='cleared'")
    .get(file);
}
// Business consumers and historical versions protect files. Derivation indexes and
// diagnostic event logs are provenance, not consumers; they remain after cleanup.
export function cleanupPlan(store: Store, projectId: string) {
  if (store.get(projectId).kind !== 'project') throw new HttpError(400, '不是项目');
  const assets = store.list('asset');
  const documents = store.list();
  const history = store.db.prepare('SELECT id,document FROM revisions').all();
  const jobs = store.db.prepare('SELECT id,input,output FROM jobs').all();
  const other: { name: string; text: string }[] = [];
  for (const table of [
    'dependencies',
    'library_versions',
    'batch_manifests',
    'apply_receipts',
    'proposal_applications',
  ])
    for (const row of store.db.prepare(`SELECT * FROM ${table}`).all())
      other.push({ name: table, text: JSON.stringify(row) });
  const candidates: any[] = [],
    protectedFiles: any[] = [];
  for (const a of assets.filter(
    (a) =>
      a.projectId === projectId &&
      a.data.category === 'review_frame' &&
      a.data.derivedSource &&
      !fileCleared(store, a.data.path),
  )) {
    const siblings = assets.filter(
      (s) => s.data.path === a.data.path || s.data.sha256 === a.data.sha256,
    );
    const ids = new Set(siblings.map((s) => s.id));
    const reasons = new Set<string>();
    if (siblings.some((s) => s.data.category !== 'review_frame' || s.data.adopted))
      reasons.add('文件仍被其他素材用途或采用引用');
    for (const d of documents)
      if (!ids.has(d.id) && [...ids].some((id) => JSON.stringify(d.data).includes(id)))
        reasons.add(`当前 ${d.kind}`);
    for (const r of history)
      if (!ids.has(String(r.id)) && [...ids].some((id) => String(r.document).includes(id)))
        reasons.add('历史版本引用');
    for (const j of jobs)
      if ([...ids].some((id) => String(j.input).includes(id) || String(j.output).includes(id)))
        reasons.add('任务输入或归档回执');
    for (const r of other) if ([...ids].some((id) => r.text.includes(id))) reasons.add(r.name);
    // A historical version can share these bytes without sharing the current path.
    for (const r of history)
      if (!ids.has(String(r.id)) && String(r.document).includes(a.data.sha256))
        reasons.add('历史版本共用文件');
    const item = {
      id: a.id,
      revision: a.revision,
      name: a.data.name,
      path: a.data.path,
      sha256: a.data.sha256,
      bytes: a.data.bytes,
      source: a.data.derivedSource,
      reasons: [...reasons],
    };
    (reasons.size ? protectedFiles : candidates).push(item);
  }
  const unique = [...new Map(candidates.map((a) => [a.path, a])).values()];
  const digest = createHash('sha256').update(JSON.stringify(unique)).digest('hex');
  return {
    projectId,
    digest,
    candidates: unique,
    protected: protectedFiles,
    bytes: unique.reduce((n, a) => n + a.bytes, 0),
  };
}
export async function executeCleanup(
  store: Store,
  root: string,
  projectId: string,
  digest: string,
  batchId: string,
) {
  const existing = store.db
    .prepare('SELECT project_id,manifest FROM media_cleanup_batches WHERE id=?')
    .get(batchId);
  if (existing) {
    const result = JSON.parse(String(existing.manifest));
    if (existing.project_id !== projectId || result.digest !== digest)
      throw new HttpError(409, '清理标识对应另一份清单');
    return result;
  }
  const priorMaintenance = store.setting('maintenance', false);
  store.transaction(() => {
    if (
      store.inFlightMutations > 1 ||
      store.jobs().some((j) => !['succeeded', 'cancelled', 'failed'].includes(j.state))
    )
      throw new HttpError(409, '存在执行任务或其他写入，请稍后清理');
    if (store.setting('media_cleanup_lock', null)) throw new HttpError(409, '已有媒体维护操作');
    store.setSetting('media_cleanup_lock', batchId);
    store.setSetting('media_cleanup_owner', process.pid);
    store.setSetting('media_cleanup_prior_maintenance', priorMaintenance);
    store.setSetting('maintenance', true);
  });
  const result: any = {
    batchId,
    projectId,
    digest,
    files: [],
    releasedBytes: 0,
    backupBytesAdded: 0,
    complete: false,
  };
  try {
    const plan = cleanupPlan(store, projectId);
    if (plan.digest !== digest) throw new HttpError(409, '引用或清理清单已变化，请重新预览');
    const backupRoot = path.resolve(root, '../media-cleanup-backups');
    await fs.mkdir(backupRoot, { recursive: true });
    // Snapshot metadata before any removal; sqlite backup is independent of live WAL files.
    const dbBackup = inside(backupRoot, `${batchId}.sqlite`);
    store.db.prepare('VACUUM INTO ?').run(dbBackup);
    result.databaseBackup = dbBackup;
    store.db
      .prepare('INSERT INTO media_cleanup_batches VALUES(?,?,?,?)')
      .run(batchId, projectId, JSON.stringify(result), Date.now());
    for (const item of plan.candidates) {
      const file = inside(root, item.path),
        backup = inside(backupRoot, `${item.sha256}${path.extname(file)}`);
      const report = { ...item, status: 'pending', error: '', backup };
      result.files.push(report);
      store.db
        .prepare('UPDATE media_cleanup_batches SET manifest=? WHERE id=?')
        .run(JSON.stringify(result), batchId);
      try {
        if ((await hashFile(file)) !== item.sha256) throw new Error('活动文件哈希不匹配');
        try {
          await fs.copyFile(file, backup, 1);
          result.backupBytesAdded += item.bytes;
        } catch (e: any) {
          if (e.code !== 'EEXIST') throw e;
        }
        if ((await hashFile(backup)) !== item.sha256) throw new Error('备份哈希不匹配');
        // Recheck consumers after backup, under the maintenance gate.
        if (!cleanupPlan(store, projectId).candidates.some((a) => a.path === item.path))
          throw new Error('已出现保留引用');
        store.db
          .prepare('INSERT OR REPLACE INTO media_file_state VALUES(?,?,?,?,?,?)')
          .run(item.path, item.sha256, 'clearing', backup, batchId, Date.now());
        await fs.unlink(file);
        store.db
          .prepare("UPDATE media_file_state SET status='cleared',updated_at=? WHERE path=?")
          .run(Date.now(), item.path);
        report.status = 'cleared';
        result.releasedBytes += item.bytes;
      } catch (e: any) {
        report.status = 'failed';
        report.error = e.message;
        // A failed unlink leaves the original available. Reconciliation after a
        // process interruption handles the separate missing-file case.
        if (
          await fs.stat(file).then(
            () => true,
            () => false,
          )
        )
          store.db
            .prepare(
              "UPDATE media_file_state SET status='available' WHERE path=? AND status='clearing'",
            )
            .run(item.path);
      }
      store.db
        .prepare('INSERT OR REPLACE INTO media_cleanup_batches VALUES(?,?,?,?)')
        .run(batchId, projectId, JSON.stringify(result), Date.now());
    }
    result.complete = true;
    store.db
      .prepare('INSERT OR REPLACE INTO media_cleanup_batches VALUES(?,?,?,?)')
      .run(batchId, projectId, JSON.stringify(result), Date.now());
    store.event(null, 'media_cleanup', { projectId, batchId, releasedBytes: result.releasedBytes });
    return result;
  } finally {
    store.setSetting('maintenance', priorMaintenance);
    store.setSetting('media_cleanup_lock', null);
    store.setSetting('media_cleanup_owner', null);
  }
}

// Called before the API starts listening. Reconcile interrupted filesystem work
// using verified bytes, without resuming deletion or creating replacement media.
export async function recoverInterruptedCleanup(store: Store, root: string) {
  const batchId = store.setting<string | null>('media_cleanup_lock', null);
  if (!batchId) return;
  const owner = store.setting<number | null>('media_cleanup_owner', null);
  if (owner) {
    let alive = true;
    try {
      process.kill(owner, 0);
    } catch (e: any) {
      if (e.code === 'ESRCH') alive = false;
      else throw e;
    }
    if (alive) throw new Error('媒体维护进程仍在运行，拒绝接管');
  }
  const entries = store.db.prepare('SELECT * FROM media_file_state WHERE batch_id=?').all(batchId);
  for (const entry of entries) {
    if (entry.status !== 'clearing') continue;
    const file = inside(root, String(entry.path));
    const exists = await fs.stat(file).then(
      () => true,
      (e) => {
        if (e.code === 'ENOENT') return false;
        throw e;
      },
    );
    if ((await hashFile(exists ? file : String(entry.backup))) !== entry.sha256)
      throw new Error(`中断清理的文件哈希不符：${entry.path}`);
    store.db
      .prepare('UPDATE media_file_state SET status=?,updated_at=? WHERE path=?')
      .run(exists ? 'available' : 'cleared', Date.now(), entry.path);
  }
  const batch = store.db
    .prepare('SELECT manifest FROM media_cleanup_batches WHERE id=?')
    .get(batchId);
  if (batch) {
    const result = JSON.parse(String(batch.manifest));
    for (const f of result.files) {
      if (fileCleared(store, f.path)) f.status = 'cleared';
      else if (f.status === 'pending') {
        f.status = 'interrupted';
        f.error = '操作中断，文件未清理';
      }
    }
    result.releasedBytes = result.files
      .filter((f: any) => f.status === 'cleared')
      .reduce((n: number, f: any) => n + f.bytes, 0);
    result.interrupted = true;
    store.db
      .prepare('UPDATE media_cleanup_batches SET manifest=? WHERE id=?')
      .run(JSON.stringify(result), batchId);
  }
  store.transaction(() => {
    store.setSetting('maintenance', store.setting('media_cleanup_prior_maintenance', false));
    store.setSetting('media_cleanup_lock', null);
    store.setSetting('media_cleanup_owner', null);
    store.event(null, 'media_cleanup_recovered', { batchId });
  });
}
export async function restoreMedia(store: Store, root: string, id: string, revision: number) {
  const asset = store.get(id, revision);
  if (asset.kind !== 'asset') throw new HttpError(400, '不是素材');
  const entry = store.db
    .prepare('SELECT * FROM media_file_state WHERE path=?')
    .get(asset.data.path);
  if (!entry || entry.status === 'available') return { restored: false };
  if (store.setting('media_cleanup_lock', null)) throw new HttpError(409, '媒体维护操作尚未结束');
  const dest = inside(root, asset.data.path),
    backupRoot = path.resolve(root, '../media-cleanup-backups');
  // Full workspace backups bundle retained bytes inside the restored directory.
  const backup = path.isAbsolute(String(entry.backup))
    ? inside(backupRoot, path.relative(backupRoot, String(entry.backup)))
    : inside(root, String(entry.backup));
  if ((await hashFile(backup)) !== asset.data.sha256)
    throw new HttpError(409, '备份哈希不符，拒绝恢复为原版本');
  const temp = inside(root, `assets/.restore-${randomUUID()}${path.extname(dest)}`);
  try {
    await fs.copyFile(backup, temp, 1);
    try {
      await fs.link(temp, dest);
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
    }
    if ((await hashFile(dest)) !== asset.data.sha256) throw new HttpError(409, '目标文件哈希冲突');
    store.db
      .prepare("UPDATE media_file_state SET status='available',updated_at=? WHERE path=?")
      .run(Date.now(), asset.data.path);
    store.event(null, 'media_restore', { projectId: asset.projectId, id, revision });
    return { restored: true };
  } finally {
    await fs.unlink(temp).catch((e) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
}
