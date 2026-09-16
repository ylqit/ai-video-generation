import { prepareShot } from '../shared/directing.js';
import { spatialIssues, spatialAssessment } from '../shared/spatial.js';
import { frameCount } from '../shared/contracts.js';
import { preparePlannedH3 } from './reference-plan.js';
import { generationDigest } from './h3-guided.js';
import { HttpError } from './db.js';
import { projectShotBrief } from './creative-brief.js';
import { validateShotSemantics } from '../shared/shot-semantics.js';

export const modularRefTemplate = 'native-h3-directed-v2';
export const modularBaseTemplate = 'native-h3-base-v2';
export const universalRefTemplate = 'native-h3-directed-v3';
export const universalBaseTemplate = 'native-h3-base-v3';
export const seriesRefTemplate = 'native-h3-directed-v4';
export const seriesBaseTemplate = 'native-h3-base-v4';
export function prepareModularH3(input: any) {
  const seriesMode = [seriesRefTemplate, seriesBaseTemplate].includes(input.templateVersion);
  const universal = [
    universalRefTemplate,
    universalBaseTemplate,
    seriesRefTemplate,
    seriesBaseTemplate,
  ].includes(input.templateVersion);
  const ref = [modularRefTemplate, universalRefTemplate, seriesRefTemplate].includes(
    input.templateVersion,
  );
  if (
    !ref &&
    ![modularBaseTemplate, universalBaseTemplate, seriesBaseTemplate].includes(
      input.templateVersion,
    )
  )
    throw new HttpError(400, '未知模块化模板');
  if (ref !== (input.segment.mode === 'ref2va'))
    throw new HttpError(400, 'Base/Ref 模式与模板不匹配');
  if (!ref && input.segment.guides?.length)
    throw new HttpError(400, 'Base 使用明确首尾帧角色，不接受 Ref Add Guide');
  const brief = input.creativeBrief;
  if (!brief || brief.checks.some((c: any) => c.severity === 'blocking'))
    throw new HttpError(409, '固定制作规范未通过审核');
  const { digest, ...content } = brief;
  if (generationDigest(content) !== digest) throw new HttpError(400, '固定制作规范摘要不匹配');
  const specs = input.planning.shots.map((s: any) => prepareShot(s, input.planning.records));
  const staged = specs.every((s: any) => s.directing?.contractRevision === 2);
  if (!staged && specs.some((s: any) => s.directing?.contractRevision === 2))
    throw new HttpError(409, '同一请求不能混用导演契约修订');
  if (
    universal &&
    (brief.schemaVersion !== (seriesMode ? 3 : 2) ||
      specs.some((s: any) => s.directing?.version !== (seriesMode ? 3 : 2)))
  )
    throw new HttpError(400, 'V3 模板需要 V3 制作配置及 directing v2 镜头');
  if (!universal && (brief.schemaVersion >= 2 || specs.some((s: any) => s.directing?.version >= 2)))
    throw new HttpError(400, '新配置或镜头语义需要 V3 执行模板');
  const semanticErrors = universal
    ? input.planning.shots.flatMap((s: any) =>
        validateShotSemantics(s, input.planning.records).map((e) => `${s.id}: ${e}`),
      )
    : [];
  if (semanticErrors.length) throw new HttpError(400, semanticErrors.join('；'));
  const projection = universal
    ? input.planning.shots.map((s: any) => projectShotBrief(brief, s))
    : [];
  if (
    universal &&
    !staged &&
    !brief.overrides.visual &&
    !brief.modules.some((m: any) => m.data.category === 'visual') &&
    !brief.visualReference &&
    projection.some((p: any) => !p.entries.some((e: any) => e.aspect === 'style'))
  )
    throw new HttpError(409, '当前镜头没有适用的视觉规范');
  const referenceChecks: any[] = [];
  const activeBindings = ref
    ? input.planning.selected || []
    : (input.assets || []).map((a: any) => ({
        id: `${a.asset.id}:${a.asset.revision}`,
        usage: a.reference.usage,
        role: a.reference.role,
      }));
  if (universal) {
    for (const binding of activeBindings) {
      const usage = binding.usage;
      if (!usage?.reviewed) throw new HttpError(409, `参考 ${binding.id} 需要实际图片用途审核`);
      if (
        !ref &&
        (binding.role === 'first_frame'
          ? usage.purpose !== 'action_start'
          : binding.role === 'last_frame'
            ? usage.purpose !== 'action_end'
            : true)
      )
        throw new HttpError(400, 'Base 图片用途必须与首帧 / 尾帧角色对应');
      for (const s of input.planning.shots.filter((s: any) =>
        ref
          ? !usage.shotIds.length || usage.shotIds.includes(s.id)
          : s.id ===
            input.segment.shotIds[
              binding.role === 'first_frame' ? 0 : input.segment.shotIds.length - 1
            ],
      )) {
        for (const f of usage.depictedState || []) {
          const instance = s.state?.instances?.find((i: any) => i.instanceId === f.instanceId);
          const entity =
            instance &&
            input.planning.records.find(
              (r: any) => r.id === instance.entity.id && r.revision === instance.entity.revision,
            );
          const definition = entity?.data.attributes?.find((a: any) => a.key === f.key);
          if (
            !definition ||
            (f.status === 'known' &&
              (definition.type === 'enum'
                ? !definition.values.includes(f.value)
                : typeof f.value !== definition.type))
          )
            throw new HttpError(
              400,
              `参考图 ${binding.id} 的属性未定义或取值错误：${f.instanceId}.${f.key}`,
            );
        }
        const expected =
          s.state?.attributes?.[usage.purpose === 'action_end' ? 'end' : 'start'] || [];
        const conflicts = (usage.depictedState || []).filter(
          (f: any) =>
            f.status === 'known' &&
            expected.some(
              (v: any) =>
                v.instanceId === f.instanceId &&
                v.key === f.key &&
                v.status === 'known' &&
                v.value !== f.value,
            ),
        );
        if (
          conflicts.length &&
          (!usage.stateException?.trim() ||
            ['action_start', 'action_end', 'composition'].includes(usage.purpose))
        )
          throw new HttpError(
            409,
            `参考图 ${binding.id} 与 ${s.id} 状态冲突，请更换动作参考或审核身份参考状态例外`,
          );
        referenceChecks.push({
          bindingId: binding.id,
          shotId: s.id,
          status: conflicts.length ? 'reviewed_exception' : 'no_declared_conflict',
          conflicts,
          reason: usage.stateException || '',
          limitation: 'Only declared properties compared; image content requires actual review.',
        });
      }
    }
  }
  const issues = specs
    .flatMap((s: any) => s.issues)
    .filter((i: any) => i.severity === 'blocking' || i.code.startsWith('wording:'));
  if (universal && specs.some((s: any) => s.trace.some((t: any) => t.status === 'unsupported')))
    throw new HttpError(409, '镜头含当前适配器不支持的旧字段，请显式转换后重新预览');
  if (issues.length)
    throw new HttpError(400, issues.map((i: any) => `${i.field}: ${i.message}`).join('；'));
  if (!specs.length || specs.some((s: any) => !s.directing?.execution.action))
    throw new HttpError(400, '每个镜头需要明确的 directing.execution.action');
  if (specs.reduce((n: number, s: any) => n + s.frames, 0) > input.segment.duration * 24)
    throw new HttpError(400, '片段短于镜头计划时长');
  const mapped = ref
    ? preparePlannedH3(input)
    : {
        images: [],
        subjects: [],
        anchors: [],
        frameCount: frameCount(input.segment.duration),
        duration: frameCount(input.segment.duration) / 24,
      };
  const render = (text: string) =>
    text.replace(/\{\{(subject|picture):([^}]+)\}\}/g, (_all, kind, id) => {
      if (!ref) throw new HttpError(400, 'Base 正文使用已审核主体名称，不使用 Ref 标签');
      if (kind === 'subject') {
        const subject = mapped.subjects.find((s: any) => s.id === id);
        if (!subject) throw new HttpError(400, `悬空主体引用 ${id}`);
        return subject.label;
      }
      const binding = input.planning.selected.find((b: any) => b.id === id);
      const picture =
        binding &&
        mapped.images.find(
          (p: any) => p.assetId === binding.asset.id && p.revision === binding.asset.revision,
        );
      if (!picture) throw new HttpError(400, `悬空图片引用 ${id}`);
      return picture.label;
    });
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
    if (staged && !d.execution.visualTreatment?.trim())
      throw new HttpError(409, `${s.shotId} 缺少本镜可执行视觉处理`);
    if ((s.layout || d.paths.length || d.doors.length) && !d.execution.visibleSpace?.trim())
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
        if (link.purpose === 'withhold' && event.mode !== 'forbidden')
          throw new HttpError(400, '隐藏信息必须关联禁止揭示事件');
        if (!event.required || (link.purpose === 'reveal' && event.mode !== 'occurrence'))
          throw new HttpError(400, '信息控制必须关联必审且职责匹配的事件');
        if (link.purpose === 'reveal')
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
          const voice = input.seriesInputs?.voices.find(
            (v: any) => v.instanceId === line.instanceId,
          )?.record;
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
  const retention = ref
    ? input.planning.selected
        .flatMap((b: any) => {
          if (universal && !b.usage?.reviewed)
            throw new HttpError(400, `参考 ${b.id} 需要明确用途和审核后的保留要求`);
          const picture = mapped.images.find(
            (p: any) => p.assetId === b.asset.id && p.revision === b.asset.revision,
          )!;
          return [
            ...(universal
              ? [
                  `${picture.label} applies only to shots ${b.usage.shotIds.join(', ') || input.segment.shotIds?.join(', ') || 'as declared'}; reference purpose ${b.usage.purpose}. ${b.usage.stateException || ''}`,
                ]
              : []),
            `${picture.label} (${universal ? b.usage.purpose : b.role || b.view}): preserve ${(universal ? b.usage.preserve : b.retain).join('; ')}; allowed changes: ${(universal ? b.usage.allow : b.allow).join('; ') || 'only the authored action'}; ${(universal ? ['environment', 'composition', 'action_start', 'action_end'].includes(b.usage.purpose) && b.inheritBackground : b.inheritBackground) ? 'inherit its explicitly assigned environment' : 'exclude its background unless separately assigned as a scene reference'}.`,
            ...(staged && ['identity', 'appearance'].includes(b.usage.purpose)
              ? [
                  `${picture.label} supplies identity features only. Do not inherit frontal pose, gaze toward the viewer, framing or background; follow the shot's staging.`,
                ]
              : []),
          ];
        })
        .concat(
          specs.flatMap((s: any) => [
            ...s.directing.execution.retention,
            ...(s.directing.execution.retentionBindings || []).map(
              (r: any) =>
                `${render(r.target)}: preserve ${r.preserve.join('; ')}; allow ${r.allow.join('; ')}; background ${r.background}.`,
            ),
          ]),
        )
    : [];
  if (ref && !universal)
    for (const instance of input.planning.instances) {
      const entity = input.planning.records.find(
        (r: any) => r.id === instance.entity.id && r.revision === instance.entity.revision,
      );
      const appearance =
        instance.appearance &&
        input.planning.records.find(
          (r: any) =>
            r.id === instance.appearance.id && r.revision === instance.appearance.revision,
        );
      const subject = mapped.subjects.find((s: any) => s.id === instance.instanceId);
      if (subject)
        retention.push(
          `${subject.label}: ${(entity?.data.fixedFeatures || []).join('; ')}${appearance ? `; appearance: ${appearance.data.description}; ${Object.values(appearance.data.features || {}).join('; ')}` : ''}`,
        );
    }
  const sections = [
    ...(ref
      ? [
          `subject_definitions:\n${mapped.subjects
            .map(
              (s: any) =>
                `${s.label}: ${universal ? s.id : input.planning.records.find((r: any) => r.id === input.planning.instances.find((i: any) => i.instanceId === s.id)?.entity.id)?.data.description || s.id}; the same assigned instance across ${s.pictures.join(', ')}.`,
            )
            .concat(
              mapped.anchors.map(
                (a: any) =>
                  `${a.label}: temporal composition anchor at frame ${a.resolvedFrameIndex}; ${render(a.instruction)}`,
              ),
            )
            .join('\n')}`,
          `summary:\n${render(universal ? '[reference generation] Execute only the following approved shot contracts in order.' : input.segment.guidedPrompt.summary)}`,
          `retention_analysis:\n${render(retention.join('\n'))}`,
        ]
      : []),
    `${ref ? 'detailed_description' : 'integrated_multimodal_description'}:\n${staged ? '' : `Visual treatment: ${visual || (universal ? brief.visualReference?.description || 'follow the applicable style entries' : '')}. ${brief.overrides.mixedMedia || ''}\nArt direction: ${art || 'use the approved input assets'}\n`}${lines.join('\n')}`,
    `overall_soundscape:\n${render(
      specs
        .map((s: any) => s.directing.sound.environment)
        .filter(Boolean)
        .join('; ') || 'N/A',
    )}`,
    `non_diegetic_music:\n${render(
      specs
        .map((s: any) => s.directing.sound.music)
        .filter((s: string) => s && s !== 'N/A')
        .join('; ') || 'N/A',
    )}`,
  ];
  let alignment = '';
  if (!ref) {
    const first = input.segment.references?.find((r: any) => r.role === 'first_frame');
    const last = input.segment.references?.find((r: any) => r.role === 'last_frame');
    const end = mapped.duration.toFixed(2);
    if (first && last)
      alignment = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${specs.length}) aligns with the ${end}-second mark of the target video.`;
    else if (first)
      alignment =
        'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
    else if (last)
      alignment = `How the reference pictures align with the target video — <Picture 1> (from [Shot ${specs.length}]) aligns with the ${end}-second mark of the target video.`;
  }
  const finalPrompt = [alignment, ...sections].filter(Boolean).join('\n\n');
  const labels = new Set([
    ...mapped.images.map((p: any) => p.label),
    ...mapped.subjects.map((s: any) => s.label),
  ]);
  if (!ref && input.segment.references?.length) {
    labels.add('<Picture 1>');
    if (input.segment.references.length === 2) labels.add('<Picture 2>');
  }
  for (const tag of finalPrompt.matchAll(/<(?:Subject|Picture|Video|Audio)\s+\d+>/g))
    if (!labels.has(tag[0])) throw new HttpError(400, `悬空标签 ${tag[0]}`);
  if (/\{\{/.test(finalPrompt)) throw new HttpError(400, '未解析的执行引用');
  if (
    /[\u3400-\u9fff]/.test(
      finalPrompt.replace(/<d>[\s\S]*?<\/d>/g, '').replace(/"(?:\\.|[^"\\])*"/g, ''),
    )
  )
    throw new HttpError(
      400,
      '执行描述、美术规范和模块覆盖须在审核前提供英文；对白可保留中文，预览不翻译',
    );
  const result: any = {
    ...mapped,
    finalPrompt,
    shotSpecs: specs,
    rulesVersion: seriesMode
      ? ref
        ? 'h3-directed-v4'
        : 'h3-base-v4'
      : universal
        ? ref
          ? 'h3-directed-v3'
          : 'h3-base-v3'
        : ref
          ? 'h3-directed-v2'
          : 'h3-base-v2',
    creativeBrief: brief,
    ...(universal ? { referenceChecks } : {}),
    spatialChecks: specs.flatMap((s: any) => spatialIssues(s, input.width / input.height)),
    ...(staged
      ? {
          contractRevision: 2,
          spatialAssessments: specs.map((s: any) => ({
            shotId: s.shotId,
            ...spatialAssessment(s, input.width / input.height),
          })),
          consumption: specs.flatMap((s: any) => [
            ...[
              'execution.action',
              'execution.visibleSpace',
              'execution.visualTreatment',
              'camera.description',
              'camera.composition',
              'camera.motion',
              'performance.reaction',
              'performance.attention',
              'interactions',
              'locations',
              'sound',
              'cues',
            ].map((field) => ({
              shotId: s.shotId,
              source: s.directing.authoringSource,
              field: `directing.${field}`,
              status: 'text_request',
              consumers: ['prompt', 'actual_media_review'],
            })),
            ...['staging', 'paths', 'doors', 'axis', 'proxies', 'performance.headHeading'].map(
              (field) => ({
                shotId: s.shotId,
                source: s.directing.authoringSource,
                field: `directing.${field}`,
                status: 'planning_check',
                consumers: ['previs', 'actual_media_review'],
              }),
            ),
            ...[
              'direction',
              'assetPolicy',
              'performance.stimulus',
              'performance.intention',
              'audienceInformation',
              'cutReason',
            ].map((field) => ({
              shotId: s.shotId,
              field,
              status: 'not_consumed',
              consumers: [],
              reason:
                'Authoring rationale or production management; not provider execution content.',
            })),
          ]),
        }
      : {}),
    ...(universal
      ? {
          projection,
          complexity: specs.map((s: any) => ({
            shotId: s.shotId,
            visibleInstances: s.directing.presence.visible.length,
            events: s.directing.events.length,
            contactRelations: s.state?.endRelations.length || 0,
            cameraMotion: s.directing.camera.motion,
            dialogue: s.directing.sound.dialogue.length,
            occlusion: 'requires_visual_review',
          })),
        }
      : {}),
    trace: [
      ...(seriesMode
        ? [
            {
              field: 'directing.carry',
              status: 'text_request',
              consumers: ['prompt', 'continuation_check', 'boundary_review'],
            },
            {
              field: 'voice_profile.samples',
              status: 'post_generation_review',
              consumers: ['voice_review'],
              reason:
                'No audio reference connected to H3; text timbre is a request, not an identity lock.',
            },
          ]
        : []),
      ...specs.flatMap((s: any) =>
        s.trace.map((t: any) => ({
          shotId: s.shotId,
          ...t,
          ...(universal
            ? {
                status:
                  t.status === 'unsupported'
                    ? 'unsupported'
                    : [
                          'directing.paths',
                          'directing.doors',
                          'directing.proxies',
                          'directing.purpose',
                          'directing.audienceInformation',
                          'directing.transition',
                          'directing.axis',
                        ].includes(t.field)
                      ? 'planning_check'
                      : 'text_request',
                consumers:
                  t.status === 'unsupported'
                    ? []
                    : [
                          'directing.paths',
                          'directing.doors',
                          'directing.proxies',
                          'directing.purpose',
                          'directing.audienceInformation',
                          'directing.transition',
                          'directing.axis',
                        ].includes(t.field)
                      ? ['planning_or_previsualization', 'post_generation_review']
                      : ['prompt', 'post_generation_review'],
              }
            : {}),
        })),
      ),
      ...(universal
        ? projection
            .flatMap((p: any) =>
              p.decisions.map((d: any) => ({
                shotId: p.shotId,
                ...d,
                consumers: d.status === 'text_request' ? ['prompt'] : [],
              })),
            )
            .concat([
              {
                field: 'state.attributes',
                status: 'text_request',
                consumers: ['prompt', 'post_generation_review'],
              },
              {
                field: 'directing.events',
                status: 'post_generation_review',
                consumers: ['prompt', 'event_evidence', 'selection'],
              },
              ...mapped.anchors.map((a: any) => ({
                field: `guide:${a.label}@${a.resolvedFrameIndex}`,
                status: 'model_input',
                consumers: ['conditioning'],
                asset: { id: a.assetId, revision: a.revision },
              })),
              ...mapped.images.map((p: any) => ({
                field: `text image slot:${p.label}`,
                status: 'model_input',
                consumers: ['reference_slots'],
                asset: { id: p.assetId, revision: p.revision },
              })),
              ...(!ref
                ? (input.assets || []).map((a: any) => ({
                    field: `base:${a.reference.role}`,
                    status: 'model_input',
                    consumers: ['base_frame_condition'],
                    asset: { id: a.asset.id, revision: a.asset.revision },
                  }))
                : []),
              ...(brief.visualReference
                ? [
                    {
                      field: 'visualReference',
                      status: 'text_request',
                      consumers: ['reviewed_visual_description'],
                      reason:
                        'Image is a reviewed specification source; conditioning requires an explicit reference binding.',
                    },
                  ]
                : []),
              {
                field: 'state.start / state.end',
                status: 'planning_check',
                consumers: ['previsualization', 'continuity_checks'],
                reason:
                  'Numeric position and heading are not automatically translated to visible prose.',
              },
              {
                field: 'entity.description / legacy retain / summary',
                status: 'excluded',
                reason: 'use scoped art and reviewed reference usage',
              },
            ])
        : []),
      ...brief.modules.map((m: any) => ({
        field: `${m.ref.id}:${m.ref.revision}`,
        consumers: [
          m.data.category === 'visual'
            ? 'detailed_description'
            : m.data.category === 'direction'
              ? 'explicit shot or framing fallback'
              : 'director stage rules and review; never injected as world facts',
        ],
        status: universal
          ? m.data.category === 'visual'
            ? brief.overrides.visual
              ? 'excluded'
              : 'text_request'
            : 'planning_check'
          : 'consumed',
      })),
      {
        field: 'numeric geometry',
        consumers: [
          'previsualization and spatialChecks; execution.visibleSpace supplies visible prose',
        ],
        status: universal ? 'planning_check' : 'consumed',
      },
    ],
  };
  if (staged) {
    result.consumption.push(...result.trace.filter((t: any) => t.status === 'model_input'));
    result.trace = result.consumption;
  }
  return result;
}
