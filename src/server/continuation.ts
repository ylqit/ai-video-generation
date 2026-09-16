import { HttpError, type Store } from './db.js';
import { evaluateCondition, incomingV2Schema, type StateFact } from '../shared/shot-semantics.js';
import { fixedSeriesRecord, predecessorCanon } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import { boundaryChanges } from './generation-dependencies.js';
import { repairWindow, selectionMedia, repairSourceUnchanged } from './selection-splice.js';

// Preparation owns source validation and comparison. It never writes planned facts or Canon.
export function prepareContinuation(store: Store, episode: any, segment: any) {
  if (segment.incoming?.version === 2) {
    const result = prepareMultipleSources(store, episode, segment);
    if (segment.repair) {
      const repair = prepareContinuation(store, episode, { ...segment, incoming: undefined });
      result.dependencies.push(...repair.dependencies);
    }
    return result;
  }
  const incoming = segment.incoming,
    repair = segment.repair;
  const dependencies: { id: string; revision: number }[] = [];
  const source = (ref: any) => {
    const doc = store.get(ref.id, ref.revision),
      head = store.get(ref.id);
    const changedForRepair =
      repair?.sourceSelection.id === ref.id && repairSourceUnchanged(doc, head);
    if (
      doc.projectId !== episode.projectId ||
      doc.kind !== 'segment_selection' ||
      !doc.data.boundary ||
      doc.data.stale ||
      (head.data.stale && !changedForRepair)
    )
      throw new HttpError(409, '接续需要已审核采用区间的实际边界；旧采用请显式重新审核');
    if (doc.parentId === episode.id && doc.data.segmentId === segment.id && !repair)
      throw new HttpError(400, '片段不能继承自身采用结果');
    dependencies.push(ref, doc.data.video, doc.data.review);
    for (const part of selectionMedia(doc.data)) dependencies.push(part.video, part.review);
    return { doc, head, changedForRepair };
  };
  let inherited: StateFact[] = [],
    relations: any[] = [],
    snapshot: any = null;
  if (incoming && incoming.mode !== 'independent') {
    if (incoming.awaiting) {
      const previous = store.get(incoming.awaiting.episodeId);
      if (
        previous.projectId !== episode.projectId ||
        previous.kind !== 'episode' ||
        !previous.data.segments.some((s: any) => s.id === incoming.awaiting.segmentId) ||
        (previous.id === episode.id && incoming.awaiting.segmentId === segment.id)
      )
        throw new HttpError(400, '等待的上游片段不存在或引用自身');
    }
    if (!incoming.selection)
      throw new HttpError(
        409,
        '等待上游实际采用，并明确选择固定边界版本；计划结果不能作为生成输入',
      );
    const { doc, head } = source(incoming.selection);
    if (
      incoming.awaiting &&
      (doc.parentId !== incoming.awaiting.episodeId ||
        doc.data.segmentId !== incoming.awaiting.segmentId)
    )
      throw new HttpError(409, '采用版本与声明的上游片段不一致');
    const side = incoming.boundary || 'end',
      boundary = doc.data.boundary[side];
    const changed = boundaryChanges(doc.data.boundary, head.data.boundary)[side];
    const first = episode.data.shots.find((s: any) => s.id === segment.shotIds[0]);
    const keys = incoming.decisions.map((d: any) => `${d.instanceId}:${d.key}`);
    if (
      new Set(keys).size !== keys.length ||
      new Set(incoming.relationDecisions.map((d: any) => d.objectId)).size !==
        incoming.relationDecisions.length
    )
      throw new HttpError(400, '接续属性或关系决策重复');
    if (!keys.length && !incoming.relationDecisions.length)
      throw new HttpError(400, '接续必须声明需要的状态或关系');
    for (const d of incoming.decisions) {
      if (changed.keys.includes(`${d.instanceId}:${d.key}`))
        throw new HttpError(409, `采用依据已改变：${d.instanceId}.${d.key}，请重新选择来源并审核`);
      const fact = boundary.facts.find(
        (f: any) => f.instanceId === d.instanceId && f.key === d.key,
      );
      if (d.decision === 'inherit' && fact?.status !== 'known')
        throw new HttpError(409, `来源边界未确认 ${d.instanceId}.${d.key}`);
      const expected: StateFact = {
        instanceId: d.instanceId,
        key: d.key,
        status: 'known',
        value: d.decision === 'inherit' ? fact.value : d.value,
      };
      if (
        evaluateCondition(
          { ...expected, operator: 'eq', value: expected.value! },
          first?.state?.attributes?.start || [],
        ) !== 'pass'
      )
        throw new HttpError(409, `镜头起始状态与接续决策不符：${d.instanceId}.${d.key}`);
      inherited.push(expected);
    }
    for (const d of incoming.relationDecisions) {
      if (changed.objects.includes(d.objectId))
        throw new HttpError(409, `采用关系已改变：${d.objectId}`);
      const actual = boundary.relations.filter((r: any) => r.objectId === d.objectId);
      const planned = (first?.state?.startRelations || []).filter(
        (r: any) => r.objectId === d.objectId,
      );
      if (
        d.decision === 'inherit' &&
        (!boundary.relationObjectIds?.includes(d.objectId) ||
          generationDigest(actual) !== generationDigest(planned))
      )
        throw new HttpError(409, `持有、包含或数量关系未确认或不匹配：${d.objectId}`);
      relations.push(...planned);
    }
    snapshot = {
      selection: incoming.selection,
      boundary: side,
      frame: boundary.frame,
      source: boundary.source || doc.data.boundary.source,
      mode: incoming.mode,
      facts: inherited,
      relations,
    };
  }
  if (repair) {
    const { doc, head, changedForRepair } = source(repair.sourceSelection);
    if (doc.revision !== head.revision && !changedForRepair)
      throw new HttpError(409, '局部修订来源已变化，请重新检查问题与替换范围');
    repairWindow(doc.data, repair);
    if (
      repair.generationRange.startFrame !== 0 ||
      repair.generationRange.endFrame > Math.round(segment.duration * 24)
    )
      throw new HttpError(400, '候选生成范围使用从零开始的本地帧，不能超过请求时长');
    const last = episode.data.shots.find((s: any) => s.id === segment.shotIds.at(-1));
    for (const f of repair.desiredEnd)
      if (
        f.status === 'known' &&
        evaluateCondition(
          { ...f, operator: 'eq', value: f.value! },
          last?.state?.attributes?.end || [],
        ) !== 'pass'
      )
        throw new HttpError(409, '修订目标结束状态必须进入最后镜头契约');
  }
  return { snapshot, dependencies, repair: repair || null };
}

function prepareMultipleSources(store: Store, episode: any, segment: any) {
  const incoming = incomingV2Schema.parse(segment.incoming),
    first = episode.data.shots.find((s: any) => s.id === segment.shotIds[0]);
  if (first?.directing?.version !== 3) throw new HttpError(400, '多来源接续需要 directing v3');
  const dependencies: { id: string; revision: number }[] = [];
  const required = new Map<string, { instanceId: string; key: string; reason: string }>();
  for (const event of first.directing.events)
    for (const c of event.preconditions)
      required.set(`${c.instanceId}:${c.key}`, {
        instanceId: c.instanceId,
        key: c.key,
        reason: `动作前提 ${event.id}`,
      });
  for (const c of first.directing.carry.attributes) required.set(`${c.instanceId}:${c.key}`, c);
  for (const i of first.state.instances) {
    const entity = fixedSeriesRecord(store, episode.projectId, i.entity, 'entity');
    for (const a of entity.data.attributes || [])
      if (['scene', 'series'].includes(a.continuity))
        required.set(`${i.instanceId}:${a.key}`, {
          instanceId: i.instanceId,
          key: a.key,
          reason: `${a.continuity} 关键属性`,
        });
  }
  if (incoming.awaiting.length)
    throw new HttpError(409, '等待明确的上游采用或剧情确认；完成后选择固定来源');
  if (incoming.mode === 'continue') predecessorCanon(store, episode);
  const sources = incoming.sources.map((s) => {
    const ref = (s.selection || s.canon)!,
      doc = fixedSeriesRecord(
        store,
        episode.projectId,
        ref,
        s.selection ? 'segment_selection' : 'continuity',
      );
    if (s.selection) {
      if (!doc.data.boundary || (doc.parentId === episode.id && doc.data.segmentId === segment.id))
        throw new HttpError(409, '采用来源缺少实际边界或引用自身');
      const sourceEp = store.get(doc.parentId!);
      if (
        incoming.mode !== 'historical' &&
        (sourceEp.data.seriesId !== episode.data.seriesId ||
          (sourceEp.id !== episode.id && sourceEp.data.number >= episode.data.number) ||
          (sourceEp.id === episode.id &&
            episode.data.segments.findIndex((v: any) => v.id === doc.data.segmentId) >=
              episode.data.segments.findIndex((v: any) => v.id === segment.id)))
      )
        throw new HttpError(400, '普通接续不能引用未来片段或其他系列');
      for (const p of selectionMedia(doc.data)) dependencies.push(p.video, p.review);
      const boundary = doc.data.boundary[s.boundary];
      return {
        id: s.id,
        ref,
        side: s.boundary,
        doc,
        facts: boundary.facts || [],
        relations: boundary.relations || [],
        relationObjectIds: boundary.relationObjectIds || [],
        actions: boundary.actions || [],
      };
    }
    if (doc.data.schemaVersion !== 3 || !doc.data.confirmed)
      throw new HttpError(409, '需要已确认 Canon v3');
    if (incoming.mode !== 'historical') {
      const prior = predecessorCanon(store, episode).canon;
      if (!prior || prior.id !== doc.id || prior.revision !== doc.revision)
        throw new HttpError(409, '普通接续必须引用直接前置 Canon');
    }
    return {
      id: s.id,
      ref,
      side: s.boundary,
      doc,
      facts: doc.data.attributes || [],
      relations: doc.data.relations || [],
      relationObjectIds: (doc.data.relationSources || []).map((r: any) => r.objectId),
      actions: doc.data.unfinishedActions || [],
    };
  });
  dependencies.push(...sources.map((s) => s.ref));
  const keys = incoming.decisions.map((d) => `${d.instanceId}:${d.key}`);
  if (new Set(keys).size !== keys.length)
    throw new HttpError(409, '多个来源对同一属性存在重复或冲突，必须明确选择');
  const facts: any[] = [],
    relations: any[] = [],
    actions: any[] = [];
  const planned = first.state.attributes?.start || [];
  for (const d of incoming.decisions) {
    const source = sources.find((s) => s.id === d.sourceId);
    const actual = source?.facts.find((f: any) => f.instanceId === d.instanceId && f.key === d.key);
    if (d.decision === 'not_applicable') {
      if (required.has(`${d.instanceId}:${d.key}`))
        throw new HttpError(409, '关键属性或动作前提不能设为不适用；先修改并审核要求');
      continue;
    }
    if (d.decision === 'inherit' && actual?.status !== 'known')
      throw new HttpError(409, `来源状态未知 ${d.instanceId}.${d.key}`);
    const competing = sources
      .flatMap((s) => s.facts)
      .filter((f: any) => f.instanceId === d.instanceId && f.key === d.key && f.status === 'known');
    if (new Set(competing.map((f: any) => generationDigest(f.value))).size > 1 && !d.reason.trim())
      throw new HttpError(409, '多个来源的同一属性冲突，请说明选择依据');
    const value = d.decision === 'inherit' ? actual.value : d.value;
    if (
      value === undefined ||
      evaluateCondition(
        { instanceId: d.instanceId, key: d.key, operator: 'eq', value },
        planned,
      ) !== 'pass'
    )
      throw new HttpError(409, `起始状态与接续不符 ${d.instanceId}.${d.key}`);
    facts.push({ instanceId: d.instanceId, key: d.key, status: 'known', value });
    if (source && d.decision === 'inherit' && source.doc.kind === 'segment_selection') {
      const change = boundaryChanges(
        source.doc.data.boundary,
        store.get(source.doc.id).data.boundary,
      )[source.side];
      if (change.keys.includes(`${d.instanceId}:${d.key}`))
        throw new HttpError(409, '采用属性已改变，请重新选择来源');
    }
  }
  for (const r of required.values())
    if (!keys.includes(`${r.instanceId}:${r.key}`)) {
      if (
        incoming.mode === 'independent' &&
        planned.some(
          (f: any) => f.instanceId === r.instanceId && f.key === r.key && f.status === 'known',
        )
      )
        continue;
      throw new HttpError(409, `缺少必查状态决策 ${r.instanceId}.${r.key}（${r.reason}）`);
    }
  const relationIds = [
    ...new Set([
      ...(first.directing.carry.relationObjectIds || []),
      ...(first.state.startRelations || []).map((r: any) => r.objectId),
    ]),
  ];
  if (
    new Set(incoming.relationDecisions.map((d) => d.objectId)).size !==
    incoming.relationDecisions.length
  )
    throw new HttpError(400, '接续关系决策重复');
  for (const id of relationIds)
    if (
      incoming.mode !== 'independent' &&
      !incoming.relationDecisions.some((d) => d.objectId === id)
    )
      throw new HttpError(409, `缺少必查关系 ${id}`);
  for (const d of incoming.relationDecisions) {
    const source = sources.find((s) => s.id === d.sourceId),
      expected = (first.state.startRelations || []).filter((r: any) => r.objectId === d.objectId);
    if (d.decision === 'not_applicable') {
      if (relationIds.includes(d.objectId)) throw new HttpError(409, '关键关系不能省略');
      continue;
    }
    if (
      d.decision === 'inherit' &&
      (!source?.relationObjectIds.includes(d.objectId) ||
        generationDigest(expected) !==
          generationDigest(source.relations.filter((r: any) => r.objectId === d.objectId)))
    )
      throw new HttpError(409, '继承关系未知或不匹配');
    if (
      source?.doc.kind === 'segment_selection' &&
      d.decision === 'inherit' &&
      boundaryChanges(source.doc.data.boundary, store.get(source.doc.id).data.boundary)[
        source.side
      ].objects.includes(d.objectId)
    )
      throw new HttpError(409, '采用关系已改变，请重新选择来源');
    relations.push(...expected);
  }
  const neededActions = [
    ...first.directing.carry.startActions,
    ...sources.flatMap((s) =>
      s.actions.filter(
        (a: any) =>
          a.unfinished && first.state.instances.some((i: any) => i.instanceId === a.instanceId),
      ),
    ),
  ];
  if (
    new Set(incoming.actionDecisions.map((d) => `${d.instanceId}:${d.actionId}`)).size !==
    incoming.actionDecisions.length
  )
    throw new HttpError(400, '动作接续决策重复');
  for (const a of neededActions)
    if (
      incoming.mode !== 'independent' &&
      !incoming.actionDecisions.some((d) => d.instanceId === a.instanceId && d.actionId === a.id)
    )
      throw new HttpError(409, `未完成动作需要明确接续 ${a.id}`);
  for (const d of incoming.actionDecisions) {
    const actual = sources
      .find((s) => s.id === d.sourceId)
      ?.actions.find((a: any) => a.id === d.actionId && a.instanceId === d.instanceId);
    const start = first.directing.carry.startActions.find(
      (a: any) => a.id === d.actionId && a.instanceId === d.instanceId,
    );
    if (
      d.decision === 'not_applicable' &&
      ['ellipsis', 'location_change', 'flashback'].includes(incoming.cut)
    )
      continue;
    if (
      !start ||
      (d.decision === 'inherit' ? !actual || start.phase !== actual.phase : start.phase !== d.phase)
    )
      throw new HttpError(409, '动作阶段无法接续；需修改动作或明确时间省略');
    const source = sources.find((s) => s.id === d.sourceId);
    if (
      source?.doc.kind === 'segment_selection' &&
      d.decision === 'inherit' &&
      (
        boundaryChanges(source.doc.data.boundary, store.get(source.doc.id).data.boundary)[
          source.side
        ].actions || []
      ).includes(d.instanceId + ':' + d.actionId)
    )
      throw new HttpError(409, '采用动作阶段已改变');
    actions.push(start);
  }
  return {
    version: 2,
    snapshot: {
      mode: incoming.mode,
      cut: incoming.cut,
      reason: incoming.reason,
      sources: sources.map((s) => ({ id: s.id, ref: s.ref, boundary: s.side })),
      facts,
      relations,
      actions,
    },
    required: [...required.values()],
    dependencies,
    repair: segment.repair || null,
  };
}
