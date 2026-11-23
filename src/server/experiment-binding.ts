import { HttpError, type Store } from './db.js';
import { fixedSeriesRecord } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import { selectionMedia } from './selection-splice.js';

// Checks one already compiled input. This annotation cannot grant media approval
// or enqueue work; it travels through the original scope preview/submit contract.
export function bindExperimentInput(
  store: Store,
  input: any,
  binding: { id: string; revision: number; digest: string; caseId: string },
) {
  const doc = fixedSeriesRecord(
    store,
    store.get(input.episode.id).projectId,
    binding,
    'validation_experiment',
  );
  const preparation = doc.data.preparation,
    definition = preparation.cases.find((c: any) => c.id === binding.caseId);
  if (binding.digest !== preparation.digest || !definition)
    throw new HttpError(409, '实验版本或案例不符');
  if (preparation.blockers.length)
    throw new HttpError(409, '实验固定条件尚未就绪：' + preparation.blockers.join('；'));
  for (const ref of preparation.dependencies) {
    fixedSeriesRecord(store, doc.projectId, ref);
    if (store.get(ref.id).revision !== ref.revision)
      throw new HttpError(409, '实验素材或模型选择已变化，请建立新准备版本');
  }
  if (
    input.modelExecution?.digest !== preparation.model?.digest ||
    input.segment.mode !== 'ref2va' ||
    input.segment.duration !== 10 ||
    input.width !== 1024 ||
    input.height !== 576 ||
    input.seed !== definition.seed
  )
    throw new HttpError(409, '实验固定模型、模式、时长、画布或种子不一致');
  if (
    store
      .jobs(doc.projectId)
      .some(
        (j) => j.input.experiment?.id === doc.id && j.input.experiment?.caseId === definition.id,
      )
  )
    throw new HttpError(409, '该实验案例已有尝试；保留原结果，不自动追加');
  const assets = (input.assets || []).map((a: any) => a.asset);
  const slots = input.referenceBindingPlan?.bindings || [];
  for (const role of definition.requiredAssets.filter(
    (r: string) => !r.startsWith('adopted_boundary:'),
  )) {
    const expected = preparation.assets.find((a: any) => a.role === role);
    if (
      !expected ||
      !assets.some(
        (a: any) =>
          a.id === expected.asset.id &&
          a.revision === expected.asset.revision &&
          a.data.sha256 === expected.sha256,
      )
    )
      throw new HttpError(409, `实验素材 ${role} 尚未实际绑定模型输入`);
    if (
      !slots.some(
        (b: any) =>
          b.asset.id === expected.asset.id &&
          b.asset.revision === expected.asset.revision &&
          (role.startsWith('identity:')
            ? b.role === 'reference_image' &&
              b.purpose
                .split(',')
                .map((s: string) => s.trim())
                .includes('identity')
            : b.role === 'time_guide' && b.frame === 0),
      )
    )
      throw new HttpError(409, `实验素材 ${role} 的身份槽或首帧 Guide 职责不符`);
  }
  if (
    definition.family === 'identity' &&
    definition.condition === 'A' &&
    slots.some(
      (b: any) =>
        b.role === 'reference_image' &&
        b.purpose
          .split(',')
          .map((s: string) => s.trim())
          .includes('identity'),
    )
  )
    throw new HttpError(409, '身份实验 A 不得额外接入身份槽');
  for (const before of definition.dependsOn) {
    const attempt = doc.data.attempts.find((a: any) => a.caseId === before);
    if (!attempt?.selection) throw new HttpError(409, '前段尚无实际采用边界，不自动补生成');
    const selection = fixedSeriesRecord(
      store,
      doc.projectId,
      attempt.selection,
      'segment_selection',
    );
    if (!selection.data.boundary?.end) throw new HttpError(409, '前段采用结束状态尚未确认');
    if (
      !input.continuation?.dependencies?.some(
        (r: any) => r.id === selection.id && r.revision === selection.revision,
      )
    )
      throw new HttpError(409, '后段未消费本次实验前段的固定采用状态');
    if (definition.requiredAssets.includes(`adopted_boundary:${before}`)) {
      const part = selectionMedia(selection.data).at(-1)!;
      if (
        !slots.some((b: any) => {
          if (b.role !== 'time_guide' || b.frame !== 0) return false;
          const source = assets.find(
            (a: any) => a.id === b.asset.id && a.revision === b.asset.revision,
          )?.data.derivedSource;
          return (
            source?.media?.id === part.video.id &&
            source.media.revision === part.video.revision &&
            source.frameIndex === Math.round(part.out * 24) - 1
          );
        })
      )
        throw new HttpError(409, '后段首帧未实际接入采用边界派生图');
    }
  }
  const annotation = {
    ...binding,
    caseId: definition.id,
    controls: preparation.controls,
    inputDigest: generationDigest(input),
  };
  return {
    ...input,
    experiment: annotation,
    dependencies: [...(input.dependencies || []), { id: doc.id, revision: doc.revision }],
  };
}
