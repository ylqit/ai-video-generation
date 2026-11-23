import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { Store } from '../src/server/db.js';
import { prepareData, config } from '../src/server/config.js';
import { StudioService } from '../src/server/service.js';
import { CanvasService } from '../src/server/canvas.js';
import { importWorkbenchFile } from '../src/server/workbench-import.js';
import { runProcess } from '../src/server/media.js';
import { Worker } from '../src/server/worker.js';
import { createApp } from '../src/server/app.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-import-'));
  prepareData(root);
  const store = new Store(':memory:'),
    project = new StudioService(store).createProject({
      title: 'imports',
      mode: 'short',
      brief: '',
    }),
    canvas = new CanvasService(store).create(project.id, {
      version: 2,
      title: 'canvas',
      nodes: [],
      edges: [],
    });
  t.after(async () => {
    store.db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, project, canvas };
}
test('UPLOAD-001 same names are independent; retry and response-loss reconciliation create no duplicates', async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, 'a.md');
  await fs.writeFile(file, '可拍的动作');
  const body = {
    idempotencyKey: 'one-file-upload',
    target: { kind: 'canvas', canvasId: f.canvas.id },
  };
  const a = await importWorkbenchFile(
    f.store,
    f.root,
    f.project.id,
    { path: file, originalname: '同名.md' },
    body,
  );
  assert.deepEqual(
    await importWorkbenchFile(
      f.store,
      f.root,
      f.project.id,
      { path: file, originalname: '同名.md' },
      body,
    ),
    a,
  );
  await importWorkbenchFile(
    f.store,
    f.root,
    f.project.id,
    { path: file, originalname: '同名.md' },
    { ...body, idempotencyKey: 'second-file-upload' },
  );
  assert.equal(f.store.get(f.canvas.id).data.nodes.length, 2);
  assert.equal(f.store.list('chapter', f.project.id).length, 2);
  await fs.writeFile(file, 'changed');
  await assert.rejects(
    importWorkbenchFile(
      f.store,
      f.root,
      f.project.id,
      { path: file, originalname: '同名.md' },
      body,
    ),
    /不同文件/,
  );
  assert.equal(f.store.jobs().length, 0);
});
test('UPLOAD-002 attachment remains an asset reference, invalid sibling does not roll back successful import; preview is local', async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, 'sample.mp4');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=64x64:r=24:d=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  const body = {
    idempotencyKey: 'attachment-upload',
    target: { kind: 'assistant', canvasId: f.canvas.id },
  };
  const a = await importWorkbenchFile(
    f.store,
    f.root,
    f.project.id,
    { path: file, originalname: 'clip.mp4' },
    body,
  );
  assert.equal(f.store.get(f.canvas.id).data.nodes.length, 0);
  assert.equal(a.reference.kind, 'asset');
  const broken = path.join(f.root, 'broken.png');
  await fs.writeFile(broken, 'not media');
  await assert.rejects(
    importWorkbenchFile(
      f.store,
      f.root,
      f.project.id,
      { path: broken, originalname: 'broken.png' },
      { ...body, idempotencyKey: 'broken-upload' },
    ),
  );
  assert.equal(f.store.list('asset', f.project.id).length, 1);
  assert.equal(f.store.jobs().length, 1);
  assert.equal(f.store.jobs()[0].kind, 'media_process');
  const worker = new Worker(f.store, f.root);
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.jobs()[0].state, 'succeeded', f.store.jobs()[0].error || '');
  const app = createApp(f.store, f.root),
    server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const origin = 'http://127.0.0.1:' + (server.address() as any).port;
  const get = (url: string) =>
    new Promise<{ body: Buffer; headers: http.IncomingHttpHeaders }>((resolve, reject) =>
      http
        .get(url, (r) => {
          const parts: Buffer[] = [];
          r.on('data', (p) => parts.push(p));
          r.on('end', () => resolve({ body: Buffer.concat(parts), headers: r.headers }));
        })
        .on('error', reject),
    );
  const preview = JSON.parse(
    (await get(origin + '/api/assets/' + a.object.id + '/preview?revision=1')).body.toString(),
  );
  assert.equal(preview.state, 'ready');
  assert.equal(f.store.jobs().length, 1);
  assert.equal((await get(origin + preview.url)).headers['content-type'], 'image/png');
});
