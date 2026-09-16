import { z } from 'zod';
import { mouthReviewIssues } from './mouth-review.js';

export const scalarSchema = z.union([z.boolean(), z.number().finite(), z.string().min(1)]);
export const attributeDefinitionSchema = z
  .object({
    key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/, '属性键使用英文标识符'),
    label: z.string().min(1),
    type: z.enum(['boolean', 'enum', 'number']),
    values: z.array(z.string().min(1)).optional(),
    continuity: z.enum(['shot', 'scene', 'series']).optional(),
  })
  .refine(
    (v) => v.type !== 'enum' || (!!v.values?.length && new Set(v.values).size === v.values.length),
    '枚举需要不同的取值',
  );
const factFields = {
  instanceId: z.string().min(1),
  key: z.string().min(1),
  status: z.enum(['known', 'unknown']),
  value: scalarSchema.nullable(),
};
const validKnowledge = (v: { status: string; value: unknown }) =>
  (v.status === 'unknown') === (v.value === null);
export const stateFactSchema = z
  .object(factFields)
  .refine(validKnowledge, '未知状态必须为 null，已知状态必须有值');
export const stateConditionSchema = z.object({
  instanceId: z.string().min(1),
  key: z.string().min(1),
  operator: z.enum(['eq', 'ne', 'gte', 'lte']),
  value: scalarSchema,
});
const intervalFields = {
  startFrame: z.number().int().nonnegative(),
  endFrame: z.number().int().positive(),
};
const validInterval = (v: { startFrame: number; endFrame: number }) => v.endFrame > v.startFrame;
export const causalEventSchema = z
  .object({
    id: z.string().min(1),
    description: z.string().min(1),
    ...intervalFields,
    required: z.boolean().default(true),
    inspection: z.enum(['frame', 'motion', 'audio']).default('motion'),
    mode: z.enum(['occurrence', 'forbidden', 'sustain']).default('occurrence'),
    afterIds: z.array(z.string()).default([]),
    preconditions: z.array(stateConditionSchema).default([]),
    changes: z.array(stateFactSchema).default([]),
    condition: stateConditionSchema.optional(),
    strictWindow: z.boolean().default(false),
  })
  .refine(validInterval, '事件帧区间错误')
  .refine((v) => v.mode !== 'sustain' || !!v.condition, '持续事件需要状态条件')
  .refine(
    (v) => v.mode === 'occurrence' || (v.inspection !== 'frame' && !v.changes.length),
    '持续或禁止事件需要区间审核，不能改变状态',
  );
export const observationSchema = z
  .object({
    id: z.string().min(1),
    ...factFields,
    ...intervalFields,
    inspection: z.enum(['frame', 'motion', 'audio']),
    notes: z.string().default(''),
  })
  .refine(validKnowledge, '观察的未知值必须为 null')
  .refine(validInterval, '观察帧区间错误');
const fixedRef = z.object({ id: z.string().min(1), revision: z.number().int().positive() });
export const legacyIncomingSchema = z
  .object({
    version: z.literal(1).optional(),
    mode: z.enum(['independent', 'continue', 'historical']),
    selection: fixedRef.optional(),
    awaiting: z.object({ episodeId: z.string().min(1), segmentId: z.string().min(1) }).optional(),
    boundary: z.enum(['start', 'end']).default('end'),
    decisions: z
      .array(
        z
          .object({
            instanceId: z.string().min(1),
            key: z.string().min(1),
            decision: z.enum(['inherit', 'adjust', 'reset']),
            value: scalarSchema.optional(),
            reason: z.string().default(''),
          })
          .refine(
            (v) => v.decision === 'inherit' || (v.value !== undefined && !!v.reason.trim()),
            '调整或重设需要值与理由',
          ),
      )
      .default([]),
    relationDecisions: z
      .array(
        z
          .object({
            objectId: z.string().min(1),
            decision: z.enum(['inherit', 'adjust', 'reset']),
            reason: z.string().default(''),
          })
          .refine((v) => v.decision === 'inherit' || !!v.reason.trim(), '关系调整需要理由'),
      )
      .default([]),
  })
  .refine(
    (v) =>
      v.mode === 'independent'
        ? !v.selection && !v.awaiting && !v.decisions.length && !v.relationDecisions.length
        : !!v.selection || (v.mode === 'continue' && !!v.awaiting),
    '独立片段不继承；接续和历史片段需要固定采用来源',
  );
const continuationDecision = z.object({
  sourceId: z.string().optional(),
  decision: z.enum(['inherit', 'adjust', 'reset', 'not_applicable']),
  reason: z.string().default(''),
});
export const incomingV2Schema = z
  .object({
    version: z.literal(2),
    mode: z.enum(['independent', 'continue', 'historical']),
    cut: z.enum(['action', 'angle', 'ellipsis', 'location_change', 'flashback', 'independent']),
    reason: z.string().default(''),
    sources: z
      .array(
        z
          .object({
            id: z.string().min(1),
            selection: fixedRef.optional(),
            canon: fixedRef.optional(),
            boundary: z.enum(['start', 'end']).default('end'),
          })
          .refine(
            (v) => Number(!!v.selection) + Number(!!v.canon) === 1,
            '每个接续来源明确选择采用或 Canon',
          ),
      )
      .default([]),
    awaiting: z
      .array(z.object({ episodeId: z.string(), segmentId: z.string().optional() }))
      .default([]),
    decisions: z
      .array(
        continuationDecision.extend({
          instanceId: z.string(),
          key: z.string(),
          value: scalarSchema.optional(),
        }),
      )
      .default([]),
    relationDecisions: z.array(continuationDecision.extend({ objectId: z.string() })).default([]),
    actionDecisions: z
      .array(
        continuationDecision.extend({
          instanceId: z.string(),
          actionId: z.string(),
          phase: z.string().optional(),
        }),
      )
      .default([]),
  })
  .superRefine((v, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(v.sources.map((s) => s.id)).size !== v.sources.length) issue('接续来源 ID 重复');
    for (const d of [...v.decisions, ...v.relationDecisions, ...v.actionDecisions]) {
      if (d.decision === 'inherit' && !v.sources.some((s) => s.id === d.sourceId))
        issue('继承必须选择固定来源');
      if (d.decision !== 'inherit' && !d.reason.trim()) issue('调整或不适用需要明确理由');
    }
    if (
      v.mode === 'independent' &&
      (v.sources.length || v.awaiting.length || v.cut !== 'independent')
    )
      issue('独立片段不得暗中继承来源');
    if (v.mode === 'historical' && (v.cut !== 'flashback' || !v.sources.length))
      issue('历史片段需要固定历史来源');
    if (['ellipsis', 'location_change', 'flashback'].includes(v.cut) && !v.reason.trim())
      issue('转场需要说明剧情关系');
  });
export const incomingSchema = z.union([incomingV2Schema, legacyIncomingSchema]);
const rangeSchema = z.object(intervalFields).refine(validInterval, '区间必须非空');
export const repairSchema = z
  .object({
    sourceSelection: fixedRef,
    issueSpace: z.enum(['source_frames', 'selected_timeline']).default('source_frames'),
    issueRange: rangeSchema,
    generationRange: rangeSchema,
    adoptRange: rangeSchema,
    goal: z.string().min(1),
    preserve: z.array(z.string()).default([]),
    desiredEnd: z.array(stateFactSchema).default([]),
    checkBefore: z.boolean().default(true),
    checkAfter: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.adoptRange.startFrame >= v.generationRange.startFrame &&
      v.adoptRange.endFrame <= v.generationRange.endFrame,
    '采用区间必须在候选生成区间内',
  );
export type StateFact = z.infer<typeof stateFactSchema>;
export type StateCondition = z.infer<typeof stateConditionSchema>;
export type CausalEvent = z.infer<typeof causalEventSchema>;
export type Observation = z.infer<typeof observationSchema>;

export function evaluateCondition(
  condition: StateCondition,
  facts: StateFact[],
): 'pass' | 'fail' | 'unknown' {
  const candidates = facts.filter(
    (f) => f.instanceId === condition.instanceId && f.key === condition.key,
  );
  if (
    !candidates.length ||
    candidates.some((c) => c.status !== 'known' || c.value !== candidates[0].value)
  )
    return 'unknown';
  const value = candidates[0].value;
  if (typeof value !== typeof condition.value) return 'fail';
  if (condition.operator === 'eq') return value === condition.value ? 'pass' : 'fail';
  if (condition.operator === 'ne') return value !== condition.value ? 'pass' : 'fail';
  if (typeof value !== 'number' || typeof condition.value !== 'number') return 'fail';
  return (condition.operator === 'gte' ? value >= condition.value : value <= condition.value)
    ? 'pass'
    : 'fail';
}

// Validate only explicit, bounded state semantics. Free prose is still authored/reviewed by people.
export function validateShotSemantics(shot: any, records: any[]): string[] {
  if (!(shot.directing?.version >= 2)) return [];
  const errors: string[] = [],
    instances: any[] = shot.state?.instances || [];
  const ids = new Set(instances.map((i) => i.instanceId));
  const definitions = new Map<string, any>();
  for (const i of instances) {
    const entity = records.find((r) => r.id === i.entity.id && r.revision === i.entity.revision);
    const attrs = entity?.data.attributes || [];
    if (new Set(attrs.map((a: any) => a.key)).size !== attrs.length)
      errors.push(`${i.instanceId} 属性定义重复`);
    for (const a of attrs) definitions.set(`${i.instanceId}:${a.key}`, a);
  }
  const checkFact = (v: any) => {
    const d = definitions.get(`${v.instanceId}:${v.key}`);
    if (!ids.has(v.instanceId) || !d) {
      errors.push(`未声明的实例属性 ${v.instanceId}.${v.key}`);
      return;
    }
    if (v.status === 'unknown') return;
    if (d.type === 'enum' ? !d.values?.includes(v.value) : typeof v.value !== d.type)
      errors.push(`属性类型或取值错误 ${v.instanceId}.${v.key}`);
    if (['gte', 'lte'].includes(v.operator) && d.type !== 'number')
      errors.push('数值比较只接受数值属性');
  };
  for (const side of ['start', 'end']) {
    const facts = shot.state?.attributes?.[side] || [];
    if (new Set(facts.map((f: any) => `${f.instanceId}:${f.key}`)).size !== facts.length)
      errors.push(`${side} 属性重复`);
    facts.forEach(checkFact);
  }
  const presence = shot.directing.presence;
  const sound = soundRequirements(shot.directing);
  if (new Set(sound.map((r) => r.id)).size !== sound.length) errors.push('声音审核项 ID 重复');
  if (
    shot.directing.sound.dialogue.length &&
    shot.directing.sound.checks?.some((c: any) => c.kind === 'no_speech')
  )
    errors.push('有对白的镜头不能同时要求全段禁止人声');
  for (const kind of ['visible', 'audible']) {
    if (new Set(presence[kind]).size !== presence[kind].length) errors.push(`${kind} 实例重复`);
    if (presence[kind].some((id: string) => !ids.has(id))) errors.push(`${kind} 含未声明实例`);
  }
  for (const line of shot.directing.sound.dialogue) {
    if (
      !(
        line.delivery === 'offscreen' || line.delivery === 'voiceover'
          ? presence.audible
          : presence.visible
      ).includes(line.instanceId)
    )
      errors.push(`对白出场职责不匹配 ${line.instanceId}`);
  }
  if (shot.directing.performance.some((p: any) => !presence.visible.includes(p.instanceId)))
    errors.push('可见表演只能分配给当前画面出场实例');
  const events: CausalEvent[] = shot.directing.events;
  if (new Set(events.map((e) => e.id)).size !== events.length) errors.push('事件 ID 重复');
  const frames = Math.round(shot.duration * 24);
  for (const e of events) {
    if (e.endFrame > frames) errors.push(`${e.id} 事件范围超出镜头`);
    [...e.preconditions, ...e.changes, ...(e.condition ? [e.condition] : [])].forEach(checkFact);
    if (
      new Set(e.afterIds).size !== e.afterIds.length ||
      e.afterIds.some((id) => !events.some((p) => p.id === id) || id === e.id)
    )
      errors.push(`${e.id} 事件依赖不存在或重复`);
    if (e.afterIds.some((id) => events.find((p) => p.id === id)?.mode !== 'occurrence'))
      errors.push(`${e.id} 的前序必须是发生事件`);
    if (new Set(e.changes.map((c) => `${c.instanceId}:${c.key}`)).size !== e.changes.length)
      errors.push(`${e.id} 状态结果重复`);
  }
  const done = new Set<string>(),
    pending = [...events];
  let facts: StateFact[] = [...(shot.state?.attributes?.start || [])];
  while (pending.length) {
    const index = pending.findIndex((e) => e.afterIds.every((id) => done.has(id)));
    if (index < 0) {
      errors.push('事件依赖存在循环或悬空');
      break;
    }
    const e = pending.splice(index, 1)[0];
    // Only causal ancestors may establish a precondition; unrelated list order is not causality.
    const ancestors = new Set<string>();
    const visit = (id: string) => {
      if (ancestors.has(id)) return;
      ancestors.add(id);
      events.find((p) => p.id === id)?.afterIds.forEach(visit);
    };
    e.afterIds.forEach(visit);
    let before: StateFact[] = [...(shot.state?.attributes?.start || [])];
    for (const prior of events
      .filter((p) => ancestors.has(p.id))
      .sort((a, b) => [...done].indexOf(a.id) - [...done].indexOf(b.id))) {
      before = [
        ...before.filter(
          (f) => !prior.changes.some((c) => c.instanceId === f.instanceId && c.key === f.key),
        ),
        ...prior.changes,
      ];
    }
    if (e.required)
      for (const c of e.preconditions)
        if (evaluateCondition(c, before) !== 'pass')
          errors.push(`${e.id} 前提未成立：${c.instanceId}.${c.key}`);
    facts = [
      ...facts.filter(
        (f) => !e.changes.some((c) => c.instanceId === f.instanceId && c.key === f.key),
      ),
      ...e.changes,
    ];
    done.add(e.id);
  }
  for (const f of shot.state?.attributes?.end || []) {
    if (
      f.status === 'known' &&
      events.some((e) => e.changes.some((c) => c.instanceId === f.instanceId && c.key === f.key)) &&
      evaluateCondition({ ...f, operator: 'eq' }, facts) !== 'pass'
    )
      errors.push(`事件结果与结束状态矛盾：${f.instanceId}.${f.key}`);
    const start = shot.state?.attributes?.start?.find(
      (v: any) => v.instanceId === f.instanceId && v.key === f.key,
    );
    if (
      f.status === 'known' &&
      start?.status === 'known' &&
      f.value !== start.value &&
      !events.some((e) => e.changes.some((c) => c.instanceId === f.instanceId && c.key === f.key))
    )
      errors.push(`状态改变没有对应事件：${f.instanceId}.${f.key}`);
  }
  const depends = (event: CausalEvent, id: string, seen = new Set<string>()): boolean =>
    event.afterIds.some((prior) => {
      if (prior === id) return true;
      if (seen.has(prior)) return false;
      seen.add(prior);
      const p = events.find((e) => e.id === prior);
      return !!p && depends(p, id, seen);
    });
  for (let a = 0; a < events.length; a++)
    for (let b = a + 1; b < events.length; b++)
      if (
        events[a].changes.some((f) =>
          events[b].changes.some(
            (g) => f.instanceId === g.instanceId && f.key === g.key && f.value !== g.value,
          ),
        ) &&
        !depends(events[a], events[b].id) &&
        !depends(events[b], events[a].id)
      )
        errors.push('同一属性的不同结果需要明确因果顺序');
  return errors;
}

export function auditShotSemantics(
  spec: any,
  review: any,
  coverage: { in: number; out: number },
  offset = 0,
): string[] {
  const errors: string[] = [],
    start = Math.round(coverage.in * 24),
    end = Math.round(coverage.out * 24);
  const events: CausalEvent[] = spec.directing?.events || [];
  const observations: Observation[] = review.observations || [];
  const evidence: any[] = (review.eventEvidence || []).filter((e: any) => e.shotId === spec.shotId);
  const factsAt = (frame: number) =>
    observations.filter((o) => o.startFrame <= frame && o.endFrame > frame);
  const check = (c: StateCondition, frame: number, label: string) => {
    if (evaluateCondition(c, factsAt(frame)) !== 'pass')
      errors.push(`${label} 未确认：${c.instanceId}.${c.key}`);
  };
  for (const e of events) {
    const ev = evidence.find((v) => v.eventId === e.id);
    if (!e.required && !ev) continue;
    if (
      !ev ||
      ev.status !== 'pass' ||
      ev.inspection !== e.inspection ||
      ev.startFrame < start ||
      ev.endFrame > end ||
      ev.endFrame <= ev.startFrame ||
      (e.inspection !== 'frame' && ev.endFrame - ev.startFrame < 2)
    ) {
      errors.push(`${e.id} 缺少采用区间内对应审核`);
      continue;
    }
    const expectedStart = offset + e.startFrame,
      expectedEnd = offset + e.endFrame;
    for (const c of e.preconditions) check(c, ev.startFrame, `${e.id} 前提`);
    if (e.mode === 'occurrence') {
      if (ev.observed !== 'occurred') errors.push(`${e.id} 没有确认事件发生`);
      if (e.strictWindow && (ev.startFrame < expectedStart || ev.endFrame > expectedEnd))
        errors.push(`${e.id} 不在要求的事件时间窗`);
      for (const f of e.changes)
        if (f.status === 'known')
          check({ ...f, operator: 'eq', value: f.value! }, ev.endFrame - 1, `${e.id} 结果`);
    } else {
      const left = Math.max(start, expectedStart),
        right = Math.min(
          end,
          e.endFrame === spec.frames ? Math.max(expectedEnd, end) : expectedEnd,
        );
      if (
        left >= right ||
        ev.startFrame > left ||
        ev.endFrame < right ||
        ev.observed !== (e.mode === 'forbidden' ? 'absent' : 'occurred')
      )
        errors.push(`${e.id} 缺少完整区间审核`);
      if (e.mode === 'sustain' && e.condition) {
        const relevant = observations.filter(
          (o) =>
            o.instanceId === e.condition!.instanceId &&
            o.key === e.condition!.key &&
            o.endFrame > left &&
            o.startFrame < right,
        );
        const points = [
          ...new Set([
            left,
            right,
            ...relevant.flatMap((o) => [Math.max(left, o.startFrame), Math.min(right, o.endFrame)]),
          ]),
        ].sort((a, b) => a - b);
        for (let i = 0; i < points.length - 1; i++) {
          const cover = relevant.filter(
            (o) =>
              o.inspection === e.inspection &&
              o.startFrame <= points[i] &&
              o.endFrame >= points[i + 1],
          );
          if (evaluateCondition(e.condition, cover) !== 'pass') {
            errors.push(`${e.id} 持续状态未获得完整观察`);
            break;
          }
        }
      }
    }
    for (const id of e.afterIds) {
      const prior = evidence.find((v) => v.eventId === id);
      if (
        !prior ||
        prior.status !== 'pass' ||
        prior.observed !== 'occurred' ||
        prior.endFrame > ev.startFrame
      )
        errors.push(`${e.id} 事件顺序不成立：${id}`);
    }
  }
  for (const [side, frame] of [
    ['start', start],
    ['end', end - 1],
  ] as const) {
    for (const f of spec.state?.attributes?.[side] || [])
      if (f.status === 'known') check({ ...f, operator: 'eq' }, frame, `${side} 边界`);
  }
  const cues = (review.cueEvidence || []).filter((c: any) => c.shotId === spec.shotId);
  for (const cue of spec.directing.cues || []) {
    const ev = cues.find((c: any) => c.cueId === cue.id);
    if (
      !ev ||
      ev.status !== 'pass' ||
      !ev.notes.trim() ||
      ev.startFrame < start ||
      ev.endFrame > end ||
      ev.endFrame - ev.startFrame < 2
    ) {
      errors.push(`时序 ${cue.id} 缺少采用区间内的实际审看或听审`);
      continue;
    }
    if (
      cue.window &&
      (ev.startFrame < offset + cue.window.startFrame || ev.endFrame > offset + cue.window.endFrame)
    )
      errors.push(`时序 ${cue.id} 的实际发生区间不符合声明窗口`);
    for (const beforeId of cue.afterIds) {
      const before = cues.find((c: any) => c.cueId === beforeId);
      if (!before || before.status !== 'pass' || before.endFrame > ev.startFrame)
        errors.push(`时序 ${cue.id} 的实际先后关系不成立`);
    }
  }
  const audio = (review.audioEvidence || []).filter((a: any) => a.shotId === spec.shotId);
  for (const req of soundRequirements(spec.directing)) {
    const ev = audio.find((a: any) => a.requirementId === req.id);
    if (
      !ev ||
      ev.status !== 'pass' ||
      ev.inspection !== 'audio' ||
      ev.startFrame < start ||
      ev.endFrame > end ||
      ev.endFrame - ev.startFrame < 2
    ) {
      errors.push(`声音 ${req.id} 缺少采用区间内实际听审`);
      continue;
    }
    if (req.kind === 'dialogue' && (ev.speakerId !== req.speakerId || ev.text !== req.text))
      errors.push(`声音 ${req.id} 说话者或对白原文不符`);
    if (req.mouthReviewRequired) {
      errors.push(
        ...mouthReviewIssues(ev, ev.startFrame, ev.endFrame).map((e) => `画内对白 ${req.id}：${e}`),
      );
    } else if (req.lipSyncRequired && ev.lipSyncReviewed !== true)
      errors.push(`画内对白 ${req.id} 需要实际核对说话人口型`);
    if (
      ['environment', 'continuation', 'music'].includes(req.kind) &&
      (ev.startFrame !== start || ev.endFrame !== end)
    )
      errors.push(`声音 ${req.id} 需要整个相关区间听审`);
    if (
      req.kind === 'no_speech' &&
      (ev.voicePresent !== false || ev.startFrame !== start || ev.endFrame !== end)
    )
      errors.push('禁止人声需要整个采用区间听审');
  }
  for (const interaction of spec.directing?.interactions || []) {
    if (!interaction.required) continue;
    const ev = (review.interactionEvidence || []).find(
      (e: any) => e.shotId === spec.shotId && e.interactionId === interaction.id,
    );
    if (
      !ev ||
      ev.status !== 'pass' ||
      ev.inspection !== 'motion' ||
      ev.startFrame < start ||
      ev.endFrame > end ||
      ev.endFrame - ev.startFrame < 2 ||
      !ev.notes?.trim()
    )
      errors.push(`交互 ${interaction.id} 缺少采用区间内的实际动作审核`);
  }
  return errors;
}

export function soundRequirements(d: any): any[] {
  if (!(d?.version >= 2)) return [];
  return [
    ...d.sound.dialogue.map((l: any, i: number) => ({
      id: `dialogue:${d.contractRevision === 2 ? l.id : i}`,
      kind: 'dialogue',
      speakerId: l.instanceId,
      text: l.text,
      description: l.text,
      delivery: l.delivery || 'onscreen',
      lipSyncRequired: d.cues !== undefined && l.delivery === 'onscreen',
      mouthReviewRequired: d.contractRevision === 2 && l.delivery === 'onscreen',
      plannedMouth: l.mouth || null,
    })),
    ...['actions', 'environment', 'continuation', 'music']
      .filter((key) => d.sound[key]?.trim() && d.sound[key].trim() !== 'N/A')
      .map((key) => ({
        id: `field:${key}`,
        kind: key === 'actions' ? 'action' : key,
        description: d.sound[key],
      })),
    ...(d.sound.checks || []),
  ];
}
