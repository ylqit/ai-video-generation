import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from './db.js';
import { config, inside } from './config.js';
import { hashFile, ingestAsset, runProcess } from './media.js';
import type { Job } from '../shared/contracts.js';
import type { MediaOperation } from '../shared/node-operations.js';
import { executeMediaPreview } from './media-preview.js';

export async function executeMediaOperation(
  store: Store,
  root: string,
  job: Job,
  signal: AbortSignal,
) {
  if (job.input.previewAsset) return executeMediaPreview(store, root, job, signal);
  const op = job.input.nodeOperation as MediaOperation,
    source = job.input.assets[0];
  const file = inside(root, source.data.path),
    dir = inside(root, `jobs/${job.id}/processing`);
  if ((await hashFile(file)) !== source.data.sha256) throw new Error('固定源媒体哈希不匹配');
  await fs.mkdir(dir, { recursive: true });
  store.patchJob(job.id, { state: 'running', error: null });
  const outputs: Record<string, string> = { ...store.job(job.id).output.processed };
  const run = async (slot: string, ext: string, args: string[], label: string) => {
    if (outputs[slot]) return store.get(outputs[slot]);
    signal.throwIfAborted();
    const output = path.join(dir, slot + ext);
    await runProcess(
      config.ffmpeg,
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', file, ...args, output],
      { signal, timeout: 600000 },
    );
    signal.throwIfAborted();
    const asset = await ingestAsset(store, root, job.projectId!, output, {
      name: label,
      category: 'derived',
      sourceAssetIds: [source.id],
      jobId: job.id,
      episodeId: job.episodeId,
      processingSource: {
        version: 1,
        jobId: job.id,
        action: op.action,
        sources: [{ id: source.id, revision: source.revision }],
        parameters: op,
      },
    });
    outputs[slot] = asset.id;
    store.patchJob(job.id, {
      output: { ...store.job(job.id).output, processed: outputs, assetIds: Object.values(outputs) },
    });
    return asset;
  };
  const video = [
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-movflags',
    '+faststart',
  ];
  const range = ['-ss', String(op.start), '-t', String(op.end! - op.start)];
  if (op.action === 'grid') {
    for (let row = 0; row < op.rows; row++)
      for (let col = 0; col < op.columns; col++) {
        const x = Math.floor((col * source.data.width) / op.columns),
          y = Math.floor((row * source.data.height) / op.rows),
          w = Math.floor(((col + 1) * source.data.width) / op.columns) - x,
          h = Math.floor(((row + 1) * source.data.height) / op.rows) - y;
        await run(
          `cell-${row + 1}-${col + 1}`,
          '.png',
          ['-vf', `crop=${w}:${h}:${x}:${y}`, '-frames:v', '1'],
          `${source.data.name} ${row + 1}行${col + 1}列`,
        );
      }
  } else if (op.action === 'crop' || op.action === 'mark') {
    const b = op.box!;
    const filter =
      op.action === 'crop'
        ? `crop=${b.width}:${b.height}:${b.x}:${b.y}`
        : `drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=0x${op.color.slice(1)}:t=${op.thickness}`;
    await run(
      'image',
      '.png',
      ['-vf', filter, '-frames:v', '1'],
      `${source.data.name} · ${op.action === 'crop' ? '裁剪' : '标记'}`,
    );
  } else if (op.action === 'frame') {
    let frame = op.frame === 'first' ? 0 : op.frame;
    if (frame === 'last') {
      let count = source.data.frameCount;
      if (!count) {
        const result = JSON.parse(
          await runProcess(
            config.ffprobe,
            [
              '-v',
              'error',
              '-count_frames',
              '-select_streams',
              'v:0',
              '-show_entries',
              'stream=nb_read_frames',
              '-of',
              'json',
              file,
            ],
            { signal, timeout: 600000 },
          ),
        );
        count = Number(result.streams[0].nb_read_frames);
      }
      if (!Number.isInteger(count) || count < 1) throw new Error('无法确定视频实际帧数');
      frame = count - 1;
    }
    await run(
      'frame',
      '.png',
      ['-vf', `select=eq(n\\,${frame})`, '-frames:v', '1', '-fps_mode', 'vfr'],
      `${source.data.name} · 第 ${frame} 帧`,
    );
  } else if (op.action === 'trim') {
    const audio = source.data.mediaType === 'audio';
    await run(
      'clip',
      audio ? '.wav' : '.mp4',
      [...range, ...(audio ? ['-vn', '-c:a', 'pcm_s16le'] : video)],
      `${source.data.name} · ${op.start}–${op.end}秒`,
    );
  } else if (op.action === 'speed') {
    const filters = [];
    let rate = op.rate;
    while (rate > 2) {
      filters.push('atempo=2');
      rate /= 2;
    }
    while (rate < 0.5) {
      filters.push('atempo=0.5');
      rate /= 0.5;
    }
    filters.push(`atempo=${rate}`);
    await run(
      'speed',
      '.wav',
      [...range, '-vn', '-af', filters.join(','), '-c:a', 'pcm_s16le'],
      `${source.data.name} · ${op.rate}倍速`,
    );
  } else if (op.action === 'extract_audio' || op.action === 'separate') {
    await run(
      'audio',
      '.wav',
      [...range, '-vn', '-c:a', 'pcm_s16le'],
      `${source.data.name} · 原声`,
    );
    if (op.action === 'separate')
      await run(
        'silent',
        '.mp4',
        [...range, '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'],
        `${source.data.name} · 无声视频`,
      );
  } else if (op.action === 'analyze') {
    let cuts: number[] = store.job(job.id).output.cuts;
    if (!cuts) {
      let log = '';
      await runProcess(
        config.ffmpeg,
        [
          '-hide_banner',
          '-i',
          file,
          '-an',
          '-vf',
          `select=gt(scene\\,${op.threshold}),showinfo`,
          '-f',
          'null',
          '-',
        ],
        {
          signal,
          timeout: 600000,
          onLine: (l) => {
            log = (log + l).slice(-8000000);
          },
        },
      );
      const detected = [...log.matchAll(/pts_time:([\d.]+)/g)]
        .map((m) => Number(m[1]))
        .filter((t) => t > op.start && t < op.end!);
      cuts = [op.start, ...[...new Set(detected)].slice(0, op.maxShots - 1), op.end!];
      store.patchJob(job.id, {
        output: {
          ...store.job(job.id).output,
          cuts,
          detection: {
            threshold: op.threshold,
            detectedCuts: detected.length,
            truncated: detected.length > op.maxShots - 1,
          },
        },
      });
    }
    let docId = store.job(job.id).output.analysisId;
    if (!docId) {
      const doc = store.create(
        'node_analysis',
        job.projectId!,
        {
          version: 1,
          title: `${source.data.name} · 拉片`,
          kind: 'shot_detection',
          source: { id: source.id, revision: source.revision },
          range: { start: op.start, end: op.end },
          method: 'ffmpeg-scene-score',
          threshold: op.threshold,
          shots: [],
          complete: false,
          jobId: job.id,
        },
        job.input.canvas.id,
      );
      docId = doc.id;
      store.patchJob(job.id, {
        output: { ...store.job(job.id).output, analysisId: docId, documentIds: [docId] },
      });
    }
    for (let i = 0; i < cuts.length - 1; i++) {
      const start = cuts[i],
        end = cuts[i + 1],
        time = (start + end) / 2;
      const frame = await run(
        `shot-${i}`,
        '.png',
        ['-ss', String(time), '-frames:v', '1'],
        `${source.data.name} · 镜头 ${i + 1}`,
      );
      const doc = store.get(docId),
        shots = doc.data.shots.filter((s: any) => s.index !== i);
      shots.push({
        index: i,
        start,
        end,
        sampledAt: time,
        frame: { id: frame.id, revision: frame.revision },
        description: null,
      });
      shots.sort((a: any, b: any) => a.index - b.index);
      store.update(docId, doc.revision, { ...doc.data, shots, complete: i === cuts.length - 2 });
    }
  }
  signal.throwIfAborted();
  store.patchJob(job.id, {
    state: 'succeeded',
    error: null,
    output: { ...store.job(job.id).output, assetIds: Object.values(outputs) },
  });
}
