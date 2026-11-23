import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../src/server/db.js';
import { retainWorkspace } from '../src/server/workspace-retention.js';

test('offline retention copies all kept revisions/media and frozen jobs without other projects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-retention-'));
  const sourceRoot = path.join(root, 'source'),
    targetRoot = path.join(root, 'target');
  await fs.mkdir(path.join(sourceRoot, 'assets'), { recursive: true });
  const source = new Store(path.join(sourceRoot, 'studio.sqlite'));
  let target: Store | undefined;
  try {
    const keep = source.create('project', '', { title: '保留作品', mode: 'short', brief: '' });
    source.create('project', '', { title: '旧演示', mode: 'short', brief: '' });
    source.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9999', instanceId: 'retained' });
    source.setSetting('oldDemoSeed', { projectId: 'old-project', complete: true });
    const bytes = Buffer.from('immutable existing media fixture'),
      sha256 = createHash('sha256').update(bytes).digest('hex');
    const file = 'assets/' + sha256 + '.bin';
    await fs.writeFile(path.join(sourceRoot, file), bytes);
    const asset = source.create('asset', keep.id, {
      name: '原始媒体',
      path: file,
      sha256,
      mediaType: 'image',
    });
    source.update(asset.id, 1, { ...asset.data, name: '当前名称' });
    source.event(null, 'domain_correction', {
      source: { id: asset.id, revision: 1 },
      affected: [{ id: asset.id }],
    });
    const job = source.createJob(
      'export',
      keep.id,
      null,
      { assets: [asset], edl: { clips: [] }, name: '历史导出' },
      'retention-export-key',
    );
    source.patchJob(job.id, {
      state: 'succeeded',
      output: { assetIds: [asset.id] },
      promptId: 'original-receipt',
    });
    const input = source.job(job.id).input,
      revisionRows = source.db
        .prepare('SELECT * FROM revisions')
        .all()
        .filter((r) => r.id === asset.id);
    source.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const report = await retainWorkspace(sourceRoot, targetRoot, keep.id);
    target = new Store(path.join(targetRoot, 'studio.sqlite'));
    assert.equal(target.list('project').length, 1);
    assert.equal(target.list('project')[0].id, keep.id);
    assert.deepEqual(target.setting('comfy', {}), source.setting('comfy', {}));
    assert.equal(target.setting('oldDemoSeed', null), null);
    assert.deepEqual(target.job(job.id).input, input);
    assert.equal(target.job(job.id).promptId, 'original-receipt');
    assert.deepEqual(
      target.db.prepare('SELECT * FROM revisions WHERE id=?').all(asset.id),
      revisionRows,
    );
    assert.equal(report.assetFiles, 1);
    assert.equal(
      target.db.prepare("SELECT count(*) n FROM events WHERE kind='domain_correction'").get()?.n,
      1,
    );
    assert.deepEqual(await fs.readFile(path.join(targetRoot, file)), bytes);
    assert.equal(source.list('project').length, 2);
    await assert.rejects(retainWorkspace(sourceRoot, targetRoot, keep.id), /目标目录已存在/);
  } finally {
    target?.db.close();
    source.db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('offline retention refuses active requests before creating a target', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-retention-active-')),
    sourceRoot = path.join(root, 'source');
  await fs.mkdir(sourceRoot);
  const source = new Store(path.join(sourceRoot, 'studio.sqlite'));
  try {
    const project = source.create('project', '', { title: '工作中' });
    source.createJob('export', project.id, null, { assets: [], edl: {} }, 'still-active-request');
    await assert.rejects(
      retainWorkspace(sourceRoot, path.join(root, 'target'), project.id),
      /未结束任务/,
    );
    await assert.rejects(fs.stat(path.join(root, 'target')), /ENOENT/);
  } finally {
    source.db.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('retention refuses legacy authoring before copying a project into a V9 database', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-retention-v9-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'),
    targetRoot = path.join(root, 'target');
  await fs.mkdir(sourceRoot);
  const store = new Store(path.join(sourceRoot, 'studio.sqlite'));
  const project = store.create('project', '', { title: 'Offline legacy fixture' });
  store.create('creation_run', project.id, { schemaVersion: 8 });
  store.close();
  await assert.rejects(retainWorkspace(sourceRoot, targetRoot, project.id), /旧作者协议/);
  await assert.rejects(fs.stat(targetRoot), /ENOENT/);
});
