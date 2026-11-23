import { z } from 'zod';
import { DeliveryService } from './delivery.js';
import { projectModelCapabilities } from './capabilities.js';
import { ModelRegistry } from './model-registry.js';
import { productionHead, activateProductionHead } from './creation-heads.js';
import { Store, HttpError } from './db.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { generationDigest } from './h3-guided.js';
import { predecessorCanon } from './series-production.js';
import {
  effectiveEpisodePlan,
  episodePredecessor,
  assertEpisodePlanCurrent,
} from './episode-plan.js';
import { subjectBindingIssues } from './subject-bindings.js';
import { adaptationIntentSchema, type AdaptationIntent } from '../shared/adaptation.js';
import { validateAdaptationIntent, indexedSource } from './source-adaptation.js';
import { authoringPrompt, authoringRegistry, authoringRules } from './creation-prompts.js';
import { validateAuthoringResult } from '../shared/creation-validation.js';
import { mergeLocalAuthoring } from '../shared/authoring-replacement.js';
import { referenceCoverageBasis } from '../shared/reference-coverage.js';
import {
  authoringSchemas,
  authoringStages,
  creationSettingsSchema,
  creationRefSchema,
  inferDurationIntent,
  type AuthoringContext,
  type AuthoringResult,
  type AuthoringStage,
  type CreationIssue,
  type CreationRef,
  type CreationSettings,
} from '../shared/creation.js';
import type { Job, RecordDoc } from '../shared/contracts.js';
import { scopeData, validateScopedRevision } from './workspace.js';
import {
  scopedRevisionSchema,
  scopeSubjectKeys,
  requirementInScope,
  referenceStartGroup,
  type ScopedRevision,
} from '../shared/workspace.js';
import { prepareCreationProduction, creationMediaStatus } from './creation-production.js';

const initialStages: AuthoringStage[] = ['brief', 'script', 'direction', 'director', 'assets'];
const ref = (doc: RecordDoc): CreationRef => ({ id: doc.id, revision: doc.revision });
export class CreationService {
  constructor(public store: Store) {}

  activate(runId: string, raw: unknown) {
    const input = z
      .object({
        runRevision: z.number().int().positive(),
        expectedHeadRevision: z.number().int().nonnegative(),
        expectedPreviousRunId: z.string().nullable(),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const run = this.get(runId);
      const prior = (run.data.activations || []).find((r: any) => r.key === input.idempotencyKey);
      if (prior) {
        if (prior.digest !== generationDigest(input))
          throw new HttpError(409, '激活幂等键用于不同内容');
        return { run, head: prior.head };
      }
      if (run.data.schemaVersion !== 9 || run.revision !== input.runRevision || run.data.paused)
        throw new HttpError(409, '运行版本或状态已变化');
      const results = this.adopted(run);
      if (['brief', 'script', 'direction', 'director', 'assets'].some((s) => !run.data.results[s]))
        throw new HttpError(409, '专业制作头需要完整的前置结果；自由制作可以从画布开始');
      const scope = this.store.get(run.data.scope.id, run.data.scope.revision);
      const shots =
        results.director?.stage === 'director'
          ? results.director.shots.filter((s) => scope.data.shotIds.includes(s.id))
          : [];
      if (results.assets?.stage === 'assets' && results.script?.stage === 'script') {
        for (const item of results.assets.items.filter((i) =>
          requirementInScope(i, results.script as any, shots),
        )) {
          const binding = run.data.bindings[item.id];
          if (!binding || binding.requirementDigest !== generationDigest(item))
            throw new HttpError(409, `请先确认本次范围的实际参考：${item.id}`);
          if (
            binding.subjectDigest !==
            generationDigest(results.script.subjects.find((s) => s.key === item.subjectKey) || null)
          )
            throw new HttpError(409, '主体内容已变化，请重新确认参考');
          const asset = this.inputRecord(run.projectId, binding.asset);
        }
      }
      if (this.store.get(run.data.episodeId).revision !== run.data.targetRevision)
        throw new HttpError(409, '分集版本已变化，请重新核对当前制作依据');
      const head = activateProductionHead(
        this.store,
        run,
        input.expectedHeadRevision,
        input.expectedPreviousRunId,
      );
      const next = this.store.update(run.id, run.revision, {
        ...run.data,
        activated: true,
        state: 'active',
        activations: [
          ...(run.data.activations || []),
          { key: input.idempotencyKey, digest: generationDigest(input), head },
        ],
      });
      return { run: next, head };
    });
  }

  settings(projectId: string) {
    new StudioService(this.store).project(projectId);
    return (
      this.store.list('creation_settings', projectId)[0] || {
        id: null,
        revision: 0,
        data: { policy: creationSettingsSchema.parse({}), providerDigest: null },
      }
    );
  }
  saveSettings(projectId: string, revision: number, raw: unknown) {
    const policy = creationSettingsSchema.parse(raw);
    return this.store.transaction(() => {
      const old = this.settings(projectId);
      if (old.revision !== revision) throw new HttpError(409, '项目创作设置已变化');
      const providerDigest = generationDigest(this.store.setting('comfy', null));
      const data = { policy, providerDigest, confirmedBy: 'user', confirmedAt: Date.now() };
      const next = old.id
        ? this.store.update(old.id, revision, data)
        : this.store.create('creation_settings', projectId, data, projectId);
      if (old.data.policy.progression === 'automatic' && policy.progression === 'review') {
        for (const job of this.store
          .jobs(projectId)
          .filter(
            (j) =>
              j.state === 'queued' &&
              j.input.creationRunId &&
              (!j.holdReason || j.holdReason === 'creation_paused'),
          ))
          this.store.patchJob(job.id, { holdReason: 'creation_mode_review' });
      }
      if (old.data.policy.progression === 'review' && policy.progression === 'automatic') {
        for (const job of this.store
          .jobs(projectId)
          .filter(
            (j) =>
              j.state === 'queued' &&
              j.input.creationRunId &&
              j.holdReason === 'creation_mode_review',
          ))
          this.store.patchJob(job.id, {
            holdReason: this.get(job.input.creationRunId).data.paused ? 'creation_paused' : null,
          });
      }
      for (const run of this.store
        .list('creation_run', projectId)
        .filter((r) => r.data.state !== 'complete')) {
        if (old.data.policy.progression !== policy.progression)
          this.store.update(run.id, run.revision, {
            ...run.data,
            productionPreview: null,
            productionApproval: null,
            state: run.data.paused ? 'paused' : 'active',
          });
        if (
          generationDigest(old.data.policy.duration) !== generationDigest(policy.duration) ||
          generationDigest(old.data.policy.output) !== generationDigest(policy.output)
        ) {
          if (run.data.effectivePlan?.series) {
            const currentPlan = effectiveEpisodePlan(
              this.store,
              this.store.get(run.data.episodeId),
            );
            if (
              generationDigest({ duration: currentPlan.duration, canvas: currentPlan.canvas }) ===
              generationDigest({
                duration: run.data.effectivePlan.duration,
                canvas: run.data.effectivePlan.canvas,
              })
            )
              continue;
          }
          const current = initialStages.indexOf(run.data.stage);
          this.revise(
            run.id,
            current >= 0 && current < 3 ? run.data.stage : 'director',
            '项目交付时长或画布要求已改变',
            [],
            false,
          );
        }
      }
      return next;
    });
  }
  allowance(projectId: string) {
    const { data } = this.settings(projectId);
    const jobs = this.store
      .jobs(projectId)
      .filter((j) => j.kind === 'generation' && j.input.creationCharge);
    const seconds = jobs.reduce((n, j) => n + j.input.creationCharge.seconds, 0);
    return {
      ...data.policy.allowance,
      usedGenerations: jobs.length,
      usedSeconds: seconds,
      remainingGenerations: Math.max(0, data.policy.allowance.maxGenerations - jobs.length),
      remainingSeconds: Math.max(0, data.policy.allowance.maxGeneratedSeconds - seconds),
    };
  }
  get(id: string) {
    const run = this.store.get(id);
    if (run.kind !== 'creation_run') throw new HttpError(400, '不是创作运行');
    return run;
  }
  inspect(id: string) {
    const run = this.get(id);
    const results = this.store
      .list('authoring_result', run.projectId)
      .filter((r) => r.parentId === id);
    const jobs = this.store
      .jobs(run.projectId)
      .filter((j) => j.input.creationRunId === id || j.input.context?.runId === id)
      .map(({ input, ...job }) => ({
        ...job,
        stage: input.context?.stage || input.segment?.id || 'export',
        epoch: input.creationEpoch ?? input.context?.epoch,
      }));
    const episode = this.store.get(run.data.episodeId);
    return {
      run,
      episode,
      results,
      jobs,
      settings: this.settings(run.projectId),
      allowance: this.allowance(run.projectId),
      media: creationMediaStatus(this.store, run),
      productionHead: productionHead(this.store, run.data.episodeId),
      deliveryPlans: this.store
        .list('creation_delivery_plan', run.projectId)
        .filter((p) => p.parentId === run.id),
    };
  }
  create(projectId: string, raw: unknown) {
    const request = z
      .object({
        request: z.string().trim().min(1).max(100000),
        episodeId: z.string().optional(),
        sources: z.array(creationRefSchema).max(100).default([]),
        adaptation: adaptationIntentSchema.optional(),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const old = this.store
        .list('creation_run', projectId)
        .find((r) => r.data.idempotencyKey === request.idempotencyKey);
      if (old) {
        if (old.data.requestDigest !== generationDigest(request))
          throw new HttpError(409, '创作幂等键用于不同请求');
        return old;
      }
      const service = new StudioService(this.store),
        project = service.project(projectId);
      const policy = this.settings(projectId).data.policy as CreationSettings;
      if (!this.settings(projectId).id)
        this.store.create(
          'creation_settings',
          projectId,
          { policy, providerDigest: null, confirmedBy: null },
          projectId,
        );
      if (!request.episodeId && project.data.mode === 'series')
        throw new HttpError(400, '长篇创作请先选择明确分集；整季规划仍由系列制作入口维护');
      const episode = request.episodeId
        ? service.owned(request.episodeId, projectId, 'episode')
        : service.createEpisode(projectId, { title: request.request.slice(0, 40) });
      for (const source of request.sources) this.inputRecord(projectId, source);
      if (request.adaptation)
        validateAdaptationIntent(this.store, projectId, request.adaptation, request.sources);
      if (
        request.adaptation?.mode === 'faithful_adaptation' &&
        !request.sources.length &&
        !episode.data.script?.trim()
      )
        throw new HttpError(400, '忠实改编需要固定原文或本集已有剧本；从一句创意起步请选择原创');
      const effectivePlan = effectiveEpisodePlan(this.store, episode, request.request);
      const run = this.store.create(
        'creation_run',
        projectId,
        {
          schemaVersion: 9,
          productionRevision: 2,
          adaptation: request.adaptation || {
            version: 1,
            mode: request.sources.length ? 'faithful_adaptation' : 'original',
            preserve: [],
            allow: [],
            pending: [],
            decisions: [],
          },
          subjectBindings: [],
          request: request.request,
          requestDigest: generationDigest(request),
          idempotencyKey: request.idempotencyKey,
          episodeId: episode.id,
          targetRevision: episode.revision,
          sources: request.sources,
          duration: effectivePlan.duration,
          effectivePlan,
          stage: 'brief',
          state: 'active',
          epoch: 1,
          results: {},
          pendingJobId: null,
          messages: [{ role: 'user', text: request.request, at: Date.now() }],
          issues: [],
          bindings: {},
          mappings: {},
          decisions: [],
          paused: false,
          materialized: null,
          exportJobId: null,
          executionProfileDigest: generationDigest(this.store.setting('comfy', null)),
        },
        episode.id,
      );
      const head = productionHead(this.store, episode.id);
      if (head.runId === run.id && head.revision === 0)
        this.store.db.prepare('INSERT INTO creation_heads VALUES(?,?,1)').run(episode.id, run.id);
      const scope = this.store.create(
        'creation_scope',
        projectId,
        scopeData(
          this.store,
          run,
          { name: '完整作品', mode: 'full', shotIds: [], groupIds: [] },
          1,
        ),
        run.id,
      );
      this.store.update(run.id, run.revision, { ...run.data, scope: ref(scope) });
      this.advance(run.id);
      return this.get(run.id);
    });
  }
  inputRecord(projectId: string, reference: CreationRef) {
    const doc = this.store.get(reference.id, reference.revision),
      head = this.store.get(reference.id);
    if (
      doc.projectId !== projectId ||
      ['creation_run', 'creation_settings', 'creation_delivery'].includes(doc.kind)
    )
      throw new HttpError(400, '来源不属于项目或不是创作资料');
    if (doc.data.stale || head.data.stale || doc.data.archived || head.data.archived)
      throw new HttpError(409, '来源已纠正或归档，需要复核');
    return doc;
  }
  adopted(run: RecordDoc): Partial<Record<AuthoringStage, AuthoringResult>> {
    const results: Partial<Record<AuthoringStage, AuthoringResult>> = {};
    for (const [stage, reference] of Object.entries(run.data.results) as [
      AuthoringStage,
      CreationRef,
    ][]) {
      const result = this.store.get(reference.id, reference.revision),
        head = this.store.get(result.id);
      if (result.parentId !== run.id || !result.data.adopted || head.data.stale)
        throw new HttpError(409, '专业结果已变化，需要重新采用');
      for (const dependency of result.data.context.dependencies as CreationRef[]) {
        const source = this.inputRecord(run.projectId, dependency);
        if (this.store.get(source.id).revision !== dependency.revision)
          throw new HttpError(409, `创作依据 ${source.id} 已有新版本，请从受影响阶段修订`);
      }
      results[stage] = result.data.result;
    }
    return results;
  }
  context(
    id: string,
    stage: AuthoringStage,
    repairIssues: CreationIssue[] = [],
    repairCandidate?: unknown,
  ): AuthoringContext {
    const run = this.get(id),
      service = new StudioService(this.store);
    if (run.data.schemaVersion !== 9) throw new HttpError(409, '当前程序仅支持 V9 创作');
    const episode = service.owned(run.data.episodeId, run.projectId, 'episode');
    if (episode.revision !== run.data.targetRevision)
      throw new HttpError(409, '分集在其他编辑器中更新，请发送修订指令以重新读取');
    const settings = structuredClone(this.settings(run.projectId).data.policy) as CreationSettings;
    settings.duration = run.data.duration;
    if (run.data.effectivePlan) {
      assertEpisodePlanCurrent(this.store, run);
      settings.output = {
        ...settings.output,
        width: run.data.effectivePlan.canvas.width,
        height: run.data.effectivePlan.canvas.height,
      };
    }
    const all = this.adopted(run),
      priorResults: Partial<Record<AuthoringStage, AuthoringResult>> = {};
    for (const name of authoringRegistry[stage].predecessors) {
      if (!all[name]) throw new HttpError(409, `前置阶段 ${name} 尚未采用`);
      priorResults[name] = all[name];
    }
    const docs = run.data.sources
      .filter((r: CreationRef) => r.id !== episode.id)
      .map((r: CreationRef) => this.inputRecord(run.projectId, r));
    for (const reference of Object.values(run.data.results) as CreationRef[])
      docs.push(this.inputRecord(run.projectId, reference));
    for (const binding of run.data.subjectBindings || [])
      if (binding.decision === 'reuse') docs.push(this.inputRecord(run.projectId, binding.entity));
    if (episode.data.seriesProduction) {
      const chain = predecessorCanon(this.store, episode, true);
      if (chain.canon) docs.push(chain.canon);
      if (chain.story) docs.push(chain.story);
    }
    const profile = episode.data.seriesProduction ? this.store.get(episode.data.seriesId) : null;
    const profileRef = profile?.data.production?.profile;
    if (profileRef) {
      docs.push(profile!, this.inputRecord(run.projectId, profileRef));
      for (const reference of profile!.data.production.sharedReferences || [])
        docs.push(this.inputRecord(run.projectId, reference));
      for (const voice of profile!.data.production.voices || [])
        docs.push(this.inputRecord(run.projectId, voice.profile));
    }
    const moduleRefs = profileRef
      ? this.store.get(profileRef.id, profileRef.revision).data.composition.moduleRefs
      : [];
    const modules = moduleRefs.map((r: CreationRef) => this.inputRecord(run.projectId, r));
    docs.push(...modules);
    if (stage === 'editorial') {
      const media = creationMediaStatus(this.store, run);
      for (const group of media.groups) {
        if (group.selection) docs.push(this.inputRecord(run.projectId, group.selection));
        for (const part of group.parts)
          docs.push(
            this.inputRecord(run.projectId, part.video),
            ...(part.review ? [this.inputRecord(run.projectId, part.review)] : []),
          );
      }
      for (const cue of media.currentEdl?.data.audio || [])
        docs.push(this.inputRecord(run.projectId, { id: cue.assetId, revision: cue.revision }));
    }
    const unique = [
      ...new Map<string, RecordDoc>(
        docs.map((d: RecordDoc) => [`${d.id}:${d.revision}`, d]),
      ).values(),
    ];
    const records: AuthoringContext['records'] = unique
      .filter((d) => d.kind !== 'authoring_result')
      .map((d) => ({
        id: d.id,
        revision: d.revision,
        kind: d.kind,
        data:
          d.kind === 'asset'
            ? {
                name: d.data.name,
                mediaType: d.data.mediaType,
                sha256: d.data.sha256,
                duration: d.data.duration,
                adopted: d.data.adopted,
              }
            : d.kind === 'creative_module'
              ? { name: d.data.name, category: d.data.category }
              : indexedSource(this.store, d).data,
      }));
    records.push({
      id: episode.id,
      revision: episode.revision,
      kind: 'episode_source',
      data: {
        title: episode.data.title,
        script: ['brief', 'script'].includes(stage) ? episode.data.script : undefined,
        summary: episode.data.summary,
        seriesProduction: episode.data.seriesProduction,
      },
    });
    if (stage === 'editorial')
      records.push({
        id: run.id,
        revision: run.revision,
        kind: 'actual_timeline',
        data: creationMediaStatus(this.store, run),
      });
    if (repairCandidate !== undefined)
      records.push({
        id: run.id,
        revision: run.revision,
        kind: 'invalid_candidate',
        data: repairCandidate,
      });
    const context: AuthoringContext = {
      schemaVersion: 9,
      runId: id,
      epoch: run.data.epoch,
      stage,
      projectId: run.projectId,
      request: run.data.request,
      target: ref(episode),
      settings,
      effectivePlan: run.data.effectivePlan,
      predecessor: episodePredecessor(this.store, episode),
      adaptation: run.data.adaptation,
      subjectBindings: run.data.subjectBindings,
      dependencies: [
        ...unique.map(ref),
        ...unique
          .filter((d) => d.kind === 'source_index')
          .flatMap((d) => d.data.entries.map((e: any) => e.source)),
      ],
      records,
      priorResults,
      ...(run.data.writable?.stage === stage
        ? {
            localProtocol: 'local-authoring-v1' as const,
            writable: {
              baseline: run.data.writable.baseline,
              baselineResult: this.store.get(
                run.data.writable.baseline.id,
                run.data.writable.baseline.revision,
              ).data.result,
              shotIds: run.data.writable.shotIds,
              sceneIds: run.data.writable.sceneIds,
              subjectKeys: run.data.writable.subjectKeys || [],
            },
          }
        : {}),
      repairIssues,
      rules: authoringRules(stage, modules, run.data.adaptation?.method),
      capabilities: projectModelCapabilities(this.store, run.projectId, run.data.episodeId),
      modelExecution:
        new ModelRegistry(this.store).resolve(run.projectId, run.data.episodeId, 'text', stage) ||
        undefined,
      executionRevision: 1,
      digest: '',
    };
    if (authoringPrompt(context).length > 300000)
      throw new HttpError(400, '创作资料超出300000字符预算，请按分集缩小来源；未截断关键事实');
    context.contractRevision = 2;
    for (const dependency of context.modelExecution?.dependencies || [])
      if (
        !context.dependencies.some(
          (d) => d.id === dependency.id && d.revision === dependency.revision,
        )
      )
        context.dependencies.push(dependency);
    context.digest = generationDigest({ ...context, digest: '' });
    return context;
  }
  complete(job: Job, raw: unknown) {
    const context = job.input.context as AuthoringContext,
      run = this.get(context.runId);
    if (context.schemaVersion !== 9 || run.data.schemaVersion !== 9)
      throw new HttpError(409, '当前程序仅处理 V9 创作上下文');
    if (
      context.projectId !== job.projectId ||
      context.digest !== generationDigest({ ...context, digest: '' })
    )
      throw new HttpError(400, '创作上下文摘要不匹配');
    let candidate = raw;
    let replacementError = '';
    if (context.localProtocol === 'local-authoring-v1' && (raw as any)?.protocol) {
      try {
        candidate = mergeLocalAuthoring(context, raw);
      } catch (error: any) {
        replacementError = error.message;
      }
    }
    const parsed = authoringSchemas[context.stage].safeParse(candidate);
    const issues: CreationIssue[] = parsed.success
      ? validateAuthoringResult(parsed.data, context.priorResults, context.settings)
      : parsed.error.issues.map((i) => ({
          code: 'output_contract',
          category: 'data',
          severity: 'blocking',
          stage: context.stage,
          field: i.path.join('.'),
          targetId: '',
          message: i.message,
        }));
    if (replacementError)
      issues.push({
        code: 'local_replacement',
        category: 'data',
        severity: 'blocking',
        stage: context.stage,
        field: 'protocol',
        targetId: '',
        message: replacementError,
      });
    if (parsed.success && context.writable) {
      try {
        validateScopedRevision(
          this.store,
          {
            ...run,
            data: { ...run.data, writable: { ...context.writable, stage: context.stage } },
          },
          context.stage,
          parsed.data,
        );
      } catch (error: any) {
        issues.push({
          code: 'local_scope',
          category: 'data',
          severity: 'blocking',
          stage: context.stage,
          field: 'writable',
          targetId: '',
          message: error.message,
        });
      }
    }
    if (parsed.success)
      if (parsed.data.contractRevision !== 2)
        issues.push({
          code: 'contract_revision',
          category: 'data',
          severity: 'blocking',
          stage: context.stage,
          field: 'contractRevision',
          targetId: '',
          message: '新作者结果必须明确 contractRevision:2；旧结果只保留原证据，不补造空间数据。',
        });
    if (parsed.success)
      for (const source of new DomainService(this.store).refs(parsed.data)) {
        if (
          !context.dependencies.some((d) => d.id === source.id && d.revision === source.revision) &&
          !(context.target.id === source.id && context.target.revision === source.revision)
        )
          issues.push({
            code: 'invented_source',
            category: 'data',
            severity: 'blocking',
            stage: context.stage,
            field: 'sources',
            targetId: source.id,
            message: '输出引用不在固定上下文中',
          });
      }
    return this.store.transaction(() => {
      const obsolete = run.data.epoch !== context.epoch;
      const doc = this.store.create(
        'authoring_result',
        run.projectId,
        {
          schemaVersion: context.schemaVersion,
          stage: context.stage,
          ordinal: this.store
            .list('authoring_result', run.projectId)
            .filter((d) => d.parentId === run.id).length,
          result: parsed.success ? parsed.data : raw,
          valid:
            parsed.success &&
            !issues.some((i) => i.category === 'data' && i.severity === 'blocking'),
          context,
          dependencies: context.dependencies,
          issues,
          adopted: false,
          stale: obsolete,
          jobId: job.id,
          ...(context.localProtocol
            ? { rawReplacement: raw, localProtocol: context.localProtocol }
            : {}),
          epoch: context.epoch,
        },
        run.id,
      );
      new DomainService(this.store).dependencies(doc, context.dependencies);
      if (!obsolete && run.data.pendingJobId === job.id)
        this.store.update(run.id, run.revision, {
          ...run.data,
          pendingJobId: null,
          state: 'active',
          issues,
        });
      return doc;
    });
  }
  saveResult(id: string, stage: AuthoringStage, raw: unknown, expected: number) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.data.schemaVersion !== 9) throw new HttpError(409, '当前程序仅支持 V9 创作');
      if (run.revision !== expected || run.data.stage !== stage || run.data.paused)
        throw new HttpError(409, '创作运行或当前阶段已变化');
      const currentContext = this.context(id, stage);
      const parsed = authoringSchemas[stage].parse(raw);
      validateScopedRevision(this.store, run, stage, parsed);
      const dataIssues = validateAuthoringResult(
        parsed,
        currentContext.priorResults,
        currentContext.settings,
      ).filter((i) => i.category === 'data' && i.severity === 'blocking');
      if (dataIssues.length) throw new HttpError(400, dataIssues.map((i) => i.message).join('；'));
      const allowed = [...currentContext.dependencies, currentContext.target];
      for (const source of new DomainService(this.store).refs(parsed))
        if (!allowed.some((r) => r.id === source.id && r.revision === source.revision))
          throw new HttpError(400, '草稿引用必须来自固定创作上下文');
      if (run.data.pendingJobId)
        this.store.patchJob(run.data.pendingJobId, { cancelRequested: true });
      this.store.update(id, expected, {
        ...run.data,
        epoch: run.data.epoch + 1,
        pendingJobId: null,
      });
      const context = this.context(id, stage);
      const saved = this.complete(
        { id: '', projectId: run.projectId, input: { context } } as Job,
        raw,
      );
      this.approve(id, saved.id, saved.revision, `save:${saved.id}:${saved.revision}`);
      return this.store.get(saved.id);
    });
  }
  editResult(
    id: string,
    stage: AuthoringStage,
    raw: unknown,
    expected: number,
    baseline: CreationRef,
    scope?: { shotIds: string[]; sceneIds: string[]; subjectKeys?: string[] },
  ) {
    return this.store.transaction(() => {
      const run = this.get(id),
        current = run.data.results[stage];
      if (
        run.revision !== expected ||
        !current ||
        current.id !== baseline.id ||
        current.revision !== baseline.revision
      )
        throw new HttpError(409, '编辑依据不是当前已采用版本');
      const revised = this.revise(
        id,
        stage,
        `专业编辑器修订 ${stage}：${scope ? '指定对象' : '完整阶段'}`,
        [],
        false,
        scope ? { ...scope, baseline } : undefined,
      );
      return this.saveResult(id, stage, raw, revised.revision);
    });
  }
  approve(
    id: string,
    resultId: string,
    revision: number,
    key: string,
    actor: 'user' | 'agent' = 'user',
  ) {
    return this.store.transaction(() => {
      const run = this.get(id),
        doc = this.store.get(resultId);
      const receipt = run.data.decisions.find((d: any) => d.key === key);
      if (receipt) {
        if (receipt.resultId !== resultId || receipt.requestRevision !== revision)
          throw new HttpError(409, '确认键用于不同专业结果');
        return run;
      }
      if (
        doc.data.adopted &&
        run.data.results?.[doc.data.stage]?.id === doc.id &&
        run.data.results[doc.data.stage].revision === doc.revision &&
        (revision === doc.revision || revision === doc.revision - 1)
      )
        return run;
      if (run.data.schemaVersion !== 9) throw new HttpError(409, '当前程序仅允许采用 V9 作者结果');
      if (
        run.data.paused ||
        doc.parentId !== id ||
        doc.kind !== 'authoring_result' ||
        doc.revision !== revision ||
        doc.data.epoch !== run.data.epoch ||
        doc.data.stale
      )
        throw new HttpError(409, '结果版本或运行状态已变化');
      if (run.data.stage !== doc.data.stage)
        throw new HttpError(409, '只能采用当前专业阶段；修改已采用结果请先发起该阶段修订');
      const context = doc.data.context as AuthoringContext;
      if (this.store.get(context.target.id).revision !== context.target.revision)
        throw new HttpError(409, '目标分集已变化');
      for (const dependency of context.dependencies) {
        const head = this.store.get(dependency.id);
        this.inputRecord(run.projectId, dependency);
        if (head.revision !== dependency.revision) throw new HttpError(409, '创作来源版本已经变化');
      }
      const parsed = authoringSchemas[doc.data.stage as AuthoringStage].safeParse(doc.data.result);
      if (!parsed.success) throw new HttpError(400, '结果结构尚未通过校验');
      if (parsed.data.stage === 'script') {
        const mappingIssues = subjectBindingIssues(this.store, run, parsed.data);
        // Mapping suggestions do not prevent saving a script. Actual references are checked at preparation.
        doc.data.mappingNotes = mappingIssues;
      }
      validateScopedRevision(this.store, run, doc.data.stage, parsed.data);
      const issues = validateAuthoringResult(parsed.data, context.priorResults, context.settings);
      issues.push(...doc.data.issues.filter((i: CreationIssue) => i.code === 'invented_source'));
      const blockers = issues.filter((i) => i.severity === 'blocking' && i.category === 'data');
      if (blockers.length) throw new HttpError(409, blockers.map((i) => i.message).join('；'));
      const accepted = this.store.update(doc.id, doc.revision, {
        ...doc.data,
        adopted: true,
        adoptedBy: actor,
        adoptedAt: Date.now(),
        ...(parsed.data.stage === 'script' && run.data.subjectBindings
          ? { subjectBindings: run.data.subjectBindings }
          : {}),
      });
      new DomainService(this.store).dependencies(accepted, context.dependencies);
      const results = { ...run.data.results, [doc.data.stage]: ref(accepted) };
      const currentResults = Object.fromEntries(
        Object.entries(results).map(([stage, reference]) => [
          stage,
          this.store.get((reference as CreationRef).id, (reference as CreationRef).revision).data
            .result,
        ]),
      ) as Partial<Record<AuthoringStage, AuthoringResult>>;
      const resultInvalidations = Object.entries(currentResults).flatMap(([stage, result]) => {
        if (stage === doc.data.stage) return [];
        const problems = validateAuthoringResult(result!, currentResults, context.settings).filter(
          (i) => i.severity === 'blocking' && i.category === 'data',
        );
        if (!problems.length) return [];
        const prior = (run.data.resultInvalidations || []).find(
          (entry: any) => entry.stage === stage,
        );
        const writable = run.data.writable;
        const director = currentResults.director;
        const shotIds = [
          ...new Set<string>([
            ...(prior?.shotIds || []),
            ...(writable?.shotIds || []),
            ...(director?.stage === 'director'
              ? director.shots
                  .filter(
                    (s) =>
                      writable?.sceneIds.includes(s.sceneId) ||
                      [
                        ...scopeSubjectKeys(
                          currentResults.script?.stage === 'script'
                            ? currentResults.script
                            : undefined,
                          [s],
                        ),
                      ].some((key) => writable?.subjectKeys?.includes(key)),
                  )
                  .map((s) => s.id)
              : []),
          ]),
        ];
        return [{ stage, shotIds, issues: problems, basis: results[doc.data.stage] }];
      });
      const index = initialStages.indexOf(doc.data.stage);
      const nextStage =
        doc.data.stage === 'editorial'
          ? 'delivery'
          : initialStages.slice(index + 1).find((stage) => !results[stage]) || 'production';
      let next = this.store.update(run.id, run.revision, {
        ...run.data,
        results,
        resultInvalidations,
        stage: nextStage,
        state: 'active',
        issues: resultInvalidations.flatMap((entry) => entry.issues),
        decisions: [
          ...run.data.decisions,
          {
            key,
            resultId,
            requestRevision: revision,
            accepted: ref(accepted),
            actor,
            epoch: run.data.epoch,
            at: Date.now(),
          },
        ],
      });
      if (next.data.scope) {
        const scope = this.store.get(next.data.scope.id);
        if (scope.data.mode === 'full' && (scope.data.pending || !scope.data.authoring.assets)) {
          const updated = this.store.update(
            scope.id,
            scope.revision,
            scopeData(
              this.store,
              next,
              {
                name: scope.data.name,
                mode: 'full',
                shotIds: [],
                groupIds: [],
                output: scope.data.output,
                continuations: scope.data.continuations,
              },
              scope.revision + 1,
            ),
          );
          new DomainService(this.store).dependencies(updated, [
            ...(Object.values(updated.data.authoring) as CreationRef[]),
            ...new DomainService(this.store).refs(updated.data.continuations || {}),
          ]);
          next = this.store.update(next.id, next.revision, { ...next.data, scope: ref(updated) });
        }
      }
      return next;
    });
  }
  revise(
    id: string,
    stage: AuthoringStage,
    request: string,
    sources: CreationRef[] = [],
    rebase = true,
    writable?: ScopedRevision,
    adaptation?: AdaptationIntent,
  ) {
    return this.store.transaction(() => {
      const run = this.get(id),
        order = [...initialStages, 'editorial'];
      if (run.data.schemaVersion !== 9) throw new HttpError(409, '当前程序仅支持 V9 修订');
      if (writable) {
        writable = scopedRevisionSchema.parse(writable);
        const baseline = this.store.get(writable.baseline.id, writable.baseline.revision);
        const current = run.data.results[stage];
        if (
          !['script', 'director'].includes(stage) ||
          baseline.parentId !== id ||
          baseline.projectId !== run.projectId ||
          baseline.data.stage !== stage ||
          !current ||
          current.id !== baseline.id ||
          current.revision !== baseline.revision
        )
          throw new HttpError(409, '局部修订需要当前已采用的阶段版本');
        const result = baseline.data.result;
        if (
          (writable.subjectKeys || []).some(
            (key) =>
              !(
                stage === 'script'
                  ? result.subjects
                  : this.adopted(run).script?.stage === 'script'
                    ? (this.adopted(run).script as any).subjects
                    : []
              )?.some((s: any) => s.key === key),
          ) ||
          writable.shotIds.some((key) => !result.shots?.some((s: any) => s.id === key)) ||
          writable.sceneIds.some((key) =>
            stage === 'script'
              ? !result.scenes.some((s: any) => s.id === key)
              : !result.shots.some((s: any) => s.sceneId === key),
          )
        )
          throw new HttpError(400, '可修改对象不存在');
      }
      if (
        order.some((name) => order.indexOf(name) < order.indexOf(stage) && !run.data.results[name])
      )
        throw new HttpError(409, '修订阶段不能跳过尚未采用的前置成果');
      const affected = order.slice(order.indexOf(stage));
      const results = { ...run.data.results };
      for (const name of affected) {
        if (results[name] && !writable) {
          const doc = this.store.get(results[name].id);
          this.store.update(doc.id, doc.revision, {
            ...doc.data,
            stale: true,
            staleReason: request,
          });
          delete results[name];
        }
      }
      for (const job of this.store
        .jobs(run.projectId)
        .filter((j) => j.input.creationRunId === id || j.input.context?.runId === id)) {
        if (job.kind === 'creative' && ['queued', 'running'].includes(job.state))
          this.store.patchJob(job.id, { cancelRequested: true });
      }
      const references = sources.length
        ? sources
        : rebase
          ? run.data.sources.map((r: CreationRef) => ref(this.store.get(r.id)))
          : run.data.sources;
      for (const source of references) this.inputRecord(run.projectId, source);
      if (adaptation) validateAdaptationIntent(this.store, run.projectId, adaptation, references);
      const settings = this.settings(run.projectId).data.policy as CreationSettings;
      const effectivePlan = run.data.effectivePlan
        ? effectiveEpisodePlan(this.store, this.store.get(run.data.episodeId), request)
        : null;
      const duration =
        settings.duration.mode === 'derive' ? inferDurationIntent(request) : settings.duration;
      return this.store.update(run.id, run.revision, {
        ...run.data,
        epoch: run.data.epoch + 1,
        ...(adaptation ? { adaptation: adaptationIntentSchema.parse(adaptation) } : {}),
        stage,
        state: 'active',
        paused: false,
        pendingJobId: null,
        issues: [],
        request: run.data.request + '\n\n用户修订：' + request,
        sources: references,
        results,
        duration: effectivePlan
          ? effectivePlan.duration.mode === 'derive'
            ? run.data.duration
            : effectivePlan.duration
          : duration.mode === 'derive'
            ? run.data.duration
            : duration,
        ...(effectivePlan
          ? {
              effectivePlan: {
                ...effectivePlan,
                duration:
                  effectivePlan.duration.mode === 'derive'
                    ? run.data.duration
                    : effectivePlan.duration,
              },
            }
          : {}),
        targetRevision: this.store.get(run.data.episodeId).revision,
        messages: [...run.data.messages, { role: 'user', text: request, at: Date.now() }],
        materialized: stage === 'editorial' ? run.data.materialized : null,
        exportJobId: null,
        edl: null,
        productionApproval: null,
        productionPreview: null,
        bindings: run.data.bindings,
        writable: writable ? { ...writable, stage } : null,
      });
    });
  }
  pause(id: string, revision: number, paused: boolean) {
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.revision !== revision) throw new HttpError(409, '运行状态已变化');
      for (const job of this.store
        .jobs(run.projectId)
        .filter(
          (j) =>
            j.state === 'queued' && (j.input.creationRunId === id || j.input.context?.runId === id),
        )) {
        if (paused && !job.holdReason)
          this.store.patchJob(job.id, { holdReason: 'creation_paused' });
        else if (job.holdReason === 'creation_paused')
          this.store.patchJob(job.id, { holdReason: null });
      }
      return this.store.update(id, revision, {
        ...run.data,
        paused,
        state: paused ? 'paused' : 'active',
      });
    });
  }
  setIssues(id: string, issues: CreationIssue[], state = 'waiting') {
    const run = this.get(id);
    if (generationDigest(run.data.issues) !== generationDigest(issues) || run.data.state !== state)
      return this.store.update(id, run.revision, { ...run.data, issues, state });
    return run;
  }
  advance(id: string) {
    const run = this.get(id);
    if (
      run.data.schemaVersion !== 9 ||
      run.data.paused ||
      run.data.progressOwner?.kind === 'assistant' ||
      run.data.state === 'complete'
    )
      return run;
    const director = run.data.results?.director;
    if (
      !authoringStages.includes(run.data.stage) &&
      director &&
      this.store.get(director.id, director.revision).data.result.contractRevision !== 2
    )
      return run; // Original V9 jobs recover independently; no automatic new creative or production work.
    const policy = this.settings(run.projectId).data.policy as CreationSettings;
    try {
      const head = productionHead(this.store, run.data.episodeId);
      if (!authoringStages.includes(run.data.stage) && head.runId !== run.id) return run;
      const held = this.store
        .jobs(run.projectId)
        .filter(
          (j) =>
            j.input.creationRunId === id &&
            j.state === 'queued' &&
            j.holdReason === 'creation_mode_review',
        );
      if (held.length) {
        const digest = generationDigest(held.map((j) => ({ id: j.id, input: j.input })));
        const preview = {
          digest,
          heldJobIds: held.map((j) => j.id),
          groups: held.map((j) => ({
            id: j.input.segment?.id || 'export',
            seconds: j.input.segment?.duration,
            width: j.input.width,
            height: j.input.height,
            steps: j.input.steps,
            prompt: j.input.prepared || j.input.edl,
          })),
        };
        if (generationDigest(run.data.productionPreview) === generationDigest(preview)) return run;
        return this.store.update(id, run.revision, {
          ...run.data,
          state: 'awaiting_production_approval',
          productionPreview: preview,
          productionApproval: null,
        });
      }
      if (run.data.pendingJobId) {
        const job = this.store.job(run.data.pendingJobId);
        if (!['failed', 'cancelled'].includes(job.state)) return run;
        return this.setIssues(id, [
          {
            code: 'creative_job_failed',
            category: 'execution',
            severity: 'blocking',
            stage: run.data.stage,
            field: '',
            targetId: job.id,
            message: job.error || '文字任务已取消；输入和日志已保留，请明确修订后重试',
          },
        ]);
      }
      if (authoringStages.includes(run.data.stage)) {
        const stage = run.data.stage as AuthoringStage;
        const candidates = this.store
          .list('authoring_result', run.projectId)
          .filter(
            (d) => d.parentId === id && d.data.stage === stage && d.data.epoch === run.data.epoch,
          )
          .sort((a, b) => a.data.ordinal - b.data.ordinal);
        const latest = candidates.at(-1);
        const errors =
          latest?.data.issues.filter(
            (i: CreationIssue) => i.severity === 'blocking' && i.category === 'data',
          ) || [];
        if (latest && !errors.length && latest.data.valid) {
          return this.approve(
            id,
            latest.id,
            latest.revision,
            `auto:${latest.id}:${latest.revision}`,
            'agent',
          );
        }
        if (latest && candidates.length > policy.maxTextRepairs)
          return this.setIssues(id, latest.data.issues, 'needs_revision');
        const context = this.context(id, stage, errors, latest?.data.result);
        return this.store.transaction(() => {
          const fresh = this.get(id);
          if (fresh.revision !== run.revision) return fresh;
          const job = this.store.createJob(
            'creative',
            run.projectId,
            run.data.episodeId,
            {
              context,
              ...(context.modelExecution ? { modelExecution: context.modelExecution } : {}),
            },
            `creation:${id}:${run.data.epoch}:${stage}:${candidates.length}`,
          );
          return this.store.update(id, fresh.revision, {
            ...fresh.data,
            pendingJobId: job.id,
            state: 'working',
            issues: [],
          });
        });
      }
      if (run.data.stage === 'production' || run.data.stage === 'review')
        return prepareCreationProduction(this.store, run, this.adopted(run), policy);
      if (run.data.stage === 'delivery') return new DeliveryService(this.store).advance(run);
      return run;
    } catch (e) {
      if (!(e instanceof HttpError || e instanceof z.ZodError)) throw e;
      return this.setIssues(id, [
        {
          code: 'creation_boundary',
          category: 'execution',
          severity: 'blocking',
          stage: run.data.stage,
          field: '',
          targetId: '',
          message: e.message,
        },
      ]);
    }
  }
  bindAsset(id: string, raw: unknown, actor: 'user' | 'agent' = 'user') {
    const input = z
      .object({
        requirementId: z.string(),
        asset: creationRefSchema,
        asGroupStart: z.boolean().optional(),
        inspected: z.boolean().default(false),
        conclusion: z.string().default(''),
        revision: z.number().int().positive(),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const run = this.get(id);
      if (run.revision !== input.revision) throw new HttpError(409, '运行已变化');
      if (run.data.materialized || !['production', 'assets'].includes(run.data.stage))
        throw new HttpError(
          409,
          '正式输入已冻结；请先修订资产阶段，再替换绑定。已受理任务继续归档。',
        );
      const assets = this.adopted(run).assets;
      if (assets?.stage !== 'assets') throw new HttpError(400, '没有对应的已采用资产需求');
      const item = assets.items.find((i) => i.id === input.requirementId);
      if (!item) throw new HttpError(400, '没有对应的已采用资产需求');
      let groupStart: { groupId: string; shotId: string } | undefined;
      if (input.asGroupStart) {
        const director = this.adopted(run).director;
        const groups = director?.stage === 'director' ? director.groups : [];
        const group = referenceStartGroup(item, groups);
        if (!group)
          throw new HttpError(
            400,
            '首帧约束需要明确属于单一生成组、覆盖其首镜的构图或起始动作图片',
          );
        if (
          assets.items.some(
            (other) =>
              other.id !== item.id && run.data.bindings[other.id]?.groupStart?.groupId === group.id,
          )
        )
          throw new HttpError(400, '同一生成组只能指定一张首帧约束图片');
        groupStart = { groupId: group.id, shotId: group.shotIds[0] };
      }
      const asset = this.inputRecord(run.projectId, input.asset);
      if (asset.kind !== 'asset' || asset.data.mediaType !== item.mediaType)
        throw new HttpError(400, '绑定素材的类型与需求不符，请选择对应图片或音频版本');
      const script = this.adopted(run).script;
      const director = this.adopted(run).director;
      const subject =
        script?.stage === 'script' ? script.subjects.find((s) => s.key === item.subjectKey) : null;
      return this.store.update(id, run.revision, {
        ...run.data,
        bindings: {
          ...run.data.bindings,
          [item.id]: {
            asset: input.asset,
            ...(groupStart ? { groupStart } : {}),
            requirementDigest: generationDigest(item),
            subjectDigest: generationDigest(subject),
            coverage: item.coverage || [],
            coverageDigest:
              director?.stage === 'director'
                ? generationDigest(referenceCoverageBasis(director, item.coverage || []))
                : null,
            inspected: input.inspected,
            conclusion: input.conclusion,
            at: Date.now(),
            reviewer: actor,
          },
        },
        materialized: null,
        state: 'active',
      });
    });
  }
  confirmDelivery(id: string, raw: unknown) {
    const run = this.get(id);
    this.adopted(run);
    return new DeliveryService(this.store).confirm(id, raw);
  }
}
