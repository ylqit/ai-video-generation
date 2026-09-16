import { randomUUID } from 'node:crypto';
import { Store, HttpError } from './db.js';
import { batchDraftSchema } from '../shared/workbench.js';
import { ReadinessService } from './readiness.js';
import { generationDigest } from './h3-guided.js';

export class BatchService {
  constructor(public store: Store) {}
  get(id: string) {
    const row = this.store.db.prepare('SELECT * FROM work_batches WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '批次不存在');
    const items = this.store.db
      .prepare('SELECT * FROM batch_items WHERE batch_id=? ORDER BY position')
      .all(id)
      .map((r) => ({
        ...r,
        item_id: String(r.item_id),
        job_id: r.job_id === null ? null : String(r.job_id),
        job: r.job_id ? this.store.job(String(r.job_id)) : null,
      }));
    const jobs = items.flatMap((i) => (i.job ? [i.job] : []));
    const displayState = jobs.some((j) => j.state === 'unknown')
      ? '待核对'
      : jobs.some((j) => j.state === 'failed')
        ? '需处理失败'
        : jobs.length && jobs.every((j) => ['succeeded', 'cancelled'].includes(j.state))
          ? '已完成'
          : row.state === 'paused'
            ? '已暂停'
            : jobs.some((j) => j.holdReason)
              ? '待复核'
              : jobs.length
                ? '执行中'
                : '草稿';
    return {
      ...row,
      id: String(row.id),
      name: String(row.name),
      state: String(row.state),
      revision: Number(row.revision),
      displayState,
      draft: JSON.parse(String(row.draft)),
      items,
    };
  }
  save(raw: unknown, id?: string, revision?: number) {
    const data = batchDraftSchema.parse(raw);
    if (new Set(data.items.map((i) => i.id)).size !== data.items.length)
      throw new HttpError(400, '批次条目标识重复');
    for (const item of data.items) {
      const ep = this.store.get(item.episodeId);
      if (ep.kind !== 'episode') throw new HttpError(400, '条目必须引用分集');
      if (item.retryOf && this.store.job(item.retryOf).projectId !== ep.projectId)
        throw new HttpError(400, '重做来源不属于项目');
    }
    return this.store.transaction(() => {
      const old = id ? this.get(id) : null;
      if (old && (old.state !== 'draft' || old.revision !== revision))
        throw new HttpError(409, '只有当前草稿版本可修改；已确认批次请新建');
      const key = id || randomUUID(),
        now = Date.now();
      if (old)
        this.store.db
          .prepare(
            'UPDATE work_batches SET revision=revision+1,name=?,draft=?,updated_at=? WHERE id=?',
          )
          .run(data.name, JSON.stringify(data), now, key);
      else
        this.store.db
          .prepare('INSERT INTO work_batches VALUES(?,?,?,?,?,?,?,?)')
          .run(key, 1, data.name, 'draft', JSON.stringify(data), null, now, now);
      this.store.event(null, 'batch', { id: key });
      return this.get(key);
    });
  }
  preview(id: string) {
    const batch = this.get(id),
      readiness = new ReadinessService(this.store),
      profile = this.store.setting('comfy', null as any);
    const included: any[] = [],
      excluded: any[] = [];
    for (const entry of batch.draft.items) {
      if (!entry.enabled || entry.waitingFor) {
        excluded.push({ entry, reason: entry.waitingFor || '未选择' });
        continue;
      }
      try {
        const prepared = readiness.generation(entry, profile);
        included.push({ entry, ...prepared });
      } catch (e: any) {
        excluded.push({ entry, reason: e.message });
      }
    }
    const manifest = {
      batchId: id,
      revision: batch.revision,
      included,
      excluded,
      count: included.length,
      requestedSeconds: included.reduce((n, v) => n + v.input.segment.duration, 0),
      estimatedGpuSeconds: null,
    };
    return { ...manifest, digest: generationDigest(manifest), uploaded: false, submitted: false };
  }
  confirm(id: string, revision: number, digest: string, key: string) {
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT id FROM work_batches WHERE confirmation_key=?')
        .get(key);
      if (prior) {
        if (prior.id !== id) throw new HttpError(409, '幂等键属于其他批次');
        const receipt = this.store.db
          .prepare('SELECT digest FROM batch_manifests WHERE batch_id=? AND revision=?')
          .get(id, revision);
        if (receipt?.digest !== digest) throw new HttpError(409, '幂等键输入不同');
        return this.get(id);
      }
      const batch = this.get(id);
      if (batch.state !== 'draft' || batch.revision !== revision)
        throw new HttpError(409, '批次版本已变化');
      const preview = this.preview(id);
      if (preview.digest !== digest) throw new HttpError(409, '输入或审核依据变化，请重新预览整批');
      if (!preview.count) throw new HttpError(400, '没有可执行条目');
      this.store.db
        .prepare('INSERT INTO batch_manifests VALUES(?,?,?,?)')
        .run(id, revision, digest, JSON.stringify(preview));
      for (const [position, item] of preview.included.entries()) {
        const input = {
          ...item.input,
          previewDigest: item.digest,
          ...(item.entry.retryOf ? { retryOf: item.entry.retryOf } : {}),
        };
        const job = this.store.createJob(
          'generation',
          item.projectId,
          item.entry.episodeId,
          input,
          `batch:${id}:${item.entry.id}`,
        );
        this.store.db
          .prepare('UPDATE jobs SET batch_id=?,batch_item_id=? WHERE id=?')
          .run(id, item.entry.id, job.id);
        this.store.db
          .prepare('INSERT INTO batch_items VALUES(?,?,?,?)')
          .run(id, item.entry.id, position, job.id);
      }
      this.store.db
        .prepare(
          "UPDATE work_batches SET state='confirmed',confirmation_key=?,updated_at=? WHERE id=?",
        )
        .run(key, Date.now(), id);
      this.store.event(null, 'batch', { id });
      return this.get(id);
    });
  }
  control(id: string, action: 'pause' | 'resume' | 'cancel') {
    return this.store.transaction(() => {
      const batch = this.get(id);
      if (batch.state === 'draft' || batch.state === 'cancelled')
        throw new HttpError(409, '批次尚未确认或已经取消');
      for (const item of batch.items) {
        const job = item.job!;
        if (action === 'pause' && job.state === 'queued')
          this.store.patchJob(job.id, { holdReason: job.holdReason || 'batch_paused' });
        else if (action === 'resume' && job.holdReason === 'batch_paused')
          this.store.patchJob(job.id, { holdReason: null });
        else if (action === 'cancel' && !['succeeded', 'failed', 'cancelled'].includes(job.state))
          this.store.patchJob(job.id, {
            cancelRequested: true,
            ...(job.state === 'queued' ? { state: 'cancelled' as const } : {}),
            holdReason: null,
          });
      }
      this.store.db
        .prepare('UPDATE work_batches SET state=?,updated_at=? WHERE id=?')
        .run(
          action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'confirmed',
          Date.now(),
          id,
        );
      this.store.event(null, 'batch', { id });
      return this.get(id);
    });
  }
}
