import { z } from 'zod';
import { versionRef } from './domain.js';
import { mouthObservationFields } from './mouth-review.js';
import { creationOverlaySchema } from './creation.js';

export const edlSchema = z
  .object({
    overlays: z.array(creationOverlaySchema).max(2000).optional(),
    schemaVersion: z.union([z.literal(2), z.literal(3)]).optional(),
    episodeId: z.string(),
    width: z
      .number()
      .int()
      .min(128)
      .max(3840)
      .refine((v) => v % 2 === 0),
    height: z
      .number()
      .int()
      .min(128)
      .max(3840)
      .refine((v) => v % 2 === 0),
    fps: z.literal(24),
    clips: z
      .array(
        z.object({
          id: z.string().min(1).optional(),
          transition: z
            .object({
              kind: z.literal('dissolve'),
              fromClipId: z.string().min(1),
              frames: z.number().int().positive(),
            })
            .strict()
            .optional(),
          visualFadeInFrames: z.number().int().nonnegative().optional(),
          visualFadeOutFrames: z.number().int().nonnegative().optional(),
          assetId: z.string(),
          revision: z.number().int().positive(),
          in: z.number().nonnegative(),
          out: z.number().positive(),
          volume: z.number().min(0).max(1),
          fadeInFrames: z.number().int().nonnegative().optional(),
          fadeOutFrames: z.number().int().nonnegative().optional(),
          selection: versionRef.optional(),
          role: z.enum(['story', 'intro', 'outro', 'recap']).optional(),
        }),
      )
      .min(1),
    audio: z.array(
      z.object({
        assetId: z.string(),
        revision: z.number().int().positive(),
        in: z.number().nonnegative(),
        out: z.number().positive(),
        start: z.number().nonnegative(),
        dialogueTake: versionRef.optional(),
        sampleRange: z
          .object({
            sampleRate: z.number().int().positive(),
            inSample: z.number().int().nonnegative(),
            outSample: z.number().int().positive(),
          })
          .optional(),
        originalAudio: z.literal('muted').optional(),
        lipSyncReviewed: z.boolean().optional(),
        ...mouthObservationFields,
        volume: z.number().min(0).max(1),
        fadeInFrames: z.number().int().nonnegative().optional(),
        fadeOutFrames: z.number().int().nonnegative().optional(),
      }),
    ),
  })
  .superRefine((edl, ctx) => {
    const frames = timelineMap(edl).frames;
    const ids = new Set<string>();
    edl.clips.forEach((c, i) => {
      const fail = (message: string) =>
        ctx.addIssue({ code: 'custom', path: ['clips', i], message });
      if (edl.schemaVersion !== 3) {
        if (c.transition || c.visualFadeInFrames || c.visualFadeOutFrames || c.id)
          fail('画面转场与片段标识需要显式 EDL v3');
        return;
      }
      if (!c.id || ids.has(c.id)) fail('v3 片段需要唯一稳定标识');
      if (c.id) ids.add(c.id);
      const count = Math.round((c.out - c.in) * 24),
        incoming = c.transition?.frames || 0,
        outgoing = edl.clips[i + 1]?.transition?.frames || 0;
      if (c.transition && (!i || c.transition.fromClipId !== edl.clips[i - 1].id))
        fail('叠化必须固定当前相邻两侧片段');
      if (incoming >= count || outgoing >= count || incoming + outgoing > count)
        fail('叠化不能耗尽片段或造成三段重叠');
      if ((c.visualFadeInFrames || 0) + (c.visualFadeOutFrames || 0) > count)
        fail('画面淡入淡出不能超过片段区间');
    });
    if (edl.overlays?.length && !edl.schemaVersion)
      ctx.addIssue({ code: 'custom', path: ['overlays'], message: '精确图文需要新版时间线' });
    if (new Set(edl.overlays?.map((o) => o.id)).size !== (edl.overlays?.length || 0))
      ctx.addIssue({ code: 'custom', path: ['overlays'], message: '图文标识重复' });
    edl.overlays?.forEach((o, i) => {
      if (o.endFrame <= o.startFrame || o.endFrame > frames)
        ctx.addIssue({
          code: 'custom',
          path: ['overlays', i],
          message: '图文区间必须位于实际成片内',
        });
    });
    for (const [track, clips] of [
      ['clips', edl.clips],
      ['audio', edl.audio],
    ] as const) {
      clips.forEach((clip, i) => {
        const samples = track === 'audio' && 'sampleRange' in clip ? clip.sampleRange : undefined;
        if (
          samples &&
          (edl.schemaVersion !== 3 ||
            samples.outSample <= samples.inSample ||
            Math.abs(clip.in - samples.inSample / samples.sampleRate) > 1e-8 ||
            Math.abs(clip.out - samples.outSample / samples.sampleRate) > 1e-8)
        )
          ctx.addIssue({
            code: 'custom',
            path: [track, i, 'sampleRange'],
            message: '采样区间需要 EDL v3 且与源音频秒坐标一致',
          });
        if (clip.out <= clip.in)
          ctx.addIssue({ code: 'custom', path: [track, i, 'out'], message: '出点必须大于入点' });
        if (edl.schemaVersion !== undefined) {
          for (const [key, v] of Object.entries(clip))
            if (
              ['in', 'out', 'start'].includes(key) &&
              !(samples && ['in', 'out'].includes(key)) &&
              typeof v === 'number' &&
              Math.abs(v * 24 - Math.round(v * 24)) > 1e-6
            )
              ctx.addIssue({
                code: 'custom',
                path: [track, i, key],
                message: '新版时间线必须使用 24 fps 整帧边界',
              });
          if (
            (clip.fadeInFrames || 0) + (clip.fadeOutFrames || 0) >
            Math.round((clip.out - clip.in) * 24)
          )
            ctx.addIssue({ code: 'custom', path: [track, i], message: '淡入淡出不能超过片段时长' });
        } else if (clip.fadeInFrames || clip.fadeOutFrames)
          ctx.addIssue({ code: 'custom', path: [track, i], message: '声音包络需要新版时间线' });
      });
    }
  });
export type EditDecisionList = z.infer<typeof edlSchema>;

// A single frame map owns overlap duration, source coordinates, playback and rendering.
// Callers validate at mutation boundaries; draft previews may contain incomplete edits.
export function timelineMap(edl: Pick<EditDecisionList, 'schemaVersion' | 'clips'>) {
  let end = 0;
  const clips = edl.clips.map((clip, index) => {
    const count = Math.round((clip.out - clip.in) * 24);
    const overlap = edl.schemaVersion === 3 ? clip.transition?.frames || 0 : 0;
    const startFrame = end - overlap;
    end = startFrame + count;
    return { clip, index, startFrame, endFrame: end, frames: count, overlap };
  });
  return { clips, frames: end };
}
export function visualLayerAt(
  entry: ReturnType<typeof timelineMap>['clips'][number],
  frame: number,
) {
  const local = frame - entry.startFrame,
    c = entry.clip;
  const active = local >= 0 && local < entry.frames;
  const gain = Math.max(
    0,
    Math.min(
      1,
      c.visualFadeInFrames ? local / Math.max(1, c.visualFadeInFrames - 1) : 1,
      c.visualFadeOutFrames
        ? (entry.frames - 1 - local) / Math.max(1, c.visualFadeOutFrames - 1)
        : 1,
    ),
  );
  return {
    active,
    opacity: active ? (entry.overlap ? Math.min(1, local / entry.overlap) : 1) : 0,
    brightness: gain,
    sourceFrame: Math.round(c.in * 24) + local,
  };
}
export function roleFrames(edl: EditDecisionList, role: string) {
  const ranges = timelineMap(edl).clips.filter((e) => (e.clip.role || 'story') === role);
  let end = 0,
    count = 0;
  for (const r of ranges) {
    count += Math.max(0, r.endFrame - Math.max(end, r.startFrame));
    end = Math.max(end, r.endFrame);
  }
  return count;
}
