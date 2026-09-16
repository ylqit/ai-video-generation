import {
  creativeModuleSchema,
  moduleCategories,
  creativeScopeSchema,
} from '../shared/creative-modules.js';
import {
  creationProfileV2Schema,
  creationProfileV3Schema,
  creationProfileV4Schema,
} from '../shared/workbench.js';
import { resolveSeries } from './series-production.js';
import { type RecordDoc } from '../shared/contracts.js';
import { Store, HttpError } from './db.js';
import { DomainService } from './domain-service.js';
import { generationDigest } from './h3-guided.js';

// Composition is deterministic and owns fixed-version resolution. It never writes records,
// executes a model, translates prose or lets a suggested world rule replace canon.
export function resolveCreativeBrief(
  store: Store,
  projectId: string,
  profile: RecordDoc,
  rawScope: unknown = {},
  requirePublished = false,
  episodeRevision?: number,
) {
  const scope = creativeScopeSchema.parse(rawScope);
  const seriesMode = profile.data.rulesVersion === 'director-v7';
  const universal = seriesMode || profile.data.rulesVersion === 'director-v6';
  const data = seriesMode
    ? creationProfileV4Schema.parse(profile.data)
    : universal
      ? creationProfileV3Schema.parse(profile.data)
      : creationProfileV2Schema.parse(profile.data);
  if (profile.kind !== 'creation_profile' || profile.projectId !== projectId)
    throw new HttpError(400, '创作配置不属于项目');
  const domain = new DomainService(store);
  // Historical context validation uses its frozen episode; current generation
  // preparation intentionally uses the head. Both retain the same scope semantics.
  const episode = scope.episodeId
    ? domain.owned(projectId, store.get(scope.episodeId, episodeRevision), 'episode')
    : undefined;
  const seriesContext =
    seriesMode && (episode || scope.seriesId)
      ? resolveSeries(store, episode || store.get(scope.seriesId!))
      : null;
  if (
    seriesContext &&
    (seriesContext.profile.id !== profile.id || seriesContext.profile.revision !== profile.revision)
  )
    throw new HttpError(409, '制作配置与系列固定版本不一致');
  if (scope.sceneId && !scope.episodeId) throw new HttpError(400, '场景例外需要明确分集');
  const sceneAliases = new Set([scope.sceneId]);
  if (scope.sceneId) {
    const ep = episode!;
    if (
      !ep.data.shots.some((s: any) => s.scene === scope.sceneId) &&
      !ep.data.dramaturgy?.scenes.some((s: any) => s.id === scope.sceneId)
    )
      throw new HttpError(400, '场景不属于指定分集');
    const sceneMatches = (ep.data.dramaturgy?.scenes || []).filter(
      (scene: any) =>
        scene.id === scope.sceneId ||
        ep.data.shots.some(
          (shot: any) => shot.scene === scope.sceneId && scene.shotIds.includes(shot.id),
        ),
    );
    if (sceneMatches.length > 1)
      throw new HttpError(400, '场景名称对应多个稳定 ID，请使用明确场景 ID');
    for (const scene of sceneMatches) {
      sceneAliases.add(scene.id);
      for (const shot of ep.data.shots.filter((s: any) => scene.shotIds.includes(s.id)))
        sceneAliases.add(shot.scene);
    }
  }
  const checks: { code: string; severity: 'blocking' | 'warning'; message: string }[] = [];
  const seen = new Set<string>();
  const modules = data.composition.moduleRefs.map((ref) => {
    const key = `${ref.id}:${ref.revision}`;
    if (seen.has(key)) throw new HttpError(400, '重复的模块版本');
    seen.add(key);
    const doc = domain.owned(projectId, ref, 'creative_module');
    if (doc.data.stale) throw new HttpError(409, `模块依据已纠正：${doc.data.name}`);
    if (!doc.data.published)
      checks.push({
        code: 'module-unpublished',
        severity: 'blocking',
        message: `模块尚未审核发布：${doc.data.name}`,
      });
    return {
      ref,
      data: creativeModuleSchema.parse(doc.data),
      digest: generationDigest(creativeModuleSchema.parse(doc.data)),
    };
  });
  const exceptions = data.composition.exceptions
    .filter(
      (e) =>
        e.scope.episodeId === scope.episodeId &&
        (!e.scope.sceneId || sceneAliases.has(e.scope.sceneId)),
    )
    .sort((a, b) => Number(!!a.scope.sceneId) - Number(!!b.scope.sceneId));
  const overrides = { ...data.composition.overrides };
  const decisions: { field: string; value: string; reason: string; source: string }[] = [];
  if (seriesContext) {
    for (const shared of seriesContext.shared) {
      for (const [field, value] of Object.entries(
        shared.data.sharedCreative ||
          (shared.kind === 'series'
            ? {
                visual: shared.data.bible?.visualStyle || '',
                world: shared.data.bible?.world || '',
                narrative: shared.data.bible?.narrativeRules || '',
              }
            : {}),
      ))
        if (
          field in overrides &&
          typeof value === 'string' &&
          !overrides[field as keyof typeof overrides]
        ) {
          overrides[field as keyof typeof overrides] = value;
          decisions.push({
            field,
            value,
            reason: '系列固定共享依据',
            source: `${shared.id}:${shared.revision}`,
          });
        }
    }
    for (const [field, value] of Object.entries(episode?.data.seriesProduction?.overrides || {}))
      if (value) {
        overrides[field as keyof typeof overrides] = String(value);
        decisions.push({
          field,
          value: String(value),
          reason: episode!.data.seriesProduction.overrideReason,
          source: episode!.id,
        });
      }
  }
  for (const e of exceptions) {
    if (!e.scope.episodeId) throw new HttpError(400, '例外需要明确分集范围');
    for (const [field, value] of Object.entries(e.overrides))
      if (value) {
        const source = JSON.stringify({
          episodeId: e.scope.episodeId,
          sceneId: e.scope.sceneId ? scope.sceneId : undefined,
        });
        if (decisions.some((d) => d.field === field && d.source === source))
          throw new HttpError(400, `同范围例外冲突：${field}`);
        overrides[field as keyof typeof overrides] = value;
        decisions.push({ field, value, reason: e.reason, source });
      }
  }
  for (const category of moduleCategories) {
    const selected = modules.filter((m) => m.data.category === category);
    if (!selected.length && !universal)
      checks.push({
        code: `missing-${category}`,
        severity: 'blocking',
        message: `缺少 ${category} 模块；可创建自定义模块`,
      });
    if (selected.length > 1 && !(category === 'visual' && overrides.mixedMedia.trim()))
      checks.push({
        code: `conflicting-${category}`,
        severity: 'blocking',
        message: `${category} 同时选中多个模块；视觉混合需明确各层用途，其他类别请合并为审核后的自定义模块`,
      });
  }
  if (universal) {
    const composition = (seriesMode ? creationProfileV4Schema : creationProfileV3Schema).parse(
      profile.data,
    ).composition;
    if (
      !modules.some((m) => m.data.category === 'visual') &&
      !overrides.visual.trim() &&
      !composition.visualReference &&
      !composition.artEntries.some((e) => e.aspect === 'style' && e.target.kind === 'global')
    )
      checks.push({
        code: 'missing-visual',
        severity: 'blocking',
        message: '需要视觉模块、明确视觉覆盖、全局画风条目或已审核视觉参考',
      });
    if (new Set(composition.artEntries.map((e) => e.id)).size !== composition.artEntries.length)
      throw new HttpError(400, '美术条目标识重复');
    for (const entry of composition.artEntries) {
      if (
        (entry.target.kind !== 'global' && !entry.target.id) ||
        (entry.target.kind === 'global' && !['style', 'material'].includes(entry.aspect))
      )
        throw new HttpError(400, '全局条目只描述画风或材质；其他条目需要明确目标');
    }
    if (composition.visualReference) {
      if (!composition.visualReference.reviewed)
        checks.push({
          code: 'visual-reference-unreviewed',
          severity: 'blocking',
          message: '视觉参考规范尚未审核',
        });
      const asset = domain.owned(projectId, composition.visualReference.asset, 'asset');
      if (!asset.data.adopted || asset.data.mediaType !== 'image')
        throw new HttpError(400, '视觉参考需要已采用图片');
    }
  }
  if (!profile.data.published)
    checks.push({
      code: 'profile-unpublished',
      severity: 'blocking',
      message: '制作规范尚未审核发布',
    });
  if (requirePublished && checks.some((c) => c.severity === 'blocking'))
    throw new HttpError(409, checks.map((c) => c.message).join('；'));
  const content = {
    schemaVersion: seriesMode ? 3 : universal ? 2 : 1,
    profile: { id: profile.id, revision: profile.revision },
    scope,
    modules,
    overrides,
    artBible: data.composition.artBible,
    ...(universal
      ? {
          artEntries: (seriesMode ? creationProfileV4Schema : creationProfileV3Schema).parse(
            profile.data,
          ).composition.artEntries,
          visualReference:
            (seriesMode ? creationProfileV4Schema : creationProfileV3Schema).parse(profile.data)
              .composition.visualReference || null,
        }
      : {}),
    decisions,
    checks,
    ...(seriesContext
      ? {
          series: { id: seriesContext.series.id, revision: seriesContext.series.revision },
          sharedReferences: seriesContext.production.sharedReferences,
        }
      : {}),
    productionConstraints: {
      goal: data.goal,
      audience: data.audience,
      targetSeconds: data.targetSeconds,
      width: data.width,
      height: data.height,
      steps: data.steps,
      sound: data.sound,
    },
    precedence: [
      'confirmed facts',
      'explicit shot design',
      'scene exception',
      'episode exception',
      'project override',
      'module suggestion',
    ],
  };
  return { ...content, digest: generationDigest(content) };
}

export function selectedProfile(
  store: Store,
  projectId: string,
  rulesVersion?: 'director-v5' | 'director-v6' | 'director-v7',
) {
  const profile = store
    .list('creation_profile', projectId)
    .filter((d) => !d.data.archived)
    .at(-1);
  if (
    !profile ||
    !['director-v5', 'director-v6', 'director-v7'].includes(profile.data.rulesVersion) ||
    (rulesVersion && profile.data.rulesVersion !== rulesVersion)
  )
    throw new HttpError(400, '请创建并审核制作配置');
  return profile;
}

export function moduleRules(brief: ReturnType<typeof resolveCreativeBrief>, stage: string) {
  return (
    brief.modules
      .map(
        (m) =>
          `[${m.data.category}: ${m.data.name} @ ${m.ref.id}:${m.ref.revision}]\n${m.data.stageRules[stage as keyof typeof m.data.stageRules]?.join('\n') || '本阶段无附加规则'}\n限制：${m.data.limitations.join('；')}`,
      )
      .join('\n\n') +
    `\n项目覆盖（不改变已确认事实）：${JSON.stringify(brief.overrides)}\n美术统一规范：${JSON.stringify(brief.schemaVersion >= 2 ? brief.artEntries : brief.artBible)}`
  );
}

// Frozen project rules -> only the stable requirements applicable to this shot.
export function projectShotBrief(brief: any, shot: any) {
  const visible: string[] = shot.directing.presence.visible;
  const instances = shot.state?.instances || [];
  const entries: any[] = [],
    decisions: any[] = [];
  for (const entry of brief.artEntries || []) {
    let reason = '';
    if (
      (entry.scope.episodeId && entry.scope.episodeId !== brief.scope.episodeId) ||
      (entry.scope.sceneId &&
        entry.scope.sceneId !== brief.scope.sceneId &&
        entry.scope.sceneId !== shot.scene) ||
      (entry.scope.shotIds.length && !entry.scope.shotIds.includes(shot.id))
    )
      reason = 'outside_scope';
    else if (entry.target.kind === 'instance' && !visible.includes(entry.target.id))
      reason = 'not_visible';
    else if (
      entry.target.kind === 'entity' &&
      !instances.some((i: any) => visible.includes(i.instanceId) && i.entity.id === entry.target.id)
    )
      reason = 'not_visible';
    else if (
      entry.target.kind === 'effect' &&
      !shot.directing.effects.some(
        (e: any) => e.source === entry.target.id || e.carrier === entry.target.id,
      )
    )
      reason = 'effect_not_used';
    else if (
      entry.when.some(
        (c: any) =>
          !(shot.state?.attributes?.start || []).some(
            (f: any) =>
              f.instanceId === c.instanceId &&
              f.key === c.key &&
              f.status === 'known' &&
              f.value === c.value,
          ),
      )
    )
      reason = 'state_not_confirmed';
    if (!reason) entries.push(entry);
    decisions.push({
      field: `artEntries.${entry.id}`,
      status: reason ? 'excluded' : 'text_request',
      reason: reason || 'applicable_stable_design',
      text: entry.text,
    });
  }
  if (Object.values(brief.artBible || {}).some(Boolean))
    decisions.push({
      field: 'artBible',
      status: 'excluded',
      reason: 'legacy_prose_requires_explicit_conversion',
    });
  return { shotId: shot.id, entries, decisions };
}
