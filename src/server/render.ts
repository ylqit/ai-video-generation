import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  edlSchema,
  type EditDecisionList,
  type RecordDoc,
  clipDuration,
} from '../shared/contracts.js';
import { config, inside } from './config.js';
import { hashFile, probeMedia, runProcess } from './media.js';

export interface RenderPart {
  key: string;
  path: string;
  sha256: string;
  frames: number;
  kind: 'video' | 'audio';
}
export interface RenderCheckpoint {
  version: 1;
  digest: string;
  parts: RenderPart[];
}
export interface RenderCheckpointOptions {
  previous?: RenderCheckpoint;
  save: (value: RenderCheckpoint) => void;
}
export function renderPlan(edl: EditDecisionList) {
  edlSchema.parse(edl);
  if (edl.schemaVersion !== 2) throw new Error('分块渲染需要 v2 时间线');
  const blocks: { startFrame: number; endFrame: number; clips: EditDecisionList['clips'] }[] = [];
  let frame = 0;
  for (let i = 0; i < edl.clips.length; i += 12) {
    const clips = edl.clips.slice(i, i + 12),
      startFrame = frame;
    frame += clips.reduce((n, c) => n + Math.round(clipDuration(c) * 24), 0);
    blocks.push({ startFrame, endFrame: frame, clips });
  }
  return { blocks, frames: frame };
}

// All temporary writes belong to this execution directory. Only the lease-checked
// checkpoint callback publishes parts; a stale process cannot replace adopted parts.
export async function renderTimeline(
  edl: EditDecisionList,
  assets: RecordDoc[],
  root: string,
  output: string,
  signal?: AbortSignal,
  options?: RenderCheckpointOptions,
) {
  const plan = renderPlan(edl),
    dir = path.dirname(output);
  await fs.mkdir(dir, { recursive: true });
  const free = await fs.statfs(dir);
  const estimate = Math.max(256 * 1024 ** 2, (plan.frames / 24) * 2 * 1024 ** 2);
  if (free.bavail * free.bsize < estimate) throw new Error('长片渲染磁盘空间不足');
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        renderer: 'frame-render-v1',
        edl,
        assets: assets.map((a) => [a.id, a.revision, a.data.sha256]),
      }),
    )
    .digest('hex');
  const checkpoint: RenderCheckpoint = {
    version: 1,
    digest,
    parts: options?.previous?.digest === digest ? [...options.previous.parts] : [],
  };
  const asset = (id: string, revision: number) => {
    const a = assets.find((a) => a.id === id && a.revision === revision);
    if (!a) throw new Error(`冻结媒体缺失：${id} v${revision}`);
    return a;
  };
  const cached = async (key: string, kind: RenderPart['kind'], frames: number) => {
    signal?.throwIfAborted();
    const p = checkpoint.parts.find((p) => p.key === key && p.kind === kind && p.frames === frames);
    if (!p) return null;
    try {
      const file = inside(root, p.path);
      if ((await hashFile(file)) === p.sha256) return file;
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    checkpoint.parts = checkpoint.parts.filter((p) => p.key !== key);
    return null;
  };
  const publish = async (key: string, kind: RenderPart['kind'], file: string, frames: number) => {
    signal?.throwIfAborted();
    const m = await probeMedia(file);
    if (kind === 'video' && m.frameCount !== frames)
      throw new Error(`渲染块帧数不符 ${key}: ${m.frameCount}/${frames}`);
    if (kind === 'audio' && Math.abs(m.duration - frames / 24) > 1 / 48000 + 1e-5)
      throw new Error(`音频块长度不符 ${key}`);
    const p = { key, kind, path: path.relative(root, file), sha256: await hashFile(file), frames };
    signal?.throwIfAborted();
    checkpoint.parts = [...checkpoint.parts.filter((p) => p.key !== key), p];
    options?.save({ ...checkpoint, parts: [...checkpoint.parts] });
    return file;
  };
  const execute = (args: string[]) =>
    runProcess(config.ffmpeg, ['-y', '-v', 'error', ...args], { signal, timeout: 60 * 60 * 1000 });
  const videoFiles: string[] = [],
    audioFiles: string[] = [];
  for (const [index, block] of plan.blocks.entries()) {
    const frames = block.endFrame - block.startFrame,
      key = `video-${index}`;
    let video = await cached(key, 'video', frames);
    if (!video) {
      video = path.join(dir, `${key}.mp4`);
      const args: string[] = [],
        filters: string[] = [];
      for (const [i, c] of block.clips.entries()) {
        const a = asset(c.assetId, c.revision),
          count = Math.round(clipDuration(c) * 24);
        if (a.data.mediaType === 'image') args.push('-loop', '1', '-framerate', '24');
        args.push(
          '-ss',
          String(c.in),
          '-t',
          String(clipDuration(c)),
          '-i',
          inside(root, a.data.path),
        );
        filters.push(
          `[${i}:v]scale=${edl.width}:${edl.height}:force_original_aspect_ratio=decrease,pad=${edl.width}:${edl.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24,trim=end_frame=${count},setpts=N/(24*TB),format=yuv420p[v${i}]`,
        );
      }
      filters.push(
        `${block.clips.map((_, i) => `[v${i}]`).join('')}concat=n=${block.clips.length}:v=1:a=0[v]`,
      );
      await execute([
        ...args,
        '-filter_complex_threads',
        '1',
        '-filter_complex',
        filters.join(';'),
        '-map',
        '[v]',
        '-an',
        '-frames:v',
        String(frames),
        '-c:v',
        'libx264',
        '-threads',
        '2',
        '-preset',
        'fast',
        '-crf',
        '20',
        '-g',
        '48',
        '-keyint_min',
        '48',
        '-sc_threshold',
        '0',
        '-video_track_timescale',
        '24000',
        video,
      ]);
      await publish(key, 'video', video, frames);
    }
    videoFiles.push(video);
    const audioKey = `audio-${index}`;
    let audio = await cached(audioKey, 'audio', frames);
    if (!audio) {
      // Every stem has block length. Absolute offsets keep envelopes unchanged at block boundaries.
      const clips: { c: EditDecisionList['audio'][number]; offset: number }[] = [];
      let cursor = block.startFrame / 24;
      for (const c of block.clips) {
        if (asset(c.assetId, c.revision).data.hasAudio)
          clips.push({ c: { ...c, start: cursor }, offset: cursor });
        cursor += clipDuration(c);
      }
      for (const c of edl.audio)
        if (c.start < block.endFrame / 24 && c.start + clipDuration(c) > block.startFrame / 24)
          clips.push({ c, offset: c.start });
      const stems: string[] = [];
      for (let group = 0; group < Math.max(1, clips.length); group += 12) {
        const stem = path.join(dir, `audio-${index}-stem-${group}.wav`),
          args: string[] = [],
          filters: string[] = [],
          labels: string[] = [];
        for (const [{ c, offset }, i] of clips
          .slice(group, group + 12)
          .map((c, i) => [c, i] as const)) {
          const start = Math.max(offset, block.startFrame / 24),
            end = Math.min(offset + clipDuration(c), block.endFrame / 24),
            sourceOffset = start - offset;
          args.push(
            '-ss',
            String(c.in + sourceOffset),
            '-t',
            String(end - start),
            '-i',
            inside(root, asset(c.assetId, c.revision).data.path),
          );
          const fi = (c.fadeInFrames || 0) / 24,
            fo = (c.fadeOutFrames || 0) / 24;
          const expression = `${c.volume}*max(0,min(1,min(${fi ? `(t+${sourceOffset})/${fi}` : '1'},${fo ? `(${clipDuration(c)}-t-${sourceOffset})/${fo}` : '1'})))`;
          filters.push(
            `[${i}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,aeval='val(0)*${expression}|val(1)*${expression}',adelay=${Math.round((start - block.startFrame / 24) * 48000)}S:all=1,apad,atrim=end_sample=${frames * 2000}[a${i}]`,
          );
          labels.push(`[a${i}]`);
        }
        if (labels.length)
          filters.push(
            `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest[a]`,
          );
        else filters.push(`anullsrc=r=48000:cl=stereo,atrim=end_sample=${frames * 2000}[a]`);
        await execute([
          ...args,
          '-filter_complex_threads',
          '1',
          '-filter_complex',
          filters.join(';'),
          '-map',
          '[a]',
          '-c:a',
          'pcm_f32le',
          stem,
        ]);
        stems.push(stem);
      }
      // Bounded fan-in also applies to many overlapping external audio tracks.
      let level = 0,
        current = stems;
      while (current.length > 1) {
        const next: string[] = [];
        for (let i = 0; i < current.length; i += 12) {
          const group = current.slice(i, i + 12),
            mixed = path.join(dir, `mix-${index}-${level}-${i}.wav`);
          await execute([
            ...group.flatMap((f) => ['-i', f]),
            '-filter_complex',
            `${group.map((_, n) => `[${n}:a]`).join('')}amix=inputs=${group.length}:normalize=0:duration=longest[a]`,
            '-map',
            '[a]',
            '-c:a',
            'pcm_f32le',
            mixed,
          ]);
          next.push(mixed);
        }
        current = next;
        level++;
      }
      audio = current[0];
      await publish(audioKey, 'audio', audio, frames);
    }
    audioFiles.push(audio);
  }
  const lists = [videoFiles, audioFiles].map((_, i) => path.join(dir, `concat-${i}.txt`));
  const signatures = [];
  for (const file of videoFiles) {
    const metadata = JSON.parse(
      await runProcess(config.ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_name,profile,width,height,pix_fmt,time_base,r_frame_rate',
        '-of',
        'json',
        file,
      ]),
    );
    signatures.push(JSON.stringify(metadata.streams[0]));
  }
  if (new Set(signatures).size !== 1) throw new Error('渲染块编码参数或时间基不一致，不能直接拼接');
  for (let i = 0; i < lists.length; i++)
    await fs.writeFile(
      lists[i],
      [videoFiles, audioFiles][i]
        .map((f) => `file '${f.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`)
        .join('\n'),
    );
  signal?.throwIfAborted();
  const overlayFilters: string[] = [];
  if (edl.overlays?.length) {
    const candidates = process.env.STUDIO_SUBTITLE_FONT
      ? [process.env.STUDIO_SUBTITLE_FONT]
      : [
          'C:/Windows/Fonts/msyh.ttc',
          '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
          '/System/Library/Fonts/PingFang.ttc',
        ];
    let font: string | undefined;
    for (const candidate of candidates) {
      try {
        await fs.access(candidate);
        font = candidate;
        break;
      } catch (e: any) {
        if (e.code !== 'ENOENT') throw e;
      }
    }
    if (!font)
      throw new Error(
        '精确图文缺少字体文件，请通过 STUDIO_SUBTITLE_FONT 配置支持作品文字的字体后恢复导出',
      );
    await fs.copyFile(font, path.join(dir, 'overlay-font.ttf'));
    for (const [index, overlay] of edl.overlays.entries()) {
      await fs.writeFile(path.join(dir, `overlay-${index}.txt`), overlay.text, 'utf8');
      const y =
        overlay.position === 'top'
          ? 'h*0.08'
          : overlay.position === 'center'
            ? '(h-text_h)/2'
            : 'h*0.90-text_h';
      overlayFilters.push(
        `drawtext=fontfile=overlay-font.ttf:textfile=overlay-${index}.txt:expansion=none:fontcolor=${overlay.color}:fontsize=${overlay.fontSize}:x=(w-text_w)/2:y=${y}:enable='gte(n,${overlay.startFrame})*lt(n,${overlay.endFrame})'`,
      );
    }
  }
  await runProcess(
    config.ffmpeg,
    [
      '-y',
      '-v',
      'error',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      lists[0],
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      lists[1],
      '-map',
      '0:v',
      '-map',
      '1:a',
      ...(overlayFilters.length
        ? ['-vf', overlayFilters.join(','), '-c:v', 'libx264', '-pix_fmt', 'yuv420p']
        : ['-c:v', 'copy']),
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-t',
      String(plan.frames / 24),
      '-movflags',
      '+faststart',
      output,
    ],
    { signal, cwd: dir, timeout: 60 * 60 * 1000 },
  );
  const result = await probeMedia(output);
  if (result.frameCount !== plan.frames)
    throw new Error(`成片帧数不符：${result.frameCount}/${plan.frames}`);
  return result;
}
