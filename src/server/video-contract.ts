import { prepareShot } from '../shared/directing.js';
import { HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';
import { projectShotBrief } from './creative-brief.js';
import { validateShotSemantics } from '../shared/shot-semantics.js';

// Matches the shared renderer's actual text consumption, separate from geometric checks.
export function stagedShotConsumption(specs: any[]) {
  return specs.flatMap((s: any) => [
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
    ...['staging', 'paths', 'doors', 'axis', 'proxies', 'performance.headHeading'].map((field) => ({
      shotId: s.shotId,
      source: s.directing.authoringSource,
      field: `directing.${field}`,
      status: 'planning_check',
      consumers: ['previs', 'actual_media_review'],
    })),
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
      reason: 'Authoring rationale or production management; not provider execution content.',
    })),
  ]);
}

// Model-independent validation and scope projection; no transport or prompt grammar.
export function prepareVideoContract(
  input: any,
  options: { ref: boolean; universal: boolean; seriesMode: boolean },
) {
  const { ref, universal, seriesMode } = options;
  const brief = input.creativeBrief;
  if (!brief) throw new HttpError(409, '缺少固定制作规范');
  const { digest, ...content } = brief;
  if (generationDigest(content) !== digest) throw new HttpError(400, '固定制作规范摘要不匹配');
  const specs = input.planning.shots.map((s: any) => prepareShot(s, input.planning.records));
  for (const s of specs)
    for (const line of s.directing?.sound?.dialogue || []) {
      if (line.requireVoiceIdentity && (!line.production || line.production === 'native'))
        throw new HttpError(
          409,
          '当前视频适配器没有接入固定声音条件；锁定声音需要明确选择导入或 TTS 配音路线',
        );
    }
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
      if (!usage) throw new HttpError(400, `参考 ${binding.id} 缺少明确用途`);
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
        referenceChecks.push({
          bindingId: binding.id,
          shotId: s.id,
          status: conflicts.length
            ? usage.stateException
              ? 'reviewed_exception'
              : 'conflict_advisory'
            : 'no_declared_conflict',
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

  if (!specs.length || specs.some((s: any) => !s.directing?.execution.action))
    throw new HttpError(400, '每个镜头需要明确的 directing.execution.action');

  return { ...options, brief, specs, staged, projection, activeBindings, referenceChecks };
}
