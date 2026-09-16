import type { AuthoringShot } from './creation.js';

export function validateShotCues(shot: AuthoringShot) {
  const issues: { code: string; message: string }[] = [];
  const cues = shot.cues || [];
  const ids = new Set(cues.map((c) => c.id));
  if (ids.size !== cues.length) issues.push({ code: 'cue_identity', message: '时序标识重复' });
  const targets = new Set<string>();
  for (const cue of cues) {
    const t = cue.target;
    const target =
      t.kind === 'event' ? t.eventId : t.kind === 'dialogue' ? t.lineId : t.performanceId;
    const identity = `${t.kind}:${target}`;
    if (targets.has(identity))
      issues.push({ code: 'cue_target_repeated', message: '同一对象只能分配一个时序提示' });
    targets.add(identity);
    if (
      !(t.kind === 'event'
        ? shot.events.some((e) => e.eventId === target)
        : t.kind === 'dialogue'
          ? shot.dialogue.some((l) => l.lineId === target)
          : shot.performances.some((p) => p.id === target))
    )
      issues.push({ code: 'cue_target', message: `时序 ${cue.id} 引用的本镜对象不存在` });
    if (
      cue.window &&
      (cue.window.endFrame <= cue.window.startFrame || cue.window.endFrame > shot.frames)
    )
      issues.push({ code: 'cue_window', message: `时序 ${cue.id} 窗口超出镜头或顺序颠倒` });
    if (
      new Set(cue.afterIds).size !== cue.afterIds.length ||
      cue.afterIds.some((id) => id === cue.id || !ids.has(id))
    )
      issues.push({ code: 'cue_after', message: `时序 ${cue.id} 的先后引用无效` });
    for (const beforeId of cue.afterIds) {
      const before = cues.find((c) => c.id === beforeId);
      if (before?.window && cue.window && before.window.endFrame > cue.window.startFrame)
        issues.push({ code: 'cue_overlap', message: `时序 ${cue.id} 与其前置动作窗口冲突` });
    }
  }
  const done = new Set<string>();
  while (done.size < cues.length) {
    const next = cues.find((c) => !done.has(c.id) && c.afterIds.every((id) => done.has(id)));
    if (!next) {
      issues.push({ code: 'cue_cycle', message: '时序关系存在循环或无法解析的引用' });
      break;
    }
    done.add(next.id);
  }
  return issues;
}
