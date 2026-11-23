import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/workspace.js';
import { authoringImpact } from '../src/server/authoring-impact.js';
import { workspaceTarget } from '../src/server/workspace-status.js';
import { localAuthoringInput, mergeLocalAuthoring } from '../src/shared/authoring-replacement.js';
import { codexOutputJsonSchema, decodeCodexOutput } from '../src/server/codex-output.js';
import { productionMetrics } from '../src/server/production-metrics.js';
import { DomainService } from '../src/server/domain-service.js';
import { SeriesProductionService } from '../src/server/series-production.js';
import { generationDigest } from '../src/server/h3-guided.js';

test('workspace selects an explicit series, episode and production head without cross-work guessing or writes', (t) => {
  const f = fixture(t);
  const ep = f.store.get(f.run.data.episodeId);
  const other = f.store.create('series', f.project.id, { title: 'Separate season' }, f.project.id);
  const second = f.store.create(
    'episode',
    f.project.id,
    { seriesId: other.id, title: 'Other episode', shots: [], segments: [] },
    other.id,
  );
  const before = f.store.db.prepare('SELECT * FROM documents ORDER BY id').all();
  const ambiguous = f.workspace.snapshot(f.project.id);
  assert.equal(ambiguous.context?.selectionRequired, 'series');
  assert.equal(ambiguous.run, null);
  const selected = f.workspace.snapshot(f.project.id, undefined, undefined, ep.data.seriesId);
  assert.equal(selected.run?.id, f.run.id);
  assert.deepEqual(
    selected.episodes.map((e) => e.id),
    [ep.id],
  );
  assert.throws(() => workspaceTarget(f.store, f.project.id, f.run.id, second.id), /不匹配/);
  assert.throws(
    () => workspaceTarget(f.store, f.project.id, f.run.id, undefined, other.id),
    /不匹配/,
  );
  assert.deepEqual(f.store.db.prepare('SELECT * FROM documents ORDER BY id').all(), before);
});

test('unactivated alternate runs require selection and current-range reference issues stay scoped', (t) => {
  const f = fixture(t, true);
  f.select();
  f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    issues: [
      {
        code: 'waiting-outside',
        message: 'P02 waits for its own source',
        severity: 'blocking',
        stage: 'director',
        category: 'continuity',
        targetId: 'P02',
      },
      {
        code: 'scene-outside',
        message: 'scene2 needs a decision',
        severity: 'blocking',
        stage: 'director',
        category: 'continuity',
        targetId: 'scene2',
      },
    ],
  });
  const snapshot = f.workspace.snapshot(f.project.id, f.run.id);
  const missing = snapshot.context!.issues.find((i) => i.requirementId === 'outside')!;
  assert.equal(missing.inScope, false);
  assert.equal(missing.gate, 'prepare');
  assert.equal(snapshot.context!.issues.find((i) => i.code === 'waiting-outside')?.inScope, false);
  assert.equal(snapshot.context!.issues.find((i) => i.code === 'scene-outside')?.inScope, false);
  f.store.create(
    'creation_run',
    f.project.id,
    { ...f.run.data, scope: null },
    f.run.data.episodeId,
  );
  f.store.db.prepare('DELETE FROM creation_heads WHERE episode_id=?').run(f.run.data.episodeId);
  assert.equal(workspaceTarget(f.store, f.project.id).context.selectionRequired, 'run');
});

test('an archived explicit production head is not silently replaced by the only remaining run', (t) => {
  const f = fixture(t),
    current = f.run;
  f.store.create(
    'creation_run',
    f.project.id,
    { ...current.data, scope: null },
    current.data.episodeId,
  );
  f.store.update(current.id, current.revision, { ...current.data, archived: true });
  const selection = workspaceTarget(f.store, f.project.id);
  assert.equal(selection.run, null);
  assert.equal(selection.context.selectionRequired, 'run');
  assert.equal(selection.context.runChoices.length, 1);
});

test('mixed independent and dependent groups prepare only ready inputs without adding tasks to the waiting group', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.director.groups[1].transition = 'continuous';
  });
  const selected = f.workspace.saveScope(
    f.run.id,
    f.run.revision,
    { name: 'Mixed readiness', mode: 'selection', groupIds: ['P01', 'P02'] },
    true,
  );
  const preview = f.workspace.preview(selected.scope.id, selected.scope.revision, f.run.revision);
  assert.deepEqual(
    preview.preview.groups.map((g: any) => g.id),
    ['P01'],
  );
  assert.ok(
    preview.issues.some(
      (i: any) => i.code === 'upstream_selection_required' && i.targetId === 'P02',
    ),
  );
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
  const submitted = f.workspace.submit(
    selected.scope.id,
    selected.scope.revision,
    f.run.revision,
    preview.preview.digest,
    'mixed-independent-only',
  );
  assert.deepEqual(
    submitted.jobs.map((j: any) => j.input.segment.id),
    ['P01'],
  );
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 1);
});

test('local author returns only authorized objects and server preserves full immutable baseline and ordering', (t) => {
  const f = fixture(t),
    baseline = f.run.data.results.director;
  const before = f.store.get(baseline.id, baseline.revision).data.result;
  f.creation.revise(f.run.id, 'director', 'Clarify one shot', [], false, {
    baseline,
    shotIds: ['shot2'],
    sceneIds: [],
  });
  const context = f.creation.context(f.run.id, 'director');
  const input = localAuthoringInput(context);
  assert.equal(input.writable.baselineResult, undefined);
  assert.deepEqual(
    input.writable.objects.shots.map((s: any) => s.id),
    ['shot2'],
  );
  assert.deepEqual(
    input.readOnlyNeighbors.map((s: any) => s.id),
    ['shot1', 'shot3'],
  );
  assert.equal(input.priorResults.script!.scenes.length, 1);
  const shot = structuredClone(before.shots[1]);
  shot.action = 'The device slowly rotates.';
  const patch = {
    protocol: 'local-authoring-v1',
    stage: 'director',
    shots: [shot],
    sceneDesigns: [],
  };
  const record = f.creation.complete(
    { id: '', projectId: f.project.id, input: { context } } as any,
    patch,
  );
  assert.equal(record.data.valid, true, JSON.stringify(record.data.issues));
  assert.deepEqual(
    record.data.result.shots,
    before.shots.map((s: any) => (s.id === shot.id ? shot : s)),
  );
  assert.deepEqual(record.data.rawReplacement, patch);
  assert.deepEqual(f.store.get(baseline.id, baseline.revision).data.result, before);
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
});

test('local transport and merge reject extra objects and duplicate identities while preserving semantic nulls', (t) => {
  const f = fixture(t),
    baseline = f.run.data.results.script;
  f.creation.revise(f.run.id, 'script', 'Revise one scene', [], false, {
    baseline,
    shotIds: [],
    sceneIds: ['scene1'],
  });
  const context = f.creation.context(f.run.id, 'script'),
    scenes = (context.writable!.baselineResult as any).scenes;
  const patch = {
    protocol: 'local-authoring-v1',
    stage: 'script',
    subjects: [],
    scenes: [scenes[1]],
  };
  assert.throws(() => mergeLocalAuthoring(context, patch), /未授权/);
  assert.throws(
    () => mergeLocalAuthoring(context, { ...patch, scenes: [scenes[0], scenes[0]] }),
    /重复/,
  );
  const wire = codexOutputJsonSchema('script', true);
  assert.equal(wire.properties.protocol.const, 'local-authoring-v1');
  assert.equal(wire.properties.contractRevision, undefined);
  assert.deepEqual([...wire.required].sort(), Object.keys(wire.properties).sort());
  const scene = structuredClone(scenes[0]);
  scene.dialogue = [
    {
      id: 'l1',
      speakerKey: 'device',
      text: 'Hello',
      sourceFactId: null,
      language: 'en',
      translation: null,
    },
  ];
  const decoded: any = decodeCodexOutput('script', { ...patch, scenes: [scene] });
  assert.equal(Object.hasOwn(decoded.scenes[0].dialogue[0], 'translation'), false);
  assert.equal(decoded.scenes[0].dialogue[0].sourceFactId, null);
  assert.equal(mergeLocalAuthoring(context, decoded).scenes[0].dialogue[0].text, 'Hello');
});

test('local object protocol does not grant camera authority to a subject-only revision', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.director.shots[0].entryState = [{ subjectKey: 'device', key: 'x', value: null }];
    outputs.script.subjects[0].attributes = [{ key: 'x', type: 'number', label: 'x', values: [] }];
  });
  const baseline = f.run.data.results.director;
  f.creation.revise(f.run.id, 'director', 'Subject only', [], false, {
    baseline,
    shotIds: [],
    sceneIds: [],
    subjectKeys: ['device'],
  });
  const context = f.creation.context(f.run.id, 'director');
  const shot = structuredClone((context.writable!.baselineResult as any).shots[0]);
  shot.camera.position = 'Changed camera';
  const record = f.creation.complete(
    { id: '', projectId: f.project.id, input: { context } } as any,
    { protocol: 'local-authoring-v1', stage: 'director', shots: [shot], sceneDesigns: [] },
  );
  assert.equal(record.data.valid, false);
  assert.ok(record.data.issues.some((i: any) => i.code === 'local_scope'));
});

test('read-only authoring impact uses inherited-state projection and ignores metadata-only title changes', (t) => {
  const f = fixture(t, false, false, (outputs) => {
    outputs.script.subjects[0].attributes = [
      { key: 'lit', label: 'Lit', type: 'boolean', values: [] },
    ];
    outputs.director.shots[0].entryState = [{ subjectKey: 'device', key: 'lit', value: false }];
    outputs.director.shots[0].exitState = [{ subjectKey: 'device', key: 'lit', value: false }];
  });
  f.select('P02');
  const baseline = f.run.data.results.director,
    result = structuredClone(f.store.get(baseline.id, baseline.revision).data.result);
  const before = f.store.db.prepare('SELECT * FROM documents ORDER BY id').all();
  result.title = 'Renamed';
  const title = authoringImpact(f.store, f.run.id, {
    revision: f.run.revision,
    baseline,
    stage: 'director',
    result,
  });
  assert.equal(title.scopes.find((s) => s.name === 'P02')!.affected, false);
  result.shots[0].exitState[0].value = true;
  const state = authoringImpact(f.store, f.run.id, {
    revision: f.run.revision,
    baseline,
    stage: 'director',
    result,
  });
  assert.equal(state.scopes.find((s) => s.name === 'P02')!.affected, true);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM documents ORDER BY id').all(), before);
  assert.throws(
    () =>
      authoringImpact(f.store, f.run.id, {
        revision: f.run.revision - 1,
        baseline,
        stage: 'director',
        result,
      }),
    /当前运行/,
  );
});

test('scope continuation fixes multiple source versions and rejects foreign ownership before preparation', (t) => {
  const f = fixture(t),
    domain = new DomainService(f.store),
    plans = new SeriesProductionService(f.store);
  let profile = domain.save(f.project.id, 'creation_profile', {
    name: 'Fixed series',
    rulesVersion: 'director-v7',
    composition: { moduleRefs: [], overrides: { visual: 'Silver product' }, artEntries: [] },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'Offline plan',
  });
  const series = f.store.list('series', f.project.id)[0];
  const preview = plans.preview(series.id, {
    version: 1,
    profile: { id: profile.id, revision: profile.revision },
    targetEpisodes: 1,
    slots: [{ id: 'slot1', episodeId: f.run.data.episodeId, title: 'One' }],
  });
  plans.apply(series.id, {
    ...preview,
    revision: series.revision,
    idempotencyKey: 'bind-existing-episode',
  });
  const run = f.run;
  f.store.update(run.id, run.revision, {
    ...run.data,
    targetRevision: f.store.get(run.data.episodeId).revision,
  });
  const sources = ['A', 'B'].map((id) =>
    f.store.create(
      'segment_selection',
      f.project.id,
      { segmentId: id, boundary: { start: {}, end: {} } },
      run.data.episodeId,
    ),
  );
  const incoming = {
    version: 2,
    mode: 'continue',
    cut: 'angle',
    sources: sources.map((s) => ({
      id: s.id,
      selection: { id: s.id, revision: s.revision },
      boundary: 'end',
    })),
    decisions: [],
  };
  const saved = f.workspace.saveScope(
    run.id,
    f.run.revision,
    { name: 'Two sources', mode: 'selection', groupIds: ['P02'], continuations: { P02: incoming } },
    true,
  );
  assert.equal(saved.scope.data.continuations?.P02.sources.length, 2);
  const dependencies = f.store.db
    .prepare('SELECT * FROM dependencies WHERE consumer_id=?')
    .all(saved.scope.id);
  assert.ok(dependencies.some((d) => Object.values(d).includes(sources[0].id)));
  const foreign = f.store.create('segment_selection', 'other-project', {});
  assert.throws(
    () =>
      f.workspace.saveScope(
        run.id,
        f.run.revision,
        {
          name: 'Wrong source',
          mode: 'selection',
          groupIds: ['P02'],
          continuations: {
            P02: {
              ...incoming,
              sources: [{ id: 'foreign', selection: { id: foreign.id, revision: 1 } }],
            },
          },
        },
        true,
      ),
    /归属/,
  );
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
});

test('metrics distinguish requests, remote acceptance, measured frames and unique adopted intervals without writes', (t) => {
  const f = fixture(t),
    ep = f.run.data.episodeId;
  const create = (key: string) =>
    f.store.createJob(
      'generation',
      f.project.id,
      ep,
      {
        creationRunId: f.run.id,
        profile: f.store.setting('comfy', null),
        segment: { id: key, duration: 12 },
      },
      key,
    );
  const job = create('metrics-one');
  f.store.patchJob(job.id, { state: 'succeeded', promptId: 'actual-id' });
  const unknown = create('metrics-two');
  f.store.patchJob(unknown.id, { state: 'unknown' });
  const video = f.store.create('asset', f.project.id, {
    jobId: job.id,
    category: 'generated',
    mediaType: 'video',
    adopted: true,
    frameCount: 291,
  });
  const review = f.store.create(
    'generation_review',
    f.project.id,
    { inspected: true, video: { id: video.id, revision: 1 } },
    ep,
  );
  for (const [start, end] of [
    [0, 5],
    [3, 7],
  ])
    f.store.create(
      'segment_selection',
      f.project.id,
      {
        creationRunId: f.run.id,
        video: { id: video.id, revision: 1 },
        review: { id: review.id, revision: 1 },
        in: start,
        out: end,
      },
      ep,
    );
  const before = generationDigest(f.store.list());
  const result = productionMetrics(f.store, f.run.id);
  assert.equal(result.requested, 2);
  assert.equal(result.remoteTaskIds, 1);
  assert.equal(result.acceptanceUnknown, 1);
  assert.equal(result.actualFrames, 291);
  assert.equal(result.uniqueAdoptedFrames, 7 * 24);
  assert.equal(result.selectedTimelineFrames, 9 * 24);
  assert.equal(result.adoptedSecondsPerRequest, 3.5);
  assert.equal(result.reviewTimeMs, null);
  assert.equal(generationDigest(f.store.list()), before);
  f.store.update(review.id, review.revision, { ...review.data, stale: true });
  assert.equal(productionMetrics(f.store, f.run.id).uniqueAdoptedFrames, 168);
});
