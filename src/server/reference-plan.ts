import { prepareShot } from '../shared/directing.js';
import { spatialIssues } from '../shared/spatial.js';
import { DomainService } from './domain-service.js';
import { HttpError, type Store } from './db.js';
import { generationDigest, prepareGuidedH3, type GuidedPreparation } from './h3-guided.js';
import { guidedPromptSchema } from '../shared/contracts.js';

export const plannedTemplateVersion = 'native-h3-reference-plan-v2';
export function resolveReferencePlan(store: Store, episode: any, segment: any, aspect = 9 / 16) {
  const domain = new DomainService(store);
  const plan = domain.owned(episode.projectId, segment.referencePlan, 'reference_plan');
  if (
    !plan.data.published ||
    plan.data.stale ||
    store.get(plan.id).revision !== plan.revision ||
    plan.data.episodeId !== episode.id ||
    plan.data.segmentId !== segment.id
  )
    throw new HttpError(409, '本次参考方案需要重新审核发布');
  if (segment.mode !== 'ref2va')
    throw new HttpError(400, '参考方案 v2 当前用于 Ref2VA；首尾帧 I2V 使用原入口');
  const universal = ['native-h3-directed-v3', 'native-h3-directed-v4'].includes(
    segment.executionVersion,
  );
  const shots = universal
    ? segment.shotIds.map((id: string) => episode.data.shots.find((s: any) => s.id === id))
    : episode.data.shots.filter((s: any) => segment.shotIds.includes(s.id));
  const visible = new Set<string>(shots.flatMap((s: any) => s.directing?.presence?.visible || []));
  const checks = domain
    .shotChecks(episode.projectId, episode.data.shots)
    .filter((c: any) => segment.shotIds.includes(c.shotId));
  if (checks.some((c: any) => c.severity === 'blocking'))
    throw new HttpError(
      400,
      checks
        .filter((c: any) => c.severity === 'blocking')
        .map((c) => c.message)
        .join('；'),
    );
  const instances = new Map<string, any>();
  for (const shot of shots)
    for (const entry of shot.state?.instances || []) {
      const prior = instances.get(entry.instanceId);
      if (prior && generationDigest(prior) !== generationDigest(entry))
        throw new HttpError(400, '同一生成片段内实例外观或参考版本冲突，请拆分片段');
      instances.set(entry.instanceId, entry);
    }
  const omittedByScope: any[] = [];
  const bindings = plan.data.bindings.filter((b: any) => {
    if (!universal) return true;
    if (!b.usage?.reviewed) throw new HttpError(409, `参考 ${b.id} 尚未确认图片内容和用途`);
    if (b.usage.purpose === 'sound' || b.usage.purpose === 'motion')
      throw new HttpError(
        400,
        '当前图片参考适配器不支持声音或运动素材条件，请使用文字声音设计或图像动作起止参考',
      );
    if (b.usage.shotIds.some((id: string) => !segment.shotIds.includes(id)))
      throw new HttpError(400, '参考用途引用不属于本片段的镜头');
    const relevant = shots.filter(
      (s: any) => !b.usage.shotIds.length || b.usage.shotIds.includes(s.id),
    );
    if (
      b.instanceIds.length &&
      !b.instanceIds.some((id: string) =>
        relevant.some((s: any) => s.directing?.presence?.visible.includes(id)),
      )
    ) {
      omittedByScope.push({ bindingId: b.id, asset: b.asset, reason: '当前用途范围内未画面出场' });
      return false;
    }
    if (b.instanceIds.some((id: string) => !visible.has(id)))
      throw new HttpError(400, '同图包含未画面出场实例，需要重新准备参考或明确只绑定可见主体');
    return true;
  });
  for (const b of bindings) {
    for (const id of b.instanceIds)
      if (!instances.has(id)) throw new HttpError(400, `图片绑定到未出场实例 ${id}`);
    if (b.pack) {
      const pack = domain.owned(episode.projectId, b.pack, 'reference_pack');
      if (pack.data.stale || !pack.data.published) throw new HttpError(409, '参考包需复核');
      for (const id of b.instanceIds) {
        const entry = instances.get(id);
        if (
          pack.data.entity.id !== entry.entity.id ||
          (entry.appearance &&
            generationDigest(pack.data.appearance) !== generationDigest(entry.appearance))
        )
          throw new HttpError(400, '图片绑定的实例与参考包身份或外观不匹配');
      }
    }
  }
  const pinned = new Set(plan.data.guides.map((g: any) => g.bindingId));
  const requiredIds = new Set<string>(
    bindings
      .filter((b: any) => b.required || b.priority === 0 || pinned.has(b.id))
      .map((b: any) => b.id),
  );
  const textIdentities = new Set<string>(plan.data.textIdentityInstanceIds || []);
  for (const id of textIdentities) {
    const entry = instances.get(id);
    if (
      !entry ||
      !visible.has(id) ||
      !universal ||
      !domain.owned(episode.projectId, entry.entity, 'entity').data.description?.trim()
    )
      throw new HttpError(400, '文字身份必须明确引用本片段可见主体及其已固定描述');
  }
  for (const [id, entry] of instances) {
    if (universal && !visible.has(id)) continue;
    const entity = domain.owned(episode.projectId, entry.entity, 'entity');
    if (textIdentities.has(id)) continue;
    const referenceRole =
      entity.data.type === 'environment'
        ? 'scene'
        : entity.data.type === 'style'
          ? 'style'
          : entity.data.type === 'object'
            ? 'prop'
            : 'identity';
    const identity = bindings.find(
      (b: any) => b.instanceIds.includes(id) && (b.role === 'identity' || b.role === referenceRole),
    );
    if (identity) requiredIds.add(identity.id);
    else checks.push({ code: `identity:${id}`, message: `${id} 缺少基准身份参考` });
    if (!entry.pack) checks.push({ code: `pack:${id}`, message: `${id} 尚未选择已审核参考包` });
  }
  for (const shot of shots)
    for (const required of shot.state?.requiredViews || []) {
      const b = bindings.find(
        (b: any) => b.instanceIds.includes(required.instanceId) && b.view === required.view,
      );
      if (b) requiredIds.add(b.id);
      else
        checks.push({
          code: `view:${required.instanceId}:${required.view}`,
          message: `缺少必需视图 ${required.view}：${required.reason}`,
        });
    }
  const ordered = [...bindings].sort(
    (a: any, b: any) =>
      Number(pinned.has(b.id) || b.priority === 0) - Number(pinned.has(a.id) || a.priority === 0) ||
      a.priority - b.priority,
  );
  const key = (b: any) => `${b.asset.id}:${b.asset.revision}`;
  const requiredKeys = new Set(ordered.filter((b: any) => requiredIds.has(b.id)).map(key));
  if (requiredKeys.size > 9)
    throw new HttpError(
      400,
      `必需图片 ${requiredKeys.size} 张超过九图限制；减少出场主体、调整参考方案或拆分片段`,
    );
  const chosen = new Set(requiredKeys),
    omitted: any[] = [...omittedByScope];
  for (const b of ordered) {
    if (chosen.has(key(b))) continue;
    if (chosen.size < 9) chosen.add(key(b));
    else omitted.push({ bindingId: b.id, reason: '九图预算已满；辅助图片未纳入', asset: b.asset });
  }
  const selected = ordered.filter((b: any) => chosen.has(key(b)));
  if (!selected.length) throw new HttpError(400, '参考方案至少需要一张已审核图片');
  for (const b of selected) {
    const asset = domain.owned(episode.projectId, b.asset, 'asset');
    if (!asset.data.adopted || asset.data.mediaType !== 'image')
      throw new HttpError(400, '生成参考必须为已采用的图片版本');
  }
  if (segment.executionVersion === 'native-h3-directed-v1') {
    const layouts = shots.flatMap((s: any) =>
      s.state?.layout ? [domain.owned(episode.projectId, s.state.layout, 'layout')] : [],
    );
    for (const shot of shots) checks.push(...spatialIssues(prepareShot(shot, layouts), aspect));
  }
  const risks = [...new Map(checks.map((c) => [c.code, c])).values()];
  // V9 r2 keeps unspecified geometry visible as a design gap; it is not a broken reference.
  const gateRisks = risks.filter(
    (r) =>
      !(
        r.severity !== 'blocking' &&
        r.code.startsWith('pose:') &&
        shots.some((s: any) => s.id === r.shotId && s.directing?.contractRevision === 2)
      ),
  );
  const mode = segment.generationMode || 'formal';
  if (gateRisks.length && mode === 'formal')
    throw new HttpError(
      409,
      `正式生成检查未通过：${gateRisks.map((r) => `${r.code} ${r.message}`).join('；')}`,
    );
  const unacknowledged = gateRisks.filter((r) => !plan.data.acknowledgedRisks.includes(r.code));
  if (unacknowledged.length)
    throw new HttpError(
      409,
      `探索生成需在参考方案中确认风险：${unacknowledged.map((r) => r.code).join(', ')}`,
    );
  const records = [...instances.values()]
    .flatMap((i) => [i.entity, i.appearance, i.pack].filter(Boolean))
    .concat(shots.flatMap((s: any) => (s.state?.layout ? [s.state.layout] : [])))
    .map((ref) => domain.owned(episode.projectId, ref));
  return {
    plan,
    selected,
    omitted,
    checks: risks,
    mode,
    instances: [...instances.values()],
    records,
    shots,
    dependencies: [
      ...domain.refs(universal ? selected : plan.data),
      ...domain.refs(shots),
      { id: plan.id, revision: plan.revision },
    ],
  };
}

// Frozen input only. Does not query the database, discover nodes, upload, or invoke an LLM.
export function preparePlannedH3(input: any): GuidedPreparation {
  const planning = input.planning;
  if (!planning) throw new HttpError(400, '缺少冻结的参考方案');
  const subjects: GuidedPreparation['subjects'] = [];
  const references = planning.selected.flatMap((b: any) => {
    const ids = b.instanceIds.length ? b.instanceIds : [`reference:${b.id}`];
    return ids.map((subjectId: string) => ({
      assetId: b.asset.id,
      revision: b.asset.revision,
      role: b.role,
      subjectId,
      instruction: b.reason,
    }));
  });
  const guides = planning.plan.data.guides.map((g: any) => {
    const b = planning.selected.find((b: any) => b.id === g.bindingId);
    if (!b) throw new HttpError(400, '关键帧绑定未纳入参考方案');
    return {
      assetId: b.asset.id,
      revision: b.asset.revision,
      frameIndex: g.frameIndex,
      instruction: g.instruction,
    };
  });
  // Share frame grid, crop and image-slot mechanics; v1 prompt behavior remains unchanged.
  const seedPreparation = prepareGuidedH3(
    {
      ...input,
      segment: {
        ...input.segment,
        references,
        guides,
        guidedPrompt: {
          summary: 'Reference plan',
          detailedDescription: '[Shot 1] Planned action.',
          overallSoundscape: 'Specified below.',
          nonDiegeticMusic: 'Specified below.',
        },
      },
    },
    { allowEmptyGuides: true },
  );
  for (const ref of references) {
    let subject = subjects.find((s) => s.id === ref.subjectId);
    if (!subject) {
      subject = {
        id: ref.subjectId,
        label: `<Subject ${subjects.length + 1}>`,
        pictures: [],
        instructions: [],
      };
      subjects.push(subject);
    }
    const picture = seedPreparation.images.find((i) => i.key === `${ref.assetId}:${ref.revision}`)!;
    if (!subject.pictures.includes(picture.label)) subject.pictures.push(picture.label);
  }
  // New compiler owns all wording; reuse only the image-slot and conditioning mechanics.
  if (['native-h3-directed-v3', 'native-h3-directed-v4'].includes(input.templateVersion))
    return { ...seedPreparation, subjects };
  const labels = new Map<string, string>();
  for (const s of subjects) labels.set(`subject:${s.id}`, s.label);
  for (const b of planning.selected)
    labels.set(
      `picture:${b.id}`,
      seedPreparation.images.find((i) => i.key === `${b.asset.id}:${b.asset.revision}`)!.label,
    );
  const render = (text: string) => {
    if (/<(?:Subject|Picture)\s+\d+>/.test(text))
      throw new HttpError(400, 'v2 正文请使用稳定 subject/picture 引用，不能手写编号');
    const result = text.replace(/\{\{(subject|picture):([^{}]+)\}\}/g, (_m, type, id) => {
      const tag = labels.get(`${type}:${id}`);
      if (!tag) throw new HttpError(400, `提示词悬空引用：${type}:${id}`);
      return tag;
    });
    if (/\{\{[^}]*\}\}/.test(result)) throw new HttpError(400, '提示词包含未解析引用');
    return result;
  };
  const prose = guidedPromptSchema.parse(input.segment.guidedPrompt);
  const mapped = Object.fromEntries(Object.entries(prose).map(([k, v]) => [k, render(v)]));
  // Reuse the existing structured shot-time validator with the exact mapped prose.
  prepareGuidedH3(
    { ...input, segment: { ...input.segment, references, guides, guidedPrompt: mapped } },
    { allowEmptyGuides: true },
  );
  const definitions = subjects.map((s) => {
    const instance = planning.instances.find((i: any) => i.instanceId === s.id);
    const entity =
      instance &&
      planning.records.find(
        (d: any) => d.id === instance.entity.id && d.revision === instance.entity.revision,
      );
    const name = entity?.data.instances.find((i: any) => i.id === s.id)?.name || s.id;
    return `${s.label}: ${name}; ${entity?.data.description || 'assigned reference content'}; same referenced content across ${s.pictures.join(', ')}.`;
  });
  const retention = subjects.map((s) => {
    const instance = planning.instances.find((i: any) => i.instanceId === s.id);
    const entity =
      instance &&
      planning.records.find(
        (d: any) => d.id === instance.entity.id && d.revision === instance.entity.revision,
      );
    const appearance =
      instance?.appearance &&
      planning.records.find(
        (d: any) => d.id === instance.appearance.id && d.revision === instance.appearance.revision,
      );
    const bindings = planning.selected.filter(
      (b: any) => b.instanceIds.includes(s.id) || `reference:${b.id}` === s.id,
    );
    const keep = [
      ...(entity?.data.fixedFeatures || []),
      ...(appearance
        ? [
            `Appearance ${appearance.data.name}: ${appearance.data.description}; ${JSON.stringify(appearance.data.features)}`,
          ]
        : []),
      ...bindings.flatMap((b: any) => b.retain),
    ];
    const allow = [
      ...(entity?.data.allowedChanges || []),
      ...bindings.flatMap((b: any) => b.allow),
    ];
    return `${s.label}: preserve assigned identity/structure: ${keep.join('; ') || bindings.map((b: any) => b.reason).join('; ')}. Allowed changes: ${allow.join('; ') || 'planned action and pose'}. ${bindings.some((b: any) => !b.inheritBackground) ? 'Do not inherit reference backgrounds unless explicitly assigned as the target scene.' : 'Use explicitly assigned environment.'}`;
  });
  for (const anchor of seedPreparation.anchors)
    definitions.push(
      `${anchor.label}: temporal composition anchor at frame ${anchor.resolvedFrameIndex}; ${render(anchor.instruction)}`,
    );
  for (const shot of planning.shots)
    if (shot.state) {
      const subjectName = (id: string) => subjects.find((s) => s.id === id)?.label || id;
      const relations = (values: any[]) =>
        values
          .map(
            (r) =>
              `${subjectName(r.objectId)} ${r.type} ${subjectName(r.targetId)} at ${r.anchor || 'assigned region'}, count ${r.quantity}, maximum ${r.maxQuantity}`,
          )
          .join('; ');
      const poses = (values: any[]) =>
        values
          .map(
            (p) =>
              `${subjectName(p.instanceId)} at scene (${p.position.x}, ${p.position.y}), body heading ${p.heading} degrees, ${p.phase}`,
          )
          .join('; ');
      const layout = planning.records.find(
        (d: any) => d.id === shot.state.layout?.id && d.revision === shot.state.layout?.revision,
      );
      const camera = layout?.data.cameras.find((c: any) => c.id === shot.state.cameraId);
      retention.push(
        `Shot ${shot.id}: anatomical attachment anchors belong to the subject, independent of screen left/right. Start relationships: ${relations(shot.state.startRelations)}. End relationships: ${relations(shot.state.endRelations)}. Start state: ${poses(shot.state.start)}. End state: ${poses(shot.state.end)}. Expected action: ${shot.state.action}. ${camera ? `Camera ${camera.name}: scene (${camera.position.x}, ${camera.position.y}), heading ${camera.heading}, ${camera.framing}. Scene coordinates use top-left origin, x right, y down, heading clockwise from north. ${shot.state.cameraIntent}` : ''}`,
      );
    }
  const finalPrompt = [
    `subject_definitions:\n${definitions.join('\n')}`,
    `summary:\n${mapped.summary}`,
    `retention_analysis:\n${retention.join('\n')}`,
    `detailed_description:\n${mapped.detailedDescription}`,
    `overall_soundscape:\n${mapped.overallSoundscape}`,
    `non_diegetic_music:\n${mapped.nonDiegeticMusic}`,
  ].join('\n\n');
  return { ...seedPreparation, rulesVersion: 'h3-reference-writing-v2', subjects, finalPrompt };
}
