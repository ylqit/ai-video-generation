import { Store, HttpError } from './db.js';
import { fixedSeriesRecord } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import { mouthReviewIssues } from '../shared/mouth-review.js';
import type { RecordDoc } from '../shared/contracts.js';

// Shared validation uses actual output coordinates, including scope exports.
export function validateDeliveryAudio(
  store: Store,
  ep: RecordDoc,
  edl: any,
  clips: any[],
  frames: number,
) {
  const refs: any[] = [],
    warnings: string[] = [];
  for (const a of edl.audio) {
    fixedSeriesRecord(store, ep.projectId, { id: a.assetId, revision: a.revision }, 'asset');
    refs.push({ id: a.assetId, revision: a.revision });
    if (a.dialogueTake) {
      const take = fixedSeriesRecord(store, ep.projectId, a.dialogueTake, 'dialogue_take');
      refs.push(a.dialogueTake);
      if (
        take.parentId !== ep.id ||
        take.data.asset.id !== a.assetId ||
        take.data.asset.revision !== a.revision ||
        take.data.in !== a.in ||
        take.data.out !== a.out ||
        (take.data.sampleRange &&
          generationDigest(take.data.sampleRange) !== generationDigest(a.sampleRange))
      )
        throw new HttpError(400, '对白采用与实际音轨不符');
      const shot = ep.data.shots.find((s: any) => s.id === take.data.shotId),
        line = shot?.directing?.sound.dialogue.find((l: any) => l.id === take.data.lineId);
      if (
        !line ||
        line.text !== take.data.actualText ||
        generationDigest(line.voiceProfile) !== generationDigest(take.data.voice)
      )
        warnings.push('对白素材与当前台词或声音版本不符');
      const overlap = clips.filter(
        (c: any) =>
          c.startFrame < Math.ceil((a.start + a.out - a.in) * 24 - 1e-8) &&
          c.endFrame > Math.round(a.start * 24),
      );
      if (a.originalAudio !== 'muted' || overlap.some((c: any) => c.volume > 0))
        warnings.push('替换对白与原片声音重叠；可以静音原片或另行准备需要保留的声音');
      if (shot?.directing?.contractRevision === 2 && line?.delivery === 'onscreen')
        warnings.push(
          ...mouthReviewIssues(
            a,
            Math.round(a.start * 24),
            Math.ceil((a.start + a.out - a.in) * 24 - 1e-8),
          ).map((e) => `替换对白：${e}`),
        );
      else if (
        !['offscreen', 'voiceover'].includes(line?.delivery || 'onscreen') &&
        a.lipSyncReviewed !== true
      )
        warnings.push('画内替换对白尚未检查口型');
    }
    if (a.start + a.out - a.in > frames / 24 + 1e-8)
      throw new HttpError(400, '声音超出实际交付时间线');
  }
  return { refs, warnings };
}
