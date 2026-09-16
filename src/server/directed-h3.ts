import { prepareShot, type ShotExecutionSpec } from '../shared/directing.js';
import { sampleShot, spatialIssues } from '../shared/spatial.js';
import { preparePlannedH3 } from './reference-plan.js';
import { HttpError } from './db.js';

export const directedTemplateVersion = 'native-h3-directed-v1';
export function prepareDirectedH3(input: any) {
  const specs: ShotExecutionSpec[] = input.planning.shots.map((s: any) =>
    prepareShot(s, input.planning.records),
  );
  const errors = specs
    .flatMap((s) => s.issues)
    .filter((i) => i.severity === 'blocking' || i.code.startsWith('wording:'));
  if (specs.some((s) => !s.directing))
    throw new HttpError(400, '新版模板需要每个镜头的 directing 设计');
  if (errors.length)
    throw new HttpError(400, errors.map((e) => `${e.field}: ${e.message}`).join('；'));
  if (specs.reduce((n, s) => n + s.frames, 0) > Math.round(input.segment.duration * 24))
    throw new HttpError(400, '生成片段时长不能短于所含镜头计划时长');
  const clean = structuredClone(input);
  // Compatibility compiler provides graph mechanics and stable reference mappings only.
  // New retention owns its content; arbitrary legacy feature metadata never reaches the model.
  const result = preparePlannedH3(clean);
  const render = (text: string) =>
    text.replace(/\{\{(subject|picture):([^}]+)\}\}/g, (_all, kind, id) => {
      if (kind === 'subject') {
        const subject = result.subjects.find((s: any) => s.id === id);
        if (!subject) throw new HttpError(400, `悬空主体引用 ${id}`);
        return subject.label;
      }
      const binding = input.planning.selected.find((b: any) => b.id === id);
      const picture =
        binding &&
        result.images.find(
          (p: any) => p.assetId === binding.asset.id && p.revision === binding.asset.revision,
        );
      if (!picture) throw new HttpError(400, `悬空图片引用 ${id}`);
      return picture.label;
    });
  const speakers = [
    ...new Set(specs.flatMap((s) => s.directing!.sound.dialogue.map((l) => l.instanceId))),
  ];
  const lines = specs.map((s, index) => {
    const d = s.directing!;
    const poseText = (poses: any[]) =>
      poses
        .map(
          (p) =>
            `${render(`{{subject:${p.instanceId}}}`)} at scene (${p.position.x},${p.position.y}), body heading ${p.heading}, ${p.phase || ''}`,
        )
        .join('; ');
    const relationText = (relations: any[]) =>
      relations
        .map(
          (r) =>
            `${render(`{{subject:${r.objectId}}}`)} ${r.type} ${result.subjects.some((s) => s.id === r.targetId) ? render(`{{subject:${r.targetId}}}`) : r.targetId} at ${r.anchor || 'assigned location'}; quantity ${r.quantity}, maximum ${r.maxQuantity}`,
        )
        .join('; ');
    const parts = [
      d.execution.action,
      s.cameraIntent,
      s.camera
        ? `Fixed camera: ${JSON.stringify((({ position, heading, height, pitch, fov }: any) => ({ position, heading, height, pitch, fov }))(sampleShot(s, 0).camera))}. Scene scale: ${JSON.stringify(s.layout?.data.space || 'schematic only')}. Scene coordinates: x right, y down; heading north zero clockwise; positive pitch up; vertical field of view in degrees.`
        : '',
      d.camera.description,
      d.camera.shotSize,
      d.camera.composition,
      `Camera movement: ${d.camera.motion}; ${d.camera.amplitude}.`,
      ...d.performance.map(
        (p) =>
          `${render(`{{subject:${p.instanceId}}}`)}: stimulus ${p.stimulus}; intention ${p.intention}; reaction ${p.reaction}; attention ${p.attention?.instanceId ? render(`{{subject:${p.attention.instanceId}}}`) : JSON.stringify(p.attention?.point || 'as authored')}; ${p.attention?.anchor || ''}; ${p.headHeading === undefined ? '' : `head heading ${p.headHeading} degrees`}`,
      ),
      ...d.effects.map(
        (e) =>
          `Effect from ${e.source} via ${e.carrier}: ${e.change}, target ${e.target}, visible result ${e.visibleResult}.`,
      ),
      `Start state: ${poseText(s.state?.start || [])}. End state: ${poseText(s.state?.end || [])}. Start relationships: ${relationText(s.state?.startRelations || [])}. End relationships: ${relationText(s.state?.endRelations || [])}. Body attachment anchors do not change with camera direction.`,
      `Transition: ${d.transition.kind}; ${d.transition.reason}; changes ${JSON.stringify(d.transition.changes)}.`,
      d.axis ? `Interaction axis: ${JSON.stringify(d.axis)}.` : '',
      ...('cues' in d ? d.cues || [] : []).map(
        (c) =>
          `Timing ${c.id}: ${JSON.stringify(c.target)}, window ${JSON.stringify(c.window)} at 24 fps; after ${c.afterIds.join(', ')}.`,
      ),
      d.sound.actions,
      ...d.sound.dialogue.map(
        (l) =>
          `${render(`{{subject:${l.instanceId}}}`)} ${l.voice} (${l.delivery || 'onscreen'}, S${speakers.indexOf(l.instanceId) + 1}) says: <d>[${l.language}] ${l.text}</d>`,
      ),
      d.paths.length
        ? `Staging paths in normalized scene coordinates, at 24 fps: ${JSON.stringify(d.paths)}`
        : '',
      d.camera.keys.length ? `Camera keyframes: ${JSON.stringify(d.camera.keys)}` : '',
      d.doors.length ? `Door states: ${JSON.stringify(d.doors)}` : '',
    ].filter(Boolean);
    const offset = specs.slice(0, index).reduce((n, p) => n + p.frames, 0) / 24;
    const stamp = `${String(Math.floor(offset / 60)).padStart(2, '0')}:${(offset % 60).toFixed(3).padStart(6, '0')}`;
    return `[Shot ${index + 1}] ${index ? `At ${stamp}, ` : ''}${render(parts.join(' '))}`;
  });
  const definitions =
    'subject_definitions:\n' +
    result.subjects
      .map((s) => `${s.label}: the same assigned subject across ${s.pictures.join(', ')}.`)
      .join('\n') +
    result.anchors
      .map(
        (a) =>
          `\n${a.label}: temporal composition anchor at frame ${a.resolvedFrameIndex}; ${a.instruction}`,
      )
      .join('');
  const explicitFeatures = input.planning.instances.flatMap((i: any) => {
    const entity = input.planning.records.find(
      (r: any) => r.id === i.entity.id && r.revision === i.entity.revision,
    );
    return (entity?.data.fixedFeatures || [])
      .filter((v: unknown) => typeof v === 'string')
      .map((v: string) => `${render(`{{subject:${i.instanceId}}}`)}: ${v}`);
  });
  const retention = input.planning.selected
    .flatMap((b: any) => [
      ...b.retain,
      ...b.allow.map((a: string) => `Allowed change: ${a}`),
      b.inheritBackground
        ? 'Use the explicitly assigned environment.'
        : 'Do not inherit the reference background.',
    ])
    .concat(explicitFeatures)
    .concat(specs.flatMap((s) => s.directing!.execution.retention));
  const finalPrompt = `${definitions}\n\nsummary:\n${render(input.segment.guidedPrompt.summary)}\n\nretention_analysis:\n${render(retention.join('\n'))}\n\ndetailed_description:\n${lines.join('\n')}\n\noverall_soundscape:\n${render(
    specs
      .map((s) => s.directing!.sound.environment)
      .filter(Boolean)
      .join('; ') || 'N/A',
  )}\n\nnon_diegetic_music:\n${render(
    specs
      .map((s) => s.directing!.sound.music)
      .filter((m) => m !== 'N/A')
      .join('; ') || 'N/A',
  )}`;
  if (/\{\{/.test(finalPrompt)) throw new HttpError(400, '存在未解析的执行引用');
  const executable = finalPrompt.replace(/<d>[\s\S]*?<\/d>/g, '').replace(/"(?:\\.|[^"\\])*"/g, '');
  if (/[\u3400-\u9fff]/.test(executable))
    throw new HttpError(
      400,
      '新版 Ref 执行字段需在创作审核阶段提供英文，对白可保留中文；预览不会临时翻译',
    );
  return {
    ...result,
    finalPrompt,
    rulesVersion: 'h3-directed-v1',
    shotSpecs: specs,
    trace: specs.flatMap((s) => s.trace.map((t) => ({ shotId: s.shotId, ...t }))),
    spatialChecks: specs.flatMap((s) => spatialIssues(s, input.width / input.height)),
  };
}
