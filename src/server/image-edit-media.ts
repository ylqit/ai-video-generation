import path from 'node:path';
import fs from 'node:fs/promises';
import { config, inside } from './config.js';
import { runProcess, ingestAsset, hashFile } from './media.js';
import type { Store } from './db.js';
import type { Job } from '../shared/contracts.js';

export async function imageEditGuide(root: string, job: Job) {
  const p = job.input.imageEdit,
    original = job.input.assets.find(
      (a: any) => a.asset.id === p.source.id && a.asset.revision === p.source.revision,
    )?.asset;
  if (!original || (await hashFile(inside(root, original.data.path))) !== original.data.sha256)
    throw new Error('局部重绘原图依据变化');
  const dir = inside(root, `jobs/${job.id}/image-edit`);
  await fs.mkdir(dir, { recursive: true });
  const output = path.join(dir, 'guide.png'),
    b = p.box;
  await runProcess(config.ffmpeg, [
    '-y',
    '-i',
    inside(root, original.data.path),
    '-vf',
    `drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=green:t=4`,
    '-frames:v',
    '1',
    output,
  ]);
  await runProcess(config.ffmpeg, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    `color=black:s=${original.data.width}x${original.data.height}`,
    '-vf',
    `drawbox=x=${b.x}:y=${b.y}:w=${b.width}:h=${b.height}:color=white:t=fill`,
    '-frames:v',
    '1',
    path.join(dir, 'mask.png'),
  ]);
  return output;
}
export async function compositeImageEdit(
  store: Store,
  root: string,
  job: Job,
  rawFile: string,
  index: number,
  signal?: AbortSignal,
) {
  const p = job.input.imageEdit,
    b = p.box,
    original = job.input.assets.find(
      (a: any) => a.asset.id === p.source.id && a.asset.revision === p.source.revision,
    ).asset;
  const dir = path.dirname(rawFile),
    output = path.join(dir, `composited-${index}.png`);
  const source = await ingestAsset(store, root, job.projectId!, rawFile, {
    name: `局部重绘原始响应 ${index + 1}`,
    category: 'image_edit_raw',
    jobId: job.id,
    sourceAssetIds: [original.id],
  });
  // Copy decoded RGBA bytes, including alpha. Overlay filters may premultiply transparent pixels.
  const width = original.data.width,
    height = original.data.height,
    baseFile = path.join(dir, `base-${index}.rgba`),
    editFile = path.join(dir, `patch-${index}.rgba`);
  await runProcess(
    config.ffmpeg,
    [
      '-y',
      '-i',
      inside(root, original.data.path),
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      baseFile,
    ],
    { signal },
  );
  await runProcess(
    config.ffmpeg,
    [
      '-y',
      '-i',
      rawFile,
      '-vf',
      `scale=${width}:${height}`,
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      editFile,
    ],
    { signal },
  );
  const base = await fs.readFile(baseFile),
    patch = await fs.readFile(editFile);
  if (base.length !== width * height * 4 || patch.length !== base.length)
    throw new Error('重绘像素尺寸不一致');
  for (let y = b.y; y < b.y + b.height; y++) {
    const start = (y * width + b.x) * 4;
    patch.copy(base, start, start, start + b.width * 4);
  }
  await fs.writeFile(baseFile, base);
  await runProcess(
    config.ffmpeg,
    [
      '-y',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      '-s',
      `${width}x${height}`,
      '-i',
      baseFile,
      '-frames:v',
      '1',
      output,
    ],
    { signal },
  );
  for (const name of ['guide', 'mask']) {
    const file = inside(root, `jobs/${job.id}/image-edit/${name}.png`);
    if (
      (await fs.access(file).then(
        () => true,
        () => false,
      )) &&
      !store.db
        .prepare(
          "SELECT id FROM documents WHERE kind='asset' AND json_extract(data,'$.jobId')=? AND json_extract(data,'$.category')=?",
        )
        .get(job.id, 'image_edit_' + name)
    )
      await ingestAsset(store, root, job.projectId!, file, {
        name: `局部重绘${name === 'guide' ? '引导图' : '蒙版'}`,
        category: 'image_edit_' + name,
        jobId: job.id,
        sourceAssetIds: [original.id],
      });
  }
  return { file: output, sourceId: source.id };
}
