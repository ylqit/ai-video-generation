import { selectionMedia } from './selection-splice.js';
import { canonV3Schema } from '../shared/domain.js';
import { Store, HttpError } from './db.js';
import { fixedSeriesRecord, predecessorCanon, resolveSeries } from './series-production.js';
import { generationDigest } from './h3-guided.js';

// Validates a proposed factual change set against actual adopted evidence. Publication is
// owned by the release transaction, never by planning, a model response, or a preview.
export function prepareCanonV3(store: Store, ep: any, raw: unknown) {
  const data = canonV3Schema.parse(raw),
    { series, production } = resolveSeries(store, ep),
    prior = predecessorCanon(store, ep).canon;
  if (
    data.episode.id !== ep.id ||
    data.episode.revision !== ep.revision ||
    !ep.data.approved ||
    ep.data.stale
  )
    throw new HttpError(409, '剧情确认需要当前已审核分集');
  if (
    generationDigest(data.previous) !==
    generationDigest(prior ? { id: prior.id, revision: prior.revision } : null)
  )
    throw new HttpError(409, '剧情确认链的直接前置版本不符');
  if (data.states.length) throw new HttpError(400, 'V3 事实使用类型化属性与明确来源，旧状态先转换');
  const instances = new Map<string, any>();
  for (const i of data.instances) {
    const e = fixedSeriesRecord(store, ep.projectId, i.entity, 'entity');
    if (!e.data.instances.some((v: any) => v.id === i.instanceId) || instances.has(i.instanceId))
      throw new HttpError(400, '剧情实例重复或主体不符');
    instances.set(i.instanceId, e);
  }
  if (new Set(data.facts.map((f) => f.id)).size !== data.facts.length)
    throw new HttpError(400, '剧情事实 ID 重复');
  const priorFacts: any[] = prior?.data.facts || [],
    effective = new Map(priorFacts.filter((f) => f.operation !== 'retract').map((f) => [f.id, f]));
  const dependencies: any[] = [
    { id: series.id, revision: series.revision },
    data.episode,
    ...(prior ? [{ id: prior.id, revision: prior.revision }] : []),
  ];
  for (const f of data.facts) {
    if (
      f.effective.slotId !== ep.data.seriesProduction.slotId ||
      f.instanceIds.some((id) => !instances.has(id))
    )
      throw new HttpError(400, '事实时点或实例不属于当前确认范围');
    const old = effective.get(f.replaces || f.id);
    if (f.operation === 'add' ? effective.has(f.id) : !old)
      throw new HttpError(400, '事实新增／变更操作与前置状态不符');
    if (f.replaces && f.replaces !== f.id && effective.has(f.id))
      throw new HttpError(400, '替代事实 ID 与另一条有效事实冲突');
    if (
      f.operation === 'retain' &&
      (f.text !== old.text ||
        generationDigest(f.attribute || null) !== generationDigest(old.attribute || null))
    )
      throw new HttpError(400, '保留事实不能暗中改变内容');
    if (
      f.informationId &&
      !production.information.some((i) => i.id === f.informationId && i.kind === f.kind)
    )
      throw new HttpError(400, '信息状态与系列条目类型不符');
    if (
      f.informationStage &&
      (!f.informationId ||
        !production.information
          .find((i) => i.id === f.informationId)
          ?.milestones.some(
            (m) => m.slotId === f.effective.slotId && m.purpose === f.informationStage,
          ) ||
        f.source.kind !== 'media')
    )
      throw new HttpError(409, '实际铺垫／回收需要对应系列节点及媒体证据');
    const source = f.source;
    if (source.kind === 'media') {
      const selection = fixedSeriesRecord(
        store,
        ep.projectId,
        source.selection,
        'segment_selection',
      );
      if (selection.parentId !== ep.id) throw new HttpError(400, '本集事实变化需要本集已采用证据');
      const segment = ep.data.segments.find((s: any) => s.id === selection.data.segmentId);
      if (segment?.incoming?.mode === 'historical' && f.kind === 'world_fact')
        throw new HttpError(409, '历史镜头不能改写当前世界状态');
      const entries = selectionMedia(selection.data).flatMap((part) => {
        const review = fixedSeriesRecord(store, ep.projectId, part.review, 'generation_review');
        dependencies.push(part.review, part.video);
        return [
          ...(review.data.observations || []),
          ...(review.data.eventEvidence || []),
          ...(review.data.audioEvidence || []),
        ].map((o) => ({
          ...o,
          adoptedStart: Math.round(part.in * 24),
          adoptedEnd: Math.round(part.out * 24),
        }));
      });
      for (const id of source.evidenceIds) {
        const matches = entries.filter(
          (e) =>
            (e.id || e.eventId || e.requirementId) === id &&
            e.startFrame >= e.adoptedStart &&
            e.endFrame <= e.adoptedEnd,
        );
        if (matches.length !== 1)
          throw new HttpError(409, '事实证据缺失、被裁掉或 ID 在组合片段中不唯一');
        const o = matches[0];
        const start = o?.startFrame ?? o?.frameIndex,
          end = o?.endFrame ?? start + 1;
        if (
          !o ||
          start < o.adoptedStart ||
          end > o.adoptedEnd ||
          ['unknown', 'unreviewed', 'issues'].includes(o.status) ||
          (o.observed && o.observed !== 'occurred')
        )
          throw new HttpError(409, '事实证据未确认或已被裁掉');
        if (
          f.attribute &&
          (o.instanceId !== f.attribute.instanceId ||
            o.key !== f.attribute.key ||
            o.status !== 'known' ||
            o.value !== f.attribute.value)
        )
          throw new HttpError(409, '属性事实与实际观察不一致');
        if (f.kind === 'world_fact' && (o.actualText !== undefined || o.requirementId))
          throw new HttpError(409, '听见对白不能直接确认为对白描述的世界事实');
      }
      dependencies.push(source.selection, selection.data.review, selection.data.video);
    } else if (source.kind === 'offscreen') {
      const basis = fixedSeriesRecord(store, ep.projectId, source.series, 'series');
      if (basis.id !== series.id) throw new HttpError(400, '画外事实必须属于当前系列');
      const event = basis.data.production?.authoredEvents.find((e: any) => e.id === source.eventId);
      if (
        !event?.approved ||
        !event.offscreen ||
        event.slotId !== ep.data.seriesProduction.slotId ||
        event.statement !== f.text
      )
        throw new HttpError(409, '画外事实没有对应已审核画外剧情条目');
      dependencies.push(source.series);
    } else {
      const basis = fixedSeriesRecord(store, ep.projectId, source.reference);
      if (prior || ![series.id, ...production.sharedReferences.map((r) => r.id)].includes(basis.id))
        throw new HttpError(409, '起始设定仅用于首集明确的共享／系列依据');
      dependencies.push(source.reference);
    }
    if (f.attribute) {
      const d = instances
        .get(f.attribute.instanceId)
        ?.data.attributes?.find((a: any) => a.key === f.attribute!.key);
      if (
        !d ||
        f.attribute.status !== 'known' ||
        (d.type === 'enum'
          ? !d.values.includes(f.attribute.value)
          : typeof f.attribute.value !== d.type)
      )
        throw new HttpError(400, 'Canon 属性类型或知识状态无效');
    }
    if (f.operation === 'retract') effective.delete(f.replaces || f.id);
    else {
      if (f.replaces) effective.delete(f.replaces);
      effective.set(f.id, f);
    }
  }
  const attributes = [...effective.values()].flatMap((f) => (f.attribute ? [f.attribute] : []));
  if ([...effective.values()].some((f) => f.instanceIds.some((id: string) => !instances.has(id))))
    throw new HttpError(409, '不能丢失继续生效事实的实例声明');
  const attrKeys = attributes.map((a) => `${a.instanceId}:${a.key}`);
  if (new Set(attrKeys).size !== attrKeys.length)
    throw new HttpError(409, '有效 Canon 存在重复属性事实；请明确替代旧事实');
  if (generationDigest(data.attributes) !== generationDigest(attributes))
    throw new HttpError(409, 'Canon 属性摘要必须由有效事实推导，不能额外补写');
  for (const old of prior?.data.relations || [])
    if (!data.relations.some((r) => r.objectId === old.objectId)) {
      const source = data.relationSources.find((s) => s.objectId === old.objectId);
      if (!source) throw new HttpError(409, '不能默默丢弃前集关系，请提供关系解除观察');
      const selection = fixedSeriesRecord(
        store,
        ep.projectId,
        source.selection,
        'segment_selection',
      );
      if (
        selection.parentId !== ep.id ||
        !selection.data.boundary?.end?.relationObjectIds.includes(old.objectId) ||
        selection.data.boundary.end.relations.some((r: any) => r.objectId === old.objectId)
      )
        throw new HttpError(409, '关系解除需要明确检查对象及不存在该关系的观察');
      dependencies.push(source.selection);
    }
  for (const r of data.relations) {
    const source = data.relationSources.find((s) => s.objectId === r.objectId);
    if (
      !source &&
      prior?.data.relations?.some((v: any) => generationDigest(v) === generationDigest(r))
    )
      continue;
    if (!source || !r.confirmed) throw new HttpError(409, '剧情关系需要已采用边界来源');
    const selection = fixedSeriesRecord(store, ep.projectId, source.selection, 'segment_selection');
    if (
      selection.parentId !== ep.id ||
      !(selection.data.boundary?.end?.relations || []).some(
        (v: any) => generationDigest(v) === generationDigest(r),
      )
    )
      throw new HttpError(409, '剧情关系与实际采用结束状态不符');
    dependencies.push(source.selection);
  }
  for (const old of prior?.data.unfinishedActions || [])
    if (
      !data.unfinishedActions.some((a) => a.id === old.id && a.instanceId === old.instanceId) &&
      !data.facts.some((f) => f.source.kind === 'media' && f.source.evidenceIds.includes(old.id))
    )
      throw new HttpError(409, '前集未完成动作需要继续保留或以事件证据解除');
  const actionSources: any[] = [];
  for (const action of data.unfinishedActions) {
    if (
      prior?.data.unfinishedActions.some(
        (a: any) => generationDigest(a) === generationDigest(action),
      )
    ) {
      const source = prior.data.actionSources?.find(
        (s: any) => s.instanceId === action.instanceId && s.actionId === action.id,
      );
      if (!source) throw new HttpError(409, '前集动作缺少固定采用来源，需重新核对');
      actionSources.push(source);
      continue;
    }
    const source = store
      .list('segment_selection', ep.projectId)
      .find(
        (s) =>
          s.parentId === ep.id &&
          !s.data.stale &&
          s.data.boundary?.end?.actions?.some(
            (a: any) => generationDigest(a) === generationDigest(action),
          ),
      );
    if (!source) throw new HttpError(409, '待续动作需要实际边界观察');
    dependencies.push({ id: source.id, revision: source.revision });
    actionSources.push({
      instanceId: action.instanceId,
      actionId: action.id,
      selection: { id: source.id, revision: source.revision },
    });
  }
  return {
    data: {
      ...data,
      facts: [...effective.values()],
      changes: data.facts,
      relationSources: [
        ...data.relationSources,
        ...(prior?.data.relationSources || []).filter(
          (s: any) => !data.relationSources.some((v) => v.objectId === s.objectId),
        ),
      ],
      actionSources,
      seriesId: series.id,
      episodeNumber: ep.data.number,
      confirmed: true,
      stale: false,
    },
    dependencies,
  };
}
