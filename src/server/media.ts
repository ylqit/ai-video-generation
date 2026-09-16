import { previsManifest, authoringPrevisManifest } from './previs-manifest.js';
import { generationDigest } from './h3-guided.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { config, inside } from './config.js';
import type { Store } from './db.js';
import { HttpError } from './db.js';
import { derivedSourceSchema, type DerivedSource } from '../shared/domain.js';
import { derivationKey } from './migrations.js';
import {
  clipDuration,
  timelineDuration,
  type EditDecisionList,
  type RecordDoc,
} from '../shared/contracts.js';

export function runProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    input?: string;
    signal?: AbortSignal;
    timeout?: number;
    onLine?: (text: string) => void;
  } = {},
) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: options.signal,
    });
    let stdout = '',
      stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('本机进程执行超时'));
    }, options.timeout || 120000);
    timer.unref();
    child.stdout.on('data', (d) => {
      stdout = (stdout + d.toString()).slice(-4000000);
      options.onLine?.(d.toString());
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-32000);
      options.onLine?.(d.toString());
    });
    child.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${path.basename(command)} 退出 ${code}: ${stderr.slice(-6000)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  });
}
export async function probeMedia(file: string) {
  const output = await runProcess(config.ffprobe, [
    '-v',
    'error',
    '-show_format',
    '-show_streams',
    '-of',
    'json',
    file,
  ]);
  const data = JSON.parse(output);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio');
  if (!video && !audio) throw new HttpError(400, '不是支持的图片、视频或音频');
  const image = /\.(png|jpe?g|webp)$/i.test(file);
  return {
    mediaType: (image ? 'image' : video ? 'video' : 'audio') as 'image' | 'video' | 'audio',
    duration: Number(data.format?.duration) || 0,
    width: video?.width,
    height: video?.height,
    frameCount: video?.nb_frames ? Number(video.nb_frames) : undefined,
    hasAudio: !!audio,
    streams: data.streams.map((s: any) => ({
      type: s.codec_type,
      codec: s.codec_name,
      frameRate: s.avg_frame_rate,
      sampleRate: s.sample_rate,
      channels: s.channels,
    })),
    bytes: Number(data.format?.size) || 0,
  };
}
export interface AssetImportMetadata {
  name?: string;
  category?: string;
  entityId?: string;
  variant?: string;
  sourceAssetIds?: string[];
  prompt?: string;
  jobId?: string | null;
  episodeId?: string | null;
  frameIndex?: number;
  derivedSource?: DerivedSource;
  previsualSource?: {
    version: number;
    kind: string;
    authoring?: { id: string; revision: number };
    episode: { id: string; revision: number };
    shotId: string;
    layout: { id: string; revision: number } | null;
    frame: number;
    width: number;
    height: number;
    renderer: string;
    spec: unknown;
    sampled: unknown;
  };
  production?: { taskId: string; taskRevision: number; viewId: string; deliveryId: string };
}
export async function hashFile(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function ingestAsset(
  store: Store,
  root: string,
  projectId: string,
  file: string,
  info: AssetImportMetadata,
  policy?: { exportJobId: string },
) {
  const allowed = new Set([
    'name',
    'category',
    'entityId',
    'variant',
    'sourceAssetIds',
    'prompt',
    'jobId',
    'episodeId',
    'frameIndex',
    'derivedSource',
    'previsualSource',
    'production',
  ]);
  for (const key of Object.keys(info))
    if (!allowed.has(key)) throw new HttpError(400, `素材元数据字段不支持：${key}`);
  if (
    info.frameIndex !== undefined &&
    info.derivedSource &&
    info.frameIndex !== info.derivedSource.frameIndex
  )
    throw new HttpError(400, '帧号与派生来源不一致');
  const source = info.derivedSource ? derivedSourceSchema.parse(info.derivedSource) : null;
  if (source && info.previsualSource) throw new HttpError(400, '派生来源类型不能混用');
  const previs = info.previsualSource;
  if (previs) {
    const ep = store.get(previs.episode.id, previs.episode.revision);
    if (
      ep.kind !== 'episode' ||
      ep.projectId !== projectId ||
      !['scene_previs', 'authoring_previs'].includes(previs.kind)
    )
      throw new HttpError(400, '预演来源归属或类型错误');
    if (previs.kind === 'authoring_previs' && !previs.authoring)
      throw new HttpError(400, '缺少导演预演来源');
    const expected =
      previs.kind === 'authoring_previs'
        ? authoringPrevisManifest(
            store,
            previs.authoring!.id,
            previs.authoring!.revision,
            previs.shotId,
            previs.frame,
            previs.width,
            previs.height,
          )
        : previsManifest(
            store,
            ep.id,
            ep.revision,
            previs.shotId,
            previs.frame,
            previs.width,
            previs.height,
          );
    if (
      expected.projectId !== projectId ||
      generationDigest(expected.manifest) !== generationDigest(previs)
    )
      throw new HttpError(400, '预演来源内容与固定版本不符');
  }
  const identity = source
    ? derivationKey(source)
    : previs
      ? 'previs:' + createHash('sha256').update(JSON.stringify(previs)).digest('hex')
      : null;
  if (source) {
    const parent = store.get(source.media.id, source.media.revision);
    if (parent.kind !== 'asset' || parent.projectId !== projectId)
      throw new HttpError(400, '派生媒体来源不属于本项目');
    const existing = store.db
      .prepare('SELECT asset_id FROM derivations WHERE project_id=? AND identity=?')
      .get(projectId, identity!);
    if (existing) return store.get(String(existing.asset_id));
  }
  const stat = await fs.stat(file);
  let limit = 512 * 1024 * 1024;
  if (policy) {
    const job = store.job(policy.exportJobId);
    const runRoot = inside(root, `jobs/${job.id}/runs`);
    if (
      job.kind !== 'export' ||
      job.projectId !== projectId ||
      info.jobId !== job.id ||
      info.category !== 'export' ||
      !path.resolve(file).startsWith(runRoot + path.sep)
    )
      throw new HttpError(400, '内部成片归档来源不匹配');
    limit = 2 * 1024 ** 3;
  }
  if (stat.size > limit)
    throw new HttpError(400, policy ? '内部成片上限 2 GiB' : '单素材上限 512 MB');
  const space = await fs.statfs(root);
  if (space.bavail * space.bsize < stat.size + 64 * 1024 ** 2)
    throw new HttpError(507, '素材归档磁盘空间不足');
  const ext = path.extname(file).toLowerCase();
  if (
    ![
      '.png',
      '.jpg',
      '.jpeg',
      '.webp',
      '.mp4',
      '.mov',
      '.webm',
      '.wav',
      '.mp3',
      '.m4a',
      '.ogg',
      '.flac',
    ].includes(ext)
  )
    throw new HttpError(400, '不支持的素材扩展名');
  const metadata = await probeMedia(file);
  if (
    previs &&
    (metadata.mediaType !== 'image' ||
      metadata.width !== previs.width ||
      metadata.height !== previs.height)
  )
    throw new HttpError(400, '预演图片格式或尺寸与清单不符');
  const sha256 = await hashFile(file);
  const relative = `assets/${sha256}${ext}`;
  const dest = inside(root, relative);
  const temporary = inside(root, `assets/.incoming-${randomUUID()}${ext}`);
  try {
    await fs.copyFile(file, temporary, 1);
    try {
      await fs.link(temporary, dest);
    } catch (e: any) {
      if (e.code !== 'EEXIST') throw e;
      if ((await hashFile(dest)) !== sha256)
        throw new HttpError(409, '已存在的媒体内容与哈希不符，请检查存储；拒绝覆盖历史资产');
    }
  } finally {
    await fs.unlink(temporary).catch((e: any) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }
  return store.transaction(() => {
    if (policy) {
      const existing = store
        .list('asset', projectId)
        .find((a) => a.data.jobId === policy.exportJobId && a.data.category === 'export');
      if (existing) {
        if (existing.data.sha256 !== sha256)
          throw new HttpError(409, '此导出任务已经归档了不同内容');
        return existing;
      }
    }
    if (info.production) {
      const p = info.production;
      const existing = store
        .list('asset', projectId)
        .find(
          (a) =>
            a.data.production?.taskId === p.taskId &&
            a.data.production?.taskRevision === p.taskRevision &&
            a.data.production?.deliveryId === p.deliveryId &&
            a.data.production?.viewId === p.viewId,
        );
      if (existing) {
        if (existing.data.sha256 !== sha256)
          throw new HttpError(409, '同一交付视图已关联不同文件，请使用新的交付标识');
        return existing;
      }
    }
    if (identity) {
      const existing = store.db
        .prepare('SELECT asset_id FROM derivations WHERE project_id=? AND identity=?')
        .get(projectId, identity);
      if (existing) {
        const prior = store.get(String(existing.asset_id));
        if (previs && prior.data.sha256 !== sha256)
          throw new HttpError(409, '同一预演来源已关联不同图片');
        return prior;
      }
    }
    const asset = store.create(
      'asset',
      projectId,
      {
        ...metadata,
        name: info.name || path.basename(file),
        category: info.category || 'reference',
        entityId: info.entityId || randomUUID(),
        variant: info.variant || '默认',
        path: relative,
        sha256,
        adopted: false,
        sourceAssetIds: info.sourceAssetIds || [],
        prompt: info.prompt || '',
        jobId: info.jobId || null,
        ...(source
          ? { derivedSource: source, derivationKey: identity, frameIndex: source.frameIndex }
          : {}),
        ...(info.frameIndex !== undefined ? { frameIndex: info.frameIndex } : {}),
        ...(previs ? { previsualSource: previs, derivationKey: identity } : {}),
        ...(info.production ? { production: info.production } : {}),
      },
      info.episodeId || projectId,
    );
    if (identity)
      store.db
        .prepare('INSERT INTO derivations VALUES(?,?,?,?)')
        .run(projectId, identity, asset.id, JSON.stringify(source || previs));
    return asset;
  });
}
export function exportArgs(
  edl: EditDecisionList,
  assets: RecordDoc[],
  root: string,
  output: string,
) {
  const args = ['-y', '-v', 'error'];
  const filters: string[] = [];
  const labels: string[] = [];
  let index = 0;
  for (const clip of edl.clips) {
    const a = assets.find((a) => a.id === clip.assetId && a.revision === clip.revision)!;
    const duration = clipDuration(clip);
    if (a.data.mediaType === 'image') args.push('-loop', '1', '-t', String(duration));
    else args.push('-ss', String(clip.in), '-t', String(duration));
    args.push('-i', inside(root, a.data.path));
    filters.push(
      `[${index}:v]scale=${edl.width}:${edl.height}:force_original_aspect_ratio=decrease,pad=${edl.width}:${edl.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${edl.fps},trim=duration=${duration},setpts=PTS-STARTPTS,format=yuv420p[v${index}]`,
    );
    if (a.data.hasAudio)
      filters.push(
        `[${index}:a]atrim=duration=${duration},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${clip.volume},apad,atrim=duration=${duration}[a${index}]`,
      );
    else
      filters.push(
        `anullsrc=r=48000:cl=stereo,atrim=duration=${duration},asetpts=PTS-STARTPTS[a${index}]`,
      );
    labels.push(`[v${index}][a${index}]`);
    index++;
  }
  filters.push(`${labels.join('')}concat=n=${edl.clips.length}:v=1:a=1[vout][baseaudio]`);
  const audioLabels = ['[baseaudio]'];
  for (const clip of edl.audio) {
    const a = assets.find((a) => a.id === clip.assetId && a.revision === clip.revision)!;
    const duration = clipDuration(clip);
    args.push('-ss', String(clip.in), '-t', String(duration), '-i', inside(root, a.data.path));
    filters.push(
      `[${index}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${clip.volume},adelay=${Math.round(clip.start * 1000)}:all=1[external${index}]`,
    );
    audioLabels.push(`[external${index}]`);
    index++;
  }
  filters.push(
    `${audioLabels.join('')}amix=inputs=${audioLabels.length}:duration=longest:normalize=0,apad,atrim=duration=${timelineDuration(edl)}[aout]`,
  );
  return [
    ...args,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'fast',
    '-crf',
    '20',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    output,
  ];
}
export async function exportMovie(
  edl: EditDecisionList,
  assets: RecordDoc[],
  root: string,
  output: string,
  signal?: AbortSignal,
  checkpoint?: import('./render.js').RenderCheckpointOptions,
) {
  if (edl.schemaVersion === 2) {
    const { renderTimeline } = await import('./render.js');
    return renderTimeline(edl, assets, root, output, signal, checkpoint);
  }
  await runProcess(config.ffmpeg, exportArgs(edl, assets, root, output), {
    timeout: 60 * 60 * 1000,
    signal,
  });
  return probeMedia(output);
}
export async function extractOriginalAudio(file: string, dir: string, signal?: AbortSignal) {
  const audio = path.join(dir, 'original-audio.wav');
  await runProcess(
    config.ffmpeg,
    ['-y', '-v', 'error', '-i', file, '-vn', '-c:a', 'pcm_s16le', audio],
    { signal },
  );
  return audio;
}
