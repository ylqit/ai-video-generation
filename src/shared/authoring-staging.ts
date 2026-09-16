import type { AuthoringShot, CreationIssue, DirectorResult, ScriptResult } from './creation.js';
import { resolveStaging } from './staging-projection.js';

/** Validate authored relationships; geometry and media observations are separate evidence. */
export function validateStaging(director: DirectorResult, script: ScriptResult): CreationIssue[] {
  if (director.contractRevision !== 2) return [];
  const issues: CreationIssue[] = [];
  const add = (
    code: string,
    field: string,
    message: string,
    targetId = '',
    severity: CreationIssue['severity'] = 'blocking',
  ) =>
    issues.push({
      code,
      field,
      message,
      targetId,
      severity,
      category: severity === 'review' ? 'quality' : 'consistency',
      stage: 'director',
    });
  const known = new Set(script.subjects.map((s) => s.key));
  const designs = director.sceneDesigns || [];
  const unique = (ids: string[], field: string) => {
    if (new Set(ids).size !== ids.length) add('staging_duplicate', field, '空间对象标识重复');
  };
  unique(
    designs.map((d) => d.id),
    'sceneDesigns',
  );
  unique(
    designs.map((d) => d.sceneId),
    'sceneDesigns.sceneId',
  );
  for (const scene of script.scenes)
    if (!designs.some((d) => d.sceneId === scene.id))
      add(
        'scene_design_missing',
        'sceneDesigns',
        `场景 ${scene.id} 需要空间设计或明确不适用的理由`,
        scene.id,
      );
  for (const d of designs) {
    const field = `sceneDesigns.${d.id}`;
    if (!script.scenes.some((s) => s.id === d.sceneId))
      add('staging_scene', field, '空间设计引用未知场景', d.id);
    if (
      d.environmentKey &&
      !script.subjects.some((s) => s.key === d.environmentKey && s.kind === 'environment')
    )
      add('staging_environment', field, '空间环境主体不存在', d.id);
    if (d.applicability === 'not_applicable' && !d.reason.trim())
      add('staging_reason', field, '不适用空间预演需要说明原因', d.id);
    if (d.scale === 'measured' && !d.space)
      add('staging_scale', field, '有尺度空间需要明确尺寸', d.id);
    if (d.applicability === 'spatial' && !d.cameras.length)
      add('staging_camera_missing', field, '空间场景需要至少一个机位', d.id);
    if (d.applicability === 'spatial' && !d.environmentKey)
      add('staging_environment', field, '空间场景需要已声明的环境主体', d.id);
    for (const [name, values] of [
      ['cameras', d.cameras],
      ['anchors', d.anchors],
      ['barriers', d.barriers],
      ['regions', d.regions],
    ] as const)
      unique(
        values.map((v) => v.id),
        `${field}.${name}`,
      );
    unique(
      d.proxies.map((p) => p.subjectKey),
      `${field}.proxies`,
    );
    for (const a of [...d.anchors, ...d.proxies])
      if (!known.has(a.subjectKey)) add('staging_subject', field, `未知主体 ${a.subjectKey}`, d.id);
    for (const b of d.barriers)
      if (b.regions.some((id) => !d.regions.some((r) => r.id === id)))
        add('staging_region', field, `障碍 ${b.id} 引用未知区域`, d.id);
  }
  const priorPoses = new Map<string, NonNullable<AuthoringShot['staging']>['entry']>();
  const resolved = resolveStaging(director);
  for (const shot of director.shots) {
    const field = `shots.${shot.id}`;
    for (const key of [
      'visibleSpace',
      'audienceFocus',
      'informationChange',
      'cutReason',
      'visualTreatment',
    ] as const)
      if (typeof shot[key] !== 'string' || !shot[key]!.trim())
        add('shot_design_missing', `${field}.${key}`, `镜头需要明确 ${key}`, shot.id);
    if (!Array.isArray(shot.interactions) || shot.staging === undefined)
      add('shot_design_missing', field, '镜头需要明确交互和空间适用性', shot.id);
    const scene = designs.find((d) => d.sceneId === shot.sceneId);
    const staging = shot.staging;
    const risk = stagingReasons(shot);
    if (risk.length && scene?.applicability !== 'spatial')
      add('staging_required', field, `交互或路径需要空间设计：${risk.join('、')}`, shot.id);
    if (scene?.applicability === 'spatial' && (!staging || staging.sceneDesignId !== scene.id))
      add('staging_binding', field, '镜头必须引用所属场景的空间设计', shot.id);
    if (scene?.applicability === 'not_applicable' && staging)
      add('staging_binding', field, '不适用场景不能同时使用空间调度', shot.id);
    if (staging && scene) {
      const before = priorPoses.get(scene.id) || [];
      const transition = director.groups.find((g) => g.shotIds[0] === shot.id)?.transition;
      if (!transition || transition === 'continuous') {
        for (const p of staging.entry) {
          const old = before.find((v) => v.subjectKey === p.subjectKey);
          if (
            old &&
            ((old.position &&
              p.position &&
              (old.position.x !== p.position.x || old.position.y !== p.position.y)) ||
              (old.heading !== null && p.heading !== null && old.heading !== p.heading))
          )
            add(
              'staging_continuity',
              field,
              `连续镜头中 ${p.subjectKey} 的入口与前镜出口不一致；请明确动作或时间转换`,
              shot.id,
            );
        }
      }
      priorPoses.set(scene.id, resolved.get(shot.id)?.exit || []);
      if (!staging.cameraId || !scene.cameras.some((c) => c.id === staging.cameraId))
        add('staging_camera', field, '镜头机位不存在', shot.id);
      for (const poses of [staging.entry, staging.exit]) {
        unique(
          poses.map((p) => p.subjectKey),
          `${field}.poses`,
        );
        for (const p of poses)
          if (!known.has(p.subjectKey))
            add('staging_subject', field, `未知落位主体 ${p.subjectKey}`, shot.id);
      }
      unique(
        staging.paths.map((p) => p.subjectKey),
        `${field}.paths`,
      );
      unique(
        staging.doors.map((d) => `${d.barrierId}:${d.frame}`),
        `${field}.doors`,
      );
      for (const p of staging.paths) {
        if (!known.has(p.subjectKey)) add('staging_subject', field, '路径主体不存在', shot.id);
        validateKeys(p.keys, `${field}.paths`);
        for (const [key, poses] of [
          [p.keys[0], resolved.get(shot.id)?.entry || []],
          [p.keys.at(-1), staging.exit],
        ] as const) {
          const pose = poses.find((v) => v.subjectKey === p.subjectKey);
          if (
            key &&
            pose &&
            ((pose.position &&
              (pose.position.x !== key.position.x || pose.position.y !== key.position.y)) ||
              (pose.heading !== null && pose.heading !== key.heading))
          )
            add(
              'staging_path_state',
              field,
              `路径 ${p.subjectKey} 与已声明的入口或出口不一致`,
              shot.id,
            );
        }
      }
      validateKeys(staging.cameraKeys, `${field}.cameraKeys`);
      for (const change of staging.doors)
        if (
          change.frame >= shot.frames ||
          !scene.barriers.some((b) => b.id === change.barrierId && b.kind === 'door')
        )
          add('staging_door', field, '门状态引用或时点无效', shot.id);
    }
    function validateKeys(keys: { frame: number }[], path: string) {
      if (keys.some((k, i) => k.frame >= shot.frames || (i > 0 && k.frame <= keys[i - 1].frame)))
        add('staging_keyframes', path, '路径关键帧必须递增且位于镜头内', shot.id);
    }
    for (const p of shot.performances) {
      if (p.attention === undefined || p.headHeading === undefined)
        add(
          'attention_missing',
          `${field}.performances.${p.id}`,
          '表演需要明确关注目标或未知状态',
          shot.id,
        );
      const a = p.attention;
      if (a?.subjectKey && !known.has(a.subjectKey))
        add('attention_subject', field, '关注主体不存在', shot.id);
      if (
        a?.anchorId &&
        !scene?.anchors.some(
          (x) => x.id === a.anchorId && (!a.subjectKey || x.subjectKey === a.subjectKey),
        )
      )
        add('attention_anchor', field, '关注锚点不存在或不属于目标', shot.id);
      if (a?.subjectKey && a.point)
        add('attention_ambiguous', field, '关注目标与独立空间点不能同时指定', shot.id);
      if (!a)
        add('attention_unspecified', field, '关注目标未指定，需按表演意图审查', shot.id, 'review');
    }
    unique(
      (shot.interactions || []).map((i) => i.id),
      `${field}.interactions`,
    );
    for (const i of shot.interactions || []) {
      if (!known.has(i.actorKey) || !known.has(i.targetKey))
        add('interaction_subject', field, '交互主体或目标不存在', shot.id);
      if (!shot.events.some((e) => e.eventId === i.eventId))
        add('interaction_event', field, '交互必须引用本镜已有事件', shot.id);
      if (
        i.anchorId &&
        !scene?.anchors.some((a) => a.id === i.anchorId && a.subjectKey === i.targetKey)
      )
        add('interaction_anchor', field, '交互锚点不存在或不属于目标', shot.id);
      if (i.required && i.kind !== 'observe' && !i.anchorId)
        add('interaction_anchor_missing', field, '关键物理交互需要操作、接触或通行锚点', shot.id);
      if (!i.action.trim() || !i.result.trim())
        add('interaction_action', field, '交互需要可见动作与结果', shot.id);
    }
    for (const r of [...shot.entryRelations, ...shot.exitRelations])
      if (
        r.anchorId &&
        !scene?.anchors.some((a) => a.id === r.anchorId && a.subjectKey === r.targetKey)
      )
        add('relation_anchor', field, '关系锚点不存在或不属于目标', shot.id);
    for (const line of shot.dialogue) {
      if (!line.mouth)
        add(
          'mouth_visibility_missing',
          field,
          '对白需要明确嘴部可见性，不能把画内等同正面',
          shot.id,
        );
      if (line.delivery !== 'onscreen' && line.mouth?.visibility === 'visible')
        add('mouth_visibility_conflict', field, '画外或旁白不能声明对应同期嘴部可见', shot.id);
      const w = line.mouth?.window;
      if (w && (w.endFrame <= w.startFrame || w.endFrame > shot.frames))
        add('mouth_window', field, '嘴部可见性区间无效', shot.id);
    }
  }
  return issues;
}

export function stagingReasons(shot: AuthoringShot): string[] {
  return [
    ...(shot.interactions || [])
      .filter((i) => i.required && i.kind !== 'observe')
      .map((i) => i.kind),
    ...([...shot.entryRelations, ...shot.exitRelations].some((r) => r.type !== 'locatedIn')
      ? ['接触或持有关系']
      : []),
    ...(shot.staging?.paths.length ? ['主体路径'] : []),
    ...(shot.staging?.doors.length ? ['出入口变化'] : []),
    ...(shot.performances.filter((p) => p.attention?.subjectKey).length > 1
      ? ['共同关注或对话关系']
      : []),
  ];
}
