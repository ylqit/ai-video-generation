import { assertAssistantMaySubmit } from './assistant-usage.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from './db.js';
import type { Job } from '../shared/contracts.js';
import { modelAvailable } from '../shared/models.js';
import { generationDigest } from './h3-guided.js';
import { speechContext } from './speech-transport.js';
import { hashFile, runProcess, ingestAsset, probeMedia } from './media.js';
import { inside, config } from './config.js';

export async function executeLipSync(
  store: Store,
  root: string,
  job: Job,
  signal: AbortSignal,
  request: typeof fetch,
) {
  if (!job.projectId) throw new Error('口型任务缺少作品归属');
  const e = job.input.modelExecution,
    dir = inside(root, `jobs/${job.id}/lipsync`);
  await fs.mkdir(dir, { recursive: true });
  const ctx = speechContext(
    store,
    e.connection,
    e.modelId,
    job.id,
    {
      checkpoint: {},
      saveCheckpoint() {},
      receiptDir: ['queued', 'unknown', 'submitting'].includes(job.state)
        ? path.join(dir, 'exchanges')
        : undefined,
      replayOnly: ['unknown', 'submitting'].includes(job.state),
      beforeSubmit() {
        if (job.state === 'queued') assertAssistantMaySubmit(store, job);
      },
    },
    signal,
    request,
  );
  if (job.state === 'archiving') {
    const native = path.join(dir, 'result.mp4');
    if (
      !job.output.downloadSha256 ||
      !(await fs.access(native).then(
        () => true,
        () => false,
      ))
    ) {
      const response = await request(job.output.descriptor.url, {
        redirect: 'error',
        signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
      });
      if (!response.ok) throw new Error(`口型归档失败 HTTP ${response.status}；保留任务身份`);
      const file = await fs.open(native, 'w');
      let size = 0;
      try {
        if (response.body)
          for await (const chunk of response.body as any) {
            size += chunk.length;
            if (size > 512 * 1024 ** 2) throw new Error('口型输出超过 512 MB');
            await file.write(chunk);
          }
      } finally {
        await file.close();
      }
      store.patchJob(job.id, {
        output: { ...store.job(job.id).output, downloadSha256: await hashFile(native) },
      });
    } else if ((await hashFile(native)) !== job.output.downloadSha256)
      throw new Error('已下载口型结果哈希不符');
    const probe = await probeMedia(native),
      frames = job.input.range.outFrame - job.input.range.inFrame;
    const existing = store
      .list('asset', job.projectId)
      .find((a) => a.data.jobId === job.id && a.data.category === 'lipsync_source');
    const source =
      existing ||
      (await ingestAsset(store, root, job.projectId, native, {
        name: job.input.name + '／原始输出',
        category: 'lipsync_source',
        jobId: job.id,
        episodeId: job.episodeId,
        sourceAssetIds: [job.input.video.id, job.input.audio.id],
      }));
    const working = path.join(dir, 'working.mp4');
    await runProcess(
      config.ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-i',
        native,
        '-vf',
        'fps=24',
        '-c:v',
        'libx264',
        '-c:a',
        'aac',
        working,
      ],
      { signal },
    );
    const adopted = store
      .list('asset', job.projectId)
      .find((a) => a.data.jobId === job.id && a.data.category === 'lipsync_candidate');
    const candidate =
      adopted ||
      (await ingestAsset(store, root, job.projectId, working, {
        name: job.input.name,
        category: 'lipsync_candidate',
        jobId: job.id,
        episodeId: job.episodeId,
        sourceAssetIds: [source.id, job.input.video.id, job.input.audio.id],
        timeBase: {
          version: 1,
          source: { id: source.id, revision: source.revision },
          mapping: 'preserve playback speed',
          sourceTimestamps: [],
          workingFramesPerSecond: 24,
          playbackRate: 1,
          converted: true,
        },
      }));
    if (store.job(job.id).output.waitSuspended) return;
    store.patchJob(job.id, {
      state: 'succeeded',
      error: null,
      output: {
        ...store.job(job.id).output,
        sourceAssetId: source.id,
        videoAssetId: candidate.id,
        assetIds: [candidate.id],
        reviewState: 'unreviewed',
        timing: {
          requestedFrames: frames,
          actualFrames: candidate.data.frameCount,
          originalDuration: probe.duration,
          conforms: candidate.data.frameCount === frames,
        },
      },
    });
    return;
  }
  if (['submitted', 'running'].includes(job.state)) {
    if (Date.now() - (job.output.lastCheckedAt || 0) < 1000) return;
    const id = job.output.remoteId;
    if (!id) throw new Error('缺少原 Sync 身份');
    const { data } = await ctx.call('/v2/generate/' + encodeURIComponent(id));
    if (store.job(job.id).output.waitSuspended) return;
    if (data?.id !== id) throw new Error('Sync 查询身份不匹配');
    if (['FAILED', 'REJECTED', 'NO_OP'].includes(data.status)) {
      store.patchJob(job.id, {
        state: 'failed',
        error: `Sync ${data.status}：${data.error || '未产生新候选'}`,
      });
      return;
    }
    if (data.status === 'COMPLETED') {
      const url = new URL(data.outputUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Sync 媒体地址无效');
      store.patchJob(job.id, {
        state: 'archiving',
        output: { ...job.output, descriptor: { url: data.outputUrl }, remoteStatus: data.status },
      });
    } else
      store.patchJob(job.id, {
        state: 'running',
        output: { ...job.output, remoteStatus: data.status, lastCheckedAt: Date.now() },
      });
    return;
  }
  if (job.state === 'queued') {
    if (job.input.take) {
      const take = store.get(job.input.take.id),
        ep = store.get(job.episodeId!);
      const line = ep.data.shots
        ?.find((s: any) => s.id === take.data.shotId)
        ?.directing?.sound?.dialogue?.find((l: any) => l.id === take.data.lineId);
      if (
        take.data.stale ||
        !line ||
        line.text !== take.data.actualText ||
        generationDigest(line.voiceProfile) !== generationDigest(take.data.voice)
      ) {
        store.patchJob(job.id, { holdReason: 'dependencies_need_review' });
        return;
      }
    }
    store.patchJob(job.id, { state: 'preparing' });
    for (const asset of [job.input.video, job.input.audio])
      if ((await hashFile(inside(root, asset.data.path))) !== asset.data.sha256)
        throw new Error('口型固定输入哈希已变化');
    const models = (await ctx.call('/v2/models')).data;
    const entries = Array.isArray(models) ? models : models?.models || models?.data;
    if (!Array.isArray(entries) || !entries.some((m: any) => (m.id || m.name || m) === e.modelId))
      throw new Error('账户未报告所选 Sync 模型；未自动切换');
    const seconds = (job.input.range.outFrame - job.input.range.inFrame) / 24;
    await runProcess(
      config.ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-i',
        inside(root, job.input.video.data.path),
        '-ss',
        String(job.input.range.inFrame / 24),
        '-t',
        String(seconds),
        '-an',
        '-vf',
        'fps=24',
        '-c:v',
        'libx264',
        path.join(dir, 'video.mp4'),
      ],
      { signal },
    );
    await runProcess(
      config.ffmpeg,
      [
        '-y',
        '-v',
        'error',
        '-i',
        inside(root, job.input.audio.data.path),
        '-af',
        `atrim=start=${job.input.audioRange?.in ?? job.input.take.data.in}:end=${job.input.audioRange?.out ?? job.input.take.data.out},asetpts=PTS-STARTPTS,apad`,
        '-t',
        String(seconds),
        '-ac',
        '1',
        '-ar',
        '24000',
        '-c:a',
        'pcm_s16le',
        path.join(dir, 'audio.wav'),
      ],
      { signal },
    );
  }
  const form = new FormData();
  form.set('model', e.modelId);
  form.set('options', JSON.stringify(job.input.requestOptions));
  for (const [field, ext, type] of [
    ['video', 'mp4', 'video/mp4'],
    ['audio', 'wav', 'audio/wav'],
  ])
    form.set(
      field,
      new Blob([new Uint8Array(await fs.readFile(path.join(dir, `${field}.${ext}`)))], { type }),
      `${field}.${ext}`,
    );
  if (job.state === 'queued') {
    const current = store.job(job.id),
      connection = store.db
        .prepare('SELECT data FROM model_connections WHERE id=?')
        .get(e.connection.id);
    if (current.cancelRequested) {
      store.patchJob(job.id, { state: 'cancelled' });
      return;
    }
    if (!connection || !modelAvailable(JSON.parse(String(connection.data)), e.modelId)) {
      store.patchJob(job.id, { state: 'queued', holdReason: 'model_connection_disabled' });
      return;
    }
    await fs.writeFile(path.join(dir, 'input.json'), JSON.stringify(job.input, null, 2));
    store.patchJob(job.id, { state: 'submitting', output: { ...job.output, executionDir: dir } });
  }
  const { data } = await ctx.call('/v2/generate', undefined, {
    form,
    headers: { 'Idempotency-Key': job.id },
  });
  if (!data?.id) throw new Error('Sync 未返回任务 ID；不重新提交');
  store.patchJob(job.id, {
    state: store.job(job.id).output.waitSuspended ? 'cancelled' : 'submitted',
    promptId: data.id,
    output: { ...store.job(job.id).output, remoteId: data.id, remoteStatus: data.status },
    error: null,
  });
}
