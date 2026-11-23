import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import { ReadinessService } from '../src/server/readiness.js';
import { BatchService } from '../src/server/batches.js';
import { Worker } from '../src/server/worker.js';
import { ComfyClient } from '../src/server/comfy.js';
import { createApp } from '../src/server/app.js';
import { prepareData } from '../src/server/config.js';
import { creationPresets } from '../src/shared/workbench.js';
import { CreationService } from '../src/server/creation.js';
const profile = { baseUrl: 'http://127.0.0.1:9919', instanceId: 'workbench-offline' };
test('same-millisecond batches keep confirmed item order instead of random UUID order', async (t) => {
  const f = await fixture(t),
    ep = episode(f),
    cloud = new Cloud(profile.baseUrl);
  const ids: string[] = [];
  for (const [index, names] of [
    ['z-first', 'y-second'],
    ['x-third', 'a-fourth'],
  ].entries()) {
    const draft = f.batches.save({
      name: `ordered-${index}`,
      items: [entry(ep, `a-${index}`, 'g1'), entry(ep, `b-${index}`, 'g2')],
    });
    const preview = f.batches.preview(draft.id);
    const batch = f.batches.confirm(draft.id, draft.revision, preview.digest, `order-${index}`);
    for (const [position, item] of batch.items.entries()) {
      // Deliberately opposite UUID order, with a tied wall clock. Only this temporary DB is changed.
      const id = names[position];
      f.store.db.prepare('UPDATE jobs SET id=?,created_at=1000 WHERE id=?').run(id, item.job!.id);
      f.store.db
        .prepare('UPDATE batch_items SET job_id=? WHERE batch_id=? AND job_id=?')
        .run(id, batch.id, item.job!.id);
      ids.push(id);
    }
  }
  const worker = new Worker(f.store, f.root, () => cloud);
  t.after(() => worker.stop());
  for (const id of ids) {
    await worker.tick();
    assert.equal(f.store.job(id).state, 'submitted', `next confirmed item must be ${id}`);
    assert.ok(f.store.job(id).promptId);
    f.store.patchJob(id, { state: 'succeeded' });
  }
  assert.equal(cloud.posts, 4);
});
test('a new coordinator waits through startup lease contention then acquires without duplicate work', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.acquire('departing-worker'), true);
  const newcomer = new Worker(f.store, f.root);
  t.after(() => newcomer.stop());
  await newcomer.tick(false);
  assert.equal(newcomer.stopped, false);
  assert.equal(newcomer.initialized, false);
  assert.equal(newcomer.executions.size, 0);
  f.store.release('departing-worker');
  await newcomer.tick(false);
  assert.equal(newcomer.initialized, true);
  assert.equal(newcomer.stopped, false);
  assert.equal(
    f.store.db.prepare('SELECT owner FROM leases WHERE name=?').get('worker')?.owner,
    newcomer.owner,
  );
  newcomer.stop();
  await newcomer.drain();
});
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-workbench-'));
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store),
    domain = new DomainService(store),
    creation = new CreationService(store),
    batches = new BatchService(store);
  store.setSetting('comfy', profile);
  const project = service.createProject({ title: '离线多项目', mode: 'short', brief: '' });
  creation.saveSettings(project.id, 0, {
    allowance: { enabled: true, maxGenerations: 100, maxGeneratedSeconds: 1000 },
  });
  t.after(async () => {
    store.close();
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'studio-workbench-'),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, service, domain, creation, batches, project };
}
function episode(f: any, projectId = f.project.id) {
  let ep = f.service.createEpisode(projectId, { title: '单片' });
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: [
      { id: 's1', scene: '演示台', description: '展示', dialogue: '', continuity: '', duration: 5 },
      { id: 's2', scene: '演示台', description: '细节', dialogue: '', continuity: '', duration: 5 },
    ],
    segments: [
      {
        id: 'g1',
        shotIds: ['s1'],
        prompt: 'A product rotates slowly.',
        mode: 't2v',
        duration: 5,
        references: [],
      },
      {
        id: 'g2',
        shotIds: ['s2'],
        prompt: 'Close-up of the product.',
        mode: 't2v',
        duration: 5,
        references: [],
      },
    ],
  });
  return f.service.approveEpisode(ep.id, ep.revision);
}
function entry(ep: any, id = 'item-1', segmentId = 'g1') {
  return {
    id,
    episodeId: ep.id,
    episodeRevision: ep.revision,
    segmentId,
    width: 864,
    height: 480,
    steps: 20,
    seed: 1,
    enabled: true,
    waitingFor: '',
  };
}
class Cloud extends ComfyClient {
  posts = 0;
  polls = 0;
  override async validate() {
    return undefined as any;
  }
  override async submit() {
    this.posts++;
    return 'prompt-' + this.posts;
  }
  override async json(url: string) {
    this.polls++;
    return url === '/queue' ? { queue_pending: [], queue_running: [] } : {};
  }
  override watch() {
    return { readyState: 1, close() {} } as any;
  }
}
test('profiles are data and library copies remain project-independent', async (t) => {
  const f = await fixture(t),
    p = f.domain.save(f.project.id, 'creation_profile', creationPresets[1]);
  const lib = f.domain.publishLibrary(
    f.project.id,
    [{ id: p.id, revision: p.revision }],
    '产品配置',
  );
  const second = f.service.createProject({ title: '动物故事', mode: 'short', brief: '' });
  const copy = f.domain.copyLibrary(second.id, lib.id, lib.revision).documents[0];
  f.domain.save(
    second.id,
    'creation_profile',
    { ...copy.data, name: '另一版' },
    copy.id,
    copy.revision,
  );
  assert.equal(f.store.get(p.id).revision, 1);
  assert.notEqual(copy.id, p.id);
});
test('cross-project batch confirms all included entries atomically and never duplicates jobs', async (t) => {
  const f = await fixture(t),
    one = episode(f),
    p2 = f.service.createProject({ title: '另一项目', mode: 'short', brief: '' }),
    two = episode(f, p2.id);
  const batch = f.batches.save({
    name: '两项目',
    items: [
      entry(one),
      entry(two, 'two'),
      { ...entry(one, 'waiting', 'g2'), waitingFor: '等待参考尾帧' },
    ],
  });
  const preview = f.batches.preview(batch.id);
  assert.equal(preview.count, 2);
  assert.equal(preview.excluded.length, 1);
  assert.equal(f.store.jobs().length, 0);
  const confirmed = f.batches.confirm(batch.id, batch.revision, preview.digest, 'confirmed-key');
  assert.equal(confirmed.items.length, 2);
  f.batches.confirm(batch.id, batch.revision, preview.digest, 'confirmed-key');
  assert.equal(f.store.jobs().length, 2);
  assert.equal(new Set(f.store.jobs().map((j) => j.projectId)).size, 2);
});
test('batch input changes invalidate entire confirmation with no partial enqueue', async (t) => {
  const f = await fixture(t),
    ep = episode(f),
    batch = f.batches.save({ name: '预览', items: [entry(ep), entry(ep, 'two', 'g2')] }),
    preview = f.batches.preview(batch.id);
  f.service.saveEpisode(ep.id, ep.revision, { ...ep.data, script: '新脚本' });
  assert.throws(
    () => f.batches.confirm(batch.id, batch.revision, preview.digest, 'stale-confirm'),
    /重新预览/,
  );
  assert.equal(f.store.jobs().length, 0);
  assert.equal(f.batches.get(batch.id).state, 'draft');
});
test('batch pause and cancel preserve known remote identity and stop unstarted work', async (t) => {
  const f = await fixture(t),
    ep = episode(f),
    batch = f.batches.save({ name: '暂停', items: [entry(ep), entry(ep, 'two', 'g2')] }),
    preview = f.batches.preview(batch.id);
  const jobs = f.batches
    .confirm(batch.id, batch.revision, preview.digest, 'pause-confirm')
    .items.map((i) => i.job!);
  f.store.patchJob(jobs[0].id, { state: 'running', promptId: 'known' });
  f.batches.control(batch.id, 'pause');
  assert.equal(f.store.job(jobs[1].id).holdReason, 'batch_paused');
  f.batches.control(batch.id, 'resume');
  assert.equal(f.store.job(jobs[1].id).holdReason, null);
  f.batches.control(batch.id, 'cancel');
  assert.equal(f.store.job(jobs[1].id).state, 'cancelled');
  assert.equal(f.store.job(jobs[0].id).promptId, 'known');
  assert.equal(f.store.job(jobs[0].id).state, 'running');
});
test('series readiness excludes dependent later episode until previous canon is confirmed', async (t) => {
  const f = await fixture(t),
    p = f.service.createProject({ title: '连续故事', mode: 'series', brief: '' }),
    first = episode(f, p.id),
    second = episode(f, p.id),
    r = new ReadinessService(f.store);
  assert.doesNotThrow(() => r.generation(entry(second), profile));
  f.store.create('continuity', p.id, { confirmed: true, stale: false }, first.id);
  assert.ok(r.generation(entry(second), profile).digest);
});
test('slow creative execution does not block cloud reconciliation and unknown holds only remote lane', async (t) => {
  const f = await fixture(t),
    ep = episode(f);
  const run = f.creation.create(f.project.id, { request: '规划', idempotencyKey: 'writing-test' });
  const writing = f.store.job(run.data.pendingJobId);
  const video = f.service.generation(
    { ...entry(ep), approved: true, idempotencyKey: 'video-known' },
    profile,
  );
  f.store.patchJob(video.id, { state: 'unknown' });
  const cloud = new Cloud(profile.baseUrl);
  let finish!: (p: any) => void;
  const waiting = new Promise<any>((r) => (finish = r));
  const worker = new Worker(
    f.store,
    f.root,
    () => cloud,
    async () => waiting,
  );
  t.after(() => worker.stop());
  await worker.tick(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.store.job(writing.id).state, 'running');
  assert.ok(cloud.polls >= 2);
  const before = cloud.polls;
  await worker.tick(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.ok(cloud.polls > before);
  assert.equal(cloud.posts, 0);
  finish({
    schemaVersion: 9,
    stage: 'brief',
    title: '离线测试',
    summary: '文字草稿',
    assumptions: [],
    openQuestions: [],
    sources: [],
    contentChange: 'preserved',
    intent: 'story',
    goal: '离线验证',
    audience: '测试',
    lockedFacts: [],
    requirements: [],
  });
  await worker.drain();
  assert.equal(f.store.job(writing.id).state, 'succeeded');
  worker.stop();
});
test('media export lane does not block remote completion persistence', async (t) => {
  const f = await fixture(t),
    ep = episode(f),
    video = f.service.generation(
      { ...entry(ep), approved: true, idempotencyKey: 'remote-video' },
      profile,
    );
  f.store.patchJob(video.id, { state: 'running', promptId: 'known' });
  const exporting = f.store.createJob(
    'export',
    f.project.id,
    ep.id,
    { edl: {}, assets: [] },
    'local-export',
  );
  const cloud = new Cloud(profile.baseUrl);
  cloud.json = async (url) =>
    url === '/queue'
      ? { queue_running: [], queue_pending: [] }
      : {
          known: {
            status: { completed: true, status_str: 'success' },
            outputs: { save: { videos: [{ filename: 'ready.mp4' }] } },
          },
        };
  let finish!: () => void;
  const pending = new Promise<void>((r) => (finish = r));
  const worker = new Worker(
    f.store,
    f.root,
    () => cloud,
    undefined,
    async () => {
      await pending;
      return {} as any;
    },
  );
  t.after(() => worker.stop());
  await worker.tick(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.store.job(exporting.id).state, 'running');
  assert.equal(f.store.job(video.id).state, 'archiving');
  assert.equal(f.store.job(video.id).output.descriptor.filename, 'ready.mp4');
  worker.stop();
  finish();
  await worker.drain();
});
test('fair scheduling rotates projects and explicit corrections hold queued frozen jobs', async (t) => {
  const f = await fixture(t),
    a = episode(f),
    p = f.service.createProject({ title: 'B', mode: 'short', brief: '' }),
    b = episode(f, p.id),
    cloud = new Cloud(profile.baseUrl),
    worker = new Worker(f.store, f.root, () => cloud);
  t.after(() => worker.stop());
  const jobs = [
    f.service.generation({ ...entry(a), approved: true, idempotencyKey: 'round-a-one' }, profile),
    f.service.generation(
      { ...entry(a, 'a2', 'g2'), approved: true, idempotencyKey: 'round-a-two' },
      profile,
    ),
    f.service.generation({ ...entry(b), approved: true, idempotencyKey: 'round-b-one' }, profile),
  ];
  await worker.tick();
  assert.ok(f.store.job(jobs[0].id).promptId);
  f.store.patchJob(jobs[0].id, { state: 'succeeded' });
  await worker.tick();
  assert.ok(f.store.job(jobs[2].id).promptId);
  assert.equal(f.store.job(jobs[1].id).state, 'queued');
  f.store.patchJob(jobs[2].id, { state: 'succeeded' });
  f.store.update(a.id, a.revision, { ...a.data, stale: true });
  await worker.tick();
  assert.equal(f.store.job(jobs[1].id).holdReason, 'dependencies_need_review');
  assert.equal(cloud.posts, 2);
});
test('paged APIs return bounded data and obsolete authoring routes do not execute', async (t) => {
  const f = await fixture(t);
  f.store.transaction(() => {
    for (let n = 0; n < 120; n++)
      f.store.create('asset', f.project.id, {
        name: '离线 ' + n,
        mediaType: 'image',
        adopted: true,
      });
  });
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const data = (await (
    await fetch(`${base}/projects/${f.project.id}/records?kind=asset&limit=25&offset=25`)
  ).json()) as any;
  assert.equal(data.items.length, 25);
  assert.equal(data.total, 120);
  const first = (await (
    await fetch(`${base}/projects/${f.project.id}/records?kind=asset&limit=25`)
  ).json()) as any;
  assert.equal(
    first.items.filter((x: any) => data.items.some((v: any) => x.id === v.id)).length,
    0,
  );
  const work = (await (await fetch(base + '/workbench?limit=1')).json()) as any;
  assert.equal(work.items.length, 1);
  assert.equal(work.items[0].documents, undefined);
  const before = f.store.jobs().length;
  const obsolete = await fetch(`${base}/projects/${f.project.id}/context/v3`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stage: 'series_plan', request: '规划' }),
  });
  assert.equal(obsolete.status, 404);
  assert.equal(f.store.jobs().length, before);
});

test('lost coordinator lease aborts local work and fences its results', async (t) => {
  const f = await fixture(t),
    cloud = new Cloud(profile.baseUrl);
  let started = false,
    aborted = false;
  const run: any = async (_context: any, _dir: any, signal: AbortSignal) => {
    started = true;
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          resolve();
        },
        { once: true },
      ),
    );
    return {};
  };
  const worker = new Worker(f.store, f.root, () => cloud, run);
  const creationRun = f.creation.create(f.project.id, {
    request: '模拟长文字',
    idempotencyKey: 'lease-creative',
  });
  const job = f.store.job(creationRun.data.pendingJobId);
  await worker.tick(false);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(started, true);
  f.store.db
    .prepare("UPDATE leases SET owner=?,expires=? WHERE name='worker'")
    .run('other-owner', Date.now() + 30000);
  await worker.tick(false);
  await worker.drain();
  assert.equal(aborted, true);
  assert.equal(worker.stopped, true);
  assert.equal(f.store.job(job.id).state, 'running');
  assert.equal(f.store.list('authoring_result').length, 0);
  assert.throws(() => f.store.patchJob(job.id, { state: 'succeeded' }), /租约/);
  f.store.writeLeaseOwner = null;
});

test('reference suggestion keeps distinct instances on shared images and returns missing views without mutation', async (t) => {
  const f = await fixture(t),
    ep = episode(f);
  const entity = f.domain.save(f.project.id, 'entity', {
    name: '同款产品',
    type: 'object',
    instances: [
      { id: 'product-a', name: 'A' },
      { id: 'product-b', name: 'B' },
    ],
  });
  const image = f.store.create('asset', f.project.id, {
    name: '固定测试图',
    mediaType: 'image',
    adopted: true,
  });
  let pack = f.domain.save(f.project.id, 'reference_pack', {
    name: '产品参考',
    entity: { id: entity.id, revision: 1 },
    views: [{ id: 'front', asset: { id: image.id, revision: 1 }, view: 'front' }],
  });
  pack = f.domain.publish(pack.id, pack.revision, { inspected: true, conclusion: '离线字段测试' });
  const state = {
    instances: ['product-a', 'product-b'].map((instanceId) => ({
      instanceId,
      entity: { id: entity.id, revision: 1 },
      pack: { id: pack.id, revision: pack.revision },
    })),
    requiredViews: [{ instanceId: 'product-a', view: 'back', reason: '需要展示背面' }],
  };
  f.store.update(ep.id, ep.revision, { ...ep.data, shots: [{ ...ep.data.shots[0], state }] });
  const before = Number(f.store.db.prepare('SELECT count(*) n FROM revisions').get()?.n);
  const result = new ReadinessService(f.store).suggest(ep.id, 'g1');
  assert.equal(result.data.bindings.length, 1);
  assert.deepEqual(result.data.bindings[0].instanceIds, ['product-a', 'product-b']);
  assert.equal(result.requiredCount, 1);
  assert.equal(result.missing[0].view, 'back');
  assert.equal(result.submitted, false);
  assert.equal(Number(f.store.db.prepare('SELECT count(*) n FROM revisions').get()?.n), before);
});

test('healthy cloud polls continue every coordinator cycle while text is pending, and three projects rotate', async (t) => {
  const f = await fixture(t),
    a = episode(f),
    p2 = f.service.createProject({ title: 'B', mode: 'short', brief: '' }),
    b = episode(f, p2.id),
    p3 = f.service.createProject({ title: 'C', mode: 'short', brief: '' }),
    c = episode(f, p3.id),
    cloud = new Cloud(profile.baseUrl);
  let finish!: (v: any) => void;
  const pending = new Promise<any>((r) => (finish = r));
  const worker = new Worker(
    f.store,
    f.root,
    () => cloud,
    async () => pending,
  );
  // Join the finite remote lane, not the deliberately pending creative lane.
  // A fixed 30ms sleep races filesystem receipt persistence under CPU load.
  async function finishRemoteCycle() {
    await Promise.all(
      [...worker.executions.values()].filter((e) => e.lane === 'remote').map((e) => e.promise),
    );
  }
  t.after(() => worker.stop());
  f.creation.create(f.project.id, { request: '长文字', idempotencyKey: 'cadence-text' });
  const jobs = [a, b, c].flatMap((ep, i) =>
    [0, 1].map((n) =>
      f.service.generation(
        {
          ...entry(ep, `${i}-${n}`, n ? 'g2' : 'g1'),
          approved: true,
          idempotencyKey: `fair-three-${i}-${n}`,
        },
        profile,
      ),
    ),
  );
  await worker.tick(false);
  await finishRemoteCycle();
  assert.ok(f.store.job(jobs[0].id).promptId);
  const checks: number[] = [];
  for (let n = 0; n < 3; n++) {
    await new Promise((r) => setTimeout(r, 1000));
    await worker.tick(false);
    await finishRemoteCycle();
    checks.push(f.store.job(jobs[0].id).output.lastCheckedAt);
  }
  assert.ok(checks.every(Number.isFinite));
  assert.ok(checks[2] > checks[1] && checks[1] > checks[0]);
  assert.ok(Math.max(checks[1] - checks[0], checks[2] - checks[1]) < 5000);
  f.store.patchJob(jobs[0].id, { state: 'succeeded' });
  await worker.tick(false);
  await finishRemoteCycle();
  assert.ok(f.store.job(jobs[2].id).promptId);
  f.store.patchJob(jobs[2].id, { state: 'succeeded' });
  await worker.tick(false);
  await finishRemoteCycle();
  assert.ok(f.store.job(jobs[4].id).promptId);
  assert.equal(f.store.job(jobs[1].id).state, 'queued');
  finish({
    schemaVersion: 9,
    stage: 'brief',
    title: '离线测试',
    summary: '文字草稿',
    assumptions: [],
    openQuestions: [],
    sources: [],
    contentChange: 'preserved',
    intent: 'story',
    goal: '离线验证',
    audience: '测试',
    lockedFacts: [],
    requirements: [],
  });
  await worker.drain();
  worker.stop();
});

test('event cursor resumes after known event and large multi-project APIs stay bounded', async (t) => {
  const f = await fixture(t);
  f.store.transaction(() => {
    for (let i = 0; i < 8; i++) {
      const p = f.service.createProject({ title: `规模测试 ${i}`, mode: 'short', brief: '' });
      for (let n = 0; n < 125; n++)
        f.store.create('asset', p.id, { name: `素材 ${n}`, mediaType: 'image', adopted: true });
      for (let n = 0; n < 25; n++) {
        const j = f.store.createJob('export', p.id, null, { name: '离线历史' }, `scale-${i}-${n}`);
        f.store.patchJob(j.id, { state: 'succeeded' });
      }
    }
  });
  const cursor = Number(f.store.db.prepare('SELECT max(seq) n FROM events').get()?.n);
  const changed = f.store.update(f.project.id, f.project.revision, {
    ...f.project.data,
    brief: '增量更新',
  });
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(
    () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const work: any = await (await fetch(base + '/workbench?limit=3&offset=3')).json();
  assert.equal(work.items.length, 3);
  assert.equal(work.total, 9);
  assert.ok(JSON.stringify(work).length < 20000);
  const jobs: any = await (await fetch(base + '/jobs?limit=17')).json();
  assert.equal(jobs.items.length, 17);
  assert.equal(jobs.total, 200);
  const controller = new AbortController();
  const response = await fetch(base + '/events', {
    headers: { 'Last-Event-ID': String(cursor) },
    signal: controller.signal,
  });
  const reader = response.body!.getReader();
  const chunk = await reader.read();
  const text = new TextDecoder().decode(chunk.value);
  controller.abort();
  assert.match(text, new RegExp(changed.id));
  assert.match(text, /revision/);
  assert.ok(!text.includes('规模测试'));
});

test('corrected basis remains held after head review flags clear before the next worker tick', async (t) => {
  const f = await fixture(t),
    ep = episode(f),
    entity = f.domain.save(f.project.id, 'entity', { name: '道具', type: 'object' });
  f.domain.dependencies(ep, [{ id: entity.id, revision: entity.revision }]);
  const job = f.service.generation(
    { ...entry(ep), approved: true, idempotencyKey: 'corrected-fast-review' },
    profile,
  );
  f.domain.impact(entity.id, true, '确认数量有误');
  const marked = f.store.get(ep.id);
  f.store.update(marked.id, marked.revision, { ...marked.data, stale: false, approved: true });
  const cloud = new Cloud(profile.baseUrl),
    worker = new Worker(f.store, f.root, () => cloud);
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.job(job.id).holdReason, 'dependencies_need_review');
  assert.equal(f.store.job(job.id).state, 'queued');
  assert.equal(cloud.posts, 0);
});
