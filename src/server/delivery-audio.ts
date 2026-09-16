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
    blockers: string[] = [];
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
        take.data.out !== a.out
      )
        throw new HttpError(400, '对白采用与实际音轨不符');
      const shot = ep.data.shots.find((s: any) => s.id === take.data.shotId),
        line = shot?.directing?.sound.dialogue.find((l: any) => l.id === take.data.lineId);
      if (
        !line ||
        line.text !== take.data.actualText ||
        generationDigest(line.voiceProfile) !== generationDigest(take.data.voice)
      )
        blockers.push('对白素材与当前台词或声音版本不符');
      const overlap = clips.filter(
        (c: any) =>
          c.startFrame < Math.round((a.start + a.out - a.in) * 24) &&
          c.endFrame > Math.round(a.start * 24),
      );
      if (a.originalAudio !== 'muted' || overlap.some((c: any) => c.volume > 0))
        blockers.push('替换对白必须静音重叠原片声音；需保留其他声音时先准备独立音轨');
      if (shot?.directing?.contractRevision === 2 && line?.delivery === 'onscreen')
        blockers.push(
          ...mouthReviewIssues(
            a,
            Math.round(a.start * 24),
            Math.round((a.start + a.out - a.in) * 24),
          ).map((e) => `替换对白：${e}`),
        );
      else if (
        !['offscreen', 'voiceover'].includes(line?.delivery || 'onscreen') &&
        a.lipSyncReviewed !== true
      )
        blockers.push('画内替换对白需要单独审核口型');
    }
    if (Math.round((a.start + a.out - a.in) * 24) > frames) blockers.push('声音超出实际交付时间线');
  }
  return { refs, blockers };
}
