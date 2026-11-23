import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CreationService } from '../src/server/creation.js';
import { WorkspaceService, resolveScope } from '../src/server/workspace.js';
import { registerWorkspaceRoutes } from '../src/server/workspace-routes.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { fixture } from './fixtures/workspace.js';
import { authoringPrompt } from '../src/server/creation-prompts.js';
import { ReadinessService } from '../src/server/readiness.js';
import { executionTextFields } from '../src/shared/execution-text.js';

test('scoped execution wording freezes alongside Chinese authoring and changes invalidate only the new preparation', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.direction.visual = '自然柔光';
    outputs.director.shots[0].visualTreatment = '自然柔光';
    outputs.script.subjects[0].description = '银色设备';
    outputs.script.scenes[0].events[0].description = '设备亮起';
  });
  const english: Record<string, string> = {
    '/director/shots/0/visualTreatment': 'Soft natural light.',
    '/script/subjects/0/description': 'A silver device.',
    '/script/scenes/0/events/0/description': 'The device lights up.',
  };
  const entries = executionTextFields(f.creation.adopted(f.run))
    .filter((e) => english[e.path])
    .map(({ path, source }) => ({ path, source, text: english[path] }));
  const originalResults = structuredClone(f.run.data.results);
  const input = {
    name: 'Wording',
    mode: 'selection',
    groupIds: ['P01'],
    executionText: { reviewed: true, entries },
  };
  const chosen = f.workspace.saveScope(f.run.id, f.run.revision, input, true);
  const preview = f.workspace.preview(chosen.scope.id, chosen.scope.revision, f.run.revision);
  assert.deepEqual(preview.issues, []);
  assert.equal(preview.preview.inputs.length, 1);
  const prepared = JSON.stringify(preview.preview.inputs[0].prepared);
  assert.ok(prepared.includes('Soft natural light.'));
  assert.ok(prepared.includes('The device lights up.'));
  const submitted = f.workspace.submit(
    chosen.scope.id,
    chosen.scope.revision,
    f.run.revision,
    preview.preview.digest,
    'wording-once',
  );
  const job = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
  const frozen = structuredClone(job.input);
  assert.deepEqual(job.input.executionText.entries, entries);
  assert.deepEqual(f.run.data.results, originalResults);
  assert.equal(
    f.creation.adopted(f.run).direction?.stage === 'direction' &&
      (f.creation.adopted(f.run).direction as any).visual,
    '自然柔光',
  );
  const count = f.store.list('creation_scope', f.project.id).length;
  assert.throws(
    () =>
      f.workspace.saveScope(
        f.run.id,
        f.run.revision,
        {
          ...input,
          executionText: { reviewed: true, entries: [{ ...entries[0], source: 'wrong baseline' }] },
        },
        true,
      ),
    /原文已变化/,
  );
  assert.equal(f.store.list('creation_scope', f.project.id).length, count);
  const changed = f.workspace.saveScope(
    f.run.id,
    f.run.revision,
    {
      ...input,
      executionText: {
        reviewed: true,
        entries: entries.map((e, i) => (i ? e : { ...e, text: 'Soft diffused natural light.' })),
      },
    },
    true,
  );
  assert.equal(f.run.data.productionPreview, null);
  const next = f.workspace.preview(changed.scope.id, changed.scope.revision, f.run.revision);
  assert.notEqual(next.preview.digest, preview.preview.digest);
  assert.deepEqual(f.store.job(job.id).input, frozen);
});
test('workspace GET is pure and full60 stays separate from scoped12 and out-of-scope imagery', async (t) => {
  const f = fixture(t, true),
    selected = f.select();
  const app = express();
  registerWorkspaceRoutes(app, f.store);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const before = generationDigest({
    docs: f.store.list(),
    jobs: f.store.jobs(),
    events: f.store.events(),
    settings: f.store.db.prepare('SELECT * FROM settings').all(),
    revisions: f.store.db.prepare('SELECT * FROM revisions').all(),
  });
  const response = await fetch(
    `http://127.0.0.1:${(server.address() as any).port}/api/projects/${f.project.id}/workspace?runId=${f.run.id}`,
  );
  assert.equal(response.status, 200);
  const snapshot = await response.json();
  assert.equal(snapshot.timing.totalFrames, 1440);
  assert.equal(snapshot.timing.requestedFrames, 288);
  assert.deepEqual(snapshot.scope.data.windows, [
    { shotId: 'shot1', startFrame: 0, endFrame: 288 },
  ]);
  assert.equal(snapshot.results.director.data.result.shots.length, 5);
  assert.equal(snapshot.requirements[0].inScope, false);
  assert.deepEqual([...new Set(snapshot.cards.map((c: any) => c.group))].sort(), [
    'scenes/shots',
    'story/direction',
    'subjects/references',
  ]);
  assert.equal(
    generationDigest({
      docs: f.store.list(),
      jobs: f.store.jobs(),
      events: f.store.events(),
      settings: f.store.db.prepare('SELECT * FROM settings').all(),
      revisions: f.store.db.prepare('SELECT * FROM revisions').all(),
    }),
    before,
  );
  const preview = f.workspace.preview(selected.scope.id, selected.scope.revision, f.run.revision);
  assert.ok(preview.preview, JSON.stringify(preview.issues));
  assert.equal(preview.preview.groups.length, 1);
  assert.equal(preview.preview.groups[0].id, 'P01');
  assert.equal(preview.preview.groups[0].seconds, 12);
  assert.equal(preview.preview.groups[0].seed, 2026091401);
  assert.equal(f.creation.allowance(f.project.id).usedGenerations, 0);
  assert.equal(f.store.jobs(f.project.id).filter((j) => j.kind === 'generation').length, 0);
  assert.equal(f.run.data.results.director.revision, snapshot.results.director.revision);
});

test('scope submit uses atomic allowance and accepted or unknown replay never changes frozen jobs', (t) => {
  const f = fixture(t),
    selection = f.select();
  const preview = f.workspace.preview(selection.scope.id, 1, f.run.revision);
  const key = crypto.randomUUID();
  const accepted = f.workspace.submit(
    selection.scope.id,
    1,
    f.run.revision,
    preview.preview.digest,
    key,
  );
  assert.equal(accepted.jobs.length, 1);
  const job = accepted.jobs[0];
  assert.deepEqual(job.input.creationScope, { id: selection.scope.id, revision: 1 });
  assert.equal(job.input.creationCharge.seconds, 12);
  f.store.patchJob(job.id, { state: 'unknown' });
  const frozen = generationDigest(f.store.job(job.id));
  const changed = f.workspace.saveScope(
    f.run.id,
    f.run.revision,
    {
      name: 'P02',
      mode: 'selection',
      groupIds: ['P02'],
      output: { ...selection.scope.data.output, seed: 7 },
    },
    true,
    selection.scope.id,
    1,
  );
  assert.equal(changed.scope.revision, 2);
  assert.equal(generationDigest(f.store.job(job.id)), frozen);
  const replay = f.workspace.submit(
    selection.scope.id,
    1,
    accepted.run.revision,
    preview.preview.digest,
    key,
  );
  assert.equal(replay.jobs[0].state, 'unknown');
  assert.equal(f.creation.allowance(f.project.id).usedGenerations, 1);
  assert.equal(f.creation.allowance(f.project.id).usedSeconds, 12);
  assert.throws(
    () => f.workspace.submit(selection.scope.id, 2, f.run.revision, preview.preview.digest, key),
    /其他输入/,
  );
  const before = generationDigest(f.store.job(job.id));
  f.workspace.preview(changed.scope.id, 2, f.run.revision);
  assert.equal(generationDigest(f.store.job(job.id)), before);
  assert.equal(f.creation.allowance(f.project.id).usedSeconds, 12);
});

test('original V9 cannot generate through an existing production projection and frozen requests remain unchanged', (t) => {
  const f = fixture(t),
    selection = f.select();
  const preview = f.workspace.preview(selection.scope.id, 1, f.run.revision);
  const submitted = f.workspace.submit(
    selection.scope.id,
    1,
    f.run.revision,
    preview.preview.digest,
    crypto.randomUUID(),
  );
  const job = submitted.jobs[0],
    frozen = generationDigest(f.store.job(job.id));
  const current = f.run,
    ref = current.data.results.director,
    record = f.store.get(ref.id, ref.revision);
  const old = structuredClone(record.data);
  delete old.result.contractRevision;
  const legacy = f.store.update(record.id, record.revision, old);
  f.store.update(current.id, current.revision, {
    ...current.data,
    results: { ...current.data.results, director: { id: legacy.id, revision: legacy.revision } },
  });
  const episode = f.store.get(current.data.episodeId);
  const beforeAdvance = generationDigest(f.run);
  f.creation.advance(current.id);
  assert.equal(generationDigest(f.run), beforeAdvance);
  assert.throws(
    () =>
      new StudioService(f.store).prepareGeneration(
        {
          episodeId: episode.id,
          episodeRevision: episode.revision,
          segmentId: episode.data.segments[0].id,
          width: 1280,
          height: 736,
          steps: 20,
          seed: 1,
        },
        f.store.setting<any>('comfy', null),
      ),
    /原 V9/,
  );
  assert.equal(generationDigest(f.store.job(job.id)), frozen);
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 1);
});

test('foreign ownership and stale scope versions reject; layout changes only the layout record', (t) => {
  const f = fixture(t),
    selected = f.select();
  const snapshot = f.workspace.snapshot(f.project.id, f.run.id),
    before = generationDigest(f.run);
  const layout = f.workspace.saveLayout(f.project.id, 0, {
    positions: { 'shot:shot1': { x: 50, y: 30 } },
    assistantWidth: 440,
  });
  assert.equal(layout.revision, 1);
  assert.equal(generationDigest(f.run), before);
  assert.equal(f.store.get(snapshot.results.director!.id).data.stale, false);
  assert.throws(() => f.workspace.saveLayout(f.project.id, 0, {}), /布局已变化/);
  assert.throws(
    () =>
      f.workspace.saveScope(f.run.id, f.run.revision - 1, { name: 'stale', mode: 'full' }, true),
    /运行已变化/,
  );
  const other = f.studio.createProject({ title: 'Other', mode: 'short', brief: '' });
  assert.throws(() => f.workspace.snapshot(other.id, f.run.id), /不属于/);
  const foreign = f.store.create('creation_scope', other.id, selected.scope.data, 'foreign-run');
  assert.throws(() => resolveScope(f.store, f.run, { id: foreign.id, revision: 1 }), /不属于/);
  f.store.update(selected.scope.id, selected.scope.revision, {
    ...selected.scope.data,
    version: 2,
  });
  assert.throws(() => resolveScope(f.store, f.run), /版本已变化/);
});

test('all epochs of the same group and their source-linked exports remain in snapshot', (t) => {
  const f = fixture(t);
  for (let epoch = 1; epoch <= 3; epoch++) {
    const job = f.store.createJob(
      'generation',
      f.project.id,
      f.run.data.episodeId,
      {
        creationRunId: f.run.id,
        creationEpoch: epoch,
        profile: f.store.setting('comfy', null),
        segment: { id: 'P01', shotIds: ['shot1'], duration: 12 },
      },
      `epoch-${epoch}`,
    );
    const video = f.store.create(
      'asset',
      f.project.id,
      {
        jobId: job.id,
        mediaType: 'video',
        category: 'generated',
        name: `Attempt ${epoch}`,
        duration: 12,
        frameCount: 288,
      },
      f.run.data.episodeId,
    );
    f.store.patchJob(job.id, { state: 'succeeded', output: { assetIds: [video.id] } });
    const exportJob = f.store.createJob(
      'export',
      f.project.id,
      f.run.data.episodeId,
      { assets: [video], edl: { clips: [{ assetId: video.id, revision: video.revision }] } },
      `export-${epoch}`,
    );
    const output = f.store.create('asset', f.project.id, {
      jobId: exportJob.id,
      mediaType: 'video',
      category: 'export',
      name: `Review ${epoch}`,
      duration: 12,
    });
    f.store.patchJob(exportJob.id, { state: 'succeeded', output: { assetIds: [output.id] } });
    f.store.create(
      'generation_review',
      f.project.id,
      { video: { id: video.id, revision: video.revision }, inspected: true, adopted: false },
      f.run.data.episodeId,
    );
  }
  const snapshot = f.workspace.snapshot(f.project.id, f.run.id);
  assert.equal(snapshot.candidates.length, 3);
  assert.deepEqual(
    snapshot.candidates.map((c) => c.epoch),
    [1, 2, 3],
  );
  assert.ok(snapshot.candidates.every((c) => c.exports.length === 1 && c.review && c.video));
  assert.equal(snapshot.edges.filter((e) => e.relation === 'exported').length, 3);
  assert.equal(snapshot.timing.actualFrames, 864);
  assert.equal(snapshot.timing.adoptedFrames, 0);
  assert.ok(snapshot.jobs.every((j) => !('input' in j)));
});

test('direct editor drafts use fixed baselines and cannot modify unselected objects', (t) => {
  const f = fixture(t),
    baseline = f.run.data.results.director;
  const original = f.store.get(baseline.id, baseline.revision).data.result;
  const forged = structuredClone(original);
  forged.shots[1].action = 'Unauthorized second shot edit';
  const before = generationDigest({ run: f.run, jobs: f.store.jobs(), docs: f.store.list() });
  assert.throws(
    () =>
      f.creation.editResult(f.run.id, 'director', forged, f.run.revision, baseline, {
        shotIds: ['shot1'],
        sceneIds: [],
      }),
    /未选择对象/,
  );
  assert.equal(
    generationDigest({ run: f.run, jobs: f.store.jobs(), docs: f.store.list() }),
    before,
  );
  const edited = structuredClone(original);
  edited.shots[0].action = 'Camera observes the silver device in a steady close-up.';
  const count = f.store.jobs().length;
  const draft = f.creation.editResult(f.run.id, 'director', edited, f.run.revision, baseline, {
    shotIds: ['shot1'],
    sceneIds: [],
  });
  assert.equal(draft.data.adopted, true);
  assert.equal(f.store.jobs().length, count);
  const tampered = structuredClone(draft.data.result);
  tampered.shots[2].action = 'Tampered third shot';
  const updated = f.store.update(draft.id, draft.revision, { ...draft.data, result: tampered });
  assert.throws(
    () => f.creation.approve(f.run.id, updated.id, updated.revision, crypto.randomUUID()),
    /当前专业阶段/,
  );
  assert.deepEqual(f.creation.get(f.run.id).data.results.director, {
    id: draft.id,
    revision: draft.revision,
  });
  assert.deepEqual(f.store.get(draft.id, draft.revision).data.result, edited);
});

test('new runs have an explicitly pending full scope and missing scopes are never inferred', (t) => {
  const f = fixture(t);
  const run = f.creation.create(f.project.id, {
    request: 'A new draft without imagery',
    idempotencyKey: crypto.randomUUID(),
  });
  const scope = f.store.get(run.data.scope.id, run.data.scope.revision);
  assert.equal(scope.data.pending, true);
  assert.equal(scope.data.mode, 'full');
  assert.throws(() => resolveScope(f.store, run), /导演计划/);
  assert.throws(
    () => resolveScope(f.store, { ...run, data: { ...run.data, scope: null } }),
    /缺少执行范围/,
  );
});

test('local authoring revision invalidates only scopes whose actual objects changed', (t) => {
  const f = fixture(t);
  const changedScope = f.select('P01').scope;
  const unchangedScope = f.select('P02').scope;
  const baseline = f.run.data.results.director;
  const priorAssets = f.run.data.results.assets;
  const result = structuredClone(f.store.get(baseline.id, baseline.revision).data.result);
  result.shots[0].action = 'The same silver device is observed from a steady angle.';
  const draft = f.creation.editResult(f.run.id, 'director', result, f.run.revision, baseline, {
    shotIds: ['shot1'],
    sceneIds: [],
  });
  f.creation.approve(f.run.id, draft.id, draft.revision, crypto.randomUUID());
  assert.deepEqual(f.run.data.results.assets, priorAssets);
  assert.equal(f.run.data.stage, 'production');
  assert.equal(
    resolveScope(f.store, f.run, { id: unchangedScope.id, revision: 1 }).id,
    unchangedScope.id,
  );
  const preview = f.workspace.preview(unchangedScope.id, 1, f.run.revision);
  assert.ok(preview.preview, JSON.stringify(preview.issues));
  assert.equal(preview.preview.groups[0].id, 'P02');
  assert.throws(
    () => resolveScope(f.store, f.run, { id: changedScope.id, revision: 1 }),
    /已修订对象/,
  );
  assert.equal(
    f.store.get(baseline.id, baseline.revision).data.result.shots[0].action,
    f.outputs.director.shots[0].action,
  );
});

test('materializing a second scope preserves outside drafts and authoring order', (t) => {
  const f = fixture(t);
  const first = f.select('P03');
  f.workspace.preview(first.scope.id, 1, f.run.revision);
  const before = f.store.get(f.run.data.episodeId).data.shots.find((s: any) => s.id === 'shot3');
  const second = f.select('P02');
  f.workspace.preview(second.scope.id, 1, f.run.revision);
  const episode = f.store.get(f.run.data.episodeId);
  assert.deepEqual(
    episode.data.shots.map((s: any) => s.id),
    ['shot2', 'shot3'],
  );
  assert.deepEqual(
    episode.data.shots.find((s: any) => s.id === 'shot3'),
    before,
  );
  assert.equal(
    f.workspace.snapshot(f.project.id, f.run.id).results.director!.data.result.shots.length,
    5,
  );
});

test('reading creation policy, allowance, and empty workspace never initializes settings', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const project = new StudioService(store).createProject({
    title: 'Empty',
    mode: 'short',
    brief: '',
  });
  const creation = new CreationService(store);
  const before = generationDigest({ docs: store.list(), events: store.events() });
  assert.equal(creation.settings(project.id).id, null);
  assert.equal(creation.settings(project.id).revision, 0);
  assert.equal(creation.allowance(project.id).usedGenerations, 0);
  assert.equal(new WorkspaceService(store).snapshot(project.id).run, null);
  assert.equal(generationDigest({ docs: store.list(), events: store.events() }), before);
});

test('partial multi-shot group keeps full draft membership while only selected shots reach readiness and submit', (t) => {
  const f = fixture(t, false, true);
  const full = f.select('P01');
  f.workspace.preview(full.scope.id, 1, f.run.revision);
  const before = f.store.get(f.run.data.episodeId);
  const fullGroup = structuredClone(before.data.segments.find((g: any) => g.id === 'P01'));
  const outsideShot = structuredClone(before.data.shots.find((s: any) => s.id === 'shot1b'));
  assert.deepEqual(fullGroup.shotIds, ['shot1', 'shot1b']);
  const partial = f.workspace.saveScope(
    f.run.id,
    f.run.revision,
    {
      name: 'First shot only',
      mode: 'selection',
      shotIds: ['shot1'],
      output: full.scope.data.output,
    },
    true,
  );
  const preview = f.workspace.preview(partial.scope.id, 1, f.run.revision);
  assert.ok(preview.preview, JSON.stringify(preview.issues));
  const episode = f.store.get(f.run.data.episodeId);
  assert.deepEqual(
    episode.data.segments.find((g: any) => g.id === 'P01'),
    fullGroup,
  );
  assert.deepEqual(
    episode.data.shots.find((s: any) => s.id === 'shot1b'),
    outsideShot,
  );
  assert.deepEqual(preview.preview.inputs[0].segment.shotIds, ['shot1']);
  assert.deepEqual(
    preview.preview.inputs[0].planning.shots.map((s: any) => s.id),
    ['shot1'],
  );
  assert.equal(preview.preview.inputs[0].segment.duration, 6);
  assert.equal(f.creation.allowance(f.project.id).usedGenerations, 0);
  const submitted = f.workspace.submit(
    partial.scope.id,
    1,
    f.run.revision,
    preview.preview.digest,
    crypto.randomUUID(),
  );
  assert.deepEqual(submitted.jobs[0].input.segment.shotIds, ['shot1']);
  assert.equal(submitted.jobs[0].input.creationCharge.seconds, 6);
  const frozen = generationDigest(submitted.jobs[0]);
  const run = f.run;
  f.store.update(run.id, run.revision, {
    ...run.data,
    materialized: {
      ...run.data.materialized,
      segments: [{ ...run.data.materialized.segments[0], shotIds: ['shot1', 'shot1b'] }],
    },
  });
  assert.throws(
    () =>
      new ReadinessService(f.store).generation(
        {
          episodeId: episode.id,
          episodeRevision: episode.revision,
          segmentId: 'P01',
          ...partial.scope.data.output,
        },
        f.store.setting('comfy', null as any),
        { id: partial.scope.id, revision: 1 },
      ),
    /范围外镜头/,
  );
  assert.equal(generationDigest(f.store.job(submitted.jobs[0].id)), frozen);
});

test('writable text context freezes complete baseline, permitted IDs and exact dependency before any model execution', (t) => {
  const f = fixture(t);
  const baseline = f.run.data.results.director;
  const original = f.store.get(baseline.id, baseline.revision).data.result;
  f.creation.revise(f.run.id, 'director', 'Make only shot1 action clearer', [], false, {
    baseline,
    shotIds: ['shot1'],
    sceneIds: [],
  });
  const context = f.creation.context(f.run.id, 'director');
  assert.deepEqual(context.writable?.baseline, baseline);
  assert.deepEqual(context.writable?.shotIds, ['shot1']);
  assert.deepEqual(context.writable?.sceneIds, []);
  assert.deepEqual(context.writable?.baselineResult, original);
  assert.ok(
    context.dependencies.some((r) => r.id === baseline.id && r.revision === baseline.revision),
  );
  const prompt = authoringPrompt(context);
  assert.ok(prompt.includes('保持未选择对象'));
  assert.equal(prompt.includes('"baselineResult"'), false);
  assert.equal(prompt.includes('"id":"shot5"'), false);
  assert.ok(prompt.includes('local-authoring-v1'));
  assert.ok(prompt.includes('"id":"shot1"'));
});

test('same-run scoped candidates preserve frozen inputs and awaiting review without rematerialization or new calls', (t) => {
  const f = fixture(t),
    selected = f.select('P01');
  const jobs = Array.from({ length: 3 }, (_, index) => {
    const job = f.store.createJob(
      'generation',
      f.project.id,
      f.run.data.episodeId,
      {
        creationRunId: f.run.id,
        creationEpoch: index + 1,
        profile: f.store.setting('comfy', null),
        segment: { id: 'P01', shotIds: ['shot1'], duration: 12 },
      },
      `historical-${index}`,
    );
    return f.store.patchJob(job.id, { state: 'succeeded', output: {} });
  });
  const scope = f.store.update(selected.scope.id, 1, {
    ...selected.scope.data,
    version: 2,
    candidates: jobs.map((j) => ({
      jobId: j.id,
      shotIds: ['shot1'],
      reason: 'Same V9 run, explicit scope reuse',
    })),
  });
  const run = f.run;
  f.store.update(run.id, run.revision, {
    ...run.data,
    scope: { id: scope.id, revision: scope.revision },
    stage: 'review',
    state: 'awaiting_review',
  });
  resolveScope(f.store, f.run);
  const rawInputs = f.store.db.prepare('SELECT id,input FROM jobs ORDER BY id').all();
  const episode = f.store.get(f.run.data.episodeId);
  const advanced = f.creation.advance(f.run.id);
  assert.equal(advanced.data.state, 'awaiting_review');
  assert.equal(advanced.data.stage, 'review');
  assert.equal(advanced.data.materialized, null);
  assert.equal(advanced.data.issues[0].code, 'actual_review_required');
  assert.deepEqual(f.store.get(episode.id), episode);
  assert.deepEqual(f.store.db.prepare('SELECT id,input FROM jobs ORDER BY id').all(), rawInputs);
  assert.equal(f.creation.allowance(f.project.id).usedGenerations, 3);
  assert.equal(f.creation.allowance(f.project.id).usedSeconds, 36);
  assert.deepEqual(
    f.workspace.snapshot(f.project.id, run.id).candidates.map((c) => c.label),
    jobs.map((j) => `P01 · ${j.id.slice(0, 8)}`),
  );
  const preview = f.workspace.preview(scope.id, scope.revision, f.run.revision);
  assert.equal(preview.preview, null);
  assert.equal(preview.run.data.state, 'awaiting_review');
  const changed = f.workspace.saveScope(
    run.id,
    f.run.revision,
    { name: 'P01 revised scope', mode: 'selection', shotIds: ['shot1'], output: scope.data.output },
    true,
    scope.id,
    scope.revision,
  );
  assert.equal(changed.scope.data.candidates, undefined);
  const invalid = f.store.update(changed.scope.id, changed.scope.revision, {
    ...changed.scope.data,
    version: changed.scope.revision + 1,
    candidates: [{ jobId: jobs[0].id, shotIds: ['shot2'], reason: 'Wrong shot association' }],
  });
  assert.throws(
    () => resolveScope(f.store, f.run, { id: invalid.id, revision: invalid.revision }),
    /历史候选关联/,
  );
  assert.deepEqual(f.store.db.prepare('SELECT id,input FROM jobs ORDER BY id').all(), rawInputs);
});

test('complementary partial scopes merge group membership in authoring order without an initial full preview', (t) => {
  for (const order of [
    ['shot1', 'shot1b'],
    ['shot1b', 'shot1'],
  ]) {
    const f = fixture(t, true, true);
    const first = f.workspace.saveScope(
      f.run.id,
      f.run.revision,
      { name: 'First partial', mode: 'selection', shotIds: [order[0]] },
      true,
    );
    const initial = f.workspace.preview(first.scope.id, 1, f.run.revision);
    assert.ok(initial.preview, JSON.stringify(initial.issues));
    assert.deepEqual(
      f.store.get(f.run.data.episodeId).data.segments.find((s: any) => s.id === 'P01').shotIds,
      [order[0]],
    );
    const accepted = f.workspace.submit(
      first.scope.id,
      1,
      f.run.revision,
      initial.preview.digest,
      crypto.randomUUID(),
    ).jobs[0];
    const outside = structuredClone(
      f.store.get(f.run.data.episodeId).data.shots.find((s: any) => s.id === order[0]),
    );
    const second = f.workspace.saveScope(
      f.run.id,
      f.run.revision,
      { name: 'Complementary partial', mode: 'selection', shotIds: [order[1]] },
      true,
    );
    const preview = f.workspace.preview(second.scope.id, 1, f.run.revision);
    assert.ok(preview.preview, JSON.stringify(preview.issues));
    const episode = f.store.get(f.run.data.episodeId);
    const group = episode.data.segments.find((s: any) => s.id === 'P01');
    assert.deepEqual(group.shotIds, ['shot1', 'shot1b']);
    assert.equal(group.duration, 12);
    assert.deepEqual(
      episode.data.shots.find((s: any) => s.id === order[0]),
      outside,
    );
    assert.deepEqual(preview.preview.inputs[0].segment.shotIds, [order[1]]);
    assert.deepEqual(
      preview.preview.inputs[0].planning.shots.map((s: any) => s.id),
      [order[1]],
    );
    assert.equal(preview.preview.inputs[0].segment.duration, 6);
    const submitted = f.workspace.submit(
      second.scope.id,
      1,
      f.run.revision,
      preview.preview.digest,
      crypto.randomUUID(),
    );
    assert.deepEqual(submitted.jobs[0].input.segment.shotIds, [order[1]]);
    assert.deepEqual(f.store.job(accepted.id), accepted);
    assert.equal(f.creation.allowance(f.project.id).usedSeconds, 12);
  }
});

test('local script edits revalidate retained director dependencies and block only affected scope with a revision issue', (t) => {
  const f = fixture(t);
  const unaffected = f.select('P02').scope;
  const baseline = f.run.data.results.script;
  const result = structuredClone(f.store.get(baseline.id, baseline.revision).data.result);
  result.scenes[0].events[0].id = 'event1-new';
  const draft = f.creation.editResult(f.run.id, 'script', result, f.run.revision, baseline, {
    shotIds: [],
    sceneIds: ['scene1'],
  });
  f.creation.approve(f.run.id, draft.id, draft.revision, crypto.randomUUID());
  const invalidation = f.run.data.resultInvalidations.find(
    (entry: any) => entry.stage === 'director',
  );
  assert.deepEqual(invalidation.shotIds, ['shot1']);
  assert.ok(invalidation.issues.some((i: any) => i.code === 'unknown_event'));
  const unchanged = f.workspace.preview(unaffected.id, unaffected.revision, f.run.revision);
  assert.ok(unchanged.preview, JSON.stringify(unchanged.issues));
  assert.deepEqual(unchanged.preview.inputs[0].segment.shotIds, ['shot2']);
  const affected = f.select('P01').scope;
  const before = f.store.get(f.run.data.episodeId);
  const preview = f.workspace.preview(affected.id, affected.revision, f.run.revision);
  assert.equal(preview.preview, null);
  assert.equal(preview.run.data.state, 'needs_revision');
  assert.ok(
    preview.issues.some(
      (i: any) =>
        i.stage === 'director' && i.code === 'unknown_event' && i.message.includes('需要修订'),
    ),
  );
  assert.deepEqual(f.store.get(before.id), before);
  assert.equal(f.creation.allowance(f.project.id).usedGenerations, 0);
  const directorBaseline = f.run.data.results.director;
  const repaired = structuredClone(
    f.store.get(directorBaseline.id, directorBaseline.revision).data.result,
  );
  repaired.shots[0].events[0].eventId = 'event1-new';
  const repairedDraft = f.creation.editResult(
    f.run.id,
    'director',
    repaired,
    f.run.revision,
    directorBaseline,
    { shotIds: ['shot1'], sceneIds: [] },
  );
  f.creation.approve(f.run.id, repairedDraft.id, repairedDraft.revision, crypto.randomUUID());
  assert.deepEqual(f.run.data.resultInvalidations, []);
  const refreshed = f.select('P01');
  assert.ok(f.workspace.preview(refreshed.scope.id, 1, f.run.revision).preview);
});

test('subject-local revisions authorize only exact subject content and preserve all scenes', (t) => {
  const f = fixture(t),
    baseline = f.run.data.results.script;
  const original = f.store.get(baseline.id, baseline.revision).data.result;
  const changed = structuredClone(original);
  changed.subjects[0].description = 'A polished silver device.';
  const forged = structuredClone(changed);
  forged.scenes[0].narrative = 'Unauthorized story rewrite';
  const scope = { shotIds: [], sceneIds: [], subjectKeys: ['device'] };
  assert.throws(
    () => f.creation.editResult(f.run.id, 'script', forged, f.run.revision, baseline, scope),
    /未选择对象/,
  );
  const draft = f.creation.editResult(f.run.id, 'script', changed, f.run.revision, baseline, scope);
  assert.deepEqual(draft.data.result.scenes, original.scenes);
  assert.equal(draft.data.result.subjects[0].description, changed.subjects[0].description);
  assert.deepEqual(f.store.get(baseline.id, baseline.revision).data.result, original);
});

test('an earlier local state change invalidates a later scope that carries that state', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.script.subjects[0].attributes = [
      { key: 'lit', label: 'Lit', type: 'boolean', values: [] },
    ];
    outputs.director.shots[0].entryState = [{ subjectKey: 'device', key: 'lit', value: false }];
    outputs.director.shots[0].exitState = [{ subjectKey: 'device', key: 'lit', value: false }];
  });
  const selected = f.select('P02');
  const baseline = f.run.data.results.director;
  const changed = structuredClone(f.store.get(baseline.id, baseline.revision).data.result);
  changed.shots[0].exitState[0].value = true;
  const draft = f.creation.editResult(f.run.id, 'director', changed, f.run.revision, baseline, {
    shotIds: ['shot1'],
    sceneIds: [],
  });
  f.creation.approve(f.run.id, draft.id, draft.revision, crypto.randomUUID());
  assert.throws(
    () =>
      resolveScope(f.store, f.run, { id: selected.scope.id, revision: selected.scope.revision }),
    /已修订/,
  );
});

test('director subject permissions allow the owned performance but reject camera or another subject mutation', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.director.shots[0].performances = [
      {
        id: 'gesture',
        subjectKey: 'device',
        trigger: 'Power starts.',
        goal: 'Indicate readiness.',
        obstacle: '',
        visible: 'The antenna lifts.',
        attention: null,
        headHeading: null,
      },
    ];
  });
  const baseline = f.run.data.results.director;
  const changed = structuredClone(f.store.get(baseline.id, baseline.revision).data.result);
  changed.shots[0].performances[0].visible = 'The antenna turns toward the indicator.';
  const forged = structuredClone(changed);
  forged.shots[0].camera.position = 'Unauthorized camera change';
  const scope = { shotIds: [], sceneIds: [], subjectKeys: ['device'] };
  assert.throws(
    () => f.creation.editResult(f.run.id, 'director', forged, f.run.revision, baseline, scope),
    /未选择对象/,
  );
  const draft = f.creation.editResult(
    f.run.id,
    'director',
    changed,
    f.run.revision,
    baseline,
    scope,
  );
  assert.equal(
    draft.data.result.shots[0].performances[0].visible,
    changed.shots[0].performances[0].visible,
  );
});

test('V9 r2 provider prompt consumes only the current shot execution fields and records exclusions', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.direction.visual = 'Global policy token GLOBAL_NOT_FOR_MODEL';
    outputs.direction.assetPolicy = 'MAKE_NINE_IMAGES RETRY_QUOTA MANUAL_APPROVAL';
    outputs.script.subjects[0].description = 'FULL_STORY_DESCRIPTION';
    outputs.director.shots[4].action = 'FUTURE_GROUP_ACTION';
    outputs.director.shots[0].visualTreatment = 'CURRENT_LOCAL_LIGHT';
    outputs.director.shots[0].visibleSpace = 'CURRENT_OPERATING_SIDE';
  });
  const scope = f.select().scope;
  const preview = f.workspace.preview(scope.id, scope.revision, f.run.revision).preview;
  assert.ok(preview);
  const compiled = preview.inputs[0].prepared;
  for (const token of [
    'GLOBAL_NOT_FOR_MODEL',
    'MAKE_NINE_IMAGES',
    'RETRY_QUOTA',
    'MANUAL_APPROVAL',
    'FULL_STORY_DESCRIPTION',
    'FUTURE_GROUP_ACTION',
  ])
    assert.equal(compiled.finalPrompt.includes(token), false, token);
  for (const token of ['CURRENT_LOCAL_LIGHT', 'CURRENT_OPERATING_SIDE'])
    assert.ok(compiled.finalPrompt.includes(token));
  assert.equal(compiled.contractRevision, 2);
  assert.equal(compiled.spatialAssessments[0].status, 'not_applicable');
  assert.ok(
    compiled.consumption.some((c: any) => c.field === 'assetPolicy' && c.status === 'not_consumed'),
  );
  assert.ok(compiled.consumption.some((c: any) => c.source?.id === f.run.data.results.director.id));
  assert.deepEqual(compiled.trace, compiled.consumption);
});
