import { z } from 'zod';

export const mouthObservationFields = {
  mouthObserved: z.enum(['visible', 'occluded', 'out_of_frame', 'unknown']).optional(),
  mouthInspected: z.boolean().optional(),
  mouthWindows: z
    .array(
      z.object({
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        lipSyncReviewed: z.boolean(),
      }),
    )
    .optional(),
};

/** Coordinates are actual source frames for candidate review, output frames for replacement audio. */
export function mouthReviewIssues(evidence: any, start: number, end: number): string[] {
  const errors: string[] = [];
  if (
    evidence.mouthInspected !== true ||
    !evidence.mouthObserved ||
    evidence.mouthObserved === 'unknown'
  )
    errors.push('实际嘴部可见性尚未检查');
  const windows = [...(evidence.mouthWindows || [])].sort(
    (a: any, b: any) => a.startFrame - b.startFrame,
  );
  if (
    evidence.mouthObserved === 'visible' &&
    (!windows.length ||
      windows.some(
        (w: any, i: number) =>
          w.startFrame < start ||
          w.endFrame > end ||
          w.endFrame <= w.startFrame ||
          !w.lipSyncReviewed ||
          (i > 0 && w.startFrame < windows[i - 1].endFrame),
      ))
  )
    errors.push('需要核对每个实际可见区间的口型，区间不得越界或重叠');
  if (evidence.mouthObserved !== 'visible' && windows.length) errors.push('可见区间与观察结果矛盾');
  return errors;
}
