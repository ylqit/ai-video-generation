import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inside, config } from './config.js';
import { ingestAsset, probeMedia, extractOriginalAudio, hashFile, runProcess } from './media.js';
import type { Store } from './db.js';
import type { Job } from '../shared/contracts.js';

// Shared archival lifecycle. Transport supplies bytes; adoption and review remain separate.
export async function archiveVideoCandidate(
  store: Store,
  root: string,
  job: Job,
  owner: string,
  download: () => Promise<Response>,
  signal?: AbortSignal,
) {
  if (!job.projectId) throw new Error('视频归档需要项目归属');
  const dir = inside(root, `jobs/${job.id}/runs/${owner}`);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'result.mp4');
  const nativeApi = job.input.modelExecution && job.input.modelExecution.protocol !== 'comfy-h3';
  let video = job.output.videoAssetId
    ? store.get(job.output.videoAssetId)
    : store
        .list('asset', job.projectId)
        .find((a) => a.data.jobId === job.id && a.data.category === 'generated');
  if (!video) {
    const original = nativeApi
      ? store
          .list('asset', job.projectId)
          .find((a) => a.data.jobId === job.id && a.data.category === 'provider_original')
      : null;
    if (original) {
      if ((await hashFile(inside(root, original.data.path))) !== original.data.sha256)
        throw new Error('原始媒体哈希变化');
      await fs.copyFile(inside(root, original.data.path), file);
    } else {
      const response = await download();
      if (!response.body) throw new Error('视频下载没有响应体');
      let bytes = 0;
      const limit = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          if (bytes > 512 * 1024 * 1024) done(new Error('视频超过 512 MB 下载限制'));
          else done(null, chunk);
        },
      });
      const partial = file + '.part';
      await pipeline(Readable.fromWeb(response.body as any), limit, createWriteStream(partial), {
        signal,
      });
      signal?.throwIfAborted();
      await fs.rename(partial, file);
    }
    const info = await probeMedia(file);
    if (info.mediaType !== 'video' || !info.duration) throw new Error('输出不是有效视频');
    let workFile = file;
    let source = original;
    let timeBase: any;
    if (nativeApi) {
      source ||= await ingestAsset(store, root, job.projectId, file, {
        name: `${job.input.segment.id} · 供应商原始媒体`,
        category: 'provider_original',
        jobId: job.id,
        episodeId: job.episodeId,
        sourceAssetIds: job.input.assets.map((a: any) => a.asset.id),
      });
      const frames =
        JSON.parse(
          await runProcess(
            config.ffprobe,
            [
              '-v',
              'error',
              '-select_streams',
              'v:0',
              '-show_entries',
              'frame=best_effort_timestamp_time',
              '-of',
              'json',
              file,
            ],
            { signal },
          ),
        ).frames || [];
      const timestamps = frames.map((f: any) => Number(f.best_effort_timestamp_time));
      if (!timestamps.length || timestamps.some((t: number) => !Number.isFinite(t)))
        throw new Error('无法固定源视频时间映射');
      const is24 =
        timestamps.length > 1 &&
        timestamps
          .slice(1)
          .every((t: number, i: number) => Math.abs(t - timestamps[i] - 1 / 24) < 0.0001);
      if (!is24) {
        workFile = path.join(dir, 'working-24fps.mp4');
        await runProcess(
          config.ffmpeg,
          [
            '-y',
            '-v',
            'error',
            '-i',
            file,
            '-map',
            '0:v:0',
            '-map',
            '0:a?',
            '-vf',
            'fps=24',
            '-c:v',
            'libx264',
            '-crf',
            '16',
            '-pix_fmt',
            'yuv420p',
            '-c:a',
            'copy',
            '-movflags',
            '+faststart',
            workFile,
          ],
          { signal, timeout: 120000 },
        );
      }
      timeBase = {
        version: 1,
        source: { id: source.id, revision: source.revision },
        mapping: 'timestamp',
        sourceTimestamps: timestamps,
        workingFramesPerSecond: 24,
        playbackRate: 1,
        converted: !is24,
      };
    }
    video = await ingestAsset(store, root, job.projectId, workFile, {
      name: `${job.input.name || job.input.segment.id} · 候选`,
      category: 'generated',
      jobId: job.id,
      episodeId: job.episodeId,
      prompt: job.input.prepared?.finalPrompt || job.input.segment.prompt,
      sourceAssetIds: [
        ...job.input.assets.map((a: any) => a.asset.id),
        ...(source ? [source.id] : []),
      ],
      ...(timeBase ? { timeBase } : {}),
    });
  }
  store.patchJob(job.id, {
    output: { ...store.job(job.id).output, videoAssetId: video.id },
  });
  const existing = store.list('asset', job.projectId).filter((a) => a.data.jobId === job.id);
  const last = existing.find((a) => a.data.category === 'keyframe');
  let audio = existing.find((a) => a.data.category === 'original_audio');
  if (video.data.hasAudio && !audio) {
    const file = await extractOriginalAudio(inside(root, video.data.path), dir, signal);
    audio = await ingestAsset(store, root, job.projectId, file, {
      name: '原始音轨',
      category: 'original_audio',
      jobId: job.id,
      episodeId: job.episodeId,
      sourceAssetIds: [video.id],
      derivedSource: {
        jobId: job.id,
        media: { id: video.id, revision: video.revision },
        kind: 'audio',
        frameIndex: null,
        interval: null,
        parameters: { codec: 'pcm_s16le' },
      },
    });
    await fs
      .unlink(file)
      .catch((e) => store.event(job.id, 'media_cleanup_warning', { error: e.message }));
  }
  const metadata = await probeMedia(inside(root, video.data.path));
  const reviewFrames = store.job(job.id).output.reviewFrames;
  store.patchJob(job.id, {
    output: {
      ...store.job(job.id).output,
      mediaCheck: {
        frameCount: metadata.frameCount,
        duration: metadata.duration,
        width: metadata.width,
        height: metadata.height,
        expectedFrameCount: job.input.prepared?.frameCount,
        frameCountMatches: metadata.frameCount === job.input.prepared?.frameCount,
        streams: metadata.streams,
        visualReview: 'pending',
      },
    },
  });
  store.patchJob(job.id, {
    state: store.job(job.id).cancelRequested ? 'cancelled' : 'succeeded',
    output: {
      ...store.job(job.id).output,
      assetIds: [
        video.id,
        ...(last ? [last.id] : []),
        ...(audio ? [audio.id] : []),
        ...(reviewFrames || []).map((f: any) => f.assetId),
      ],
    },
    error: null,
  });
}
