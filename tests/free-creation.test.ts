import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CanvasService } from '../src/server/canvas.js';
import { ProductionAssistant } from '../src/server/production-assistant.js';
import { prepareCanvasGeneration } from '../src/server/canvas-generation.js';
import { configureModel } from './fixtures/models.js';
import { compileH3, ComfyClient } from '../src/server/comfy.js';
import { Worker } from '../src/server/worker.js';
import {
  previewFreeCreationMigration,
  applyFreeCreationMigration,
} from '../src/server/free-creation-migration.js';
import { taskSummary } from '../src/server/task-summary.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { codexOutputJsonSchema } from '../src/server/codex-output.js';

function fixture(t: any, maxSteps = 20) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const project = new StudioService(store).createProject({
    title: '自由作品',
    mode: 'series',
    brief: '',
  });
  const service = new CanvasService(store);
  let canvas = service.create(project.id, { version: 1, title: '测试画布', nodes: [], edges: [] });
  const text = configureModel(store, project.id, 'codex'),
    video = configureModel(store, project.id, 'comfy-h3');
  canvas = service.save(canvas.id, canvas.revision, {
    ...canvas.data,
    nodes: [
      {
        id: 'video',
        title: '校园',
        type: 'video',
        text: 'A student walks into a classroom.',
        x: 0,
        y: 0,
        generation: { model: video.selection, mode: 't2v', seconds: 5 },
      },
    ],
  });
  const assistant = new ProductionAssistant(store, '');
  const run = assistant.create(canvas.id, {
    revision: canvas.revision,
    goal: '写作并制作当前画布',
    models: [text.selection, video.selection],
    permissions: ['write', 'generate', 'select', 'edit', 'export'],
    budget: { maxSteps, videoRequests: 1, videoSeconds: 5 },
    idempotencyKey: crypto.randomUUID(),
  });
  return { store, project, service, canvas, assistant, run, video };
}
async function decide(f: ReturnType<typeof fixture>, action: string, request: any = null) {
  let run = await f.assistant.advance(f.run.id);
  const job = f.store.job(run.data.pendingDecision);
  f.assistant.completeDecision(job, {
    action,
    reason: 'offline decision',
    requirementId: null,
    request: request === null ? null : JSON.stringify(request),
  });
  f.store.patchJob(job.id, { state: 'succeeded' });
  await f.assistant.advance(run.id);
  return f.assistant.advance(run.id);
}

test('blank canvas shares versioned documents and protects concurrent user edits', (t) => {
  const f = fixture(t),
    old = f.service.get(f.canvas.id);
  const next = f.service.save(old.id, old.revision, {
    ...old.data,
    nodes: [
      ...old.data.nodes,
      { id: 'script', type: 'document', title: '剧本', text: '原创正文', x: 20, y: 20 },
    ],
  });
  const node = next.data.nodes.find((n: any) => n.id === 'script');
  assert.equal(f.store.get(node.document.id).data.content, '原创正文');
  assert.equal(next.data.agentRunId, f.run.id);
  assert.throws(() => f.service.save(old.id, old.revision, old.data), /画布/);
  assert.equal(f.store.list('generation_review').length, 0);
});

test('unreviewed media enters a standalone EDL and an immutable export job without fake approvals', (t) => {
  const f = fixture(t),
    a = f.store.create('asset', f.project.id, {
      mediaType: 'video',
      duration: 5,
      frames: 120,
      fps: 24,
      path: 'fake.mp4',
      adopted: false,
    });
  const current = f.service.get(f.canvas.id);
  const edl = f.service.saveTimeline(current.id, current.revision, {
    schemaVersion: 3,
    episodeId: '',
    width: 128,
    height: 128,
    fps: 24,
    clips: [{ id: 'c', assetId: a.id, revision: 1, in: 0, out: 5, volume: 1 }],
    audio: [],
  });
  const next = f.service.get(current.id),
    body = {
      revision: next.revision,
      edl: { id: edl.id, revision: edl.revision },
      idempotencyKey: crypto.randomUUID(),
    };
  const job = f.service.export(current.id, body);
  assert.equal(f.service.export(current.id, body).id, job.id);
  assert.equal(job.input.edl.clips[0].out, 5);
  assert.equal(f.store.get(a.id).data.adopted, false);
  assert.equal(f.store.list('generation_review').length, 0);
  assert.equal(f.store.list('assembly_review').length, 0);
  assert.throws(
    () =>
      f.service.saveTimeline(current.id, next.revision, {
        ...edl.data,
        clips: [{ ...edl.data.clips[0], out: 6 }],
      }),
    /范围|长度|区间|超出|超过/,
  );
});

test('canvas H3 identity and first-frame bindings share actual image labels but keep guide duties', (t) => {
  const f = fixture(t),
    asset = f.store.create('asset', f.project.id, {
      name: 'identity',
      mediaType: 'image',
      width: 1024,
      height: 576,
      bytes: 123,
      path: 'image.png',
      sha256: 'fixed',
      adopted: false,
    });
  let c = f.service.get(f.canvas.id);
  const node = {
    ...c.data.nodes[0],
    generation: { ...c.data.nodes[0].generation, mode: 'ref2va' },
  };
  c = f.service.save(c.id, c.revision, {
    ...c.data,
    nodes: [
      node,
      {
        id: 'image',
        type: 'image',
        title: '参考',
        x: 0,
        y: 200,
        text: '',
        asset: { id: asset.id, revision: 1 },
      },
    ],
    edges: [
      { id: 'anchor', source: 'image', target: 'video', relation: 'input', purpose: 'first_frame' },
      { id: 'identity', source: 'image', target: 'video', relation: 'input', purpose: 'identity' },
    ],
  });
  const p = prepareCanvasGeneration(f.store, c.id, 'video');
  assert.deepEqual(prepareCanvasGeneration(f.store, c.id, 'video'), p);
  assert.equal(p.input.prepared.images.length, 1);
  assert.deepEqual(
    p.input.prepared.inputBindings.map((b: any) => b.label),
    ['<Picture 1>', '<Picture 1>'],
  );
  assert.equal(p.input.prepared.anchors[0].resolvedFrameIndex, 0);
  const graph = compileH3(p.input, new Map([[asset.id + ':1', 'image.png']]), 'offline');
  assert.match(graph.condition.inputs.prompt, /subject_definitions/);
  assert.equal(f.store.jobs().length, 0);
});

test('agent persists intent before execution, submits once without per-request approval and waits on unknown acceptance', async (t) => {
  const f = fixture(t);
  let run = await decide(f, 'generate', { nodeId: 'video' });
  assert.equal(run.data.state, 'waiting_job');
  const id = run.data.waiting.jobs[0],
    count = f.store.jobs().length;
  f.store.patchJob(id, { state: 'unknown' });
  const recovered = new ProductionAssistant(f.store, '');
  for (let i = 0; i < 4; i++) await recovered.advance(run.id);
  assert.equal(f.store.jobs().length, count);
  run = recovered.control(run.id, { revision: recovered.get(run.id).revision, action: 'pause' });
  assert.equal(run.data.state, 'paused');
  assert.equal(f.store.job(id).state, 'unknown');
  f.store.patchJob(id, { state: 'succeeded' });
  run = recovered.control(run.id, { revision: run.revision, action: 'resume' });
  run = await recovered.advance(run.id);
  assert.equal(run.data.state, 'active');
  assert.match(run.data.note, /尚未观察/);
  run = await decide(f, 'generate', { nodeId: 'video' });
  assert.equal(run.data.state, 'paused');
  assert.match(run.data.note, /预算/);
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 1);
});

test('two ineffective decisions pause; budget never resets on resume; repeated receipts are exact', async (t) => {
  const f = fixture(t, 2);
  assert.equal((await decide(f, 'inspect')).data.state, 'active');
  let run = await decide(f, 'inspect');
  assert.equal(run.data.state, 'paused');
  assert.match(run.data.note, /两次/);
  const job = f.store.job(run.data.steps[0].jobId),
    decision = run.data.steps[0].decision;
  assert.equal(f.assistant.completeDecision(job, decision).revision, run.revision);
  assert.throws(() => f.assistant.completeDecision(job, { ...decision, action: 'finish' }), /回执/);
  run = f.assistant.control(run.id, { revision: run.revision, action: 'resume' });
  run = await f.assistant.advance(run.id);
  assert.equal(run.data.state, 'paused');
  assert.match(run.data.note, /预算/);
  assert.equal(codexOutputJsonSchema('assistant').properties.contractRevision, undefined);
});

test('changed canvas invalidates an in-flight decision before any paid submission', async (t) => {
  const f = fixture(t);
  let run = await f.assistant.advance(f.run.id);
  const job = f.store.job(run.data.pendingDecision);
  f.assistant.completeDecision(job, {
    action: 'generate',
    reason: 'offline',
    requirementId: null,
    request: JSON.stringify({ nodeId: 'video' }),
  });
  f.store.patchJob(job.id, { state: 'succeeded' });
  const c = f.service.get(f.canvas.id);
  f.service.save(c.id, c.revision, { ...c.data, title: '用户修改' });
  run = await f.assistant.advance(run.id);
  assert.equal(run.data.state, 'paused');
  assert.match(run.data.note, /变化/);
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
});

test('original Worker executes a scoped decision and waits without media-understanding claims', async (t) => {
  const previous = process.env.STUDIO_PROTOCOL_TEST_KEY;
  process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline';
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'free-agent-'));
  t.after(async () => {
    if (previous === undefined) delete process.env.STUDIO_PROTOCOL_TEST_KEY;
    else process.env.STUDIO_PROTOCOL_TEST_KEY = previous;
    await fs.rm(root, { recursive: true, force: true });
  });
  const f = fixture(t, 1),
    worker = new Worker(f.store, root, undefined, async (context) => {
      assert.equal(context.mode, 'assistant');
      return { action: 'wait', reason: '需要实际素材', requirementId: null, request: null };
    });
  t.after(() => worker.stop());
  for (let i = 0; i < 4; i++) await worker.tick();
  const run = f.assistant.get(f.run.id);
  assert.equal(run.data.state, 'waiting_input', run.data.note);
  assert.equal(run.data.receipts[0].action, 'wait');
  const count = f.store.jobs().length;
  await worker.tick();
  assert.equal(f.store.jobs().length, count);
});

test('fixed canvas and EDL assets do not silently upgrade to a newer media version', (t) => {
  const f = fixture(t),
    a = f.store.create('asset', f.project.id, {
      name: 'source',
      mediaType: 'video',
      duration: 5,
      path: 'v1.mp4',
    });
  const c = f.service.get(f.canvas.id);
  f.service.save(c.id, c.revision, {
    ...c.data,
    nodes: [
      ...c.data.nodes,
      { id: 'old', type: 'video', title: '旧版本', x: 0, y: 0, asset: { id: a.id, revision: 1 } },
    ],
  });
  f.store.update(a.id, 1, { ...a.data, duration: 3, path: 'v2.mp4' });
  const snap = f.service.snapshot(c.id);
  assert.equal(snap.assets.find((v) => v.id === a.id && v.revision === 1)?.data.duration, 5);
  assert.equal(snap.library.find((v) => v.id === a.id)?.revision, 2);
});

test('queued scoped generation stops on pause while accepted jobs and selection remain independent of review', async (t) => {
  const f = fixture(t);
  let run = await decide(f, 'generate', { nodeId: 'video' });
  const job = f.store.job(run.data.waiting.jobs[0]);
  run = f.assistant.control(run.id, { revision: run.revision, action: 'pause' });
  assert.equal(f.store.job(job.id).holdReason, 'assistant_paused');
  run = f.assistant.control(run.id, { revision: run.revision, action: 'resume' });
  assert.equal(f.store.job(job.id).holdReason, null);
  f.store.patchJob(job.id, { state: 'submitted', promptId: 'real-accepted-id' });
  run = f.assistant.control(run.id, { revision: run.revision, action: 'stop' });
  assert.equal(f.store.job(job.id).state, 'submitted');
  f.store.patchJob(job.id, { state: 'succeeded' });
  const a = f.store.create('asset', f.project.id, {
    name: 'candidate',
    mediaType: 'video',
    category: 'generated',
    jobId: job.id,
    duration: 5,
    path: 'candidate.mp4',
  });
  const c = f.service.collect(f.canvas.id, [job.id]);
  const n = c.data.nodes.find((n: any) => n.asset?.id === a.id);
  n.selected = true;
  f.service.save(c.id, c.revision, c.data);
  const summary = taskSummary(f.store, { projectId: f.project.id });
  const result = summary.items.find((j) => j.id === job.id)!;
  assert.equal(result.canvasId, c.id);
  assert.equal(result.quality, 'adopted');
  assert.equal(taskSummary(f.store, { projectId: f.project.id, attention: '1' }).total, 0);
  assert.equal(f.store.list('generation_review').length, 0);
});

test('explicit free-creation migration is additive, checks races and leaves frozen tasks and media untouched', (t) => {
  const f = fixture(t),
    chapter = f.store.create(
      'chapter',
      f.project.id,
      { title: '原文', content: '历史正文' },
      f.project.id,
    );
  const legacy = f.store.create(
    'assistant_run',
    f.project.id,
    { version: 1, state: 'active' },
    f.project.id,
  );
  const job = f.store.createJob(
    'export',
    f.project.id,
    null,
    { name: 'frozen', asset: { id: 'preserved', revision: 1 } },
    'migration-frozen',
  );
  f.store.patchJob(job.id, { state: 'submitted', promptId: 'remote-fixed' });
  const prior = JSON.stringify(f.store.job(job.id)),
    history = JSON.stringify(f.store.get(chapter.id, 1));
  const stale = previewFreeCreationMigration(f.store);
  f.store.update(chapter.id, 1, { ...chapter.data, content: '当前正文' });
  assert.throws(() => applyFreeCreationMigration(f.store, stale.digest), /变化/);
  const preview = previewFreeCreationMigration(f.store);
  const result = applyFreeCreationMigration(f.store, preview.digest);
  assert.equal(result.created.length, 1);
  assert.equal(f.store.get(legacy.id).data.state, 'paused');
  assert.equal(JSON.stringify(f.store.job(job.id)), prior);
  assert.equal(JSON.stringify(f.store.get(chapter.id, 1)), history);
  const again = previewFreeCreationMigration(f.store);
  assert.equal(again.projects[0].targets.length, 0);
  assert.equal(applyFreeCreationMigration(f.store, again.digest).created.length, 0);
  assert.equal(f.store.list('generation_review').length, 0);
});

test('pausing during Comfy input preparation prevents submission and resumes the same frozen task', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'free-pause-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const f = fixture(t);
  let run = await decide(f, 'generate', { nodeId: 'video' });
  const id = run.data.waiting.jobs[0];
  let validated!: () => void,
    continueInput!: () => void,
    submissions = 0;
  const entered = new Promise<void>((resolve) => (validated = resolve)),
    wait = new Promise<void>((resolve) => (continueInput = resolve));
  class MockComfy extends ComfyClient {
    override async validate() {
      validated();
      await wait;
    }
    override async submit() {
      submissions++;
      return 'accepted-once';
    }
  }
  const client = new MockComfy('http://127.0.0.1:9'),
    worker = new Worker(f.store, root, () => client);
  t.after(() => worker.stop());
  const tick = worker.tick();
  await entered;
  run = f.assistant.control(run.id, {
    revision: f.assistant.get(run.id).revision,
    action: 'pause',
  });
  continueInput();
  await tick;
  assert.equal(submissions, 0);
  assert.equal(f.store.job(id).state, 'queued');
  assert.equal(f.store.job(id).holdReason, 'assistant_paused');
  f.assistant.control(run.id, { revision: run.revision, action: 'resume' });
  await worker.tick();
  assert.equal(submissions, 1);
  assert.equal(f.store.job(id).promptId, 'accepted-once');
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 1);
});

test('local agent cannot rewrite another document through an alias or export unrelated timeline media', async (t) => {
  const f = fixture(t),
    source = f.store.create(
      'chapter',
      f.project.id,
      { title: '受保护文档', content: '不可改写' },
      f.project.id,
    );
  let run = f.assistant.get(f.run.id);
  f.store.update(run.id, run.revision, { ...run.data, nodeIds: ['video'] });
  run = await decide(f, 'write', {
    node: {
      id: 'alias',
      type: 'document',
      title: source.data.title,
      text: '越界修改',
      document: { id: source.id, revision: source.revision },
      x: 0,
      y: 0,
    },
  });
  assert.equal(run.data.state, 'paused');
  assert.match(run.data.note, /授权范围外/);
  assert.equal(f.store.get(source.id).data.content, '不可改写');
  const a = f.store.create('asset', f.project.id, {
      mediaType: 'video',
      duration: 5,
      path: 'other.mp4',
    }),
    c = f.service.get(f.canvas.id);
  f.service.saveTimeline(c.id, c.revision, {
    schemaVersion: 3,
    episodeId: '',
    width: 128,
    height: 128,
    fps: 24,
    clips: [{ id: 'other', assetId: a.id, revision: 1, in: 0, out: 5, volume: 1 }],
    audio: [],
  });
  f.assistant.control(run.id, { revision: run.revision, action: 'resume' });
  run = await decide(f, 'export');
  assert.equal(run.data.state, 'paused');
  assert.match(run.data.note, /未授权素材/);
  assert.equal(f.store.jobs().filter((j) => j.kind === 'export').length, 0);
});

test('agent counts new inventory and operation information as progress but pauses repeated empty inspection', async (t) => {
  const f = fixture(t);
  let run = await decide(f, 'inspect', { library: 'image' });
  assert.equal(run.data.noProgress, 0);
  run = await decide(f, 'inspect', { operation: 'synthesize' });
  assert.equal(run.data.noProgress, 0);
  assert.ok(run.data.receipts.at(-1).result.requestSchema);
  run = await decide(f, 'inspect', { library: 'image' });
  assert.equal(run.data.state, 'active');
  assert.equal(run.data.noProgress, 1);
  run = await decide(f, 'inspect', { library: 'image' });
  assert.equal(run.data.state, 'paused');
  assert.equal(run.data.noProgress, 2);
});
