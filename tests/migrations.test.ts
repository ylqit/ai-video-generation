import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/db.js';
import { migrateDatabase, upgradeModelDatabase } from '../src/server/migrations.js';
import {
  productionHead,
  activateProductionHead,
  assertProductionHead,
} from '../src/server/creation-heads.js';

test('empty database initializes directly to v6 and reopening preserves V9 records', () => {
  const store = new Store(':memory:');
  const ep = store.create('episode', 'p', { shots: [] });
  const run = store.create(
    'creation_run',
    'p',
    { schemaVersion: 9, episodeId: ep.id, results: {} },
    ep.id,
  );
  const before = store.db.prepare('SELECT * FROM revisions ORDER BY id,revision').all();
  migrateDatabase(store.db);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 6);
  assert.equal(productionHead(store, ep.id).runId, run.id);
  assert.deepEqual(store.db.prepare('SELECT * FROM revisions ORDER BY id,revision').all(), before);
  migrateDatabase(store.db);
  assert.equal(productionHead(store, ep.id).revision, 0);
  store.db.close();
});

test('legacy v3 is rejected without schema migration or data changes', () => {
  const store = new Store(':memory:');
  store.db.exec('DROP TABLE creation_heads; PRAGMA user_version=3;');
  assert.throws(() => migrateDatabase(store.db), /不支持旧数据库/);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 3);
  assert.equal(
    store.db.prepare("SELECT name FROM sqlite_master WHERE name='creation_heads'").get(),
    undefined,
  );
  store.db.close();
});

test('failed empty initialization rolls back every new table and the version', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE media_file_state(id TEXT)');
  assert.throws(() => migrateDatabase(db), /already exists/);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 0);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='documents'").get(),
    undefined,
  );
  db.close();
});

test('v5 rejects V8 current and historical authoring without rewriting either', () => {
  const store = new Store(':memory:');
  const run = store.create('creation_run', 'p', { schemaVersion: 8 });
  const before = store.db.prepare('SELECT * FROM revisions').all();
  assert.throws(() => migrateDatabase(store.db), /旧作者协议/);
  assert.deepEqual(store.db.prepare('SELECT * FROM revisions').all(), before);
  store.update(run.id, run.revision, { schemaVersion: 9 });
  assert.throws(() => migrateDatabase(store.db), /旧作者协议/);
  assert.equal(store.get(run.id, 1).data.schemaVersion, 8);
  store.close();
});

test('invalid V9 model responses remain diagnostic records across restart', () => {
  const store = new Store(':memory:');
  const draft = store.create('authoring_result', 'p', {
    schemaVersion: 9,
    result: { unexpected: 'malformed model output' },
    valid: false,
  });
  migrateDatabase(store.db);
  assert.equal(store.get(draft.id).data.valid, false);
  store.close();
});

test('ambiguous production heads need explicit activation and pending jobs block switching', () => {
  const store = new Store(':memory:');
  const ep = store.create('episode', 'p', {});
  const first = store.create('creation_run', 'p', { episodeId: ep.id }, ep.id);
  const second = store.create('creation_run', 'p', { episodeId: ep.id }, ep.id);
  assert.equal(productionHead(store, ep.id).conflict, true);
  assert.throws(() => assertProductionHead(store, first), /制作头/);
  activateProductionHead(store, first, 0, null);
  assert.throws(() => activateProductionHead(store, second, 0, first.id), /已变化/);
  const job = store.createJob('creative', 'p', ep.id, {}, 'head-test-job');
  store.patchJob(job.id, { state: 'unknown' });
  assert.throws(() => activateProductionHead(store, second, 1, first.id), /作业/);
  store.patchJob(job.id, { state: 'cancelled', output: { waitSuspended: true } });
  assert.throws(() => activateProductionHead(store, second, 1, first.id), /作业/);
  store.patchJob(job.id, { state: 'cancelled', output: {} });
  const archive = store.createJob('generation', 'p', ep.id, {}, 'archive-recovery-job');
  store.patchJob(archive.id, {
    state: 'failed',
    output: { descriptor: { filename: 'result.mp4' } },
  });
  assert.throws(() => activateProductionHead(store, second, 1, first.id), /作业/);
  store.patchJob(archive.id, { state: 'succeeded', output: {} });
  store.patchJob(job.id, { state: 'succeeded' });
  activateProductionHead(store, second, 1, first.id);
  assert.throws(() => assertProductionHead(store, first), /制作头/);
  assertProductionHead(store, second);
  store.db.close();
});

test('future database versions are not downgraded', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA user_version=7');
  assert.throws(() => migrateDatabase(db), /拒绝降级/);
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 7);
  db.close();
});

test('v4 to v5 is explicit, additive and preserves frozen task bytes', () => {
  const store = new Store(':memory:');
  store.createJob(
    'generation',
    'p',
    null,
    { segment: { id: 'historical' }, prepared: { finalPrompt: 'fixed input' } },
    'frozen-h3',
  );
  store.db.exec(
    'DROP TABLE model_connections; DROP TABLE model_connection_versions; DROP TABLE model_secrets; DROP INDEX model_config_owner; PRAGMA user_version=4;',
  );
  const before = store.db.prepare('SELECT * FROM jobs').all();
  assert.throws(() => migrateDatabase(store.db), /显式模型迁移/);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 4);
  store.acquire('active-worker');
  assert.throws(() => upgradeModelDatabase(store.db), /租约/);
  store.release('active-worker');
  upgradeModelDatabase(store.db);
  assert.equal(store.db.prepare('PRAGMA user_version').get()!.user_version, 5);
  assert.deepEqual(store.db.prepare('SELECT * FROM jobs').all(), before);
  assert.throws(() => upgradeModelDatabase(store.db), /仅接受 v4/);
  store.close();
});
