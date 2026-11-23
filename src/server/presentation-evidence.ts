import { timelineMap } from '../shared/edit-timeline.js';
import type { EditDecisionList } from '../shared/contracts.js';
import { Store, HttpError } from './db.js';
import { selectionMedia } from './selection-splice.js';

// Source observations remain immutable. This projection describes where editing may
// obscure them, so only an actual rendered review can confirm their presentation.
export function presentationEvidence(store: Store, edl: EditDecisionList) {
  const map = timelineMap(edl),
    rows: any[] = [];
  for (const entry of map.clips) {
    const c = entry.clip;
    if (!c.selection) continue;
    const selection = store.get(c.selection.id, c.selection.revision);
    const parts = selectionMedia(selection.data);
    for (const part of parts) {
      if (part.video.id !== c.assetId || part.video.revision !== c.revision) continue;
      if (!part.review) continue;
      const review = store.get(part.review.id, part.review.revision);
      const boundary = selection.data.boundary?.end;
      const boundaryEnd = Math.round(part.out * 24);
      const windows = (boundary?.windows || []).filter(
        (w: any) => w.startFrame >= Math.round(part.in * 24) && w.endFrame <= boundaryEnd,
      );
      const boundaryEvidence =
        part === parts.at(-1) && boundary
          ? [
              {
                id: 'selection_boundary:end',
                startFrame: windows.length
                  ? Math.min(...windows.map((w: any) => w.startFrame))
                  : boundaryEnd - 1,
                endFrame: boundaryEnd,
                inspection: windows.length ? 'motion' : 'frame',
              },
            ]
          : [];
      for (const e of [
        ...(review.data.observations || []),
        ...(review.data.eventEvidence || []),
        ...(review.data.audioEvidence || []),
        ...boundaryEvidence,
      ]) {
        const from = e.startFrame ?? e.frameIndex,
          to = e.endFrame ?? from + 1;
        if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
        const startFrame = entry.startFrame + from - Math.round(c.in * 24),
          endFrame = entry.startFrame + to - Math.round(c.in * 24);
        const contained = startFrame >= entry.startFrame && endFrame <= entry.endFrame;
        const windows = [
          [entry.startFrame, entry.startFrame + entry.overlap],
          [entry.startFrame, entry.startFrame + (c.visualFadeInFrames || 0)],
          [entry.endFrame - (c.visualFadeOutFrames || 0), entry.endFrame],
          [map.clips[entry.index + 1]?.startFrame ?? entry.endFrame, entry.endFrame],
        ];
        const audio = e.inspection === 'audio' || e.actualText !== undefined;
        const overlaps = ([a, b]: number[]) => a < b && a < endFrame && b > startFrame;
        const audioWindows = [
          [entry.startFrame, entry.startFrame + (c.fadeInFrames || 0)],
          [entry.endFrame - (c.fadeOutFrames || 0), entry.endFrame],
          ...edl.audio
            .filter((a) => a.volume > 0)
            .map((a) => [Math.round(a.start * 24), Math.round((a.start + a.out - a.in) * 24)]),
        ];
        const overlayWindows = (edl.overlays || []).map((o) => [o.startFrame, o.endFrame]);
        const affected =
          !contained ||
          (audio
            ? c.volume === 0 || audioWindows.some(overlaps)
            : [...windows, ...overlayWindows].some(overlaps));
        rows.push({
          selection: c.selection,
          evidenceId: e.id || e.eventId || e.requirementId,
          media: part.video,
          startFrame,
          endFrame,
          contained,
          affected,
          inspection: e.inspection || 'frame',
        });
      }
    }
  }
  return rows;
}

export function validateCanonPresentation(
  store: Store,
  edl: EditDecisionList,
  canon: any,
  reviews: any[],
) {
  if (edl.schemaVersion !== 3) return;
  const rows = presentationEvidence(store, edl);
  const sources = [
    ...(canon.facts || []).filter((f: any) => f.source.kind === 'media').map((f: any) => f.source),
    ...[...(canon.relationSources || []), ...(canon.actionSources || [])].map((s: any) => ({
      selection: s.selection,
      evidenceIds: ['selection_boundary:end'],
    })),
  ];
  for (const source of sources) {
    const selection = store.get(source.selection.id, source.selection.revision);
    // Inherited facts retain their earlier episode's delivery evidence; do not require
    // every later episode to replay their original establishing shot.
    if (selection.parentId && selection.parentId !== edl.episodeId) continue;
    for (const id of source.evidenceIds) {
      const matches = rows.filter(
        (r) =>
          r.selection.id === source.selection.id &&
          r.selection.revision === source.selection.revision &&
          r.evidenceId === id &&
          r.contained,
      );
      if (!matches.length) throw new HttpError(409, `Canon 证据 ${id} 不在实际成片采用区间内`);
      if (
        matches.every((r) => r.affected) &&
        !reviews.some((review) =>
          review.data.presentedEvidence?.some(
            (e: any) =>
              e.selection.id === source.selection.id &&
              e.selection.revision === source.selection.revision &&
              e.evidenceId === id,
          ),
        )
      )
        throw new HttpError(409, `Canon 证据 ${id} 受转场或音轨影响，请在实际导出中重新确认呈现`);
    }
  }
}
