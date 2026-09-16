import { productionHead } from './creation-heads.js';
import { candidateMedia } from './candidate-media.js';
import { Store, HttpError } from './db.js';
import { CreationService } from './creation.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { prepareCreationProduction, creationMediaStatus } from './creation-production.js';
import { generationDigest } from './h3-guided.js';
import {
  scopeInputSchema,
  scopeSubjectKeys,
  requirementInScope,
  workspaceLayoutSchema,
  type CreationScope,
  type ScopeInput,
  type WorkspaceSnapshot,
  type ScopedRevision,
} from '../shared/workspace.js';
import { type AuthoringStage, type CreationRef, type DirectorResult } from '../shared/creation.js';
import type { RecordDoc } from '../shared/contracts.js';
import { projectExecutionText } from '../shared/execution-text.js';
import { resolveAuthoringStates } from '../shared/authoring-state.js';
import { resolveStaging, sceneDesignDependencies } from '../shared/staging-projection.js';

// One boundary owns selection resolution, authoring version checks and full-work timing.
export function resolveScope(
  store: Store,
  run: RecordDoc,
  reference = run.data.scope,
): RecordDoc<CreationScope> {
  if (!reference) throw new HttpError(409, '此运行缺少执行范围');
  const scope = store.get(reference.id, reference.revision) as RecordDoc<CreationScope>;
  if (
    scope.kind !== 'creation_scope' ||
    scope.projectId !== run.projectId ||
    scope.parentId !== run.id
  )
    throw new HttpError(400, '执行范围不属于此创作运行');
  if (store.get(scope.id).revision !== reference.revision || scope.data.version !== scope.revision)
    throw new HttpError(409, '执行范围版本已变化');
  if (scope.data.pending) throw new HttpError(409, '导演计划采用后才能执行此范围');
  const directorRef = scope.data.authoring.director;
  if (!directorRef) throw new HttpError(409, '执行范围缺少导演依据');
  const director = store.get(directorRef.id, directorRef.revision).data.result as DirectorResult;
  const selectedShots = director.shots.filter((s) => scope.data.shotIds.includes(s.id));
  const knownStates = resolveAuthoringStates(director);
  const sceneIds = new Set(selectedShots.map((s) => s.sceneId));
  const scriptRef = scope.data.authoring.script;
  const subjectKeys = scopeSubjectKeys(
    scriptRef ? store.get(scriptRef.id, scriptRef.revision).data.result : undefined,
    selectedShots.map((shot) => ({ ...shot, ...knownStates.get(shot.id)! })),
  );
  // Authoring records contain the whole work. Compare the actual scoped dependency
  // projection when a local edit replaced a whole-work record, while keeping the
  // scope's original fixed references as its executable source of truth.
  const projection = (stage: string, value: any) => {
    const { summary: _summary, ...data } = value;
    if (stage === 'script')
      return {
        ...data,
        scenes: data.scenes.filter((s: any) => sceneIds.has(s.id)),
        subjects: data.subjects.filter((s: any) => subjectKeys.has(s.key)),
      };
    if (stage === 'assets')
      return {
        ...data,
        items: data.items.filter((i: any) =>
          requirementInScope(
            i,
            scriptRef ? store.get(scriptRef.id, scriptRef.revision).data.result : undefined,
            selectedShots,
          ),
        ),
      };
    if (stage === 'director') {
      const projectedStates = resolveAuthoringStates(value);
      const projectedStaging = resolveStaging(value);
      let frame = 0;
      const windows: CreationScope['windows'] = [];
      for (const shot of data.shots) {
        if (scope.data.shotIds.includes(shot.id))
          windows.push({ shotId: shot.id, startFrame: frame, endFrame: frame + shot.frames });
        frame += shot.frames;
      }
      return {
        ...data,
        ...(data.sceneDesigns
          ? {
              sceneDesigns: data.sceneDesigns
                .filter((d: any) => sceneIds.has(d.sceneId))
                .map((d: any) =>
                  sceneDesignDependencies(
                    d,
                    data.shots.filter((s: any) => scope.data.shotIds.includes(s.id)),
                  ),
                ),
            }
          : {}),
        shots: data.shots.filter((s: any) => scope.data.shotIds.includes(s.id)),
        groups: data.groups
          .filter((g: any) => scope.data.groupIds.includes(g.id))
          .map((g: any) => ({
            ...g,
            shotIds: g.shotIds.filter((id: string) => scope.data.shotIds.includes(id)),
          })),
        windows,
        knownStates: data.shots
          .filter((s: any) => scope.data.shotIds.includes(s.id))
          .map((s: any) => [s.id, projectedStates.get(s.id)]),
        knownStaging: data.shots
          .filter((s: any) => scope.data.shotIds.includes(s.id))
          .map((s: any) => [s.id, projectedStaging.get(s.id)]),
      };
    }
    return data;
  };
  for (const [stage, reference] of Object.entries(scope.data.authoring)) {
    const current = run.data.results[stage];
    const doc = store.get(reference!.id, reference!.revision);
    if (
      !current ||
      doc.kind !== 'authoring_result' ||
      doc.parentId !== run.id ||
      doc.projectId !== run.projectId ||
      !doc.data.adopted ||
      store.get(doc.id).data.stale
    )
      throw new HttpError(409, '执行范围的创作依据已变化，请明确保存新范围版本');
    if (current.id !== reference!.id || current.revision !== reference!.revision) {
      const latest = store.get(current.id, current.revision);
      if (
        latest.kind !== 'authoring_result' ||
        latest.parentId !== run.id ||
        !latest.data.adopted ||
        store.get(latest.id).data.stale ||
        generationDigest(projection(stage, doc.data.result)) !==
          generationDigest(projection(stage, latest.data.result))
      )
        throw new HttpError(409, '执行范围包含已修订对象，请明确保存新范围版本');
    }
  }
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[])
    if (!scope.data.authoring[stage])
      throw new HttpError(409, '执行范围需要包含已采用的完整前置依据，请保存新范围版本');
  const associated = new Set<string>();
  for (const candidate of scope.data.candidates || []) {
    const job = store.job(candidate.jobId);
    const expectedShots = (job.input.segment?.shotIds || []).filter((id: string) =>
      scope.data.shotIds.includes(id),
    );
    if (
      associated.has(job.id) ||
      job.kind !== 'generation' ||
      job.projectId !== run.projectId ||
      job.input.creationRunId !== run.id ||
      !scope.data.groupIds.includes(job.input.segment?.id) ||
      !candidate.reason?.trim() ||
      !expectedShots.length ||
      generationDigest(expectedShots) !== generationDigest(candidate.shotIds)
    )
      throw new HttpError(409, '历史候选关联与固定任务的项目、运行、片段或镜头不匹配');
    associated.add(job.id);
  }
  return scope;
}

export function scopeData(
  store: Store,
  run: RecordDoc,
  input: ScopeInput,
  version: number,
): CreationScope {
  const adopted = new CreationService(store).adopted(run);
  try {
    projectExecutionText(adopted, input.executionText);
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : '执行文案不匹配');
  }
  const director = adopted.director as DirectorResult | undefined;
  const ids = new Set(input.shotIds),
    groups = new Set(input.groupIds);
  if (input.mode === 'selection' && !director)
    throw new HttpError(409, '选择范围需要已采用的导演计划');
  if (director) {
    if (
      [...ids].some((id) => !director.shots.some((s) => s.id === id)) ||
      [...groups].some((id) => !director.groups.some((g) => g.id === id))
    )
      throw new HttpError(400, '范围包含不存在的镜头或片段');
    if (input.mode === 'full') director.shots.forEach((s) => ids.add(s.id));
    for (const group of director.groups.filter((g) => groups.has(g.id)))
      group.shotIds.forEach((id) => ids.add(id));
  }
  if (input.mode === 'selection' && !ids.size) throw new HttpError(400, '选择范围不能为空');
  let totalFrames = 0;
  const windows: CreationScope['windows'] = [];
  for (const shot of director?.shots || []) {
    if (ids.has(shot.id))
      windows.push({
        shotId: shot.id,
        startFrame: totalFrames,
        endFrame: totalFrames + shot.frames,
      });
    totalFrames += shot.frames;
  }
  return {
    version,
    runId: run.id,
    name: input.name,
    mode: input.mode,
    pending: !director,
    ...(input.executionText ? { executionText: input.executionText } : {}),
    authoring: Object.fromEntries(
      Object.entries(run.data.results).filter(([stage]) => stage !== 'editorial'),
    ),
    shotIds: windows.map((w) => w.shotId),
    groupIds: (director?.groups || [])
      .filter((g) => g.shotIds.some((id) => ids.has(id)))
      .map((g) => g.id),
    windows,
    totalFrames,
    requestedFrames: windows.reduce((n, w) => n + w.endFrame - w.startFrame, 0),
    output: input.output || {
      ...new CreationService(store).settings(run.projectId).data.policy.output,
      seed: 0,
    },
  };
}

export function validateScopedRevision(
  store: Store,
  run: RecordDoc,
  stage: AuthoringStage,
  result: any,
) {
  const edit = run.data.writable as (ScopedRevision & { stage: AuthoringStage }) | undefined;
  if (!edit || edit.stage !== stage) return;
  const baseline = store.get(edit.baseline.id, edit.baseline.revision);
  if (baseline.parentId !== run.id || baseline.data.stage !== stage)
    throw new HttpError(400, '局部修订依据不属于此阶段');
  const before = baseline.data.result;
  if (!['script', 'director'].includes(stage)) throw new HttpError(400, '局部修订只支持剧本和导演');
  const subjectKeys = new Set(edit.subjectKeys || []);
  const outsideSubjectScope = (value: any, field: string) => {
    if (stage !== 'director' || !subjectKeys.size) return value;
    const copy = structuredClone(value);
    if (field === 'shots') {
      for (const key of ['performances', 'entryState', 'exitState'])
        copy[key] = copy[key].filter((v: any) => !subjectKeys.has(v.subjectKey));
      for (const key of ['entryRelations', 'exitRelations'])
        copy[key] = copy[key].filter((v: any) => !subjectKeys.has(v.objectKey));
      if (copy.interactions)
        copy.interactions = copy.interactions.filter((v: any) => !subjectKeys.has(v.actorKey));
      if (copy.staging)
        for (const key of ['entry', 'exit', 'paths'])
          copy.staging[key] = copy.staging[key].filter((v: any) => !subjectKeys.has(v.subjectKey));
    }
    if (field === 'sceneDesigns')
      for (const key of ['anchors', 'proxies'])
        copy[key] = copy[key].filter((v: any) => !subjectKeys.has(v.subjectKey));
    return copy;
  };
  const fields =
    stage === 'script'
      ? ['scenes', 'subjects']
      : ['shots', ...(before.sceneDesigns ? ['sceneDesigns'] : [])];
  const oldRest = { ...before },
    newRest = { ...result };
  for (const field of fields) {
    const identity = field === 'subjects' ? 'key' : 'id';
    const allowed = new Set(
      field === 'subjects'
        ? edit.subjectKeys || []
        : field === 'scenes'
          ? edit.sceneIds
          : field === 'sceneDesigns'
            ? before.sceneDesigns
                .filter((d: any) => edit.sceneIds.includes(d.sceneId))
                .map((d: any) => d.id)
            : edit.shotIds,
    );
    if (field === 'shots')
      for (const shot of before.shots)
        if (edit.sceneIds.includes(shot.sceneId)) allowed.add(shot.id);
    if (
      generationDigest(before[field].map((o: any) => o[identity])) !==
      generationDigest(result[field].map((o: any) => o[identity]))
    )
      throw new HttpError(400, '局部修订不能新增、删除或重排对象');
    for (let index = 0; index < before[field].length; index++)
      if (
        !allowed.has(before[field][index][identity]) &&
        generationDigest(outsideSubjectScope(before[field][index], field)) !==
          generationDigest(outsideSubjectScope(result[field][index], field))
      )
        throw new HttpError(400, `局部修订不能修改未选择对象 ${before[field][index][identity]}`);
    delete oldRest[field];
    delete newRest[field];
  }
  delete oldRest.summary;
  delete newRest.summary;
  if (generationDigest(oldRest) !== generationDigest(newRest))
    throw new HttpError(400, '局部修订不能修改范围外的全局字段');
}

export class WorkspaceService {
  constructor(public store: Store) {}

  layout(projectId: string): WorkspaceSnapshot['layout'] {
    new StudioService(this.store).project(projectId);
    const doc = this.store.list('workspace_layout', projectId)[0];
    return doc
      ? { id: doc.id, revision: doc.revision, data: workspaceLayoutSchema.parse(doc.data) }
      : { id: null, revision: 0, data: workspaceLayoutSchema.parse({}) };
  }
  saveLayout(projectId: string, revision: number, raw: unknown) {
    const data = workspaceLayoutSchema.parse(raw);
    return this.store.transaction(() => {
      const old = this.layout(projectId);
      if (old.revision !== revision) throw new HttpError(409, '工作台布局已变化');
      return old.id
        ? this.store.update(old.id, revision, data)
        : this.store.create('workspace_layout', projectId, data, projectId);
    });
  }
  saveScope(
    runId: string,
    runRevision: number,
    raw: unknown,
    activate: boolean,
    id?: string,
    revision?: number,
  ) {
    const input = scopeInputSchema.parse(raw);
    return this.store.transaction(() => {
      const run = new CreationService(this.store).get(runId);
      if (run.revision !== runRevision) throw new HttpError(409, '创作运行已变化');
      if (id) {
        const old = this.store.get(id);
        if (
          old.kind !== 'creation_scope' ||
          old.parentId !== run.id ||
          old.projectId !== run.projectId
        )
          throw new HttpError(400, '执行范围归属错误');
        if (old.revision !== revision) throw new HttpError(409, '执行范围已变化');
      }
      const data = scopeData(this.store, run, input, id ? revision! + 1 : 1);
      const scope = id
        ? this.store.update(id, revision!, data)
        : this.store.create('creation_scope', run.projectId, data, run.id);
      new DomainService(this.store).dependencies(scope, Object.values(data.authoring));
      const active = activate || run.data.scope?.id === id;
      const next = active
        ? this.store.update(run.id, run.revision, {
            ...run.data,
            scope: { id: scope.id, revision: scope.revision },
            materialized: null,
            productionApproval: null,
            productionPreview: null,
          })
        : run;
      return { scope, run: next };
    });
  }
  preview(scopeId: string, revision: number, runRevision: number) {
    return this.store.transaction(() => {
      const scope = this.store.get(scopeId),
        service = new CreationService(this.store);
      const run = service.get(scope.parentId || '');
      if (
        run.revision !== runRevision ||
        scope.revision !== revision ||
        run.data.scope?.id !== scopeId ||
        run.data.scope?.revision !== revision
      )
        throw new HttpError(409, '请使用当前已激活的范围和运行版本');
      resolveScope(this.store, run);
      if (run.data.paused) throw new HttpError(409, '运行已暂停');
      const next = prepareCreationProduction(
        this.store,
        run,
        service.adopted(run),
        { ...service.settings(run.projectId).data.policy, progression: 'review' },
        true,
      );
      return {
        run: next,
        scope,
        preview: next.data.productionPreview || null,
        issues: next.data.issues,
        allowance: service.allowance(run.projectId),
      };
    });
  }
  submit(
    scopeId: string,
    revision: number,
    runRevision: number,
    digest: string,
    idempotencyKey: string,
  ) {
    return this.store.transaction(() => {
      const scope = this.store.get(scopeId),
        service = new CreationService(this.store);
      let run = service.get(scope.parentId || '');
      const receipt = (run.data.scopeSubmissions || []).find((r: any) => r.key === idempotencyKey);
      if (receipt) {
        if (
          receipt.scope.id !== scopeId ||
          receipt.scope.revision !== revision ||
          receipt.digest !== digest
        )
          throw new HttpError(409, '提交幂等键对应其他输入');
        return { run, jobs: receipt.jobIds.map((id: string) => this.store.job(id)) };
      }
      if (
        run.revision !== runRevision ||
        run.data.scope?.id !== scopeId ||
        run.data.scope?.revision !== revision ||
        run.data.paused
      )
        throw new HttpError(409, '范围或运行版本已变化');
      resolveScope(this.store, run);
      if (!run.data.productionPreview || run.data.productionPreview.digest !== digest)
        throw new HttpError(409, '请重新预览并确认准确输入');
      run = this.store.update(run.id, run.revision, { ...run.data, productionApproval: digest });
      run = prepareCreationProduction(this.store, run, service.adopted(run), {
        ...service.settings(run.projectId).data.policy,
        progression: 'review',
      });
      if (run.data.productionPreview) throw new HttpError(409, '预览输入已变化，请重新确认');
      const jobs = this.store
        .jobs(run.projectId)
        .filter(
          (j) =>
            j.input.creationRunId === run.id &&
            j.input.creationScope?.id === scopeId &&
            j.input.creationScope?.revision === revision,
        );
      run = this.store.update(run.id, run.revision, {
        ...run.data,
        scopeSubmissions: [
          ...(run.data.scopeSubmissions || []),
          {
            key: idempotencyKey,
            scope: { id: scopeId, revision },
            digest,
            jobIds: jobs.map((j) => j.id),
          },
        ],
      });
      return { run, jobs };
    });
  }

  snapshot(projectId: string, runId?: string, episodeId?: string): WorkspaceSnapshot {
    const service = new CreationService(this.store),
      project = new StudioService(this.store).project(projectId);
    const episodes = this.store.list('episode', projectId).filter((e) => !e.data.archived);
    if (episodeId && !episodes.some((e) => e.id === episodeId))
      throw new HttpError(400, '分集不属于项目');
    const eligibleRuns = this.store
      .list('creation_run', projectId)
      .filter((r) => !r.data.archived && (!episodeId || r.data.episodeId === episodeId));
    const run = runId
      ? service.get(runId)
      : eligibleRuns
          .filter((r) => productionHead(this.store, r.data.episodeId).runId === r.id)
          .at(-1) ||
        eligibleRuns.at(-1) ||
        null;
    if (run && (run.projectId !== projectId || (episodeId && run.data.episodeId !== episodeId)))
      throw new HttpError(400, '创作运行不属于当前项目或分集');
    const results: WorkspaceSnapshot['results'] = {};
    if (run) {
      for (const [stage, reference] of Object.entries(run.data.results || {}) as [
        AuthoringStage,
        CreationRef,
      ][]) {
        const doc = this.store.get(reference.id, reference.revision);
        if (!this.store.get(doc.id).data.stale && !doc.data.archived) results[stage] = doc;
      }
      for (const doc of this.store
        .list('authoring_result', projectId)
        .filter(
          (r) =>
            r.parentId === run.id &&
            r.data.epoch === run.data.epoch &&
            !r.data.stale &&
            !r.data.archived,
        ))
        if (
          !results[doc.data.stage as AuthoringStage] ||
          doc.createdAt >= results[doc.data.stage as AuthoringStage]!.createdAt
        )
          results[doc.data.stage as AuthoringStage] = doc;
    }
    const scopes = this.store
      .list('creation_scope', projectId)
      .filter((s) => s.parentId === run?.id) as RecordDoc<CreationScope>[];
    const scope = run?.data.scope
      ? (this.store.get(run.data.scope.id, run.data.scope.revision) as RecordDoc<CreationScope>)
      : null;
    const allJobs = this.store.jobs(projectId);
    const runJobs = allJobs.filter(
      (j) =>
        run &&
        (j.input.creationRunId === run.id ||
          j.input.context?.runId === run.id ||
          scope?.data.candidates?.some((c) => c.jobId === j.id)),
    );
    const media = this.store.list('asset', projectId);
    const reviews = this.store.list('generation_review', projectId);
    const candidates: WorkspaceSnapshot['candidates'] = runJobs
      .filter((j) => j.kind === 'generation')
      .map((job) =>
        candidateMedia(
          this.store,
          job,
          media,
          allJobs,
          reviews,
          `${job.input.segment?.id || '候选'} · ${job.id.slice(0, 8)}`,
          false,
        ),
      );
    const sources = (run?.data.sources || []).map((r: CreationRef) =>
      this.store.get(r.id, r.revision),
    );
    const referenced = new Map<string, RecordDoc>();
    for (const asset of [
      ...sources.filter((s: RecordDoc) => s.kind === 'asset'),
      ...candidates.flatMap((c) => [c.video, c.audio, ...c.exports]).filter(Boolean),
    ] as RecordDoc[])
      referenced.set(`${asset.id}:${asset.revision}`, asset);
    for (const r of new DomainService(this.store).refs({
      results: Object.values(results).map((r) => r.data.result),
      bindings: run?.data.bindings || {},
    })) {
      const asset = this.store.get(r.id, r.revision);
      if (asset.kind === 'asset') referenced.set(`${asset.id}:${asset.revision}`, asset);
    }
    const scopedShots = (results.director?.data.result.shots || []).filter(
      (s: any) => !scope || scope.data.shotIds.includes(s.id),
    );
    const requirements = (results.assets?.data.result.items || []).map((item: any) => ({
      ...item,
      binding: run?.data.bindings?.[item.id] || null,
      inScope: !scope || requirementInScope(item, results.script?.data.result, scopedShots),
    }));
    const subjects = results.script?.data.result.subjects || [];
    const cards: WorkspaceSnapshot['cards'] = [
      ...Object.values(results).map((r) => ({
        id: r.id,
        title: r.data.result.title,
        summary: r.data.result.summary,
        type: r.data.stage,
        group: ['brief', 'script', 'direction'].includes(r.data.stage)
          ? 'story/direction'
          : r.data.stage === 'assets'
            ? 'subjects/references'
            : r.data.stage === 'director'
              ? 'scenes/shots'
              : 'video/delivery',
        record: { id: r.id, revision: r.revision },
        asset: null,
        status: r.data.adopted ? 'adopted' : 'draft',
        shotIds: r.data.result.shots?.map((s: any) => s.id) || [],
      })),
      ...sources
        .filter((s: RecordDoc) => s.kind !== 'asset')
        .map((s: RecordDoc) => ({
          id: s.id,
          title: s.data.title || s.data.name || s.kind,
          type: 'source',
          group: 'story/direction',
          record: { id: s.id, revision: s.revision },
          asset: null,
          status: s.data.stale ? 'stale' : 'source',
          shotIds: [],
        })),
      ...subjects.map((s: any) => ({
        id: `subject:${s.key}`,
        title: s.name,
        summary: s.description,
        type: 'subject',
        group: 'subjects/references',
        record: results.script
          ? { id: results.script.id, revision: results.script.revision }
          : null,
        asset: null,
        status: 'authored',
        shotIds: (results.director?.data.result.shots || [])
          .filter((shot: any) => shot.visibleSubjectKeys.includes(s.key))
          .map((s: any) => s.id),
      })),
      ...requirements.map((item: any) => ({
        id: `requirement:${item.id}`,
        title: item.description || item.id,
        summary: item.prompt,
        type: 'requirement',
        group: 'subjects/references',
        record: results.assets
          ? { id: results.assets.id, revision: results.assets.revision }
          : null,
        asset: item.binding?.asset || null,
        status: item.binding ? 'bound' : 'missing',
        shotIds: item.shotIds,
      })),
      ...[...referenced.values()]
        .filter(
          (a) =>
            !['review_frame', 'generated', 'export'].includes(a.data.category) &&
            a.data.mediaType === 'image',
        )
        .map((a) => ({
          id: a.id,
          title: a.data.name,
          type: 'asset',
          group: 'subjects/references',
          record: { id: a.id, revision: a.revision },
          asset: { id: a.id, revision: a.revision },
          status: a.data.adopted ? 'adopted' : 'available',
          shotIds: [],
        })),
      ...(results.script?.data.result.scenes || []).map((s: any) => ({
        id: `scene:${s.id}`,
        title: s.title,
        summary: s.narrative,
        type: 'scene',
        group: 'scenes/shots',
        record: { id: results.script!.id, revision: results.script!.revision },
        asset: null,
        status: 'authored',
        shotIds: (results.director?.data.result.shots || [])
          .filter((shot: any) => shot.sceneId === s.id)
          .map((s: any) => s.id),
      })),
      ...(results.director?.data.result.shots || []).map((s: any) => ({
        id: `shot:${s.id}`,
        title: s.purpose || s.id,
        summary: s.action,
        type: 'shot',
        group: 'scenes/shots',
        record: { id: results.director!.id, revision: results.director!.revision },
        asset: null,
        status: scope?.data.shotIds.includes(s.id) ? 'in_scope' : 'authored',
        shotIds: [s.id],
      })),
      ...candidates.map((c) => ({
        id: c.id,
        title: c.label,
        type: 'candidate',
        group: 'video/delivery',
        record: c.review ? { id: c.review.id, revision: c.review.revision } : null,
        asset: c.video ? { id: c.video.id, revision: c.video.revision } : null,
        status: c.state,
        shotIds: c.shotIds,
      })),
      ...[...new Map(candidates.flatMap((c) => c.exports).map((a) => [a.id, a])).values()].map(
        (a) => ({
          id: a.id,
          title: a.data.name || '预览导出',
          type: 'export',
          group: 'video/delivery',
          record: { id: a.id, revision: a.revision },
          asset: { id: a.id, revision: a.revision },
          status: 'exported',
          shotIds: [],
        }),
      ),
    ];
    const edges: WorkspaceSnapshot['edges'] = [];
    for (const doc of Object.values(results))
      for (const reference of doc.data.context?.dependencies || [])
        if (cards.some((c) => c.id === reference.id))
          edges.push({
            id: `${reference.id}:${doc.id}`,
            from: reference.id,
            to: doc.id,
            relation: 'source',
          });
    for (const item of requirements)
      for (const shotId of item.shotIds)
        if (cards.some((c) => c.id === `shot:${shotId}`))
          edges.push({
            id: `shot:${shotId}:requirement:${item.id}`,
            from: `shot:${shotId}`,
            to: `requirement:${item.id}`,
            relation: 'requires',
          });
    for (const c of candidates) {
      for (const shotId of c.shotIds)
        if (cards.some((card) => card.id === `shot:${shotId}`))
          edges.push({
            id: `shot:${shotId}:${c.id}`,
            from: `shot:${shotId}`,
            to: c.id,
            relation: 'generated',
          });
      for (const asset of c.exports)
        edges.push({ id: `${c.id}:${asset.id}`, from: c.id, to: asset.id, relation: 'exported' });
    }
    const director = results.director?.data.result as DirectorResult | undefined;
    const adoptedFrames = run ? creationMediaStatus(this.store, run).frames : 0;
    return {
      project,
      episodes,
      run: run
        ? {
            ...run,
            data: {
              ...run.data,
              productionPreview: run.data.productionPreview
                ? { ...run.data.productionPreview, inputs: undefined }
                : null,
            },
          }
        : null,
      results,
      sources,
      subjects,
      assets: [...referenced.values()],
      scope,
      scopes,
      allowance: service.allowance(projectId),
      layout: this.layout(projectId),
      requirements,
      candidates,
      jobs: runJobs.map(({ input, ...job }) => ({
        ...job,
        stage: input.context?.stage || input.segment?.id || 'export',
        epoch: input.creationEpoch ?? input.context?.epoch ?? null,
        scope: input.creationScope || null,
      })),
      messages: [
        ...(run?.data.messages || []).map((m: any, i: number) => ({
          ...m,
          id: `run:${i}`,
        })),
        ...this.store
          .list('creation_message', projectId)
          .filter((m) => m.parentId === run?.id)
          .map((m) => ({
            id: m.id,
            role: m.data.role || 'assistant',
            text: m.data.text || '',
            at: m.data.at || m.createdAt,
            mode: m.data.mode,
            resultLinks: m.data.resultLinks || [],
            historical: !!m.data.historical,
          })),
      ]
        .filter(
          (m, i, all) =>
            !all
              .slice(i + 1)
              .some((next) => m.role === next.role && m.text === next.text && m.at === next.at),
        )
        .sort((a, b) => a.at - b.at),
      cards,
      edges,
      timing: {
        totalFrames: director?.shots.reduce((n, s) => n + s.frames, 0) || 0,
        requestedFrames: scope?.data.requestedFrames || 0,
        actualFrames: candidates.reduce(
          (n, c) =>
            n + (c.video?.data.frameCount || Math.round((c.video?.data.duration || 0) * 24)),
          0,
        ),
        adoptedFrames,
      },
    };
  }
}
