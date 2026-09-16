import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Store, HttpError } from './db.js';
import { CreationMediaService } from './creation-media.js';
import { CreationService } from './creation.js';
import { ComfyClient, compileH3 } from './comfy.js';
import { inside } from './config.js';
import { runCodex } from './codex.js';
import { generationDigest, guidedTemplateVersion } from './h3-guided.js';
import { ingestAsset, probeMedia, extractOriginalAudio, exportMovie, hashFile } from './media.js';
import type { Job } from '../shared/contracts.js';
import type WebSocket from 'ws';
import { generationDependencies, correctionAffectsInput } from './generation-dependencies.js';
import { repairSourceUnchanged } from './selection-splice.js';

export class Worker {
  owner = randomUUID();
  stopped = false;
  initialized = false;
  executions = new Map<
    string,
    { lane: string; controller: AbortController; promise: Promise<void> }
  >();
  lastProject: string | null = null;
  heartbeat: ReturnType<typeof setInterval> | null = null;
  progressConnection: { jobId: string; socket: WebSocket } | null = null;
  constructor(
    public store: Store,
    public root: string,
    public makeClient = (url: string) => new ComfyClient(url),
    public runCreative = runCodex,
    public exportMedia = exportMovie,
  ) {}
  async tick(wait = true) {
    if (this.stopped) return;
    if (this.store.setting('maintenance', false)) {
      if (!this.executions.size) {
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.heartbeat = null;
        this.store.release(this.owner);
      }
      return;
    }
    if (!this.store.acquire(this.owner)) {
      // Startup contention is normal during a watched-process restart. Only an
      // initialized owner losing its lease must stop and fence existing work.
      if (this.initialized) this.stop();
      return;
    }
    this.store.writeLeaseOwner = this.owner;
    if (!this.initialized) {
      this.store.recover();
      this.initialized = true;
    }
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (!this.store.acquire(this.owner)) {
          this.stop();
          return;
        }
        for (const [id, execution] of this.executions)
          if (this.store.job(id).cancelRequested && execution.lane === 'creative')
            execution.controller.abort();
      }, 2000);
      this.heartbeat.unref();
    }
    const creation = new CreationService(this.store);
    for (const run of this.store
      .list('creation_run')
      .filter((r) => !r.data.paused && r.data.state !== 'complete'))
      creation.advance(run.id);
    const jobs = this.store.db
      .prepare(
        `SELECT j.id,j.project_id,j.episode_id,j.kind,j.state,j.prompt_id,j.error,j.cancel_requested,j.created_at,j.updated_at,j.batch_id,j.batch_item_id,j.hold_reason,
          json_object('dependencies',json_extract(j.input,'$.dependencies'),
            'segment',json_object('id',json_extract(j.input,'$.segment.id'),'incoming',json_extract(j.input,'$.segment.incoming'),'repair',json_extract(j.input,'$.segment.repair')),
            'episode',json_extract(j.input,'$.episode'),
            'assets',(SELECT json_group_array(json_object('asset',json_object('id',json_extract(value,'$.asset.id'),'revision',json_extract(value,'$.asset.revision')))) FROM json_each(j.input,'$.assets')),
            'creativeBrief',json_object('profile',json_extract(j.input,'$.creativeBrief.profile'),'visualReference',json_extract(j.input,'$.creativeBrief.visualReference'),
              'modules',(SELECT json_group_array(json_object('ref',json_extract(value,'$.ref'))) FROM json_each(j.input,'$.creativeBrief.modules'))),
            'planning',json_object('dependencies',json_extract(j.input,'$.planning.dependencies'),
              'records',(SELECT json_group_array(json_object('id',json_extract(value,'$.id'),'revision',json_extract(value,'$.revision'))) FROM json_each(j.input,'$.planning.records')))) AS input,
          json_object('basisCorrected',json_extract(j.output,'$.basisCorrected')) AS output FROM jobs j
         LEFT JOIN batch_items item ON item.job_id=j.id
         WHERE j.state NOT IN ('succeeded','failed','cancelled')
         ORDER BY COALESCE(
           (SELECT MIN(member.rowid) FROM jobs member WHERE member.batch_id=j.batch_id),
           j.rowid
         ), COALESCE(item.position,0), j.rowid`,
      )
      .all()
      .map((r) => this.store.decodeJob(r));
    for (const job of jobs)
      if (job.state === 'queued' && job.cancelRequested)
        this.store.patchJob(job.id, { state: 'cancelled' });
    if (
      this.progressConnection &&
      !jobs.some(
        (j) =>
          j.id === this.progressConnection!.jobId &&
          ['submitted', 'running', 'unknown'].includes(j.state),
      )
    ) {
      this.progressConnection.socket.close();
      this.progressConnection = null;
    }
    const free = (lane: string) => ![...this.executions.values()].some((e) => e.lane === lane);
    const available = (j: Job) => !this.executions.has(j.id) && !j.holdReason && !j.cancelRequested;
    const generationJobs = jobs.filter((j) => j.kind === 'generation');
    const corrections = generationJobs.length
      ? this.store.db
          .prepare(
            "SELECT data,created_at FROM events WHERE kind='domain_correction' AND created_at>=?",
          )
          .all(Math.min(...generationJobs.map((j) => j.createdAt)))
          .map((e) => ({ at: Number(e.created_at), data: JSON.parse(String(e.data)) }))
      : [];
    // Corrections pause queued frozen inputs; optional newer revisions do not.
    for (const j of generationJobs) {
      const refs = generationDependencies(j.input);
      const corrected = corrections.some(
        (e) => e.at >= j.createdAt && correctionAffectsInput(j.input, e.data, j.id),
      );
      if (
        corrected ||
        refs.some((r: any) => {
          const head = this.store.get(r.id);
          if (!head.data.stale) return false;
          return !(
            j.input.segment?.repair?.sourceSelection?.id === r.id &&
            repairSourceUnchanged(this.store.get(r.id, r.revision), head)
          );
        })
      ) {
        if (j.state === 'queued' && !j.holdReason)
          this.store.patchJob(j.id, { holdReason: 'dependencies_need_review' });
        else if (j.state !== 'queued' && !j.output.basisCorrected)
          this.store.patchJob(j.id, {
            output: {
              ...this.store.job(j.id).output,
              basisCorrected: true,
              basisCorrectionMessage: '已提交输入的依据已被纠正；继续归档，采用前需复核。',
            },
          });
      }
    }
    const start = (job: Job | undefined, lane: string) => {
      if (!job || !free(lane) || this.executions.has(job.id)) return;
      const controller = new AbortController();
      const promise = this.execute(this.store.job(job.id), lane, controller.signal)
        .catch((error) => {
          console.error('Worker 执行状态提交失败：', error);
          this.stop();
        })
        .finally(() => this.executions.delete(job.id));
      this.executions.set(job.id, { lane, controller, promise });
    };
    start(
      jobs.find((j) => j.kind === 'creative' && j.state === 'queued' && available(j)),
      'creative',
    );
    const unresolved = jobs.find(
      (j) =>
        j.kind === 'generation' &&
        ['submitted', 'running', 'unknown', 'submitting', 'preparing'].includes(j.state),
    );
    const queued = jobs.filter(
      (j) =>
        j.kind === 'generation' &&
        j.state === 'queued' &&
        available(j) &&
        !this.store.job(j.id).holdReason,
    );
    const projects = [...new Set(queued.map((j) => j.projectId))];
    const nextProject = projects[(projects.indexOf(this.lastProject || '') + 1) % projects.length];
    const next = unresolved || queued.find((j) => j.projectId === nextProject);
    if (next && free('remote') && !this.executions.has(next.id)) {
      if (next.state === 'queued') this.lastProject = next.projectId;
      start(next, 'remote');
    }
    start(
      jobs.find(
        (j) => j.kind === 'generation' && j.state === 'archiving' && !this.executions.has(j.id),
      ) || jobs.find((j) => j.kind === 'export' && j.state === 'queued' && available(j)),
      'media',
    );
    if (wait) {
      await Promise.all([...this.executions.values()].map((e) => e.promise));
      // Compatibility for direct tick callers: finish the newly discovered archive.
      const archive = this.store
        .jobs()
        .find((j) => j.state === 'archiving' && j.kind === 'generation');
      if (archive && free('media')) {
        start(archive, 'media');
        await Promise.all([...this.executions.values()].map((e) => e.promise));
      }
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
  async execute(job: Job, lane: string, signal: AbortSignal) {
    try {
      if (job.kind === 'generation') {
        if (
          ['queued', 'preparing'].includes(job.state) &&
          job.input.creationRunId &&
          this.store.get(job.input.creationRunId).data.schemaVersion !== 9
        )
          throw new Error('当前程序仅支持 V9 生成；尚未调用模型');
        if (lane === 'media')
          await this.archive(job, this.makeClient(job.input.profile.baseUrl), signal);
        else await this.generation(job, signal);
      } else if (job.kind === 'creative') {
        if (job.input.context?.schemaVersion !== 9)
          throw new Error(
            'Obsolete creative protocol; start a current authoring or discussion task',
          );
        this.store.patchJob(job.id, { state: 'running', error: null });
        const executionDir = inside(this.root, `jobs/${job.id}/runs/${this.owner}`);
        this.store.patchJob(job.id, { output: { ...job.output, executionDir } });
        const proposal = await this.runCreative(job.input.context, executionDir, signal);
        signal.throwIfAborted();
        const discussion = job.input.context.mode === 'discussion';
        const doc = discussion
          ? new CreationMediaService(this.store, this.root).completeDiscussion(job, proposal)
          : new CreationService(this.store).complete(job, proposal);
        if (
          !discussion &&
          !this.store
            .list('creation_message', job.projectId)
            .some((m) => m.data.role === 'assistant' && m.data.jobId === job.id)
        ) {
          this.store.create(
            'creation_message',
            job.projectId,
            {
              runId: job.input.context.runId,
              role: 'assistant',
              mode: job.input.messageKey ? 'revise' : 'execute',
              text: doc.data.valid
                ? '文字草稿已生成，请查看并决定是否采用。'
                : '文字输出未通过数据校验，请查看具体问题后修订。',
              resultLinks: [
                { id: doc.id, revision: doc.revision, title: doc.data.result?.title || '查看草稿' },
              ],
              jobId: job.id,
              historical: doc.data.stale,
              epoch: job.input.context.epoch,
              at: Date.now(),
            },
            job.input.context.runId,
          );
        }
        this.store.patchJob(job.id, {
          state: 'succeeded',
          output: {
            ...this.store.job(job.id).output,
            ...(discussion ? { messageId: doc.id } : { authoringResultId: doc.id }),
          },
          error: null,
        });
      } else {
        const archived = this.store
          .list('asset', job.projectId)
          .find((a) => a.data.category === 'export' && a.data.jobId === job.id);
        if (archived) {
          const file = inside(this.root, archived.data.path);
          if ((await hashFile(file)) !== archived.data.sha256)
            throw new Error('已归档成片校验失败，请检查存储');
          signal.throwIfAborted();
          this.store.patchJob(job.id, {
            state: 'succeeded',
            output: { ...job.output, assetIds: [archived.id] },
            error: null,
          });
          return;
        }
        this.store.patchJob(job.id, { state: 'running', error: null });
        const dir = inside(this.root, `jobs/${job.id}/runs/${this.owner}`);
        await fs.mkdir(dir, { recursive: true });
        const output = path.join(dir, 'export.mp4');
        if (job.input.purpose === 'candidate_review' || job.input.deliveryPlan)
          for (const source of job.input.assets) {
            signal.throwIfAborted();
            if ((await hashFile(inside(this.root, source.data.path))) !== source.data.sha256)
              throw new Error('审看导出的固定素材内容已变化；拒绝使用不同内容继续渲染');
          }
        await this.exportMedia(job.input.edl, job.input.assets, this.root, output, signal, {
          previous: job.output.renderCheckpoint,
          save: (renderCheckpoint) => {
            signal.throwIfAborted();
            this.store.patchJob(job.id, {
              output: { ...this.store.job(job.id).output, renderCheckpoint },
            });
          },
        });
        signal.throwIfAborted();
        const asset = await ingestAsset(
          this.store,
          this.root,
          job.projectId,
          output,
          {
            name: job.input.name || '成片',
            category: 'export',
            sourceAssetIds: (job.input.sourceAssets || job.input.assets || []).map(
              (a: any) => a.id,
            ),
            jobId: job.id,
            episodeId: job.episodeId,
          },
          { exportJobId: job.id },
        );
        this.store.patchJob(job.id, {
          state: 'succeeded',
          output: { ...this.store.job(job.id).output, assetIds: [asset.id] },
          error: null,
        });
      }
    } catch (e: any) {
      const current = this.store.job(job.id);
      if (current.output.waitSuspended) return;
      const networkStage =
        job.kind === 'generation' && ['unknown', 'submitted', 'running'].includes(current.state);
      if (this.stopped) return;
      this.store.patchJob(job.id, {
        state: networkStage ? current.state : current.cancelRequested ? 'cancelled' : 'failed',
        error: e.message || String(e),
      });
    }
  }
  async generation(job: Job, signal?: AbortSignal) {
    const client = this.makeClient(job.input.profile.baseUrl);
    if (job.state === 'queued') {
      this.store.patchJob(job.id, { state: 'preparing', error: null });
      const mappings = new Map<string, string>();
      const guided = Boolean(job.input.prepared);
      for (const a of job.input.assets)
        mappings.set(
          guided ? `${a.reference.assetId}:${a.reference.revision}` : a.reference.assetId,
          `studio_${a.asset.data.sha256}${path.extname(a.asset.data.path)}`,
        );
      const provisional = compileH3(job.input, mappings, job.id);
      await client.validate(provisional);
      signal?.throwIfAborted();
      const receipts: any = {};
      const uploaded = new Map<string, string>();
      for (const a of job.input.assets) {
        signal?.throwIfAborted();
        const key = guided ? `${a.reference.assetId}:${a.reference.revision}` : a.reference.assetId;
        const fileKey = a.asset.data.path;
        const filename =
          (guided && uploaded.get(fileKey)) ||
          (await client.upload(inside(this.root, a.asset.data.path), mappings.get(key)!));
        uploaded.set(fileKey, filename);
        mappings.set(key, filename);
        receipts[key] = {
          filename,
          sha256: a.asset.data.sha256,
          instanceId: job.input.profile.instanceId,
          ...(guided ? { assetId: a.reference.assetId, revision: a.reference.revision } : {}),
        };
      }
      const graph = compileH3(job.input, mappings, job.id),
        dir = inside(this.root, `jobs/${job.id}/runs/${this.owner}`);
      signal?.throwIfAborted();
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'workflow.json'), JSON.stringify(graph, null, 2));
      await fs.writeFile(path.join(dir, 'input.json'), JSON.stringify(job.input, null, 2));
      if (guided) await fs.writeFile(path.join(dir, 'prompt.txt'), job.input.prepared.finalPrompt);
      if (this.store.job(job.id).cancelRequested) {
        this.store.patchJob(job.id, { state: 'cancelled' });
        return;
      }
      this.store.patchJob(job.id, {
        state: 'submitting',
        output: { receipts, graph, executionDir: dir },
        error: null,
      });
      try {
        const id = await client.submit(graph, job);
        this.store.patchJob(job.id, { state: 'submitted', promptId: id, error: null });
      } catch (e: any) {
        const definite = e instanceof HttpError && [400, 401, 403, 404, 422].includes(e.status);
        this.store.patchJob(job.id, {
          state: definite ? 'failed' : 'unknown',
          error: `${definite ? '提交被拒绝' : '提交结果未知，请核对，未自动重发'}：${e.message}`,
        });
      }
      return;
    }
    if (job.state === 'unknown') {
      const [queue, history] = await Promise.all([
        client.json('/queue'),
        client.json('/history?max_items=200'),
      ]);
      if (this.store.job(job.id).output.waitSuspended) return;
      const item = [...queue.queue_running, ...queue.queue_pending].find(
        (p: any) =>
          p[3]?.studio?.job_id === job.id &&
          p[3]?.studio?.instance_id === job.input.profile.instanceId,
      );
      const found = Object.entries(history).find(
        ([, h]: any) =>
          h.prompt?.[3]?.studio?.job_id === job.id &&
          h.prompt?.[3]?.studio?.instance_id === job.input.profile.instanceId,
      );
      if (item || found)
        this.store.patchJob(job.id, {
          state: 'submitted',
          promptId: item ? item[1] : found![0],
          error: null,
        });
      else
        this.store.patchJob(job.id, {
          error: '提交结果未知：当前队列及最近 200 条历史未找到标记；核对范围有限，不会重新提交',
          output: { ...this.store.job(job.id).output, lastCheckedAt: Date.now() },
        });
      return;
    }
    if (job.state === 'archiving' && job.output.descriptor) {
      await this.archive(job, client);
      return;
    }
    if (!job.promptId) throw new Error('任务缺少已确认的云端身份');
    const [history, queue] = await Promise.all([
      client.json(`/history/${encodeURIComponent(job.promptId)}`),
      client.json('/queue'),
    ]);
    if (this.store.job(job.id).output.waitSuspended) return;
    const result = history[job.promptId];
    if (result) {
      if (result.status?.status_str === 'error') {
        const err = result.status.messages?.find((m: any) => m[0] === 'execution_error')?.[1];
        this.store.patchJob(job.id, {
          state: 'failed',
          error: `云端生成失败：${err?.exception_message || JSON.stringify(result.status)}`,
        });
        return;
      }
      if (result.status?.completed && result.status?.status_str === 'success') {
        const outputs = result.outputs?.save;
        const descriptor = [
          ...(outputs?.images || []),
          ...(outputs?.videos || []),
          ...(outputs?.gifs || []),
        ].find((v: any) => typeof v.filename === 'string' && /\.(mp4|webm|mov)$/i.test(v.filename));
        if (!descriptor) throw new Error('云端执行完成，但指定 save 节点没有视频输出');
        const started = result.status.messages?.find((m: any) => m[0] === 'execution_start')?.[1]
          ?.timestamp;
        const finished = result.status.messages?.find((m: any) => m[0] === 'execution_success')?.[1]
          ?.timestamp;
        const timing =
          Number.isFinite(started) && Number.isFinite(finished) && finished >= started
            ? {
                remoteDurationMs: finished - started,
                remoteTimingSource: 'ComfyUI history execution timestamps',
              }
            : {};
        this.store.patchJob(job.id, {
          state: 'archiving',
          output: { ...job.output, descriptor, remoteStatus: result.status, ...timing },
          error: null,
        });
        return;
      }
    }
    const queued = queue.queue_pending.some((p: any) => p[1] === job.promptId),
      running = queue.queue_running.some((p: any) => p[1] === job.promptId);
    if (job.cancelRequested && queued) {
      await client.request('/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delete: [job.promptId] }),
      });
      const after = await client.json('/queue');
      if (
        !after.queue_running.some((p: any) => p[1] === job.promptId) &&
        !after.queue_pending.some((p: any) => p[1] === job.promptId)
      ) {
        const h = await client.json(`/history/${encodeURIComponent(job.promptId)}`);
        if (!h[job.promptId]) {
          this.store.patchJob(job.id, { state: 'cancelled', error: null });
          return;
        }
      }
    }
    this.store.patchJob(job.id, {
      state: running ? 'running' : 'submitted',
      output: { ...this.store.job(job.id).output, lastCheckedAt: Date.now() },
      error:
        job.cancelRequested && running
          ? '云端正在运行；为避免中断其他任务，等待完成并保留结果'
          : !running && !queued
            ? '队列与历史暂未找到此任务；可能已重启或清理，保留 prompt_id 等待核对'
            : null,
    });
    // Worker owns this connection across polling ticks; history remains authoritative.
    if (
      this.progressConnection?.jobId !== job.id ||
      this.progressConnection.socket.readyState > 1
    ) {
      this.progressConnection?.socket.close();
      const socket = client.watch(job.id, (event) => {
        if (
          !this.stopped &&
          ['progress', 'executing', 'execution_error', 'connection_warning'].includes(event.type)
        )
          this.store.event(job.id, 'progress', event);
      });
      this.progressConnection = { jobId: job.id, socket };
    }
  }
  async archive(job: Job, client: ComfyClient, signal?: AbortSignal) {
    const dir = inside(this.root, `jobs/${job.id}/runs/${this.owner}`);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, 'result.mp4');
    let video = job.output.videoAssetId
      ? this.store.get(job.output.videoAssetId)
      : this.store
          .list('asset', job.projectId)
          .find((a) => a.data.jobId === job.id && a.data.category === 'generated');
    if (!video) {
      const d = job.output.descriptor;
      const params = new URLSearchParams({
        filename: d.filename,
        subfolder: d.subfolder || '',
        type: d.type || 'output',
      });
      const response = await client.request('/view?' + params, {}, 120000);
      if (!response.body) throw new Error('视频下载没有响应体');
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > 512 * 1024 * 1024) done(new Error('视频超过 512 MB 下载限制'));
          else done(null, chunk);
        },
      });
      const partial = file + '.part';
      await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(partial), {
        signal,
      });
      signal?.throwIfAborted();
      await fs.rename(partial, file);
      const info = await probeMedia(file);
      if (info.mediaType !== 'video' || !info.duration) throw new Error('输出不是有效视频');
      video = await ingestAsset(this.store, this.root, job.projectId, file, {
        name: `${job.input.segment.id} · 候选`,
        category: 'generated',
        jobId: job.id,
        episodeId: job.episodeId,
        prompt: job.input.prepared?.finalPrompt || job.input.segment.prompt,
        sourceAssetIds: job.input.assets.map((a: any) => a.asset.id),
      });
    }
    this.store.patchJob(job.id, {
      output: { ...this.store.job(job.id).output, videoAssetId: video.id },
    });
    const existing = this.store.list('asset', job.projectId).filter((a) => a.data.jobId === job.id);
    const last = existing.find((a) => a.data.category === 'keyframe');
    let audio = existing.find((a) => a.data.category === 'original_audio');
    if (video.data.hasAudio && !audio) {
      const file = await extractOriginalAudio(inside(this.root, video.data.path), dir, signal);
      audio = await ingestAsset(this.store, this.root, job.projectId, file, {
        name: '原始音轨',
        category: 'original_audio',
        jobId: job.id,
        episodeId: job.episodeId,
        sourceAssetIds: [video.id],
        derivedSource: {
          jobId: job.id,
          media: { id: video.id, revision: video.revision },
          kind: 'audio',
          frameIndex: null,
          interval: null,
          parameters: { codec: 'pcm_s16le' },
        },
      });
      await fs
        .unlink(file)
        .catch((e) => this.store.event(job.id, 'media_cleanup_warning', { error: e.message }));
    }
    const metadata = await probeMedia(inside(this.root, video.data.path));
    const reviewFrames = this.store.job(job.id).output.reviewFrames;
    this.store.patchJob(job.id, {
      output: {
        ...this.store.job(job.id).output,
        mediaCheck: {
          frameCount: metadata.frameCount,
          duration: metadata.duration,
          width: metadata.width,
          height: metadata.height,
          expectedFrameCount: job.input.prepared?.frameCount,
          frameCountMatches: metadata.frameCount === job.input.prepared?.frameCount,
          streams: metadata.streams,
          visualReview: 'pending',
        },
      },
    });
    this.store.patchJob(job.id, {
      state: this.store.job(job.id).cancelRequested ? 'cancelled' : 'succeeded',
      output: {
        ...this.store.job(job.id).output,
        assetIds: [
          video.id,
          ...(last ? [last.id] : []),
          ...(audio ? [audio.id] : []),
          ...(reviewFrames || []).map((f: any) => f.assetId),
        ],
      },
      error: null,
    });
  }
  stop() {
    this.stopped = true;
    for (const execution of this.executions.values()) execution.controller.abort();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.progressConnection?.socket.close();
    this.progressConnection = null;
  }
  async drain() {
    await Promise.allSettled([...this.executions.values()].map((e) => e.promise));
  }
}
