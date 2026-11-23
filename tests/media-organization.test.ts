import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import {
  cleanupPlan,
  executeCleanup,
  fileCleared,
  restoreMedia,
  recoverInterruptedCleanup,
} from '../src/server/media-retention.js';
import { libraryPage } from '../src/server/media-library.js';
import { extractFrameAsset } from '../src/server/media-evidence.js';
import { runProcess, ingestAsset } from '../src/server/media.js';
import { prepareData } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import { retainWorkspace } from '../src/server/workspace-retention.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
async function fixture(t: any) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-organize-')),
    root = path.join(base, 'data');
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite'));
  const project = new StudioService(store).createProject({
    title: 'Organization',
    mode: 'short',
    brief: '',
  });
  t.after(async () => {
    store.close();
    assert.ok(base.startsWith(path.join(os.tmpdir(), 'studio-organize-')));
    await fs.rm(base, { recursive: true, force: true });
  });
  return { base, root, store, project };
}
async function frame(f: any, name: string, index = 1) {
  const bytes = Buffer.from(name),
    sha256 = createHash('sha256').update(bytes).digest('hex'),
    file = `assets/${sha256}.png`;
  await fs.writeFile(path.join(f.root, file), bytes);
  return f.store.create('asset', f.project.id, {
    name,
    mediaType: 'image',
    category: 'review_frame',
    path: file,
    sha256,
    bytes: bytes.length,
    derivedSource: {
      media: { id: 'source', revision: 1 },
      kind: 'review_frame',
      frameIndex: index,
    },
    frameIndex: index,
  });
}
test('library filters before pagination, keeps derivatives attached and reads without writes', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 40; i++) await frame(f, 'frame' + i);
  for (let i = 0; i < 4; i++)
    f.store.create('asset', f.project.id, {
      name: 'reference' + i,
      mediaType: 'image',
      category: 'reference',
      path: 'assets/r' + i,
    });
  const before = f.store.db.prepare('SELECT count(*) n FROM events').get();
  const page = libraryPage(f.store, f.project.id, { limit: 2, offset: 2 });
  assert.equal(page.total, 4);
  assert.equal(page.items.length, 2);
  assert.ok(page.items.every((i) => i.role === 'reference'));
  assert.equal(page.counts.attachment, 40);
  assert.deepEqual(f.store.db.prepare('SELECT count(*) n FROM events').get(), before);
});
test('cleanup protects historical consumers, receipts and shared bytes', async (t) => {
  const f = await fixture(t);
  const historical = await frame(f, 'history'),
    receipt = await frame(f, 'receipt'),
    shared = await frame(f, 'shared'),
    free = await frame(f, 'unused');
  const consumer = f.store.create('reference_plan', f.project.id, {
    asset: { id: historical.id, revision: 1 },
  });
  f.store.update(consumer.id, 1, {});
  const j = f.store.createJob('export', f.project.id, null, {}, randomUUID());
  f.store.patchJob(j.id, { state: 'succeeded', output: { assetIds: [receipt.id] } });
  f.store.create('asset', f.project.id, { ...shared.data, category: 'keyframe' });
  const plan = cleanupPlan(f.store, f.project.id);
  assert.deepEqual(
    plan.candidates.map((a) => a.id),
    [free.id],
  );
  assert.equal(plan.protected.length, 3);
});
test('cleanup verifies backup, is idempotent, preserves versions, and restores original hash', async (t) => {
  const f = await fixture(t),
    a = await frame(f, 'unused bytes');
  const original = f.store.get(a.id, 1),
    plan = cleanupPlan(f.store, f.project.id),
    key = randomUUID();
  const result = await executeCleanup(f.store, f.root, f.project.id, plan.digest, key);
  assert.equal(result.releasedBytes, a.data.bytes);
  assert.equal(fileCleared(f.store, a.data.path), true);
  assert.equal(libraryPage(f.store, f.project.id, { view: 'attachment' }).total, 0);
  assert.equal(libraryPage(f.store, f.project.id, { view: 'cleared' }).total, 1);
  assert.deepEqual(f.store.get(a.id, 1), original);
  assert.deepEqual(await executeCleanup(f.store, f.root, f.project.id, plan.digest, key), result);
  await restoreMedia(f.store, f.root, a.id, 1);
  assert.equal(fileCleared(f.store, a.data.path), false);
  assert.equal((await fs.readFile(path.join(f.root, a.data.path))).toString(), 'unused bytes');
  assert.equal(f.store.setting('maintenance', false), false);
});
test('changed references and running jobs stop cleanup before removal', async (t) => {
  const f = await fixture(t),
    a = await frame(f, 'retain me'),
    plan = cleanupPlan(f.store, f.project.id);
  f.store.create('reference_plan', f.project.id, { asset: { id: a.id, revision: 1 } });
  await assert.rejects(
    () => executeCleanup(f.store, f.root, f.project.id, plan.digest, randomUUID()),
    /清单已变化/,
  );
  await fs.stat(path.join(f.root, a.data.path));
  assert.equal(f.store.setting('maintenance', false), false);
  f.store.createJob('export', f.project.id, null, {}, randomUUID());
  await assert.rejects(
    () =>
      executeCleanup(
        f.store,
        f.root,
        f.project.id,
        cleanupPlan(f.store, f.project.id).digest,
        randomUUID(),
      ),
    /执行任务/,
  );
});
test('cleared media GET returns 410 without rebuilding; explicit restore verifies corrupted backup', async (t) => {
  const f = await fixture(t),
    a = await frame(f, 'media');
  const plan = cleanupPlan(f.store, f.project.id);
  const result = await executeCleanup(f.store, f.root, f.project.id, plan.digest, randomUUID());
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api/assets/${a.id}/file?revision=1`;
  assert.equal((await fetch(url)).status, 410);
  await assert.rejects(() => fs.stat(path.join(f.root, a.data.path)));
  await fs.writeFile(result.files[0].backup, 'corrupt');
  await assert.rejects(() => restoreMedia(f.store, f.root, a.id, 1), /哈希不符/);
});
test('concurrent evidence extraction shares one asset and leaves no temporary directory', async (t) => {
  const f = await fixture(t);
  const file = path.join(f.root, 'source.mp4');
  await runProcess('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=160x128:r=24:d=1',
    '-c:v',
    'libx264',
    file,
  ]);
  const video = await ingestAsset(f.store, f.root, f.project.id, file, { category: 'generated' });
  const [a, b] = await Promise.all([
    extractFrameAsset(f.store, f.root, video.id, video.revision, 5),
    extractFrameAsset(f.store, f.root, video.id, video.revision, 5),
  ]);
  assert.equal(a.id, b.id);
  assert.equal((await extractFrameAsset(f.store, f.root, video.id, 1, 5)).id, a.id);
  assert.equal(f.store.list('asset').length, 2);
  const last = await extractFrameAsset(f.store, f.root, video.id, 1, 'last');
  assert.equal((await extractFrameAsset(f.store, f.root, video.id, 1, 23)).id, last.id);
  assert.equal((await fs.readdir(path.join(f.root, 'jobs'))).length, 0);
  await assert.rejects(() => extractFrameAsset(f.store, f.root, video.id, 1, 24), /越界/);
});

test('interrupted cleanup reconciles verified files without continuing deletion', async (t) => {
  const f = await fixture(t),
    a = await frame(f, 'recover me');
  const plan = cleanupPlan(f.store, f.project.id),
    key = randomUUID();
  const result = await executeCleanup(f.store, f.root, f.project.id, plan.digest, key);
  f.store.db.prepare("UPDATE media_file_state SET status='clearing'").run();
  result.files[0].status = 'pending';
  f.store.db
    .prepare('UPDATE media_cleanup_batches SET manifest=? WHERE id=?')
    .run(JSON.stringify(result), key);
  f.store.setSetting('media_cleanup_lock', key);
  f.store.setSetting('media_cleanup_owner', null);
  f.store.setSetting('maintenance', true);
  await recoverInterruptedCleanup(f.store, f.root);
  assert.equal(fileCleared(f.store, a.data.path), true);
  assert.equal(f.store.setting('maintenance', false), false);
  assert.equal(f.store.setting('media_cleanup_lock', null), null);
  assert.deepEqual(f.store.get(a.id), a);
  await restoreMedia(f.store, f.root, a.id, a.revision);
  assert.equal(await fs.readFile(path.join(f.root, a.data.path), 'utf8'), 'recover me');
});

test('workspace backup and retention bundle cleared files and preserve explicit recovery', async (t) => {
  const f = await fixture(t),
    a = await frame(f, 'portable backup bytes');
  await executeCleanup(
    f.store,
    f.root,
    f.project.id,
    cleanupPlan(f.store, f.project.id).digest,
    randomUUID(),
  );
  const backup = path.join(f.base, 'full-backup'),
    restored = path.join(f.base, 'restored');
  await promisify(execFile)(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', backup], {
    env: { ...process.env, STUDIO_DATA_DIR: f.root },
    windowsHide: true,
  });
  await promisify(execFile)(
    process.execPath,
    ['--import', 'tsx', 'scripts/backup.ts', 'restore', backup, restored],
    { windowsHide: true },
  );
  const recovered = new Store(path.join(restored, 'studio.sqlite'));
  try {
    assert.equal(fileCleared(recovered, a.data.path), true);
    await restoreMedia(recovered, restored, a.id, a.revision);
    assert.equal(
      await fs.readFile(path.join(restored, a.data.path), 'utf8'),
      'portable backup bytes',
    );
  } finally {
    recovered.close();
  }
  const retained = path.join(f.base, 'retained');
  await retainWorkspace(backup, retained, f.project.id);
  const copy = new Store(path.join(retained, 'studio.sqlite'));
  try {
    assert.equal(fileCleared(copy, a.data.path), true);
    await restoreMedia(copy, retained, a.id, a.revision);
    assert.deepEqual(copy.get(a.id), a);
  } finally {
    copy.close();
  }
});

test('SQL pagination promotes bound derivatives and uses identical media filters for totals and counts without full collection reads', async (t) => {
  const f = await fixture(t),
    promoted = await frame(f, 'promoted'),
    attachment = await frame(f, 'attachment');
  f.store.create('creation_run', f.project.id, {
    bindings: { identity: { asset: { id: promoted.id, revision: promoted.revision } } },
  });
  for (let i = 0; i < 3; i++)
    f.store.create('asset', f.project.id, {
      name: `audio${i}`,
      mediaType: 'audio',
      category: 'reference',
      path: `assets/audio${i}`,
    });
  f.store.list = () => {
    throw new Error('full collection read is forbidden');
  };
  f.store.jobs = () => {
    throw new Error('full jobs read is forbidden');
  };
  const page = libraryPage(f.store, f.project.id, { mediaType: 'image', limit: 1 });
  assert.equal(page.total, 1);
  assert.equal(page.counts.reference, 1);
  assert.equal(page.counts.attachment, 1);
  assert.equal(page.items[0].asset.id, promoted.id);
  assert.equal(
    libraryPage(f.store, f.project.id, { mediaType: 'image', limit: 1, offset: 1 }).items.length,
    0,
  );
  assert.equal(
    libraryPage(f.store, f.project.id, { mediaType: 'image', view: 'attachment' }).items[0].asset
      .id,
    attachment.id,
  );
});

test('historical delivery plans, independent EDLs, confirmation and V9 sources protect media from cleanup', async (t) => {
  const f = await fixture(t);
  for (const kind of [
    'creation_delivery_plan',
    'edl',
    'creation_delivery',
    'creation_run',
  ] as const) {
    const asset = await frame(f, kind),
      record = f.store.create(
        kind,
        f.project.id,
        kind === 'creation_run'
          ? { schemaVersion: 9, sources: [{ id: asset.id, revision: asset.revision }] }
          : { media: { id: asset.id, revision: asset.revision } },
      );
    f.store.update(record.id, record.revision, { archived: true });
  }
  const unused = await frame(f, 'free');
  assert.deepEqual(
    cleanupPlan(f.store, f.project.id).candidates.map((d) => d.id),
    [unused.id],
  );
});
