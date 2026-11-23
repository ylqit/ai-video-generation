import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express } from 'express';
import { Store, HttpError } from './db.js';
import { config, inside } from './config.js';
import { hashFile, runProcess } from './media.js';
import type { Job } from '../shared/contracts.js';

export function scheduleMediaPreview(
  store: Store,
  projectId: string,
  ref: { id: string; revision: number },
) {
  const a = store.get(ref.id, ref.revision);
  if (a.projectId !== projectId || a.kind !== 'asset' || a.data.fileCleared)
    throw new HttpError(400, '素材不可预览');
  const key = 'media_preview:' + a.id + ':' + a.revision;
  const old = store.db.prepare('SELECT id FROM jobs WHERE idempotency_key=?').get(key);
  if (old) return store.job(String(old.id));
  return store.createJob(
    'media_process',
    projectId,
    null,
    { previewAsset: ref, dependencies: [ref], name: a.data.name + ' · 本机预览缓存' },
    key,
  );
}
export async function executeMediaPreview(
  store: Store,
  root: string,
  job: Job,
  signal: AbortSignal,
) {
  const a = store.get(job.input.previewAsset.id, job.input.previewAsset.revision),
    file = inside(root, a.data.path),
    key = 'media_preview:' + a.id + ':' + a.revision;
  if ((await hashFile(file)) !== a.data.sha256) throw new Error('预览源媒体已变化');
  store.patchJob(job.id, { state: 'running' });
  const relative = 'previews/' + a.id + '-' + a.revision + '.png',
    target = inside(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const args =
    a.data.mediaType === 'audio'
      ? [
          '-filter_complex',
          'aformat=channel_layouts=mono,showwavespic=s=640x100:colors=0x7964d9',
          '-frames:v',
          '1',
        ]
      : ['-vf', 'scale=400:300:force_original_aspect_ratio=decrease', '-frames:v', '1'];
  await runProcess(config.ffmpeg, ['-y', '-v', 'error', '-i', file, ...args, target], {
    signal,
    timeout: 300000,
  });
  store.setSetting(key, {
    state: 'ready',
    path: relative,
    kind: a.data.mediaType === 'audio' ? 'waveform' : 'poster',
    source: job.input.previewAsset,
  });
  store.patchJob(job.id, {
    state: 'succeeded',
    error: null,
    output: { preview: job.input.previewAsset },
  });
}
export function registerMediaPreviewRoutes(app: Express, store: Store, root: string) {
  app.get('/api/assets/:id/preview', (req, res) => {
    const a = store.get(
      String(req.params.id),
      req.query.revision ? Number(req.query.revision) : undefined,
    );
    if (a.kind !== 'asset') throw new HttpError(400, '不是媒体');
    const key = 'media_preview:' + a.id + ':' + a.revision,
      r = store.setting<any>(key, null);
    if (req.query.file === '1') {
      if (!r) throw new HttpError(404, '预览尚未准备');
      return res.sendFile(inside(root, r.path));
    }
    const row = store.db
      .prepare('SELECT id,state,error FROM jobs WHERE idempotency_key=?')
      .get(key);
    const [num, den] = String(
      a.data.streams?.find((s: any) => s.type === 'video')?.frameRate || '24/1',
    )
      .split('/')
      .map(Number);
    res.json({
      fps: den > 0 && num > 0 ? num / den : 24,
      duration: a.data.duration,
      state: r?.state || row?.state || 'missing',
      kind: r?.kind,
      jobId: row?.id,
      error: row?.error,
      url: r ? '/api/assets/' + a.id + '/preview?revision=' + a.revision + '&file=1' : null,
    });
  });
  app.post('/api/assets/:id/preview', (req, res) => {
    const a = store.get(String(req.params.id), Number(req.body.revision));
    res
      .status(201)
      .json(scheduleMediaPreview(store, a.projectId, { id: a.id, revision: a.revision }));
  });
}
