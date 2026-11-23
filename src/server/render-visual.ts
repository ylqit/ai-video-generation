import type { EditDecisionList, RecordDoc } from '../shared/contracts.js';
import { timelineMap } from '../shared/edit-timeline.js';
import { inside } from './config.js';

// Clip-local frame expressions remain unchanged when an overlap crosses a render block.
// Audio is deliberately absent: video transitions never rewrite a dialogue envelope.
export function visualBlockInput(
  edl: EditDecisionList,
  assets: RecordDoc[],
  root: string,
  startFrame: number,
  endFrame: number,
) {
  const args: string[] = [],
    filters: string[] = [];
  const frames = endFrame - startFrame;
  filters.push(
    `color=c=black:s=${edl.width}x${edl.height}:r=24,trim=end_frame=${frames},setpts=N/(24*TB)[base]`,
  );
  const entries = timelineMap(edl).clips.filter(
    (e) => e.startFrame < endFrame && e.endFrame > startFrame,
  );
  let previous = 'base';
  for (const [i, entry] of entries.entries()) {
    const c = entry.clip,
      asset = assets.find((a) => a.id === c.assetId && a.revision === c.revision);
    if (!asset) throw new Error(`冻结转场媒体缺失：${c.assetId} v${c.revision}`);
    const from = Math.max(startFrame, entry.startFrame),
      until = Math.min(endFrame, entry.endFrame);
    const offset = from - entry.startFrame,
      relative = from - startFrame;
    if (asset.data.mediaType === 'image') args.push('-loop', '1', '-framerate', '24');
    args.push(
      '-ss',
      String(c.in + offset / 24),
      '-t',
      String((until - from) / 24),
      '-i',
      inside(root, asset.data.path),
    );
    const local = `(N+${offset})`;
    const gain = `max(0,min(1,min(${c.visualFadeInFrames ? `${local}/${Math.max(1, c.visualFadeInFrames - 1)}` : '1'},${c.visualFadeOutFrames ? `(${entry.frames - 1}-${local})/${Math.max(1, c.visualFadeOutFrames - 1)}` : '1'})))`;
    const alpha = entry.overlap ? `min(1,${local}/${entry.overlap})` : '1';
    // A hard cut has no per-pixel gain or alpha operation. Keeping an identity
    // geq here makes long timelines pay the fade computation on every frame.
    const effect =
      c.visualFadeInFrames || c.visualFadeOutFrames || entry.overlap
        ? `,geq=r='r(X,Y)*${gain}':g='g(X,Y)*${gain}':b='b(X,Y)*${gain}':a='alpha(X,Y)*${alpha}'`
        : '';
    filters.push(
      `[${i}:v]scale=${edl.width}:${edl.height}:force_original_aspect_ratio=decrease,pad=${edl.width}:${edl.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,trim=end_frame=${until - from},setpts=N/(24*TB),format=rgba${effect},setpts=PTS+${relative}/(24*TB)[layer${i}]`,
    );
    filters.push(
      `[${previous}][layer${i}]overlay=eof_action=pass:repeatlast=0:enable='gte(t,${relative / 24})*lt(t,${(until - startFrame) / 24})'[mix${i}]`,
    );
    previous = `mix${i}`;
  }
  filters.push(`[${previous}]format=yuv420p[v]`);
  return { args, filters };
}
