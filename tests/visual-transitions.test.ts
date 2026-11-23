import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, prepareData } from '../src/server/config.js';
import { runProcess, hashFile } from '../src/server/media.js';
import { renderTimeline, type RenderCheckpoint } from '../src/server/render.js';
import { edlSchema, type RecordDoc } from '../src/shared/contracts.js';

test('actual cross-block dissolve, visual fades, independent J/L audio and recovered export share frame coordinates', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-v3-render-'));
  prepareData(root);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const assets: RecordDoc[] = [];
  for (const color of ['red', 'blue']) {
    const file = path.join(root, color + '.png');
    await runProcess(config.ffmpeg, [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=${color}:s=128x128`,
      '-frames:v',
      '1',
      file,
    ]);
    assets.push({
      id: color,
      revision: 1,
      kind: 'asset',
      projectId: 'p',
      parentId: null,
      createdAt: 0,
      updatedAt: 0,
      data: { mediaType: 'image', path: color + '.png', sha256: await hashFile(file) },
    });
  }
  const sound = path.join(root, 'tone.wav');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=3',
    sound,
  ]);
  assets.push({
    id: 'tone',
    revision: 1,
    kind: 'asset',
    projectId: 'p',
    parentId: null,
    createdAt: 0,
    updatedAt: 0,
    data: { mediaType: 'audio', path: 'tone.wav', sha256: await hashFile(sound) },
  });
  const edl = edlSchema.parse({
    schemaVersion: 3,
    episodeId: 'e',
    width: 128,
    height: 128,
    fps: 24,
    clips: [
      {
        id: 'left',
        assetId: 'red',
        revision: 1,
        in: 0,
        out: 13,
        volume: 0,
        visualFadeInFrames: 24,
      },
      {
        id: 'right',
        assetId: 'blue',
        revision: 1,
        in: 0,
        out: 13,
        volume: 0,
        transition: { kind: 'dissolve', fromClipId: 'left', frames: 48 },
        visualFadeOutFrames: 24,
      },
    ],
    audio: [{ assetId: 'tone', revision: 1, in: 0, out: 3, start: 11, volume: 1 }],
    overlays: [],
  });
  let checkpoint: RenderCheckpoint | undefined;
  await assert.rejects(
    renderTimeline(edl, assets, root, path.join(root, 'interrupted', 'out.mp4'), undefined, {
      save: (c) => {
        checkpoint = c;
        throw new Error('checkpoint interruption');
      },
    }),
    /interruption/,
  );
  const first = checkpoint!.parts[0];
  const out = path.join(root, 'resumed', 'out.mp4');
  const metadata = await renderTimeline(edl, assets, root, out, undefined, {
    previous: checkpoint,
    save: (c) => {
      checkpoint = c;
    },
  });
  assert.equal(metadata.frameCount, 576);
  assert.equal(checkpoint!.parts[0].sha256, first.sha256);
  const pixels = path.join(root, 'pixels.raw');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    out,
    '-vf',
    "select='eq(n,0)+eq(n,264)+eq(n,288)+eq(n,312)+eq(n,575)',scale=1:1",
    '-fps_mode',
    'vfr',
    '-f',
    'rawvideo',
    '-pix_fmt',
    'rgb24',
    pixels,
  ]);
  const b = await fs.readFile(pixels);
  assert.equal(b.length, 15);
  assert.ok(Math.max(...b.subarray(0, 3)) < 12, 'first frame fades from black');
  assert.ok(b[3] > 230 && b[5] < 20, 'dissolve starts on left');
  assert.ok(b[6] > 95 && b[6] < 155 && b[8] > 95 && b[8] < 155, 'block boundary has both inputs');
  assert.ok(b[9] < 20 && b[11] > 230, 'dissolve completes on right');
  assert.ok(Math.max(...b.subarray(12, 15)) < 12, 'last frame fades to black');
  const pcm = path.join(root, 'audio.raw');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    out,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '48000',
    '-f',
    'f32le',
    pcm,
  ]);
  const bytes = await fs.readFile(pcm);
  const rms = (seconds: number) => {
    let sum = 0;
    const from = Math.round(seconds * 48000);
    for (let i = 0; i < 4800; i++) {
      const v = bytes.readFloatLE((from + i) * 4);
      sum += v * v;
    }
    return Math.sqrt(sum / 4800);
  };
  assert.ok(rms(10) < 0.001);
  assert.ok(rms(11.5) > 0.05);
  assert.ok(rms(12.5) > 0.05);
  assert.ok(Math.abs(rms(11.5) - rms(12.5)) < 0.005);
  assert.ok(rms(14.2) < 0.001);
});
