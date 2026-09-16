import { z } from 'zod';

export const shotProductionSchema = z.object({
  purpose: z.string().min(1),
  camera: z.string().min(1),
  startState: z.string().min(1),
  endState: z.string().min(1),
  sound: z.string(),
  magic: z.string(),
  instanceIds: z.array(z.string()),
  requiredViews: z.array(z.string()),
  acceptance: z.array(z.string()),
  delivery: z.enum(['generated', 'title']).default('generated'),
});
export const dramaturgySchema = z.object({
  version: z.literal(1),
  targetFrames: z.number().int().positive(),
  canvas: z
    .object({
      width: z.number().int().min(128).max(3840).multipleOf(2),
      height: z.number().int().min(128).max(3840).multipleOf(2),
    })
    .optional(),
  theme: z.string().min(1),
  scenes: z
    .array(
      z.object({
        id: z.string().min(1),
        title: z.string().min(1),
        targetFrames: z.number().int().positive(),
        goal: z.string().min(1),
        obstacle: z.string().min(1),
        action: z.string().min(1),
        outcome: z.string().min(1),
        shotIds: z.array(z.string()).min(1),
      }),
    )
    .min(1),
  rules: z.array(
    z.object({
      id: z.string().min(1),
      rule: z.string().min(1),
      setupShotIds: z.array(z.string()).min(1),
      payoffShotIds: z.array(z.string()).min(1),
    }),
  ),
  information: z
    .array(
      z.object({
        id: z.string().min(1),
        kind: z.enum([
          'world_fact',
          'character_knowledge',
          'character_belief',
          'audience_knowledge',
        ]),
        statement: z.string().min(1),
        instanceIds: z.array(z.string()).default([]),
        shotIds: z.array(z.string()).min(1),
        afterIds: z.array(z.string()).default([]),
        conflictsWith: z.array(z.string()).default([]),
      }),
    )
    .optional(),
  plannedCanon: z.array(
    z.object({
      id: z.string().min(1),
      fact: z.string().min(1),
      evidenceShotIds: z.array(z.string()).min(1),
    }),
  ),
});
export type Dramaturgy = z.infer<typeof dramaturgySchema>;

// Durations, references and chronology are deterministic checks, not a visual approval.
export function dramaturgyIssues(plan: {
  shots: {
    id: string;
    duration: number;
    directing?: {
      version: number;
      information?: { informationId: string; eventId: string; purpose: string }[];
      events: { id: string; afterIds?: string[] }[];
    };
  }[];
  dramaturgy?: Dramaturgy;
}) {
  const d = plan.dramaturgy;
  if (!d) return [];
  const issues: string[] = [],
    shots = new Map(plan.shots.map((s, i) => [s.id, { ...s, index: i }]));
  const assigned = new Set<string>();
  if (new Set(d.scenes.map((s) => s.id)).size !== d.scenes.length) issues.push('场景 ID 重复');
  for (const scene of d.scenes) {
    let frames = 0;
    for (const id of scene.shotIds) {
      const shot = shots.get(id);
      if (!shot) {
        issues.push(`场景 ${scene.id} 引用了不存在的镜头 ${id}`);
        continue;
      }
      if (assigned.has(id)) issues.push(`镜头 ${id} 重复分配到场景`);
      assigned.add(id);
      if (Math.abs(shot.duration * 24 - Math.round(shot.duration * 24)) > 1e-6)
        issues.push(`镜头 ${id} 时长不在 24 fps 帧网格`);
      frames += Math.round(shot.duration * 24);
    }
    if (frames !== scene.targetFrames)
      issues.push(`场景 ${scene.id} 时长不符：${frames}/${scene.targetFrames} 帧`);
  }
  if (assigned.size !== plan.shots.length) issues.push('存在未分配到场景的镜头');
  if (d.scenes.reduce((n, s) => n + s.targetFrames, 0) !== d.targetFrames)
    issues.push('场景总时长与成片目标不符');
  const order = d.scenes.flatMap((s) => s.shotIds);
  if (order.join('|') !== plan.shots.map((s) => s.id).join('|'))
    issues.push('场景镜头顺序与分镜顺序不符');
  for (const rule of d.rules) {
    const ids = [...rule.setupShotIds, ...rule.payoffShotIds];
    if (ids.some((id) => !shots.has(id))) {
      issues.push(`规则 ${rule.id} 的证据镜头不存在`);
      continue;
    }
    if (
      Math.min(...rule.setupShotIds.map((id) => shots.get(id)!.index)) >=
      Math.min(...rule.payoffShotIds.map((id) => shots.get(id)!.index))
    )
      issues.push(`规则 ${rule.id} 必须先展示再回收`);
  }
  const information = d.information || [];
  if (new Set(information.map((i) => i.id)).size !== information.length)
    issues.push('信息条目 ID 重复');
  for (const item of information) {
    if (item.shotIds.some((id) => !shots.has(id))) issues.push(`信息 ${item.id} 的镜头不存在`);
    for (const id of item.afterIds) {
      const prior = information.find((v) => v.id === id);
      const before = Math.min(
        ...(prior?.shotIds || []).map((s) => shots.get(s)?.index ?? Infinity),
      );
      const after = Math.min(...item.shotIds.map((s) => shots.get(s)?.index ?? -1));
      const directing = plan.shots[after]?.directing;
      const first = directing?.information?.find(
        (i) => i.informationId === id && i.purpose === 'reveal',
      );
      const later = directing?.information?.find(
        (i) => i.informationId === item.id && i.purpose === 'reveal',
      );
      const orderedWithinShot =
        before === after &&
        (directing?.version || 0) >= 2 &&
        first &&
        later &&
        directing?.events.find((e) => e.id === later.eventId)?.afterIds?.includes(first.eventId);
      if (!prior || (before >= after && !orderedWithinShot))
        issues.push(`信息 ${item.id} 的先行揭示 ${id} 不成立`);
    }
    for (const id of item.conflictsWith)
      if (!information.some((v) => v.id === id))
        issues.push(`信息 ${item.id} 引用不存在的冲突 ${id}`);
  }
  for (const fact of d.plannedCanon)
    if (fact.evidenceShotIds.some((id) => !shots.has(id)))
      issues.push(`剧情状态 ${fact.id} 的证据镜头不存在`);
  return issues;
}

// The same envelope is used by browser preview and the frame timeline renderer.
export function clipGain(
  clip: { in: number; out: number; volume: number; fadeInFrames?: number; fadeOutFrames?: number },
  localSeconds: number,
) {
  const duration = clip.out - clip.in,
    fi = (clip.fadeInFrames || 0) / 24,
    fo = (clip.fadeOutFrames || 0) / 24;
  return (
    clip.volume *
    Math.max(0, Math.min(1, fi ? localSeconds / fi : 1, fo ? (duration - localSeconds) / fo : 1))
  );
}
