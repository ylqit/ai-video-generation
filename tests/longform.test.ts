import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { edlSchema, type EditDecisionList, type RecordDoc } from '../src/shared/contracts.js';
import { clipGain, dramaturgyIssues } from '../src/shared/longform.js';
import { renderPlan, renderTimeline, type RenderCheckpoint } from '../src/server/render.js';
import { runProcess, hashFile, ingestAsset } from '../src/server/media.js';
import { config, prepareData } from '../src/server/config.js';
import { Worker } from '../src/server/worker.js';
import { grayportPlan } from './fixtures/longform-story.js';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { productionProgress } from '../src/server/production.js';
import { createApp } from '../src/server/app.js';

test('longform drafts stay blocked; production ignores offline fixtures and formal export requires target frames', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-longform-api-'));
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store);
  const server = createApp(store, root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'studio-longform-api-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${(server.address() as any).port}`,
    p = service.createProject({ title: '长片', mode: 'series', brief: '' });
  let ep = service.createEpisode(p.id, {});
  ep = service.saveEpisode(ep.id, ep.revision, grayportPlan());
  const old = ep;
  ep = service.approveEpisode(ep.id, ep.revision);
  assert.equal(store.get(old.id, old.revision).data.approved, false);
  assert.throws(
    () =>
      service.prepareGeneration(
        {
          episodeId: ep.id,
          episodeRevision: ep.revision,
          segmentId: ep.data.segments[0].id,
          width: 576,
          height: 1024,
          steps: 20,
          seed: 1,
        },
        { baseUrl: 'http://127.0.0.1:1', instanceId: 'mock' },
      ),
    /参考方案/,
  );
  const fixture = store.createJob(
    'generation',
    p.id,
    ep.id,
    { offlineFixture: true, segment: ep.data.segments[0] },
    'test-offline-generation',
  );
  store.patchJob(fixture.id, { state: 'succeeded' });
  const progress = productionProgress(store, ep.id);
  assert.equal(progress.attempts, 0);
  assert.equal(progress.adoptedSeconds, 0);
  assert.equal(progress.targetSeconds, 600);
  const response = await fetch(`${url}/api/episodes/${ep.id}/production`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).scenes.length, 10);
  const image = store.create('asset', p.id, {
    mediaType: 'image',
    adopted: true,
    path: 'fake.png',
    sha256: 'fixture-only',
  });
  const edl = service.saveEdl(p.id, {
    schemaVersion: 2,
    episodeId: ep.id,
    width: 128,
    height: 224,
    fps: 24,
    clips: [{ assetId: image.id, revision: 1, in: 0, out: 5, volume: 0 }],
    audio: [],
  });
  const denied = await fetch(`${url}/api/edls/${edl.id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ revision: edl.revision, idempotencyKey: 'test-incomplete-final' }),
  });
  assert.equal(denied.status, 201);
  assert.equal((await denied.json()).kind, 'export');
  const draft = await fetch(`${url}/api/edls/${edl.id}/export`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      revision: edl.revision,
      allowPartial: true,
      idempotencyKey: 'test-partial-draft',
    }),
  });
  assert.equal(draft.status, 201);
  assert.equal((await draft.json()).kind, 'export');
});

const timeline = (clips = 13): EditDecisionList => ({
  schemaVersion: 2,
  episodeId: 'e',
  width: 128,
  height: 224,
  fps: 24,
  clips: Array.from({ length: clips }, () => ({
    assetId: 'v',
    revision: 1,
    in: 0,
    out: 0.5,
    volume: 0.5,
  })),
  audio: [
    {
      assetId: 'v',
      revision: 1,
      in: 0,
      out: 1,
      start: 5.75,
      volume: 0.2,
      fadeInFrames: 6,
      fadeOutFrames: 6,
    },
  ],
});
test('authored ten-minute drama has 23 lines, complete setup/payoff, and two real six-second actions', () => {
  const plan = grayportPlan();
  assert.equal(
    plan.shots.reduce((n, s) => n + s.duration * 24, 0),
    14400,
  );
  assert.equal(plan.shots.filter((s) => s.dialogue).length, 23);
  for (const ids of [
    ['S04-08', 'S04-09', 'S04-10', 'S04-11'],
    ['S08-15', 'S08-16'],
  ])
    assert.equal(
      plan.shots.filter((s) => ids.includes(s.id)).reduce((n, s) => n + s.duration, 0),
      6,
    );
  assert.deepEqual(dramaturgyIssues(plan), []);
  assert.equal(plan.shots.filter((s) => s.production?.delivery === 'title').length, 2);
});
test('frame timelines validate boundaries without silently changing legacy trims', () => {
  const edl = timeline();
  assert.equal(renderPlan(edl).blocks.length, 2);
  assert.equal(renderPlan(edl).frames, 156);
  edl.clips[0].out = 0.51;
  assert.throws(() => edlSchema.parse(edl), /整帧/);
  delete edl.schemaVersion;
  edl.audio = [];
  assert.equal(edlSchema.parse(edl).clips[0].out, 0.51);
  assert.equal(
    clipGain({ in: 0, out: 2, volume: 0.8, fadeInFrames: 24, fadeOutFrames: 24 }, 0.5),
    0.4,
  );
});
test('dramaturgy rejects missing setup and inconsistent scene timing', () => {
  const issues = dramaturgyIssues({
    shots: [{ id: 's', duration: 5 }],
    dramaturgy: {
      version: 1,
      theme: 'test',
      targetFrames: 120,
      scenes: [
        {
          id: 'a',
          title: 'a',
          targetFrames: 119,
          goal: 'a',
          obstacle: 'b',
          action: 'c',
          outcome: 'd',
          shotIds: ['s'],
        },
      ],
      rules: [{ id: 'r', rule: 'r', setupShotIds: ['missing'], payoffShotIds: ['s'] }],
      plannedCanon: [],
    },
  });
  assert.ok(issues.some((i) => i.includes('时长')));
  assert.ok(issues.some((i) => i.includes('证据镜头')));
});
test('render resumes verified chunks after interrupted checkpoint publication, preserves frame count and global audio', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-longform-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, 'signal.mp4');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=128x224:r=24:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    source,
  ]);
  const a = {
    id: 'v',
    revision: 1,
    data: {
      path: 'signal.mp4',
      mediaType: 'video',
      hasAudio: true,
      sha256: await hashFile(source),
    },
  } as RecordDoc;
  let checkpoint: RenderCheckpoint | undefined;
  await assert.rejects(
    renderTimeline(timeline(), [a], root, path.join(root, 'run-one', 'export.mp4'), undefined, {
      save: (c) => {
        checkpoint = c;
        if (c.parts.length === 2) throw new Error('simulated exit');
      },
    }),
    /simulated exit/,
  );
  const saved = checkpoint!.parts.map((p) => p.path);
  const result = await renderTimeline(
    timeline(),
    [a],
    root,
    path.join(root, 'run-two', 'export.mp4'),
    undefined,
    {
      previous: checkpoint,
      save: (c) => {
        checkpoint = c;
      },
    },
  );
  assert.equal(result.frameCount, 156);
  assert.equal(result.duration, 6.5);
  assert.equal(result.hasAudio, true);
  assert.ok(checkpoint!.parts.some((p) => p.path === saved[0]));
  assert.ok(checkpoint!.parts.some((p) => p.path === saved[1]));
  await assert.rejects(fs.stat(path.join(root, 'run-two', 'video-0.mp4')), { code: 'ENOENT' });
  await fs.writeFile(path.join(root, saved[0]), 'damaged render part');
  const repaired = await renderTimeline(
    timeline(),
    [a],
    root,
    path.join(root, 'run-three', 'export.mp4'),
    undefined,
    {
      previous: checkpoint,
      save: (c) => {
        checkpoint = c;
      },
    },
  );
  assert.equal(repaired.frameCount, 156);
  assert.ok(checkpoint!.parts.some((p) => p.path === saved[1]));
  assert.ok(checkpoint!.parts.some((p) => p.path === path.join('run-three', 'video-0.mp4')));

  // Simulate exit after asset transaction, before the original export job is completed.
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite'));
  const service = new StudioService(store);
  const project = service.createProject({ title: '归档恢复', mode: 'short', brief: '' });
  const episode = service.createEpisode(project.id, {});
  const job = store.createJob(
    'export',
    project.id,
    episode.id,
    { edl: timeline(), assets: [a] },
    'interrupted-export',
  );
  const runDir = path.join(root, 'jobs', job.id, 'runs', 'stopped-owner');
  await fs.mkdir(runDir, { recursive: true });
  const file = path.join(runDir, 'export.mp4');
  await fs.copyFile(source, file);
  const imported = await ingestAsset(
    store,
    root,
    project.id,
    file,
    { category: 'export', jobId: job.id },
    { exportJobId: job.id },
  );
  store.patchJob(job.id, { state: 'running', output: {} });
  const worker = new Worker(store, root, undefined, undefined, async () => {
    throw new Error('already archived: renderer must not run');
  });
  try {
    await worker.tick();
    assert.equal(store.job(job.id).state, 'failed');
    assert.match(store.job(job.id).error || '', /本机执行中断/);
    // Existing explicit retry policy requeues the same job; it never creates a new attempt.
    store.patchJob(job.id, { state: 'queued', error: null });
    await worker.tick();
    assert.equal(store.job(job.id).state, 'succeeded', store.job(job.id).error || '');
    assert.deepEqual(store.job(job.id).output.assetIds, [imported.id]);
    assert.equal(store.list('asset', project.id).length, 1);
    assert.equal(
      (await fs.readdir(path.join(root, 'assets'))).filter((n) => n.startsWith('.incoming-'))
        .length,
      0,
    );
    await fs.writeFile(path.join(root, imported.data.path), 'corrupt stored media');
    await assert.rejects(
      ingestAsset(
        store,
        root,
        project.id,
        file,
        { category: 'export', jobId: job.id },
        { exportJobId: job.id },
      ),
      /拒绝覆盖历史资产/,
    );
  } finally {
    worker.stop();
    store.close();
  }
});
