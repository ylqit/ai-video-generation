import { HttpError } from './db.js';

// Deterministic rendering of approved shots. Reference labels are allocated by the binding plan.
export function renderShotDescriptions(
  input: any,
  context: any,
  mapped: any,
  render: (text: string) => string,
) {
  const { ref, universal, seriesMode, brief, specs, staged, projection, activeBindings } = context;
  const visual =
    brief.overrides.visual ||
    brief.modules
      .filter((m: any) => m.data.category === 'visual')
      .map((m: any) =>
        Object.entries(m.data.spec)
          .filter(([k]) => k !== 'representation')
          .map(([k, v]) => `${k}: ${v}`)
          .join('; '),
      )
      .join('\n');
  const moduleDirection = brief.modules.find((m: any) => m.data.category === 'direction')?.data
    .spec;
  const art = Object.entries(universal ? {} : brief.artBible)
    .filter(([, value]) => value)
    .map(([key, value]) => `${key}: ${value}`)
    .join('; ');
  const lines = specs.map((s: any, index: number) => {
    const d = s.directing;
    if (!context.freeCreation && staged && !d.execution.visualTreatment?.trim())
      throw new HttpError(409, `${s.shotId} 缺少本镜可执行视觉处理`);
    if (
      !context.freeCreation &&
      (s.layout || d.paths.length || d.doors.length) &&
      !d.execution.visibleSpace?.trim()
    )
      throw new HttpError(400, `${s.shotId} 需要已审核的 visibleSpace；坐标不能代替可见空间描述`);
    const camera = [
      s.cameraIntent,
      d.camera.description,
      d.camera.shotSize,
      d.camera.composition,
      `Camera motion: ${d.camera.motion}; ${d.camera.amplitude}`,
    ].filter(Boolean);
    // Explicit shot design replaces direction defaults; numeric geometry stays in checks/previs.
    const performance = d.performance.map(
      (p: any) =>
        `${ref && (!universal || mapped.subjects.some((v: any) => v.id === p.instanceId)) ? render(`{{subject:${p.instanceId}}}`) : p.instanceId}: ${staged ? '' : `stimulus ${p.stimulus}; intention ${p.intention}; `}visible reaction ${p.reaction}; attention ${p.attention?.instanceId ? (ref && (!universal || mapped.subjects.some((v: any) => v.id === p.attention.instanceId)) ? render(`{{subject:${p.attention.instanceId}}}`) : p.attention.instanceId) : p.attention?.anchor || 'as described in the action'}${staged && p.attention?.anchor ? `; ${p.attention.anchor}` : ''}.`,
    );
    const contract: string[] = [];
    if (universal) {
      const name = (id: string) =>
        ref && mapped.subjects.some((v: any) => v.id === id) ? render(`{{subject:${id}}}`) : id;
      const condition = (v: any) =>
        `${name(v.instanceId)}.${v.key} ${v.operator || '='} ${JSON.stringify(v.value)}`;
      contract.push(
        `Visible instances only: ${d.presence.visible.map(name).join(', ') || 'none'}. Audible instances: ${d.presence.audible.map(name).join(', ') || 'none'}.`,
      );
      if (!ref)
        for (const b of activeBindings.filter(
          (b: any) =>
            s.shotId ===
            input.segment.shotIds[b.role === 'first_frame' ? 0 : input.segment.shotIds.length - 1],
        ))
          contract.push(
            `The ${b.role} image defines ${b.usage.purpose}. Preserve: ${b.usage.preserve.join('; ') || 'the reviewed boundary state'}; allowed changes: ${b.usage.allow.join('; ') || 'only the authored action'}.`,
          );
      const localArt = staged ? '' : projection[index].entries.map((e: any) => e.text).join('; ');
      if (localArt) contract.push(`Applicable stable design: ${localArt}.`);
      for (const instance of (s.state?.instances || []).filter(
        (i: any) => d.presence.visible.includes(i.instanceId) && i.appearance,
      )) {
        const appearance = input.planning.records.find(
          (r: any) =>
            r.id === instance.appearance.id && r.revision === instance.appearance.revision,
        );
        if (!appearance) throw new HttpError(400, '当前外观版本缺少固定记录');
        contract.push(
          `Current appearance of ${name(instance.instanceId)}: ${appearance.data.description}; ${Object.values(appearance.data.features || {}).join('; ')}.`,
        );
      }
      for (const side of ['start', 'end']) {
        const values = s.state?.attributes?.[side] || [];
        if (values.length)
          contract.push(
            `${side === 'start' ? 'Initial' : 'Required final'} state: ${values.map((v: any) => (v.status === 'known' ? condition(v) : `${name(v.instanceId)}.${v.key} is unknown; do not invent its value`)).join('; ')}.`,
          );
      }
      for (const side of ['start', 'end']) {
        const relations = s.state?.[`${side}Relations`] || [];
        if (relations.length)
          contract.push(
            `${side} relationships: ${relations.map((r: any) => `${name(r.objectId)} ${r.type} ${name(r.targetId)} at ${r.anchor || 'specified location'}, quantity ${r.quantity}`).join('; ')}.`,
          );
      }
      if (staged) {
        for (const i of d.interactions || [])
          contract.push(
            `Interaction ${i.id}, event ${i.eventId}: ${name(i.actorId)} ${i.kind} ${name(i.targetId)} at ${i.anchorId || 'the described target'} using ${i.effector}. Preconditions: ${i.precondition}. Visible action: ${i.action}. Result: ${i.result}.`,
          );
        for (const side of ['start', 'end'])
          for (const location of d.locations?.[side] || [])
            contract.push(
              `${side} location: ${name(location.objectId)} in ${name(location.targetId)}, ${location.anchor}.`,
            );
      }
      for (const e of d.events)
        contract.push(
          `Event ${e.id} (${e.mode}, ${e.required ? 'required' : 'optional'}): ${e.description}. ${e.afterIds.length ? `Only after ${e.afterIds.join(', ')} completes. ` : ''}${e.preconditions.length ? `Preconditions: ${e.preconditions.map(condition).join('; ')}. ` : ''}${e.condition ? `Maintain ${condition(e.condition)} throughout frames [${e.startFrame},${e.endFrame}). ` : ''}${e.changes.length ? `Observed result must be: ${e.changes.map(condition).join('; ')}. ` : ''}${e.mode === 'forbidden' ? `This event must not occur throughout frames [${e.startFrame},${e.endFrame}). ` : ''}${e.strictWindow ? `Timing window: frames [${e.startFrame},${e.endFrame}).` : ''}`,
        );
      for (const link of d.information || []) {
        const info = input.information?.find((v: any) => v.id === link.informationId);
        const event = d.events.find((v: any) => v.id === link.eventId);
        if (!info || !event || !info.shotIds.includes(s.shotId))
          throw new HttpError(400, '信息控制引用缺失或不属于镜头');
        if (!context.freeCreation && link.purpose === 'withhold' && event.mode !== 'forbidden')
          throw new HttpError(400, '隐藏信息必须关联禁止揭示事件');
        if (
          !context.freeCreation &&
          (!event.required || (link.purpose === 'reveal' && event.mode !== 'occurrence'))
        )
          throw new HttpError(400, '信息控制必须关联必审且职责匹配的事件');
        if (!context.freeCreation && link.purpose === 'reveal')
          for (const id of info.afterIds) {
            const priorLink = d.information.find(
              (v: any) => v.informationId === id && v.purpose === 'reveal',
            );
            if (priorLink && !event.afterIds.includes(priorLink.eventId))
              throw new HttpError(400, '同镜头信息揭示先后关系必须进入事件依赖');
          }
        contract.push(
          `Information ${link.purpose} (${info.kind}), bound to event ${event.id}: ${info.statement}.`,
        );
      }
      if (seriesMode) {
        for (const side of ['start', 'end'])
          for (const action of d.carry[side + 'Actions'])
            contract.push(
              side +
                ' action phase: ' +
                name(action.instanceId) +
                ' ' +
                action.id +
                ' at ' +
                action.phase +
                '; direction ' +
                action.direction +
                '; attention ' +
                action.attention +
                '; unfinished ' +
                action.unfinished +
                '; next allowed ' +
                action.next +
                '.',
            );
        for (const line of d.sound.dialogue) {
          const voice = input.seriesInputs?.voices?.find(
            (v: any) => v.instanceId === line.instanceId,
          )?.record;
          if (context.freeCreation && !voice) continue;
          if (
            !voice ||
            voice.id !== line.voiceProfile.id ||
            voice.revision !== line.voiceProfile.revision
          )
            throw new HttpError(409, '台词声音版本未固定到当前系列或分集覆盖');
          contract.push(
            'Voice request for ' +
              name(line.instanceId) +
              ': ' +
              voice.data.language +
              '; ' +
              voice.data.timbre +
              '; pronunciation ' +
              voice.data.pronunciation +
              '; performance ' +
              voice.data.performance +
              '.',
          );
        }
      }
      if (input.segment.repair)
        contract.push(
          `Repair goal: ${input.segment.repair.goal}. Preserve: ${input.segment.repair.preserve.join('; ')}. Finish required changes within adopted candidate frames [${input.segment.repair.adoptRange.startFrame},${input.segment.repair.adoptRange.endFrame}).`,
        );
      for (const check of d.sound.checks || [])
        contract.push(`Audio requirement ${check.kind}: ${check.description}.`);
    }
    const dialogue = d.sound.dialogue.map(
      (l: any) =>
        `${ref && (!universal || mapped.subjects.some((s: any) => s.id === l.instanceId)) ? render(`{{subject:${l.instanceId}}}`) : l.instanceId} (${l.delivery || 'onscreen'}, ${l.voice}${staged ? `; mouth ${l.mouth?.visibility || 'unknown'}${l.mouth?.window ? ` during local frames [${l.mouth.window.startFrame},${l.mouth.window.endFrame})` : ''}; preserve the authored framing` : ''}) says: <d>[${l.language}] ${l.text}</d>`,
    );
    const offset =
      specs.slice(0, index).reduce((n: number, prior: any) => n + prior.frames, 0) / 24;
    const cut = index
      ? `At ${String(Math.floor(offset / 60)).padStart(2, '0')}:${(offset % 60).toFixed(3).padStart(6, '0')}, `
      : '';
    return `[Shot ${index + 1}] ${cut}${render(
      [
        ...contract,
        ...(staged ? [`Visual treatment: ${d.execution.visualTreatment}.`] : []),
        d.execution.action,
        d.execution.visibleSpace,
        ...camera,
        ...performance,
        ...dialogue,
        ...(d.cues || []).map(
          (c: any) =>
            `Timing cue ${c.id} for ${JSON.stringify(c.target)}: ${c.window ? `local frames [${c.window.startFrame},${c.window.endFrame}) at 24 fps` : 'time unspecified'}${c.afterIds.length ? `; only after ${c.afterIds.join(', ')} finishes` : ''}.`,
        ),
        ...d.effects.map(
          (e: any) =>
            `Effect from ${e.source} via ${e.carrier}: ${e.change}; target ${e.target}; visible result ${e.visibleResult}.`,
        ),
        d.sound.actions,
        d.sound.continuation,
        !staged && !d.camera.description && !s.cameraIntent
          ? brief.overrides.direction || moduleDirection?.framing
          : '',
      ]
        .filter(Boolean)
        .join(' '),
    )}`;
  });
  return { visual, art, lines };
}
