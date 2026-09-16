import { HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';

export function repairSourceUnchanged(source: any, head: any) {
  if (source.data.stale || head.data.staleCause !== 'plan_changed') return false;
  const content = (data: any) =>
    Object.fromEntries(
      Object.entries(data).filter(([k]) => !['stale', 'staleReason', 'staleCause'].includes(k)),
    );
  return generationDigest(content(source.data)) === generationDigest(content(head.data));
}

// Compatibility boundary: old selections are one media interval; repaired selections are
// a fixed ordered composition. Both feed the existing EDL and its duration accounting.
export function selectionMedia(data: any): any[] {
  return (
    data.composition?.parts || [
      { video: data.video, review: data.review, in: data.in, out: data.out, volume: data.volume },
    ]
  );
}

export function repairWindow(source: any, repair: any) {
  const parts = selectionMedia(source);
  const frames = parts.reduce((n, p) => n + Math.round((p.out - p.in) * 24), 0);
  if (source.composition && repair.issueSpace !== 'selected_timeline')
    throw new HttpError(400, '已经局部装配的片段需要使用采用时间线帧定位问题');
  const offset = repair.issueSpace === 'selected_timeline' ? 0 : Math.round(source.in * 24);
  const start = repair.issueRange.startFrame - offset,
    end = repair.issueRange.endFrame - offset;
  if (start < 0 || end > frames || end <= start)
    throw new HttpError(400, '问题范围必须位于原采用范围内');
  return { parts, frames, start, end };
}

export function spliceSelection(source: any, repair: any, candidate: any, candidateBoundary: any) {
  const window = repairWindow(source.data, repair),
    before: any[] = [],
    after: any[] = [];
  let cursor = 0;
  for (const part of window.parts) {
    const length = Math.round((part.out - part.in) * 24),
      end = cursor + length;
    if (cursor < window.start)
      before.push({ ...part, out: part.in + (Math.min(end, window.start) - cursor) / 24 });
    if (end > window.end)
      after.push({ ...part, in: part.in + (Math.max(cursor, window.end) - cursor) / 24 });
    cursor = end;
  }
  const parts = [...before, ...selectionMedia(candidate), ...after];
  const totalFrames = parts.reduce((n, p) => n + Math.round((p.out - p.in) * 24), 0);
  const boundarySide = (data: any, side: string) => ({
    ...data[side],
    source: data[side].source || data.source,
  });
  return {
    composition: {
      version: 1,
      sourceSelection: repair.sourceSelection,
      issueSpace: repair.issueSpace || 'source_frames',
      issueRange: repair.issueRange,
      parts,
      totalFrames,
    },
    candidateBoundary,
    boundary: {
      startFrame: 0,
      endFrame: totalFrames,
      coordinateSpace: 'selected_timeline',
      start: boundarySide(before.length ? source.data.boundary : candidateBoundary, 'start'),
      end: boundarySide(after.length ? source.data.boundary : candidateBoundary, 'end'),
    },
  };
}
