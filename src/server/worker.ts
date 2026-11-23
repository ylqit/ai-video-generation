import { assertAssistantMaySubmit } from './assistant-usage.js';
import { attachCanvasResults } from './canvas-results.js';
import { executeMediaOperation } from './node-media-worker.js';
import { executeNodeAnalysis } from './node-analysis-worker.js';
import { renderDirectorJob } from './director-render-job.js';
import { attachConversationResult } from './canvas-conversation.js';
import { ProductionAssistant } from './production-assistant.js';
import { executeSpeechJob } from './speech-worker.js';
import { voiceHandleIdentity } from '../shared/speech.js';
import { SeriesProposals } from './series-proposal.js';
import { modelAvailable } from '../shared/models.js';
import { archiveVideoCandidate } from './candidate-archive.js';
import { executeProviderMedia } from './provider-media.js';
import { runTextModel } from './text-model.js';
import { resolveCredential } from './model-credentials.js';
import { ModelHttpError } from './model-http.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, HttpError } from './db.js';
import { CreationMediaService } from './creation-media.js';
import { CreationService } from './creation.js';
import { ComfyClient, compileH3 } from './comfy.js';
import { inside } from './config.js';
import { runCodex } from './codex.js';
import { generationDigest, guidedTemplateVersion } from './h3-guided.js';
import { ingestAsset, exportMovie, hashFile } from './media.js';
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
    public requestModel: typeof fetch = fetch,
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
      for (const row of this.store.db
        .prepare(
          "SELECT id FROM jobs WHERE state IN ('succeeded','failed','unknown') AND json_extract(input,'$.canvas.id') IS NOT NULL",
        )
        .all())
        this.reconcileCanvas(String(row.id));
      this.initialized = true;
    }
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        if (!this.store.acquire(this.owner)) {
          this.stop();
          return;
        }
        for (const [id, execution] of this.executions)
          if (this.store.job(id).cancelRequested && this.store.job(id).kind === 'creative')
            execution.controller.abort();
      }, 2000);
      this.heartbeat.unref();
    }
    const creation = new CreationService(this.store);
    for (const run of this.store
      .list('creation_run')
      .filter((r) => !r.data.paused && r.data.state !== 'complete'))
      creation.advance(run.id);
    const assistant = new ProductionAssistant(this.store, this.root);
    for (const run of this.store
      .list('assistant_run')
      .filter((r) => !['completed', 'stopped', 'paused'].includes(r.data.state)))
      await assistant.advance(run.id);
    const jobs = this.store.db
      .prepare(
        `SELECT j.id,j.project_id,j.episode_id,j.kind,j.state,j.prompt_id,j.error,j.cancel_requested,j.created_at,j.updated_at,j.batch_id,j.batch_item_id,j.hold_reason,
          json_object('dependencies',json_extract(j.input,'$.dependencies'),
            'voice',json_object('id',json_extract(j.input,'$.voice.id')),'modelExecution',json_extract(j.input,'$.modelExecution'),'profile',json_extract(j.input,'$.profile'),
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
    const generationJobs = jobs.filter((j) => j.kind === 'generation' || j.kind === 'image');
    for (const job of jobs.filter((j) => j.state === 'queued' && j.input.modelExecution)) {
      const connection = this.store.db
        .prepare('SELECT data FROM model_connections WHERE id=?')
        .get(job.input.modelExecution.connection.id);
      const enabled =
        connection &&
        modelAvailable(JSON.parse(String(connection.data)), job.input.modelExecution.modelId);
      if (!enabled && !job.holdReason) {
        this.store.patchJob(job.id, { holdReason: 'model_connection_disabled' });
        job.holdReason = 'model_connection_disabled';
      }
      if (enabled && job.holdReason === 'model_connection_disabled') {
        this.store.patchJob(job.id, { holdReason: null });
        job.holdReason = null;
      }
      if (job.input.voice && job.holdReason === 'voice_disabled') {
        const voice = this.store.db
          .prepare('SELECT enabled FROM library_metadata WHERE id=?')
          .get(job.input.voice.id);
        if (voice?.enabled) {
          this.store.patchJob(job.id, { holdReason: null });
          job.holdReason = null;
        }
      }
      if (job.input.voice && job.holdReason === 'voice_unavailable') {
        const status = this.store.setting<any>(
          `voice_probe:${generationDigest(voiceHandleIdentity(job.input.voice.data.handle))}`,
          null,
        );
        if (status?.state === 'ready' && (!status.expiresAt || status.expiresAt > Date.now())) {
          this.store.patchJob(job.id, { holdReason: null });
          job.holdReason = null;
        }
      }
    }
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
        .finally(() => {
          this.executions.delete(job.id);
          this.reconcileCanvas(job.id);
        });
      this.executions.set(job.id, { lane, controller, promise });
    };
    start(
      jobs.find(
        (j) =>
          j.kind === 'creative' && !j.input.modelExecution && j.state === 'queued' && available(j),
      ),
      'creative',
    );
    const unresolved = jobs.find(
      (j) =>
        j.kind === 'generation' &&
        !j.input.modelExecution &&
        ['submitted', 'running', 'unknown', 'submitting', 'preparing'].includes(j.state),
    );
    const queued = jobs.filter(
      (j) =>
        j.kind === 'generation' &&
        !j.input.modelExecution &&
        j.state === 'queued' &&
        available(j) &&
        !this.store.job(j.id).holdReason,
    );
    const projects = [...new Set(queued.map((j) => j.projectId))];
    const nextProject = projects[(projects.indexOf(this.lastProject || '') + 1) % projects.length];
    const next = unresolved || queued.find((j) => j.projectId === nextProject);
    const explicitOnSameInstance =
      next &&
      jobs.some(
        (j) =>
          j.input.modelExecution?.protocol === 'comfy-h3' &&
          j.input.profile?.instanceId === next.input.profile?.instanceId &&
          !['queued', 'archiving', 'failed', 'succeeded', 'cancelled'].includes(j.state),
      );
    if (
      next &&
      (!explicitOnSameInstance || unresolved) &&
      free('remote') &&
      !this.executions.has(next.id)
    ) {
      if (next.state === 'queued') this.lastProject = next.projectId;
      start(next, 'remote');
    }
    const modelGroups = new Map<string, Job[]>();
    for (const job of jobs.filter(
      (j) =>
        j.input.modelExecution &&
        !['archiving', 'failed', 'succeeded', 'cancelled'].includes(j.state),
    )) {
      const key = job.input.modelExecution.connection.data.capacityGroup;
      const members = modelGroups.get(key) || [];
      members.push(job);
      modelGroups.set(key, members);
    }
    for (const [group, members] of modelGroups) {
      const limit = Math.min(
        ...members.map((j) => j.input.modelExecution.connection.data.concurrency),
      );
      const sharedLegacy = unresolved || (next && this.executions.has(next.id) ? next : null);
      const capacity =
        limit -
        (sharedLegacy &&
        members.some(
          (j) =>
            j.input.modelExecution.protocol === 'comfy-h3' &&
            j.input.profile?.instanceId === sharedLegacy.input.profile?.instanceId,
        )
          ? 1
          : 0);
      const running = members.filter((j) => j.state !== 'queued');
      const waiting = members.filter(
        (j) => j.state === 'queued' && available(j) && !this.store.job(j.id).holdReason,
      );
      for (let slot = 0; slot < Math.max(capacity, running.length); slot++)
        start(
          running[slot] || (slot < capacity ? waiting[slot - running.length] : undefined),
          `model:${group}:${slot}`,
        );
    }
    start(
      jobs.find(
        (j) =>
          [
            'generation',
            'image',
            'voice_clone',
            'speech',
            'lipsync',
            'media_analysis',
            'transcription',
          ].includes(j.kind) &&
          j.state === 'archiving' &&
          !this.executions.has(j.id),
      ) ||
        jobs.find(
          (j) =>
            ['export', 'media_process', 'previs'].includes(j.kind) &&
            j.state === 'queued' &&
            available(j),
        ),
      'media',
    );
    if (wait) {
      await Promise.all([...this.executions.values()].map((e) => e.promise));
      // Compatibility for direct tick callers: finish the newly discovered archive.
      const archive = this.store
        .jobs()
        .find(
          (j) =>
            j.state === 'archiving' &&
            [
              'generation',
              'image',
              'voice_clone',
              'speech',
              'lipsync',
              'media_analysis',
              'transcription',
            ].includes(j.kind),
        );
      if (archive && free('media')) {
        start(archive, 'media');
        await Promise.all([...this.executions.values()].map((e) => e.promise));
      }
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
  // Archival is complete even if linking a result to its workspace needs recovery.
  reconcileCanvas(jobId: string) {
    if (this.stopped) return;
    try {
      attachCanvasResults(this.store, jobId);
      attachConversationResult(this.store, jobId);
      const job = this.store.job(jobId);
      if (job.output.canvasSyncError)
        this.store.patchJob(jobId, { output: { ...job.output, canvasSyncError: null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('画布结果回填待恢复：', jobId, message);
      const job = this.store.job(jobId);
      this.store.patchJob(jobId, { output: { ...job.output, canvasSyncError: message } });
    }
  }
  async execute(job: Job, lane: string, signal: AbortSignal) {
    try {
      if (job.kind === 'media_process') {
        await executeMediaOperation(this.store, this.root, job, signal);
        return;
      }
      if (job.kind === 'previs') {
        await renderDirectorJob(this.store, this.root, job, signal);
        return;
      }
      if (['media_analysis', 'transcription'].includes(job.kind)) {
        await executeNodeAnalysis(
          this.store,
          this.root,
          job,
          signal,
          this.requestModel,
          this.runCreative,
        );
        return;
      }
      if (['voice_clone', 'speech', 'lipsync'].includes(job.kind)) {
        await executeSpeechJob(this.store, this.root, job, signal, this.requestModel);
        return;
      }
      if (!job.projectId) throw new Error('项目任务缺少归属');
      if (
        job.state === 'queued' &&
        job.input.creationRunId &&
        this.store.get(job.input.creationRunId).data.schemaVersion !== 9
      )
        throw new Error('当前程序仅支持 V9 生产；尚未调用模型');
      if (
        job.kind === 'image' ||
        (job.kind === 'generation' &&
          job.input.modelExecution &&
          job.input.modelExecution.protocol !== 'comfy-h3')
      ) {
        await executeProviderMedia(
          this.store,
          this.root,
          job,
          this.owner,
          signal,
          this.requestModel,
        );
      } else if (job.kind === 'generation') {
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
        const apiText = job.input.modelExecution && job.input.modelExecution.protocol !== 'codex';
        const unknown = job.state === 'unknown';
        if (unknown && !apiText) return;
        this.store.patchJob(job.id, {
          state: apiText ? (unknown ? 'unknown' : 'preparing') : 'running',
          error: null,
        });
        const executionDir =
          (job.input.modelExecution && job.output.executionDir) ||
          inside(this.root, `jobs/${job.id}/runs/${this.owner}`);
        this.store.patchJob(job.id, { output: { ...job.output, executionDir } });
        let proposal;
        if (apiText) {
          const result = await runTextModel(
            this.store,
            job.input.context,
            executionDir,
            signal,
            this.requestModel,
            unknown,
            () => {
              signal.throwIfAborted();
              assertAssistantMaySubmit(this.store, job);
              if (this.store.job(job.id).cancelRequested) throw new HttpError(409, '提交前已取消');
              const enabled = this.store.db
                .prepare('SELECT data FROM model_connections WHERE id=?')
                .get(job.input.modelExecution.connection.id);
              if (
                !enabled ||
                !modelAvailable(JSON.parse(String(enabled.data)), job.input.modelExecution.modelId)
              ) {
                this.store.patchJob(job.id, {
                  state: 'queued',
                  holdReason: 'model_connection_disabled',
                });
                throw new HttpError(409, '提交前连接已停用');
              }
              this.store.patchJob(job.id, { state: 'submitting' });
            },
            this.root,
          );
          proposal = result.result;
          this.store.patchJob(job.id, {
            state: 'running',
            output: {
              ...this.store.job(job.id).output,
              providerReceipt: result.receipt,
              descriptor: { textResponseFile: path.join(executionDir, 'response.json') },
            },
          });
        } else {
          const secret = job.input.modelExecution
            ? await resolveCredential(
                this.store,
                job.input.modelExecution.connection.data.credential,
              )
            : null;
          if (job.input.modelExecution) {
            signal.throwIfAborted();
            assertAssistantMaySubmit(this.store, job);
            if (this.store.job(job.id).cancelRequested) throw new HttpError(409, '提交前已取消');
            const currentConnection = this.store.db
              .prepare('SELECT data FROM model_connections WHERE id=?')
              .get(job.input.modelExecution.connection.id);
            if (
              !currentConnection ||
              !modelAvailable(
                JSON.parse(String(currentConnection.data)),
                job.input.modelExecution.modelId,
              )
            ) {
              this.store.patchJob(job.id, {
                state: 'queued',
                holdReason: 'model_connection_disabled',
              });
              return;
            }
          }
          proposal = await this.runCreative(
            job.input.context,
            executionDir,
            signal,
            secret ? { ...process.env, STUDIO_TASK_API_KEY: secret } : undefined,
          );
        }
        signal.throwIfAborted();
        const assistant = job.input.context.mode === 'assistant';
        const season = job.input.context.mode === 'series_proposal';
        const discussion = job.input.context.mode === 'discussion';
        const doc = season
          ? new SeriesProposals(this.store).complete(job, proposal)
          : assistant
            ? new ProductionAssistant(this.store, this.root).completeDecision(job, proposal)
            : discussion
              ? new CreationMediaService(this.store, this.root).completeDiscussion(job, proposal)
              : new CreationService(this.store).complete(job, proposal);
        if (
          !discussion &&
          !assistant &&
          !season &&
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
            ...(season
              ? { seriesProposalId: doc.id }
              : assistant
                ? { assistantRunId: doc.id }
                : discussion
                  ? { messageId: doc.id }
                  : { authoringResultId: doc.id }),
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
        if (job.input.canvas || job.input.purpose === 'candidate_review' || job.input.deliveryPlan)
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
      if (current.state === 'queued' && current.holdReason) return;
      const networkStage =
        ['generation', 'image', 'creative', 'voice_clone', 'speech', 'lipsync'].includes(
          job.kind,
        ) &&
        [
          'unknown',
          'submitted',
          ...(['generation', 'voice_clone', 'speech', 'lipsync'].includes(job.kind)
            ? ['running']
            : []),
        ].includes(current.state);
      if (this.stopped) return;
      if (
        job.kind === 'creative' &&
        job.input.modelExecution &&
        ['submitting', 'unknown'].includes(current.state) &&
        current.output.executionDir
      ) {
        const responseFile = path.join(current.output.executionDir, 'response.json');
        if (
          await fs.access(responseFile).then(
            () => true,
            () => false,
          )
        ) {
          this.store.patchJob(job.id, {
            state: 'failed',
            output: { ...current.output, descriptor: { textResponseFile: responseFile } },
            error: e.message || String(e),
          });
          return;
        }
      }
      const rejected =
        (e instanceof ModelHttpError ||
          (['voice_clone', 'speech', 'lipsync'].includes(job.kind) && e instanceof HttpError)) &&
        [400, 401, 402, 403, 404, 413, 422, 429].includes(e.status);
      this.store.patchJob(job.id, {
        state:
          rejected && current.state === 'submitting'
            ? 'failed'
            : job.input.modelExecution && current.state === 'submitting'
              ? 'unknown'
              : networkStage
                ? current.state
                : current.cancelRequested
                  ? 'cancelled'
                  : 'failed',
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
      if (job.input.modelExecution) {
        const currentConnection = this.store.db
          .prepare('SELECT data FROM model_connections WHERE id=?')
          .get(job.input.modelExecution.connection.id);
        if (
          !currentConnection ||
          !modelAvailable(
            JSON.parse(String(currentConnection.data)),
            job.input.modelExecution.modelId,
          )
        ) {
          this.store.patchJob(job.id, { state: 'queued', holdReason: 'model_connection_disabled' });
          return;
        }
      }
      assertAssistantMaySubmit(this.store, job);
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
    await archiveVideoCandidate(
      this.store,
      this.root,
      job,
      this.owner,
      () => {
        const d = job.output.descriptor;
        const params = new URLSearchParams({
          filename: d.filename,
          subfolder: d.subfolder || '',
          type: d.type || 'output',
        });
        return client.request('/view?' + params, {}, 120000);
      },
      signal,
    );
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
