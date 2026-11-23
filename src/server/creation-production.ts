import { z } from 'zod';
import { assertEpisodePlanCurrent, episodePredecessor } from './episode-plan.js';
import { formatComparison } from '../shared/production-plan.js';
import { subjectBindingIssues } from './subject-bindings.js';
import { bindExperimentInput } from './experiment-binding.js';
import { ModelRegistry } from './model-registry.js';
import { Store, HttpError } from './db.js';
import { assertProductionHead } from './creation-heads.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { ReadinessService } from './readiness.js';
import { resolveSeries, predecessorCanon } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import { selectionMedia } from './selection-splice.js';
import { directingSchema } from '../shared/directing.js';
import { resolveAuthoringStates } from '../shared/authoring-state.js';
import { projectExecutionText } from '../shared/execution-text.js';
import { projectSceneDesign, projectShotStaging } from '../shared/staging-projection.js';
import { scopeSubjectKeys } from '../shared/workspace.js';
import { referenceCoverage, referenceCoverageBasis } from '../shared/reference-coverage.js';
import { shotStateSchema } from '../shared/domain.js';
import {
  authoringExecutionIssues,
  validateAuthoringResult,
} from '../shared/creation-validation.js';
import {
  creationRefSchema,
  durationBounds,
  type AuthoringResult,
  type AuthoringStage,
  type CreationSettings,
  type DirectorResult,
  type ScriptResult,
  type CreationIssue,
} from '../shared/creation.js';
import { segmentSchema, type Job, type RecordDoc } from '../shared/contracts.js';
import { resolveScope } from './workspace.js';
import { requirementInScope } from '../shared/workspace.js';

type Results = Partial<Record<AuthoringStage, AuthoringResult>>;
const ref = (d: RecordDoc) => ({ id: d.id, revision: d.revision });
function issue(
  code: string,
  message: string,
  targetId = '',
  category: CreationIssue['category'] = 'execution',
): CreationIssue {
  return {
    code,
    message,
    targetId,
    category,
    severity: 'blocking',
    stage: 'production',
    field: targetId,
  };
}
function updateRun(store: Store, run: RecordDoc, changes: Record<string, unknown>) {
  const data = { ...run.data, ...changes };
  return generationDigest(data) === generationDigest(run.data)
    ? run
    : store.update(run.id, run.revision, data);
}

function candidateIssue(job: Job): CreationIssue | null {
  if (job.state === 'succeeded')
    return issue(
      'actual_review_required',
      `片段 ${job.input.segment.id} 已归档，请实际看片、听音并在候选审核中采用；当前没有自动媒体审查能力。`,
      job.id,
      'evidence',
    );
  if (['failed', 'cancelled', 'unknown', 'archive_failed'].includes(job.state))
    return issue(
      'generation_recovery',
      `片段 ${job.input.segment.id}：${job.error || job.state}。受理不明先核对；归档失败只恢复归档；明确重做使用新的额度。`,
      job.id,
    );
  return null;
}

// Only actual, current selections are eligible. No model response can create one.
export function creationMediaStatus(store: Store, run: RecordDoc) {
  const ep = store.get(run.data.episodeId);
  const selections = store
    .list('segment_selection', run.projectId)
    .filter(
      (d) =>
        d.parentId === ep.id &&
        !d.data.stale &&
        !d.data.archived &&
        d.data.creationRunId === run.id,
    );
  const groups = (ep.data.segments || []).map((segment: any) => {
    const selection = selections.filter((d) => d.data.segmentId === segment.id).at(-1);
    const parts = selection ? selectionMedia(selection.data) : [];
    const current = parts.every((p) => {
      const media = store.get(p.video.id, p.video.revision);
      return media.projectId === run.projectId && media.data.mediaType === 'video';
    });
    return {
      id: segment.id,
      shotIds: segment.shotIds,
      plannedFrames: Math.round(segment.duration * 24),
      selection: selection && current ? ref(selection) : null,
      parts: current ? parts : [],
      frames: current ? parts.reduce((n, p) => n + Math.round((p.out - p.in) * 24), 0) : 0,
    };
  });
  const exportJob = run.data.exportJobId ? store.job(run.data.exportJobId) : null;
  const exportAssetId = exportJob?.state === 'succeeded' ? exportJob.output.assetIds?.[0] : null;
  const exportAsset = exportAssetId ? store.get(exportAssetId) : null;
  const currentEdl = run.data.edl ? store.get(run.data.edl.id) : null;
  const delivery = run.data.delivery ? store.get(run.data.delivery.id) : null;
  const deliveryValid = delivery
    ? !delivery.data.stale &&
      currentEdl?.id === delivery.data.edl.id &&
      currentEdl?.revision === delivery.data.edl.revision &&
      ep.revision === delivery.data.episode.revision &&
      groups.every(
        (g: any) =>
          g.selection &&
          currentEdl?.data.clips.some(
            (c: any) =>
              c.selection?.id === g.selection.id && c.selection?.revision === g.selection.revision,
          ),
      )
    : null;
  return {
    groups,
    frames: groups.reduce((n: number, g: any) => n + g.frames, 0),
    ready: !!groups.length && groups.every((g: any) => !!g.selection),
    exportAsset,
    currentEdl,
    deliveryValid,
    edl: run.data.edl || null,
    bindings: run.data.bindings,
    mappings: run.data.mappings,
    capabilities: {
      imageGeneration: false,
      speechGeneration: false,
      visualReview: false,
      audioReview: false,
    },
  };
}

// Deterministic authoring-to-domain mapping. It owns IDs and semantic translation,
// not storytelling. The old episode schema is reached only at the execution boundary.
function materialize(store: Store, run: RecordDoc, results: Results) {
  assertProductionHead(store, run);
  assertEpisodePlanCurrent(store, run);
  if (run.data.schemaVersion !== 9) throw new HttpError(409, '当前程序仅支持 V9 生成');
  const scope = resolveScope(store, run);
  if (scope.data.experiment && scope.data.groupIds.length !== 1)
    throw new HttpError(400, '一份实验案例只对应一个明确生成组');
  const sourceResults = results;
  results = projectExecutionText(results, scope.data.executionText);
  const script = results.script as ScriptResult,
    fullDirector = results.director as DirectorResult;
  if (
    !script ||
    !fullDirector ||
    results.direction?.stage !== 'direction' ||
    results.assets?.stage !== 'assets'
  )
    throw new HttpError(409, '创作前置结果尚未采用');
  if (fullDirector.contractRevision !== 2)
    return updateRun(store, run, {
      state: 'needs_revision',
      issues: [
        issue(
          'director_contract_revision',
          '当前导演为原 V9 修订，请通过正常导演修订完成空间与执行设计后重新预览；历史冻结任务不可重编译。',
          '',
          'consistency',
        ),
      ],
    });
  const director: DirectorResult = {
    ...fullDirector,
    shots: fullDirector.shots.filter((s) => scope.data.shotIds.includes(s.id)),
    groups: fullDirector.groups
      .filter((g) => scope.data.groupIds.includes(g.id))
      .map((g) => ({ ...g, shotIds: g.shotIds.filter((id) => scope.data.shotIds.includes(id)) })),
  };
  const invalidReferences = validateAuthoringResult(fullDirector, results, {
    ...store.list('creation_settings', run.projectId)[0].data.policy,
    duration: run.data.duration,
  }).filter(
    (i) =>
      ['data', 'consistency'].includes(i.category) &&
      i.severity === 'blocking' &&
      (i.code !== 'scene_design_missing' ||
        scope.data.shotIds.some(
          (id) => fullDirector.shots.find((s) => s.id === id)?.sceneId === i.targetId,
        )) &&
      (!i.field.startsWith('sceneDesigns.') ||
        i.field === 'sceneDesigns.sceneId' ||
        fullDirector.sceneDesigns?.some(
          (d) =>
            scope.data.shotIds.some(
              (id) => fullDirector.shots.find((s) => s.id === id)?.sceneId === d.sceneId,
            ) &&
            (i.field === `sceneDesigns.${d.id}` || i.field.startsWith(`sceneDesigns.${d.id}.`)),
        )) &&
      (!i.field.startsWith('shots.') ||
        scope.data.shotIds.some(
          (id) => i.field === `shots.${id}` || i.field.startsWith(`shots.${id}.`),
        )),
  );
  if (invalidReferences.length)
    return updateRun(store, run, { state: 'needs_revision', issues: invalidReferences });
  const resolvedStates = resolveAuthoringStates(fullDirector);
  const direction = results.direction,
    requirements = results.assets.items.filter((i) =>
      requirementInScope(i, script, director.shots),
    );
  const domain = new DomainService(store),
    service = new StudioService(store);
  let ep = store.get(run.data.episodeId);
  if (ep.revision !== run.data.targetRevision)
    throw new HttpError(409, '分集已在其他编辑器修改，请发送修订指令重新读取');
  const mappings = { ...run.data.mappings },
    bindings = run.data.bindings;
  const output = scope.data.output;
  const sharedReferences = ep.data.seriesProduction
    ? resolveSeries(store, ep).production.sharedReferences
    : [];
  const definitions = new Map<string, any>();
  const mappingIssues = subjectBindingIssues(store, run, script);
  if (mappingIssues.length)
    return updateRun(store, run, {
      state: 'needs_revision',
      issues: mappingIssues.map((message) => issue('subject_mapping', message)),
    });
  for (const subject of script.subjects) {
    // Explicit existing instance IDs from fixed source records can be reused.
    const explicit = run.data.subjectBindings?.find((b: any) => b.subjectKey === subject.key);
    const sourceEntity =
      explicit?.decision === 'reuse'
        ? store.get(explicit.entity.id, explicit.entity.revision)
        : explicit?.decision === 'new'
          ? null
          : [...run.data.sources, ...sharedReferences]
              .map((r) => store.get(r.id, r.revision))
              .find(
                (d) =>
                  d.kind === 'entity' && d.data.instances.some((i: any) => i.id === subject.key),
              );
    const instanceId = sourceEntity
      ? explicit?.instanceId || subject.key
      : `${run.id}:${subject.key}`;
    const locations = [
      ...new Set(
        fullDirector.shots
          .flatMap((s) => [...s.entryRelations, ...s.exitRelations])
          .filter((r) => r.type === 'locatedIn' && r.objectKey === subject.key)
          .map((r) => r.targetKey),
      ),
    ];
    const anchors = [
      ...new Set([
        ...fullDirector.shots
          .flatMap((s) => [...s.entryRelations, ...s.exitRelations])
          .filter((r) => r.targetKey === subject.key && ['heldBy', 'attachedTo'].includes(r.type))
          .map((r) => r.anchor),
        ...(fullDirector.sceneDesigns || []).flatMap((d) =>
          d.anchors.filter((a) => a.subjectKey === subject.key).map((a) => a.label),
        ),
      ]),
    ];
    const data = {
      name: subject.name,
      type:
        subject.kind === 'human' || subject.kind === 'animal'
          ? 'character'
          : subject.kind === 'environment'
            ? 'environment'
            : 'object',
      subtype: subject.kind,
      description: subject.description,
      instances: [{ id: instanceId, name: subject.name }],
      anchors,
      attributes: [
        ...subject.attributes.map((a) => ({ ...a, type: a.type, continuity: 'scene' })),
        ...(locations.length
          ? [
              {
                key: 'creation_location',
                label: '所在环境',
                type: 'enum',
                values: locations,
                continuity: 'scene',
              },
            ]
          : []),
      ],
    };
    const digest = generationDigest(data),
      existing = mappings[subject.key]?.entity ? mappings[subject.key] : null;
    const entity =
      sourceEntity ||
      (existing?.digest === digest
        ? store.get(existing.entity.id, existing.entity.revision)
        : domain.save(
            run.projectId,
            'entity',
            data,
            existing?.entity.id,
            existing ? store.get(existing.entity.id).revision : undefined,
          ));
    definitions.set(subject.key, entity);
    mappings[subject.key] = { entity: ref(entity), instanceId, digest };
  }
  for (const item of requirements) {
    const entity = mappings[item.subjectKey]?.entity;
    if (!entity) throw new HttpError(400, `资产需求没有主体：${item.id}`);
    const key = `task:${item.id}`,
      data = {
        name: item.description || item.id,
        entity,
        requirements: `${item.description}\n${item.prompt}\n版式：${item.layout}`,
        views: [{ id: item.id, view: item.view, instruction: item.prompt }],
      };
    if (script.subjects.some((s) => s.key === key))
      throw new HttpError(400, '资产任务标识与主体键冲突，请重命名');
    const digest = generationDigest(data),
      existing = mappings[key];
    const task =
      existing?.digest === digest
        ? store.get(existing.ref.id, existing.ref.revision)
        : domain.save(
            run.projectId,
            'asset_task',
            data,
            existing?.ref.id,
            existing ? store.get(existing.ref.id).revision : undefined,
          );
    mappings[key] = { ref: ref(task), digest };
  }
  // Persist useful asset requests even when execution is still waiting on real media.
  run = updateRun(store, run, { mappings });
  const missing: CreationIssue[] = [];
  for (const item of requirements) {
    const binding = bindings[item.id];
    if (!binding) {
      missing.push(
        issue(
          'asset_import_required',
          `请生成或导入并审核「${item.description || item.id}」，再绑定真实${item.mediaType === 'audio' ? '音频' : '图片'}版本。当前未接通该媒体生成能力。`,
          item.id,
        ),
      );
      continue;
    }
    if (
      ((item.coverage?.length || 0) > 0 &&
        binding.coverageDigest !==
          generationDigest(
            referenceCoverageBasis(sourceResults.director as DirectorResult, item.coverage!),
          )) ||
      binding.requirementDigest !==
        generationDigest(
          sourceResults.assets?.stage === 'assets' &&
            sourceResults.assets.items.find((i) => i.id === item.id),
        ) ||
      binding.subjectDigest !==
        generationDigest(
          sourceResults.script?.stage === 'script' &&
            sourceResults.script.subjects.find((s) => s.key === item.subjectKey),
        ) ||
      (binding.groupStart &&
        !fullDirector.groups.some(
          (group) =>
            group.id === binding.groupStart.groupId &&
            group.shotIds[0] === binding.groupStart.shotId,
        ))
    ) {
      missing.push(
        issue(
          'asset_binding_changed',
          `「${item.description || item.id}」的主体、用途或首帧目标已变化，请重新核对素材绑定`,
          item.id,
          'evidence',
        ),
      );
      continue;
    }
    const asset = domain.owned(run.projectId, binding.asset, 'asset');
    if (asset.data.mediaType !== item.mediaType)
      missing.push(
        issue('asset_review_required', `资产 ${item.id} 需要重新审核`, item.id, 'evidence'),
      );
  }
  if (missing.length) return updateRun(store, run, { issues: missing, state: 'awaiting_assets' });
  const executionIssues = director.groups.flatMap((group) => {
    const model = new ModelRegistry(store).resolve(
      run.projectId,
      run.data.episodeId,
      'video',
      group.id,
    );
    return authoringExecutionIssues(
      { ...director, groups: [group] },
      model
        ? {
            provider: model.protocol,
            minSeconds: model.capabilities.minSeconds!,
            maxSeconds: model.capabilities.maxSeconds!,
            framesPerSecond: 24,
          }
        : undefined,
    );
  });
  if (executionIssues.length)
    return updateRun(store, run, { issues: executionIssues, state: 'needs_revision' });

  return store.transaction(() => {
    const instance = (key: string) => {
      if (!mappings[key]?.instanceId) throw new HttpError(400, `主体不存在：${key}`);
      return mappings[key].instanceId as string;
    };
    const layouts = new Map<string, RecordDoc>();
    for (const design of director.sceneDesigns || []) {
      if (
        design.applicability !== 'spatial' ||
        !director.shots.some((s) => s.staging?.sceneDesignId === design.id)
      )
        continue;
      const data = {
        ...projectSceneDesign(design, mappings[design.environmentKey!].entity),
        creationSource: { result: run.data.results.director, sceneDesignId: design.id },
      };
      const key = `layout:${design.id}`,
        digest = generationDigest(data),
        existing = mappings[key];
      const layout =
        existing?.digest === digest
          ? store.get(existing.ref.id, existing.ref.revision)
          : domain.save(run.projectId, 'layout', data);
      mappings[key] = { ref: ref(layout), digest };
      domain.dependencies(layout, [
        run.data.results.director,
        ...(design.source ? [design.source] : []),
      ]);
      layouts.set(design.id, layout);
    }
    const fact = (f: any) => ({
      instanceId: instance(f.subjectKey),
      key: f.key,
      status: f.value === null ? 'unknown' : 'known',
      value: f.value,
    });
    const relation = (r: any) => ({
      objectId: instance(r.objectKey),
      type: r.type,
      targetId: instance(r.targetKey),
      anchor: r.anchor,
      confirmed: true,
    });
    const states = (s: any[], rs: any[]) => [
      ...s.map(fact),
      ...rs
        .filter((r) => r.type === 'locatedIn')
        .map((r) =>
          fact({ subjectKey: r.objectKey, key: 'creation_location', value: r.targetKey }),
        ),
    ];
    const voices = new Map<string, any>();
    const packs = new Map<string, any>();
    for (const subject of script.subjects) {
      const images = requirements.filter(
        (i) => i.mediaType === 'image' && i.subjectKey === subject.key,
      );
      if (!images.length) continue;
      let pack = domain.save(run.projectId, 'reference_pack', {
        name: `${subject.name} · 已绑定参考`,
        entity: mappings[subject.key].entity,
        views: images.map((i) => ({
          id: i.id,
          asset: bindings[i.id].asset,
          view: i.view,
          label: i.description,
          scope: i.purpose,
        })),
        notes: images.map((i) => bindings[i.id].conclusion).join('\n'),
      });
      pack = domain.publish(pack.id, pack.revision, {
        inspected: false,
        conclusion: images.map((i) => bindings[i.id].conclusion).join('\n'),
      });
      packs.set(subject.key, ref(pack));
    }
    for (const item of requirements.filter((i) => i.purpose === 'voice')) {
      const audio = domain.owned(run.projectId, bindings[item.id].asset, 'asset');
      const data = {
        version: 1,
        name: item.description || item.id,
        entity: mappings[item.subjectKey].entity,
        language:
          script.scenes.flatMap((s) => s.dialogue).find((l) => l.speakerKey === item.subjectKey)
            ?.language || 'und',
        timbre: item.prompt,
        samples: [
          {
            asset: ref(audio),
            in: 0,
            out: audio.data.duration,
            inspected: false,
            notes: bindings[item.id].conclusion,
          },
        ],
      };
      let voice = domain.save(run.projectId, 'voice_profile', data);
      voice = domain.publish(voice.id, voice.revision, {
        inspected: false,
        conclusion: bindings[item.id].conclusion,
      });
      voices.set(item.subjectKey, ref(voice));
    }
    let profile: RecordDoc;
    if (ep.data.seriesProduction) {
      const series = resolveSeries(store, ep);
      profile = series.profile;
      for (const voice of series.voices) {
        const key = script.subjects.find((s) => instance(s.key) === voice.instanceId)?.key;
        if (key && !voices.has(key)) voices.set(key, ref(voice.record));
      }
    } else {
      profile = domain.save(run.projectId, 'creation_profile', {
        name: direction.title || '会话创作配置',
        rulesVersion: 'director-v6',
        goal: results.brief?.stage === 'brief' ? results.brief.goal : '',
        sound: direction.sound,
        composition: {
          moduleRefs: [],
          overrides: {
            visual: direction.visual,
            narrative: direction.narrative,
            direction: `${direction.directing}\n${direction.editing}\n${direction.sound}`,
            mixedMedia: direction.assetPolicy,
          },
          artEntries: script.subjects
            .filter((s) => s.description.trim())
            .map((s) => ({
              id: s.key,
              target: { kind: 'instance', id: instance(s.key) },
              aspect: 'identity',
              text: s.description,
              stable: true,
            })),
        },
      });
      profile = domain.publish(profile.id, profile.revision, {
        inspected: false,
        conclusion: '由已采用呈现方向确定性映射；创作方案采用不表示媒体审核通过',
      });
      domain.dependencies(profile, [run.data.results.direction]);
    }
    const shots = director.shots.map((s) => {
      const scene = script.scenes.find((c) => c.id === s.sceneId)!;
      const group = director.groups.find((g) => g.shotIds.includes(s.id))!;
      const resolved = resolvedStates.get(s.id)!;
      const spatial = projectShotStaging(fullDirector, s, instance);
      const layout = s.staging ? layouts.get(s.staging.sceneDesignId) : undefined;
      const start = states(resolved.entryState, resolved.entryRelations),
        end = states(resolved.exitState, resolved.exitRelations);
      const changes = end.filter(
        (f) =>
          f.status === 'known' &&
          !start.some(
            (p) => p.instanceId === f.instanceId && p.key === f.key && p.value === f.value,
          ),
      );
      const lines = s.dialogue.map(({ lineId: id }) => scene.dialogue.find((l) => l.id === id)!);
      // Native dialogue does not consume a voice sample. Fixed identity is checked
      // by explicit speech/import preparation, rather than an unused sample gate.
      const keys = [
        ...new Set([
          ...s.visibleSubjectKeys,
          ...(s.staging?.paths || []).map((p) => p.subjectKey),
          ...scopeSubjectKeys(script, [s]),
          ...spatial.directing.staging.entry
            .map((p) => p.instanceId)
            .map((id) => script.subjects.find((subject) => instance(subject.key) === id)!.key),
          ...lines.map((l) => l.speakerKey),
          ...resolved.entryState.map((f) => f.subjectKey),
          ...resolved.exitState.map((f) => f.subjectKey),
          ...[...resolved.entryRelations, ...resolved.exitRelations].flatMap((r) => [
            r.objectKey,
            r.targetKey,
          ]),
        ]),
      ];
      return {
        id: s.id,
        scene: s.sceneId,
        duration: s.frames / 24,
        description: s.purpose,
        dialogue: lines.map((l) => l.text).join('\n'),
        continuity: group.reason,
        state: shotStateSchema.parse({
          ...spatial.state,
          layout: layout ? ref(layout) : null,
          instances: keys.map((k) => ({
            instanceId: instance(k),
            entity: mappings[k].entity,
            ...(packs.has(k) ? { pack: packs.get(k) } : {}),
          })),
          confirmed: true,
          startRelations: resolved.entryRelations
            .filter((r) => r.type !== 'locatedIn')
            .map(relation),
          endRelations: resolved.exitRelations.filter((r) => r.type !== 'locatedIn').map(relation),
          relationKnowledge: {
            start: [...new Set(resolved.entryRelations.map((r) => instance(r.objectKey)))],
            end: [...new Set(resolved.exitRelations.map((r) => instance(r.objectKey)))],
          },
          attributes: { start, end },
        }),
        directing: directingSchema.parse({
          ...spatial.directing,
          authoringSource: run.data.results.director,
          version: ep.data.seriesProduction ? 3 : 2,
          purpose: s.purpose,
          presence: {
            visible: s.visibleSubjectKeys.map(instance),
            audible: [...new Set(lines.map((l) => instance(l.speakerKey)))],
          },
          locations: {
            start: resolved.entryRelations
              .filter((r) => r.type === 'locatedIn')
              .map((r) => ({
                objectId: instance(r.objectKey),
                targetId: instance(r.targetKey),
                anchor: r.anchor,
                anchorId: r.anchorId || null,
              })),
            end: resolved.exitRelations
              .filter((r) => r.type === 'locatedIn')
              .map((r) => ({
                objectId: instance(r.objectKey),
                targetId: instance(r.targetKey),
                anchor: r.anchor,
                anchorId: r.anchorId || null,
              })),
          },
          transition: {
            kind:
              group.shotIds[0] === s.id && group.transition !== 'independent'
                ? group.transition
                : 'continuous',
            reason: group.reason,
            changes: resolved.transitionChanges.map((change) => ({
              objectId: instance(change.subjectKey),
              property: change.property,
              reason: change.reason,
            })),
          },
          events: spatial.directing.events.map((event, index) => ({
            ...event,
            description: `${scene.events.find((c) => c.id === s.events[index].eventId)!.description} [${s.events[index].phase}]`,
            changes: index === s.events.length - 1 ? changes : [],
          })),
          cues: spatial.directing.cues,
          ...(ep.data.seriesProduction
            ? {
                carry: {
                  attributes: [
                    ...new Map(
                      [...start, ...end].map((f) => [
                        f.instanceId + ':' + f.key,
                        { instanceId: f.instanceId, key: f.key, reason: '已声明关键状态' },
                      ]),
                    ).values(),
                  ],
                  relationObjectIds: [
                    ...new Set(
                      [...s.entryRelations, ...s.exitRelations]
                        .filter((r) => r.type !== 'locatedIn')
                        .map((r) => instance(r.objectKey)),
                    ),
                  ],
                },
              }
            : {}),
          sound: {
            dialogue: lines.map((l) => ({
              id: l.id,
              delivery: s.dialogue.find((d) => d.lineId === l.id)!.delivery,
              mouth: s.dialogue.find((d) => d.lineId === l.id)!.mouth,
              instanceId: instance(l.speakerKey),
              language: l.language,
              text: l.text,
              ...(ep.data.seriesProduction
                ? { id: l.id, voiceProfile: voices.get(l.speakerKey) }
                : {}),
            })),
            environment: s.environmentSound,
            actions: s.actionSound,
            continuation: s.soundContinuation,
            music: 'N/A',
          },
        }),
      };
    });
    const segments = director.groups.map((g) => {
      const index = fullDirector.groups.findIndex((full) => full.id === g.id);
      const first = shots.find((s) => s.id === g.shotIds[0])!;
      const continuous = index > 0 && g.transition === 'continuous';
      const imageRequirements = requirements.filter(
        (i) =>
          i.mediaType === 'image' &&
          (!i.shotIds.length || i.shotIds.some((id) => g.shotIds.includes(id))),
      );
      const override = scope?.data.continuations?.[g.id];
      const incoming: any = override
        ? structuredClone(override)
        : ep.data.seriesProduction
          ? {
              version: 2,
              mode: continuous ? 'continue' : 'independent',
              cut: continuous ? 'angle' : 'independent',
              reason: g.reason,
              awaiting: continuous
                ? [{ episodeId: ep.id, segmentId: fullDirector.groups[index - 1].id }]
                : [],
            }
          : {
              version: 1,
              mode: continuous ? 'continue' : 'independent',
              ...(continuous
                ? {
                    awaiting: { episodeId: ep.id, segmentId: fullDirector.groups[index - 1].id },
                    decisions: first.state
                      .attributes!.start.filter((f) => f.status === 'known')
                      .map((f) => ({ instanceId: f.instanceId, key: f.key, decision: 'inherit' })),
                    relationDecisions: first.state.startRelations.map((r) => ({
                      objectId: r.objectId,
                      decision: 'inherit',
                    })),
                  }
                : {}),
            };
      if (!override && ep.data.seriesProduction && index === 0 && g.transition === 'continuous') {
        const prior = predecessorCanon(store, ep).canon;
        if (!prior)
          throw new HttpError(
            409,
            '首个片段声明承接前集，但没有有效的直接前置 Canon；请补齐系列依据或明确改为独立片段',
          );
        Object.assign(incoming, {
          mode: 'continue',
          cut: 'angle',
          sources: [{ id: 'previous-canon', canon: ref(prior), boundary: 'end' }],
          decisions: first.state
            .attributes!.start.filter((f) => f.status === 'known')
            .map((f) => ({
              instanceId: f.instanceId,
              key: f.key,
              decision: 'inherit',
              sourceId: 'previous-canon',
            })),
          relationDecisions: first.state.startRelations.map((r) => ({
            objectId: r.objectId,
            decision: 'inherit',
            sourceId: 'previous-canon',
          })),
        });
      }
      return {
        id: g.id,
        shotIds: g.shotIds,
        duration:
          g.shotIds.reduce((n, id) => n + director.shots.find((s) => s.id === id)!.frames, 0) / 24,
        prompt: g.shotIds.map((id) => director.shots.find((s) => s.id === id)!.action).join('\n'),
        mode: 't2v',
        references: [],
        guides: [],
        generationMode: 'formal',
        executionVersion: ep.data.seriesProduction ? 'native-h3-base-v4' : 'native-h3-base-v3',
        incoming,
        imageRequirements,
      };
    });
    const runtimeBounds = durationBounds(run.data.duration);
    const seriesProduction = ep.data.seriesProduction
      ? {
          ...ep.data.seriesProduction,
          ...(!run.data.effectivePlan && runtimeBounds
            ? {
                runtime: {
                  targetFrames: Math.round(run.data.duration.seconds * 24),
                  toleranceFrames: Math.min(
                    Math.round(run.data.duration.seconds * 24) - runtimeBounds.minFrames,
                    runtimeBounds.maxFrames - Math.round(run.data.duration.seconds * 24),
                  ),
                },
              }
            : {}),
          overrides: {
            visual: direction.visual,
            world: '',
            narrative: direction.narrative,
            direction: `${direction.directing}\n${direction.editing}\n${direction.sound}`,
            mixedMedia: direction.assetPolicy,
          },
          overrideReason: '本集已采用创作方向与交付时长',
          voices: [...voices].map(([key, voice]) => ({
            instanceId: instance(key),
            profile: voice,
            reason: '已听审并绑定的声音身份',
          })),
        }
      : undefined;
    ep = service.saveEpisode(
      ep.id,
      ep.revision,
      {
        ...ep.data,
        summary: script.summary,
        script: script.screenplayText,
        shots: [
          ...ep.data.shots.filter((s: any) => !scope.data.shotIds.includes(s.id)),
          ...shots,
        ].sort(
          (a, b) =>
            fullDirector.shots.findIndex((s) => s.id === a.id) -
            fullDirector.shots.findIndex((s) => s.id === b.id),
        ),
        segments: [
          ...ep.data.segments.filter((s: any) => !scope.data.groupIds.includes(s.id)),
          ...segments.map((segment) => {
            const existing = ep.data.segments.find((s: any) => s.id === segment.id);
            if (!existing?.shotIds.some((id: string) => !scope.data.shotIds.includes(id)))
              return segment;
            const shotIds = fullDirector.groups
              .find((g) => g.id === segment.id)!
              .shotIds.filter(
                (id) => existing.shotIds.includes(id) || segment.shotIds.includes(id),
              );
            if (generationDigest(shotIds) === generationDigest(existing.shotIds)) return existing;
            return {
              ...existing,
              shotIds,
              duration:
                shotIds.reduce(
                  (n, id) => n + fullDirector.shots.find((s) => s.id === id)!.frames,
                  0,
                ) / 24,
              prompt: shotIds
                .map((id) => fullDirector.shots.find((s) => s.id === id)!.action)
                .join('\n'),
            };
          }),
        ].sort(
          (a, b) =>
            fullDirector.groups.findIndex((g) => g.id === a.id) -
            fullDirector.groups.findIndex((g) => g.id === b.id),
        ),
        creationProfile: ref(profile),
        ...(seriesProduction ? { seriesProduction } : {}),
      },
      Object.values(run.data.results),
    );
    for (const segment of segments) {
      if (!segment.imageRequirements.length) continue;
      let plan = domain.save(run.projectId, 'reference_plan', {
        episodeId: ep.id,
        segmentId: segment.id,
        name: `${script.title} / ${segment.id}`,
        textIdentityInstanceIds: [
          ...new Set(
            director.shots
              .filter((s) => segment.shotIds.includes(s.id))
              .flatMap((s) => s.visibleSubjectKeys),
          ),
        ]
          .filter((key) => !segment.imageRequirements.some((item) => item.subjectKey === key))
          .map(instance),
        guides: segment.imageRequirements
          .filter(
            (item) =>
              bindings[item.id].groupStart?.groupId === segment.id &&
              bindings[item.id].groupStart.shotId === segment.shotIds[0],
          )
          .map((item) => ({
            bindingId: item.id,
            frameIndex: 0,
            instruction: `Use this inspected image as the opening composition and state of the group. ${(item.preserve || []).join('; ')}`,
          })),
        bindings: segment.imageRequirements.map((item) => ({
          id: item.id,
          asset: bindings[item.id].asset,
          instanceIds: [instance(item.subjectKey)],
          pack: packs.get(item.subjectKey),
          view: item.view,
          role:
            item.purpose === 'environment'
              ? 'scene'
              : item.purpose === 'style'
                ? 'style'
                : definitions.get(item.subjectKey)?.data.type === 'character'
                  ? 'identity'
                  : 'prop',
          priority: 4,
          required: true,
          reason: item.description,
          usage: {
            purpose: item.purpose,
            shotIds: item.shotIds.length
              ? item.shotIds.filter((id) => segment.shotIds.includes(id))
              : segment.shotIds,
            preserve: item.preserve || [],
            allow: item.allow || [],
            coverage: (bindings[item.id].coverage || []).filter((c: any) =>
              segment.shotIds.includes(c.shotId),
            ),
            reviewed: Boolean(bindings[item.id].inspected),
          },
        })),
      });
      plan = domain.publish(plan.id, plan.revision, {
        inspected: false,
        conclusion: segment.imageRequirements.map((i) => bindings[i.id].conclusion).join('\n'),
      });
      Object.assign(segment, {
        referencePlan: ref(plan),
        mode: 'ref2va',
        executionVersion: seriesProduction ? 'native-h3-directed-v4' : 'native-h3-directed-v3',
      });
    }
    if (segments.some((s) => s.imageRequirements.length))
      ep = service.saveEpisode(ep.id, ep.revision, {
        ...ep.data,
        segments: ep.data.segments.map((s: any) =>
          s.shotIds.every((id: string) => scope.data.shotIds.includes(id))
            ? segments.find((g) => g.id === s.id) || s
            : s,
        ),
      });
    ep = service.approveEpisode(ep.id, ep.revision);
    return updateRun(store, store.get(run.id), {
      materialized: {
        episode: ref(ep),
        profile: ref(profile),
        output,
        scope: ref(scope),
        segments: segments.map((segment) => segmentSchema.parse(segment)),
        results: run.data.results,
        bindingsDigest: generationDigest(bindings),
      },
      targetRevision: ep.revision,
      issues: [],
      state: 'active',
      mappings,
    });
  });
}

export function prepareCreationProduction(
  store: Store,
  run: RecordDoc,
  results: Results,
  policy: CreationSettings,
  previewOnly = false,
) {
  const scope = resolveScope(store, run);
  if (run.data.productionRevision) {
    const predecessor = episodePredecessor(store, store.get(run.data.episodeId));
    if (predecessor.hypothetical)
      return updateRun(store, run, {
        state: 'awaiting_review',
        issues: [issue('predecessor_waiting', predecessor.waiting!, '', 'evidence')],
        productionPreview: null,
        productionApproval: null,
      });
    assertEpisodePlanCurrent(store, run);
  }
  const invalidations = (run.data.resultInvalidations || []).filter(
    (entry: any) =>
      !entry.shotIds.length || entry.shotIds.some((id: string) => scope.data.shotIds.includes(id)),
  );
  if (invalidations.length)
    return updateRun(store, run, {
      state: 'needs_revision',
      issues: invalidations.flatMap((entry: any) =>
        entry.issues.map((i: CreationIssue) => ({
          ...i,
          message: `${entry.stage} 阶段需要修订：${i.message}`,
        })),
      ),
      productionPreview: null,
      productionApproval: null,
    });
  const associated = new Set((scope.data.candidates || []).map((c) => c.jobId));
  const allJobs = store
    .jobs(run.projectId)
    .filter(
      (j) =>
        j.kind === 'generation' &&
        (j.input.creationRunId === run.id || associated.has(j.id)) &&
        ((j.input.creationScope?.id === scope.id &&
          j.input.creationScope?.revision === scope.revision) ||
          associated.has(j.id)),
    );
  if (
    !run.data.materialized &&
    scope.data.groupIds.length &&
    scope.data.groupIds.every((id) => allJobs.some((j) => j.input.segment.id === id)) &&
    !creationMediaStatus(store, run).groups.some(
      (g: any) => scope.data.groupIds.includes(g.id) && g.selection,
    )
  ) {
    return updateRun(store, run, {
      stage: 'review',
      state: allJobs.some(
        (j) => !['succeeded', 'failed', 'cancelled', 'unknown', 'archive_failed'].includes(j.state),
      )
        ? 'generating'
        : 'awaiting_review',
      issues: scope.data.groupIds.flatMap((id) => {
        const issue = candidateIssue(allJobs.filter((j) => j.input.segment.id === id).at(-1)!);
        return issue ? [issue] : [];
      }),
      productionPreview: null,
      productionApproval: null,
    });
  }
  results = Object.fromEntries(
    Object.entries(scope.data.authoring).map(([stage, r]) => [
      stage,
      store.get(r!.id, r!.revision).data.result,
    ]),
  );
  if (!run.data.materialized) {
    run = materialize(store, run, results);
    if (!run.data.materialized) return run;
  }
  let ep = store.get(run.data.episodeId);
  if (ep.revision !== run.data.targetRevision)
    throw new HttpError(409, '正式分集已改变，请在创作会话中明确重新读取与采用');
  const media = creationMediaStatus(store, run);
  const groups = media.groups.filter((g: any) => scope.data.groupIds.includes(g.id));
  if (!previewOnly && groups.length && groups.every((g: any) => !!g.selection))
    return updateRun(store, run, {
      stage: 'editorial',
      state: 'active',
      issues: [],
      pendingJobId: null,
    });
  const issues: CreationIssue[] = [],
    prepared: any[] = [];
  for (const group of groups) {
    if (group.selection) continue;
    const latest = allJobs.filter((j) => j.input.segment.id === group.id).at(-1);
    if (latest) {
      const jobIssue = candidateIssue(latest);
      if (jobIssue) issues.push(jobIssue);
      continue;
    }
    if (results.director?.stage !== 'director' || results.director.contractRevision !== 2) {
      issues.push(
        issue(
          'director_contract_revision',
          '原 V9 导演仅供查看、审看与原作业恢复；新增生成须完成修订 2 导演设计并重新预览。',
          group.id,
          'consistency',
        ),
      );
      continue;
    }
    const segment = run.data.materialized.segments.find((s: any) => s.id === group.id);
    const awaiting =
      segment.incoming?.version === 2 ? segment.incoming.awaiting?.[0] : segment.incoming?.awaiting;
    if (awaiting) {
      const previous = media.groups.find((g: any) => g.id === awaiting.segmentId)?.selection;
      if (!previous) {
        issues.push(
          issue(
            'upstream_selection_required',
            `${group.id} 等待 ${awaiting.segmentId} 的实际采用边界`,
            group.id,
            'evidence',
          ),
        );
        continue;
      }
      const first = ep.data.shots.find((s: any) => s.id === segment.shotIds[0]);
      const incoming =
        segment.incoming.version === 2
          ? {
              ...segment.incoming,
              sources: [{ id: 'previous', selection: previous, boundary: 'end' }],
              awaiting: [],
              decisions: first.state.attributes.start
                .filter((f: any) => f.status === 'known')
                .map((f: any) => ({
                  instanceId: f.instanceId,
                  key: f.key,
                  decision: 'inherit',
                  sourceId: 'previous',
                })),
              relationDecisions: first.state.startRelations.map((r: any) => ({
                objectId: r.objectId,
                decision: 'inherit',
                sourceId: 'previous',
              })),
            }
          : { ...segment.incoming, selection: previous };
      if (generationDigest(incoming) !== generationDigest(segment.incoming)) {
        const fullSegment = ep.data.segments.find((s: any) => s.id === segment.id);
        if (generationDigest(fullSegment.shotIds) === generationDigest(segment.shotIds)) {
          const service = new StudioService(store);
          ep = service.saveEpisode(ep.id, ep.revision, {
            ...ep.data,
            segments: ep.data.segments.map((s: any) =>
              s.id === segment.id ? { ...s, incoming } : s,
            ),
          });
          ep = service.approveEpisode(ep.id, ep.revision);
        }
        run = updateRun(store, run, {
          targetRevision: ep.revision,
          materialized: {
            ...run.data.materialized,
            episode: ref(ep),
            segments: run.data.materialized.segments.map((s: any) =>
              s.id === segment.id ? { ...s, incoming } : s,
            ),
          },
        });
      }
    }
    try {
      const profile = run.data.materialized.output;
      const preparation = new ReadinessService(store).generation(
        {
          episodeId: ep.id,
          episodeRevision: ep.revision,
          segmentId: group.id,
          width: profile.width,
          height: profile.height,
          steps: profile.steps,
          seed: profile.seed ?? 0,
        },
        store.setting('comfy', null as any),
        ref(scope),
      );
      const p = preparation.input as any;
      const ratio = p.prepared?.request?.ratio;
      const firstBinding =
        p.prepared?.inputBindings?.find((b: any) => b.role === 'first_frame') ||
        p.prepared?.inputBindings?.[0];
      const firstAsset = p.assets?.find((a: any) => a.asset.id === firstBinding?.asset.id)?.asset;
      const size =
        ratio && ratio !== 'adaptive'
          ? ratio.split(':').map(Number)
          : ratio === 'adaptive'
            ? [firstAsset?.data.width, firstAsset?.data.height]
            : [profile.width, profile.height];
      const format = run.data.effectivePlan
        ? formatComparison(run.data.effectivePlan, size[0], size[1])
        : null;
      if (format && (!size.every((v: number) => Number.isFinite(v) && v > 0) || !format.ready))
        throw new HttpError(409, format.message);
      const preparedInput = {
        ...preparation.input,
        ...(run.data.effectivePlan
          ? { effectivePlan: run.data.effectivePlan, formatComparison: format }
          : {}),
        authoringVersion: 9,
        contractRevision: 2,
        authoring: scope.data.authoring,
        executionText: scope.data.executionText || null,
        contentDigest: generationDigest({
          shots: preparation.input.planning?.shots,
          records: preparation.input.planning?.records,
        }),
        creationRunId: run.id,
        creationEpoch: run.data.epoch,
        creationScope: ref(scope),
        referenceCoverage: referenceCoverage(
          {
            ...(results.director as DirectorResult),
            shots: (results.director as DirectorResult).shots.filter((s) =>
              group.shotIds.includes(s.id),
            ),
          },
          results.assets?.stage === 'assets' ? results.assets.items : [],
          run.data.bindings,
        ),
      };
      prepared.push(
        scope.data.experiment
          ? bindExperimentInput(store, preparedInput, scope.data.experiment)
          : preparedInput,
      );
    } catch (e) {
      if (!(e instanceof HttpError || e instanceof z.ZodError)) throw e;
      issues.push(issue('execution_not_ready', e.message, group.id));
    }
  }
  const digest = generationDigest({
    epoch: run.data.epoch,
    scope: ref(scope),
    materialized: run.data.materialized,
    policyRevision: store.list('creation_settings', run.projectId)[0]?.revision,
    prepared,
  });
  if (
    prepared.length &&
    (previewOnly || (policy.progression === 'review' && run.data.productionApproval !== digest))
  )
    return updateRun(store, run, {
      productionPreview: {
        digest,
        scope: ref(scope),
        inputs: prepared,
        groups: prepared.map((i) => ({
          id: i.segment.id,
          seconds: i.segment.duration,
          width: i.width,
          height: i.height,
          steps: i.steps,
          seed: i.seed,
          references: i.segment.references,
          template: i.templateVersion,
          prompt: i.prepared,
        })),
      },
      issues,
      state: 'awaiting_production_approval',
    });
  if (prepared.length)
    return store.transaction(() => {
      for (const input of prepared)
        store.createJob(
          'generation',
          run.projectId,
          ep.id,
          input,
          `creation:${run.id}:scope:${scope.id}:${scope.revision}:video:${input.segment.id}`,
        );
      return updateRun(store, run, {
        state: 'generating',
        issues,
        productionPreview: null,
        productionApproval: null,
      });
    });
  return updateRun(store, run, {
    stage: allJobs.length ? 'review' : 'production',
    state: allJobs.some(
      (j) => !['succeeded', 'failed', 'cancelled', 'unknown', 'archive_failed'].includes(j.state),
    )
      ? 'generating'
      : 'awaiting_review',
    issues,
  });
}
