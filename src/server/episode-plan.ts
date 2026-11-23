import { HttpError, type Store } from './db.js';
import { creationSettingsSchema, inferDurationIntent } from '../shared/creation.js';
import type { EffectiveEpisodePlan, PredecessorStatus } from '../shared/production-plan.js';
import { resolveSeries, episodeRuntime, predecessorCanon } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import type { RecordDoc } from '../shared/contracts.js';

// A single requirements projection for writing, preparation and delivery. It never
// changes the series plan or promotes an authored result into confirmed facts.
export function effectiveEpisodePlan(
  store: Store,
  episode: RecordDoc,
  request = '',
): EffectiveEpisodePlan {
  const settings = store.list('creation_settings', episode.projectId)[0];
  const policy = creationSettingsSchema.parse(settings?.data.policy || {});
  const inferred = inferDurationIntent(request);
  const plan: EffectiveEpisodePlan = {
    version: 1,
    episode: { id: episode.id, revision: episode.revision },
    series: null,
    slotId: null,
    duration: policy.duration.mode === 'derive' ? inferred : policy.duration,
    runtime: null,
    canvas: {
      width: policy.output.width,
      height: policy.output.height,
      mismatch: policy.output.mismatch || 'require_match',
    },
    origins: {
      duration:
        policy.duration.mode === 'derive' && inferred.mode !== 'derive' ? 'request' : 'project',
      canvas: 'project',
    },
    dependencies: settings ? [{ id: settings.id, revision: settings.revision }] : [],
    warnings: [],
  };
  if (!episode.data.seriesProduction) return plan;
  const { series, production } = resolveSeries(store, episode);
  const slot = production.slots.find((s) => s.id === episode.data.seriesProduction.slotId)!;
  const runtime = episodeRuntime(store, episode);
  plan.series = { id: series.id, revision: series.revision };
  plan.slotId = slot.id;
  plan.runtime = runtime;
  plan.duration = runtime.toleranceFrames
    ? {
        mode: 'approximate',
        seconds: runtime.targetFrames / 24,
        tolerancePercent: (100 * runtime.toleranceFrames) / runtime.targetFrames,
      }
    : { mode: 'exact', seconds: runtime.targetFrames / 24 };
  plan.origins.duration = episode.data.seriesProduction.runtime
    ? 'episode'
    : slot.runtime
      ? 'slot'
      : 'series';
  const canvas = episode.data.seriesProduction.canvas || production.canvas;
  if (canvas) {
    plan.canvas = canvas;
    plan.origins.canvas = episode.data.seriesProduction.canvas ? 'episode' : 'series';
  }
  plan.dependencies.push(plan.series);
  if (inferred.mode !== 'derive' && Math.round(inferred.seconds * 24) !== runtime.targetFrames)
    plan.warnings.push(
      `文字中的整集时长 ${inferred.seconds} 秒与已确认计划 ${runtime.targetFrames / 24} 秒不同；以计划为准，请在系列规划中比较并修改。`,
    );
  return plan;
}

export function episodePredecessor(store: Store, episode: RecordDoc): PredecessorStatus {
  if (!episode.data.seriesProduction)
    return {
      status: 'independent',
      canon: null,
      waiting: null,
      hypothetical: false,
      reason: '非系列作品',
    };
  const { production } = resolveSeries(store, episode);
  const dependency = episode.data.seriesProduction.factDependency || production.factDependency;
  if (dependency?.mode === 'independent')
    return {
      status: 'independent',
      canon: null,
      waiting: null,
      hypothetical: false,
      reason: dependency.reason,
    };
  const chain = predecessorCanon(store, episode, true);
  return {
    status: chain.waiting ? 'waiting' : chain.canon ? 'confirmed' : 'starting_point',
    canon: chain.canon ? { id: chain.canon.id, revision: chain.canon.revision } : null,
    waiting: chain.waiting,
    hypothetical: !!chain.waiting,
    reason: chain.waiting
      ? '允许假设稿；依赖该事实的正式准备等待确认'
      : '按本系列直接前置确认链读取',
  };
}

export function assertEpisodePlanCurrent(store: Store, run: RecordDoc) {
  if (!run.data.effectivePlan) return; // Historical runs retain their original contract.
  const current = effectiveEpisodePlan(store, store.get(run.data.episodeId), run.data.request);
  if (!current.series && current.origins.duration === 'request')
    current.duration = run.data.duration;
  const requirements = (p: EffectiveEpisodePlan) => ({
    duration: p.duration,
    canvas: p.canvas,
    slotId: p.slotId,
  });
  if (
    generationDigest(requirements(current)) !==
    generationDigest(requirements(run.data.effectivePlan))
  )
    throw new HttpError(
      409,
      '本集有效制作要求已变化；请比较并修订创作依据后重新准备，历史任务保留原规格',
    );
}
