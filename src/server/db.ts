import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { migrateDatabase } from './migrations.js';
import type { Kind, RecordDoc, Job, JobState } from '../shared/contracts.js';
import { creationSettingsSchema } from '../shared/creation.js';
import { createHash } from 'node:crypto';
import { reserveModelUsage } from './model-usage.js';
import { reserveSpeechUsage } from './speech-usage.js';
import { reserveAssistantUsage } from './assistant-usage.js';
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export class Store {
  db: DatabaseSync;
  // A worker connection must still own the lease when committing business state.
  // API connections leave this unset and only enqueue or review records.
  writeLeaseOwner: string | null = null;
  inFlightMutations = 0;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    try {
      migrateDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  transaction<T>(fn: () => T): T {
    if (this.db.isTransaction) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.writeLeaseOwner) {
        if (this.setting('media_cleanup_lock', null))
          throw new HttpError(503, '媒体维护中，Worker 暂停写入');
        const lease = this.db
          .prepare('SELECT owner,expires FROM leases WHERE name=?')
          .get('worker');
        if (lease?.owner !== this.writeLeaseOwner || Number(lease.expires) <= Date.now())
          throw new Error('Worker 已失去租约，拒绝提交过期进程的状态');
      }
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  decode(row: any): RecordDoc {
    return {
      id: row.id,
      kind: row.kind,
      projectId: row.project_id,
      parentId: row.parent_id,
      revision: row.revision,
      data: JSON.parse(row.data),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
  get(id: string, revision?: number): RecordDoc {
    const row = revision
      ? this.db
          .prepare('SELECT document FROM revisions WHERE id=? AND revision=?')
          .get(id, revision)
      : this.db.prepare('SELECT * FROM documents WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '记录不存在');
    return revision ? JSON.parse(row.document as string) : this.decode(row);
  }
  list(kind?: Kind, projectId?: string, parentId?: string): RecordDoc[] {
    return this.db
      .prepare(
        'SELECT * FROM documents WHERE (? IS NULL OR kind=?) AND (? IS NULL OR project_id=?) AND (? IS NULL OR parent_id=?) ORDER BY created_at,id',
      )
      .all(
        kind ?? null,
        kind ?? null,
        projectId ?? null,
        projectId ?? null,
        parentId ?? null,
        parentId ?? null,
      )
      .map((r) => this.decode(r));
  }
  create(
    kind: Kind,
    projectId: string,
    data: any,
    parentId: string | null = null,
    id: string = randomUUID(),
  ): RecordDoc {
    return this.transaction(() => {
      const now = Date.now();
      const doc: RecordDoc = {
        id,
        kind,
        projectId: projectId || id,
        parentId,
        revision: 1,
        data,
        createdAt: now,
        updatedAt: now,
      };
      this.db
        .prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)')
        .run(id, kind, doc.projectId, parentId, 1, JSON.stringify(data), now, now);
      this.db.prepare('INSERT INTO revisions VALUES(?,?,?)').run(id, 1, JSON.stringify(doc));
      this.event(null, 'record', { id, revision: 1, projectId: doc.projectId, kind });
      return doc;
    });
  }
  update(id: string, expected: number, data: any): RecordDoc {
    return this.transaction(() => {
      const doc = this.get(id);
      if (doc.revision !== expected) throw new HttpError(409, '内容已更新，请刷新后重新确认');
      const next = { ...doc, revision: expected + 1, data, updatedAt: Date.now() };
      const changed = this.db
        .prepare('UPDATE documents SET revision=?,data=?,updated_at=? WHERE id=? AND revision=?')
        .run(next.revision, JSON.stringify(data), next.updatedAt, id, expected);
      if (changed.changes !== 1) throw new HttpError(409, '版本冲突');
      this.db
        .prepare('INSERT INTO revisions VALUES(?,?,?)')
        .run(id, next.revision, JSON.stringify(next));
      this.event(null, 'record', {
        id,
        revision: next.revision,
        projectId: doc.projectId,
        kind: doc.kind,
      });
      return next;
    });
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    return row ? JSON.parse(row.value as string) : fallback;
  }
  setSetting(key: string, value: any) {
    this.db
      .prepare(
        'INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(key, JSON.stringify(value));
  }
  decodeJob(row: any): Job {
    return {
      id: row.id,
      projectId: row.project_id,
      episodeId: row.episode_id,
      kind: row.kind,
      state: row.state,
      input: JSON.parse(row.input),
      output: JSON.parse(row.output),
      promptId: row.prompt_id,
      error: row.error,
      cancelRequested: !!row.cancel_requested,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      batchId: row.batch_id ?? null,
      batchItemId: row.batch_item_id ?? null,
      holdReason: row.hold_reason ?? null,
    };
  }
  job(id: string): Job {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id=?').get(id);
    if (!row) throw new HttpError(404, '任务不存在');
    return this.decodeJob(row);
  }
  jobs(projectId?: string, episodeId?: string): Job[] {
    return this.db
      .prepare(
        'SELECT * FROM jobs WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR episode_id=?) ORDER BY created_at',
      )
      .all(projectId ?? null, projectId ?? null, episodeId ?? null, episodeId ?? null)
      .map((r) => this.decodeJob(r));
  }
  createJob(
    kind: Job['kind'],
    projectId: string | null,
    episodeId: string | null,
    input: any,
    key: string,
  ): Job {
    return this.transaction(() => {
      if (!projectId && !['voice_clone', 'speech'].includes(kind))
        throw new HttpError(400, '此任务需要作品归属');
      const old = this.db.prepare('SELECT * FROM jobs WHERE idempotency_key=?').get(key);
      if (old) {
        const job = this.decodeJob(old);
        const {
          assistantCharge: _priorAssistantCharge,
          creationCharge: _priorCharge,
          modelCharge: _priorModelCharge,
          speechCharge: _priorSpeechCharge,
          ...priorInput
        } = job.input;
        const {
          assistantCharge: _requestAssistantCharge,
          creationCharge: _requestCharge,
          modelCharge: _requestModelCharge,
          speechCharge: _requestSpeechCharge,
          ...requestInput
        } = input;
        if (
          job.kind !== kind ||
          job.projectId !== projectId ||
          JSON.stringify(priorInput) !== JSON.stringify(requestInput)
        )
          throw new HttpError(409, '幂等键已用于另一组输入');
        return job;
      }
      const creationRunId =
        input.creationRunId || (input.context?.stage ? input.context.runId : null);
      if (
        creationRunId &&
        (kind === 'generation' || kind === 'creative') &&
        this.get(creationRunId).data.schemaVersion !== 9
      )
        throw new HttpError(409, '当前程序仅支持 V9 创作和生成作业');
      if (['voice_clone', 'speech', 'lipsync', 'transcription'].includes(kind)) {
        const { speechCharge: _untrusted, ...uncharged } = input;
        input = {
          ...uncharged,
          speechCharge: reserveSpeechUsage(this, projectId, kind, uncharged),
        };
      } else if (
        input.modelExecution &&
        ['creative', 'image', 'generation', 'media_analysis'].includes(kind)
      ) {
        const { modelCharge: _untrusted, creationCharge: _oldCharge, ...uncharged } = input;
        input = { ...uncharged, modelCharge: reserveModelUsage(this, projectId!, kind, uncharged) };
      } else if (kind === 'generation') {
        const { creationCharge: _untrustedCharge, ...uncharged } = input;
        input = uncharged;
        // Jobs are the reservation ledger. Every dispatch path uses this same
        // transaction, including manual batches and bounded automatic retries.
        const settingsRow = this.db
          .prepare(
            "SELECT * FROM documents WHERE project_id=? AND kind='creation_settings' LIMIT 1",
          )
          .get(projectId);
        if (input.creationRunId && !settingsRow)
          throw new HttpError(409, '创作运行缺少项目额度设置');
        if (settingsRow) {
          const settings = this.decode(settingsRow);
          const policy = creationSettingsSchema.parse(settings.data.policy);
          const seconds = Number(input.segment?.duration);
          if (!policy.allowance.enabled)
            throw new HttpError(409, '请先在项目创作设置中授权生成额度');
          if (!Number.isFinite(seconds) || seconds <= 0)
            throw new HttpError(400, '生成额度需要有效的请求时长');
          const providerDigest = createHash('sha256')
            .update(JSON.stringify(input.profile))
            .digest('hex');
          if (providerDigest !== settings.data.providerDigest)
            throw new HttpError(409, '执行连接已改变，请在项目设置重新确认执行范围');
          const used = this.db
            .prepare(
              "SELECT count(*) AS count,COALESCE(sum(json_extract(input,'$.creationCharge.seconds')),0) AS seconds FROM jobs WHERE project_id=? AND kind='generation' AND json_extract(input,'$.creationCharge') IS NOT NULL",
            )
            .get(projectId)!;
          if (
            Number(used.count) + 1 > policy.allowance.maxGenerations ||
            Number(used.seconds) + seconds > policy.allowance.maxGeneratedSeconds + 1e-7
          )
            throw new HttpError(
              409,
              '项目生成额度不足；失败、取消和受理不明的已预留请求不自动返还额度',
            );
          input = {
            ...input,
            creationCharge: { seconds, settingsId: settings.id, policyRevision: settings.revision },
          };
        }
      }
      if (input.assistantRunId)
        input = { ...input, assistantCharge: reserveAssistantUsage(this, projectId, kind, input) };
      const id = randomUUID(),
        now = Date.now();
      this.db
        .prepare(
          'INSERT INTO jobs(id,project_id,episode_id,kind,state,input,idempotency_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
        )
        .run(id, projectId, episodeId, kind, 'queued', JSON.stringify(input), key, now, now);
      this.event(id, 'created', { kind });
      return this.job(id);
    });
  }
  patchJob(
    id: string,
    patch: Partial<
      Pick<Job, 'state' | 'output' | 'promptId' | 'error' | 'cancelRequested' | 'holdReason'>
    >,
  ) {
    return this.transaction(() => {
      const job = this.job(id),
        n = { ...job, ...patch };
      this.db
        .prepare(
          'UPDATE jobs SET state=?,output=?,prompt_id=?,error=?,cancel_requested=?,updated_at=?,hold_reason=? WHERE id=?',
        )
        .run(
          n.state,
          JSON.stringify(n.output),
          n.promptId,
          n.error,
          n.cancelRequested ? 1 : 0,
          Date.now(),
          n.holdReason ?? null,
          id,
        );
      this.event(id, patch.state && patch.state !== job.state ? patch.state : 'job', {
        error: n.error,
        projectId: job.projectId,
      });
      return this.job(id);
    });
  }
  event(jobId: string | null, kind: string, data: any) {
    return this.transaction(() => {
      this.db
        .prepare('INSERT INTO events(job_id,kind,data,created_at) VALUES(?,?,?,?)')
        .run(jobId, kind, JSON.stringify(data), Date.now());
    });
  }
  events(after = 0) {
    return this.db
      .prepare(
        'SELECT events.*,jobs.project_id AS projectId FROM events LEFT JOIN jobs ON jobs.id=events.job_id WHERE seq>? ORDER BY seq LIMIT 300',
      )
      .all(after)
      .map((r: any) => ({ ...r, data: JSON.parse(r.data) }));
  }
  acquire(owner: string, ttl = 30000): boolean {
    const now = Date.now();
    this.db
      .prepare(
        'INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE leases.expires<? OR leases.owner=?',
      )
      .run('worker', owner, now + ttl, now, owner);
    return this.db.prepare('SELECT owner FROM leases WHERE name=?').get('worker')?.owner === owner;
  }
  release(owner: string) {
    this.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run('worker', owner);
  }
  recover() {
    for (const job of this.jobs()) {
      if (
        ['media_process', 'previs'].includes(job.kind) &&
        ['running', 'preparing'].includes(job.state)
      ) {
        this.patchJob(job.id, { state: 'queued', error: '本地处理将从已归档输出继续' });
        continue;
      }
      if (job.state === 'preparing')
        this.patchJob(job.id, { state: 'queued', error: 'Worker 中断，准备阶段将重试' });
      if (job.state === 'submitting')
        this.patchJob(job.id, {
          state: 'unknown',
          error: '提交期间中断；先核对云端任务，禁止自动重复提交',
        });
      if (
        job.state === 'running' &&
        !['generation', 'voice_clone', 'speech', 'lipsync'].includes(job.kind)
      )
        this.patchJob(job.id, {
          state: 'failed',
          error: '本机执行中断，已保留输入和日志；可明确重试',
        });
    }
  }
  close() {
    this.db.close();
  }
}
