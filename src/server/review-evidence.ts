import { HttpError, type Store } from './db.js';
import {
  soundRequirements,
  evaluateCondition,
  validateShotSemantics,
} from '../shared/shot-semantics.js';
import { prepareShot } from '../shared/directing.js';
import { generationDigest } from './h3-guided.js';
import { actionPhaseIssues } from '../shared/series.js';
import { resolveSeries } from './series-production.js';

export function validateIssueTarget(
  specs: any[],
  issue: { shotId?: string; interactionId?: string; eventId?: string; lineId?: string },
) {
  if (!issue.shotId && !issue.interactionId && !issue.eventId && !issue.lineId) return;
  const spec = specs.find((s) => s.shotId === issue.shotId);
  if (
    !spec ||
    (issue.interactionId &&
      !spec.directing?.interactions?.some((i: any) => i.id === issue.interactionId)) ||
    (issue.eventId && !spec.directing?.events?.some((e: any) => e.id === issue.eventId)) ||
    (issue.lineId && !spec.directing?.sound?.dialogue?.some((l: any) => l.id === issue.lineId))
  )
    throw new HttpError(400, '媒体问题必须关联本任务冻结的镜头、交互、事件或对白');
}

// Explicit post-generation evaluation does not claim that the model received this contract.
export function buildReviewEvaluation(store: Store, projectId: string, job: any, basis: any) {
  if (!basis) return null;
  const ep = store.get(basis.id, basis.revision),
    head = store.get(basis.id);
  if (
    job.projectId !== projectId ||
    ep.projectId !== projectId ||
    ep.kind !== 'episode' ||
    job.episodeId !== ep.id ||
    ep.revision !== head.revision ||
    !ep.data.approved ||
    ep.data.stale
  )
    throw new HttpError(409, '新版观察审核需要本任务所属分集的当前已审核版本');
  const shots = job.input.segment.shotIds.map((id: string) =>
    ep.data.shots.find((s: any) => s.id === id),
  );
  if (shots.some((s: any) => !(s?.directing?.version >= 2)))
    throw new HttpError(409, '先显式转换并审核对应镜头的通用契约；旧任务不重新编译');
  const refs = shots.flatMap((s: any) =>
    [
      s.state?.layout,
      ...(s.state?.instances || []).flatMap((i: any) => [i.entity, i.appearance, i.pack]),
    ].filter(Boolean),
  );
  const records: any[] = [
    ...new Map<string, any>(
      refs.map((r: any) => [`${r.id}:${r.revision}`, store.get(r.id, r.revision)]),
    ).values(),
  ];
  if (records.some((r) => r.projectId !== projectId))
    throw new HttpError(400, '观察审核依据跨项目');
  const issues = shots.flatMap((s: any) => validateShotSemantics(s, records));
  if (issues.length) throw new HttpError(409, issues.join('；'));
  return {
    version: 1,
    source: 'explicit_post_generation_review',
    episode: basis,
    shotSpecs: shots.map((s: any) => prepareShot(s, records)),
    records,
    actionDefinitions: ep.data.seriesProduction
      ? resolveSeries(store, ep).production.actionDefinitions
      : [],
  };
}

export function validateObservedReview(job: any, video: any, review: any) {
  const specs = job.input.prepared?.shotSpecs || [];
  if (!specs.some((s: any) => s.version >= 2)) {
    if (
      review.observations?.length ||
      review.audioEvidence?.length ||
      review.relationObservations?.length
    )
      throw new HttpError(400, '旧任务没有收到新版契约；请保留原审核语义，不补写新版观察事实');
    return;
  }
  if (!Number.isInteger(video.data.frameCount)) throw new HttpError(409, '需要归档后的实际帧数');
  const instances = specs.flatMap((s: any) => s.state?.instances || []);
  const records = job.input.planning?.records || [];
  const rows = [
    ...(review.boundaryWindows || []),
    ...(review.observations || []),
    ...(review.relationObservations || []),
    ...(review.audioEvidence || []),
    ...(review.cueEvidence || []),
    ...(review.interactionEvidence || []),
    ...(review.audioEvidence || []).flatMap((a: any) => a.mouthWindows || []),
  ];
  if ([review.in, review.out].some((v) => Math.abs(v * 24 - Math.round(v * 24)) > 1e-6))
    throw new HttpError(400, '新版审核必须使用整帧区间');
  for (const row of rows) {
    if (
      row.startFrame < review.in * 24 ||
      row.endFrame > review.out * 24 ||
      row.endFrame > video.data.frameCount ||
      row.endFrame <= row.startFrame
    )
      throw new HttpError(400, '实际观察区间超出源媒体或审核范围');
    if (row.inspection && row.inspection !== 'frame' && row.endFrame - row.startFrame < 2)
      throw new HttpError(400, '运动与听审不能用单帧证明');
  }
  for (const w of review.boundaryWindows || []) {
    if (!specs.some((s: any) => s.version === 3))
      throw new HttpError(400, '边界动作窗口需要 V7 契约或明确事后审核依据');
    if (w.actions.some((a: any) => !instances.some((i: any) => i.instanceId === a.instanceId)))
      throw new HttpError(400, '边界动作引用未声明实例');
    const phaseIssues = actionPhaseIssues(
      w.actions,
      job.input.seriesInputs?.actionDefinitions || [],
      specs.flatMap((s: any) => s.directing?.events || []),
    );
    if (phaseIssues.length) throw new HttpError(400, phaseIssues.join('；'));
    if (w.inspection === 'audio' && w.actions.length)
      throw new HttpError(400, '声音窗口不能代替动作观察');
    if (new Set(w.actions.map((a: any) => a.instanceId + ':' + a.id)).size !== w.actions.length)
      throw new HttpError(400, '边界动作观察重复');
  }
  const observations = review.observations || [];
  for (const entries of [review.relationObservations || [], review.audioEvidence || []]) {
    const keys = entries.map((o: any) => o.id || `${o.shotId}:${o.requirementId}`);
    if (new Set(keys).size !== keys.length) throw new HttpError(400, '关系或声音审核项重复');
  }
  if (new Set(observations.map((o: any) => o.id)).size !== observations.length)
    throw new HttpError(400, '观察 ID 重复');
  for (const o of observations) {
    const instance = instances.find((i: any) => i.instanceId === o.instanceId);
    const entity =
      instance &&
      records.find(
        (r: any) => r.id === instance.entity.id && r.revision === instance.entity.revision,
      );
    const def = entity?.data.attributes?.find((a: any) => a.key === o.key);
    if (
      !def ||
      (o.status === 'known' &&
        (def.type === 'enum' ? !def.values.includes(o.value) : typeof o.value !== def.type))
    )
      throw new HttpError(400, `观察引用未声明属性或类型错误：${o.instanceId}.${o.key}`);
    if (
      observations.some(
        (p: any) =>
          p.id !== o.id &&
          p.instanceId === o.instanceId &&
          p.key === o.key &&
          p.startFrame < o.endFrame &&
          p.endFrame > o.startFrame &&
          p.status === 'known' &&
          o.status === 'known' &&
          p.value !== o.value,
      )
    )
      throw new HttpError(400, '重叠区间存在互相矛盾的已知观察');
  }
  for (const o of review.relationObservations || []) {
    if (
      new Set(o.objectIds).size !== o.objectIds.length ||
      o.objectIds.some((id: string) => !instances.some((i: any) => i.instanceId === id)) ||
      o.relations.some((r: any) => !o.objectIds.includes(r.objectId) || !r.confirmed)
    )
      throw new HttpError(400, '关系观察必须声明已检查对象，且每条关系已确认');
    for (const relation of o.relations) {
      const target = instances.find((i: any) => i.instanceId === relation.targetId);
      const entity =
        target &&
        records.find(
          (r: any) => r.id === target.entity.id && r.revision === target.entity.revision,
        );
      const region = records.some(
        (r: any) =>
          r.kind === 'layout' && r.data.regions.some((v: any) => v.id === relation.targetId),
      );
      if (
        relation.quantity > relation.maxQuantity ||
        (relation.type === 'locatedIn' ? !region : !target) ||
        (relation.anchor && !entity?.data.anchors.includes(relation.anchor))
      )
        throw new HttpError(400, '实际关系的目标、附着点或数量无效');
    }
  }
  const audio = review.audioEvidence || [];
  const interactions = review.interactionEvidence || [];
  if (
    new Set(interactions.map((e: any) => `${e.shotId}:${e.interactionId}`)).size !==
    interactions.length
  )
    throw new HttpError(400, '交互审核重复');
  for (const e of interactions)
    if (
      !specs
        .find((s: any) => s.shotId === e.shotId)
        ?.directing?.interactions?.some((i: any) => i.id === e.interactionId)
    )
      throw new HttpError(400, '交互审核必须对应实际冻结的交互');
  const cueEvidence = review.cueEvidence || [];
  if (new Set(cueEvidence.map((e: any) => `${e.shotId}:${e.cueId}`)).size !== cueEvidence.length)
    throw new HttpError(400, '时序审核重复');
  for (const ev of cueEvidence) {
    const cue = specs
      .find((s: any) => s.shotId === ev.shotId)
      ?.directing?.cues?.find((c: any) => c.id === ev.cueId);
    if (!cue || ev.inspection !== (cue.target.kind === 'dialogue' ? 'audio' : 'motion'))
      throw new HttpError(400, '时序审核没有对应要求或审查方式不符');
  }
  if (new Set(audio.map((a: any) => `${a.shotId}:${a.requirementId}`)).size !== audio.length)
    throw new HttpError(400, '声音审核重复');
  for (const ev of audio) {
    const spec = specs.find((s: any) => s.shotId === ev.shotId);
    if (!soundRequirements(spec?.directing).some((r) => r.id === ev.requirementId))
      throw new HttpError(400, '声音审核未对应冻结要求');
    const windows = [...(ev.mouthWindows || [])].sort(
      (a: any, b: any) => a.startFrame - b.startFrame,
    );
    if (
      windows.some(
        (w: any, i: number) =>
          w.startFrame < ev.startFrame ||
          w.endFrame > ev.endFrame ||
          (i > 0 && w.startFrame < windows[i - 1].endFrame),
      )
    )
      throw new HttpError(400, '嘴部可见区间越界或重叠');
    if (windows.length && ev.mouthObserved !== 'visible')
      throw new HttpError(400, '嘴部区间与实际可见性不符');
  }
}

export function selectedBoundary(specs: any[], review: any, selection: any) {
  const startFrame = Math.round(selection.in * 24),
    endFrame = Math.round(selection.out * 24);
  const boundary = (side: 'start' | 'end', frame: number, spec: any) => {
    const observations = (review.observations || []).filter(
      (o: any) => o.startFrame <= frame && o.endFrame > frame,
    );
    const keys = [
      ...new Set<string>(
        [...(spec.state?.attributes?.[side] || []), ...observations].map(
          (f) => `${f.instanceId}:${f.key}`,
        ),
      ),
    ];
    const facts = keys.map((key) => {
      const matches = observations.filter((o: any) => `${o.instanceId}:${o.key}` === key),
        planned = spec.state?.attributes?.[side]?.find(
          (f: any) => `${f.instanceId}:${f.key}` === key,
        );
      const base = matches[0] || planned;
      const known =
        matches.length &&
        evaluateCondition(
          { instanceId: base.instanceId, key: base.key, operator: 'eq', value: base.value },
          matches,
        ) === 'pass';
      return {
        instanceId: base.instanceId,
        key: base.key,
        status: known ? 'known' : 'unknown',
        value: known ? base.value : null,
        observationIds: matches.map((o: any) => o.id),
      };
    });
    const relationEvidence = (review.relationObservations || []).filter(
      (o: any) => o.startFrame <= frame && o.endFrame > frame,
    );
    const relationObjectIds = [
      ...new Set<string>(relationEvidence.flatMap((o: any) => o.objectIds)),
    ];
    const relations = relationObjectIds.flatMap((id) => {
      const versions = relationEvidence
        .filter((o: any) => o.objectIds.includes(id))
        .map((o: any) => o.relations.filter((r: any) => r.objectId === id));
      if (new Set(versions.map(generationDigest)).size !== 1)
        throw new HttpError(409, '边界关系观察互相矛盾');
      return versions[0];
    });
    for (const relation of spec.state?.[`${side}Relations`] || []) {
      if (
        !relationObjectIds.includes(relation.objectId) ||
        !relations.some((r: any) => generationDigest(r) === generationDigest(relation))
      )
        throw new HttpError(409, `${side} 边界关系没有实际证据：${relation.objectId}`);
    }
    const windows = (review.boundaryWindows || []).filter(
      (w: any) =>
        w.side === side &&
        w.startFrame <= frame &&
        w.endFrame > frame &&
        w.startFrame >= startFrame &&
        w.endFrame <= endFrame,
    );
    const motion = windows.filter((w: any) => w.inspection === 'motion' && w.status === 'pass');
    if (new Set(motion.map((w: any) => generationDigest(w.actions))).size > 1)
      throw new HttpError(409, '边界窗口的动作观察冲突');
    return {
      ...(spec.version === 3 ? { windows, actions: motion[0]?.actions || [] } : {}),
      frame,
      facts,
      relations,
      relationObjectIds,
      relationObservationIds: relationEvidence.map((o: any) => o.id),
    };
  };
  return {
    startFrame,
    endFrame,
    source: { video: selection.video, review: selection.review },
    start: boundary('start', startFrame, specs[0]),
    end: boundary('end', endFrame - 1, specs.at(-1)),
  };
}
