import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import {
  SeriesProductionService,
  resolveSeries,
  predecessorCanon,
  episodeRuntime,
  seriesInformationForEpisode,
} from '../src/server/series-production.js';
import { AssemblyService } from '../src/server/assembly.js';
import { prepareCanonV3 } from '../src/server/series-canon.js';
import { saveDialogueTake } from '../src/server/voices.js';
import { prepareContinuation } from '../src/server/continuation.js';
import { directingSchema } from '../src/shared/directing.js';
import { shotStateSchema } from '../src/shared/domain.js';
import { incomingV2Schema } from '../src/shared/shot-semantics.js';
import { assemblyDimensions, actionPhaseIssues } from '../src/shared/series.js';
import {
  generationDependencies,
  boundaryChanges,
  correctionAffectsInput,
} from '../src/server/generation-dependencies.js';
import { selectedBoundary, validateObservedReview } from '../src/server/review-evidence.js';
const ref = (d: any) => ({ id: d.id, revision: d.revision });
const fact = (value: any, instanceId = 'device') => ({
  instanceId,
  key: 'powered',
  status: value === null ? 'unknown' : 'known',
  value,
});
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'series-v7-test-'));
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store),
    domain = new DomainService(store),
    seriesService = new SeriesProductionService(store),
    assembly = new AssemblyService(store);
  t.after(async () => {
    store.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'series-v7-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = service.createProject({ title: 'Series fixture', mode: 'series', brief: '' });
  const entity = domain.save(project.id, 'entity', {
    name: 'Device',
    type: 'object',
    instances: [
      { id: 'device', name: 'Device' },
      { id: 'twin', name: 'Twin' },
    ],
    attributes: [{ key: 'powered', label: 'Power', type: 'boolean', continuity: 'series' }],
  });
  let profile = domain.save(project.id, 'creation_profile', {
    name: 'Series one',
    rulesVersion: 'director-v7',
    composition: {
      moduleRefs: [],
      overrides: { visual: 'Photographic silver product.' },
      artEntries: [],
    },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'Authored offline specification',
  });
  let series = store.list('series', project.id)[0];
  const preview = seriesService.preview(series.id, { version: 1, profile: ref(profile) });
  series = seriesService.apply(series.id, {
    ...preview,
    revision: series.revision,
    idempotencyKey: 'initial-series-plan',
  });
  const createEpisode = (index = 0) => {
    const latest = store.get(series.id),
      slot = latest.data.production.slots.filter((s: any) => s.active)[index];
    let ep = service.createEpisode(project.id, { seriesId: series.id, slotId: slot.id });
    const shot = {
      id: 's',
      scene: 'table',
      duration: 5,
      description: 'The indicator remains off.',
      dialogue: '',
      continuity: '',
      state: shotStateSchema.parse({
        instances: [{ instanceId: 'device', entity: ref(entity) }],
        confirmed: true,
        attributes: { start: [fact(false)], end: [fact(false)] },
      }),
      directing: directingSchema.parse({
        version: 3,
        presence: { visible: ['device'] },
        execution: { action: 'The indicator remains off.' },
      }),
    };
    ep = store.update(ep.id, ep.revision, {
      ...ep.data,
      shots: [shot],
      segments: [
        {
          id: 'g',
          shotIds: ['s'],
          duration: 5,
          mode: 't2v',
          prompt: 'The indicator remains off.',
          references: [],
          executionVersion: 'native-h3-base-v4',
          incoming: incomingV2Schema.parse({ version: 2, mode: 'independent', cut: 'independent' }),
        },
      ],
      approved: true,
      seriesProduction: {
        ...ep.data.seriesProduction,
        runtime: { targetFrames: 120, toleranceFrames: 0 },
      },
    });
    return ep;
  };
  const adopt = (ep: any, n = 0) => {
    const video = store.create('asset', project.id, {
      name: `offline-${n}`,
      mediaType: 'video',
      adopted: true,
      duration: 5,
      frameCount: 120,
      sha256: `offline-hash-${n}`,
    });
    const review = store.create(
      'generation_review',
      project.id,
      {
        observations: [
          { id: 'off', ...fact(false), startFrame: 0, endFrame: 120, inspection: 'motion' },
        ],
        eventEvidence: [],
        audioEvidence: [],
      },
      ep.id,
    );
    const boundary = { facts: [fact(false)], relations: [], relationObjectIds: [], actions: [] };
    const selection = store.create(
      'segment_selection',
      project.id,
      {
        schemaVersion: 3,
        segmentId: 'g',
        video: ref(video),
        review: ref(review),
        in: 0,
        out: 5,
        volume: 1,
        boundary: { start: boundary, end: boundary },
        stale: false,
      },
      ep.id,
    );
    return { video, review, selection };
  };
  const timeline = (ep: any) => {
    const { video, review, selection } = adopt(ep);
    const edl = service.saveEdl(project.id, {
      schemaVersion: 2,
      episodeId: ep.id,
      width: 128,
      height: 128,
      fps: 24,
      clips: [
        { assetId: video.id, revision: 1, in: 0, out: 5, volume: 1, selection: ref(selection) },
      ],
      audio: [],
    });
    const job = store.createJob(
      'export',
      project.id,
      ep.id,
      { edl: edl.data, edlRevision: edl.revision },
      `export-${ep.id}`,
    );
    const exported = store.create('asset', project.id, {
      mediaType: 'video',
      adopted: true,
      frameCount: 120,
      duration: 5,
      sha256: 'test-export',
      jobId: job.id,
    });
    store.patchJob(job.id, { state: 'succeeded', output: { assetIds: [exported.id] } });
    return { video, review, selection, edl, exported };
  };
  const reviewAll = (edl: any, exported: any) => {
    for (const s of assembly.inspect(edl.id).scopes)
      assembly.review({
        version: 1,
        edl: ref(edl),
        scope: s.scope,
        key: s.key,
        digest: s.digest,
        startFrame: s.startFrame,
        endFrame: s.endFrame,
        dimensions: Object.fromEntries(assemblyDimensions.map((d) => [d, 'pass'])),
        watched: true,
        listened: true,
        conclusion: 'Synthetic offline evidence fixture, not a visual claim',
        ...(s.scope === 'episode' ? { exportAsset: ref(exported) } : {}),
      });
  };
  const canon = (ep: any, selection?: any) => ({
    schemaVersion: 3,
    episode: ref(ep),
    previous: null,
    instances: ep.data.shots[0].state.instances,
    facts: selection
      ? [
          {
            id: 'device-off',
            text: 'The indicator is off.',
            instanceIds: ['device'],
            kind: 'world_fact',
            operation: 'add',
            attribute: fact(false),
            effective: { slotId: ep.data.seriesProduction.slotId },
            source: { kind: 'media', selection: ref(selection), evidenceIds: ['off'] },
          },
        ]
      : [],
    attributes: selection ? [fact(false)] : [],
    states: [],
    relations: [],
    unfinishedActions: [],
    openLoops: [],
  });
  return {
    root,
    store,
    service,
    domain,
    seriesService,
    assembly,
    project,
    series,
    entity,
    profile,
    createEpisode,
    adopt,
    timeline,
    reviewAll,
    canon,
  };
}

test('20 × 20-minute planning creates stable slots without episodes/jobs and preserves retired history', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.list('episode').length, 0);
  assert.equal(f.store.jobs().length, 0);
  assert.equal(f.series.data.production.slots.length, 20);
  assert.equal(f.series.data.production.runtime.targetFrames, 28800);
  const ep = f.createEpisode(2),
    old = f.store.get(f.series.id);
  const preview = f.seriesService.preview(old.id, { ...old.data.production, targetEpisodes: 2 });
  assert.ok(preview.impacts.find((i: any) => i.episodeId === ep.id && !i.active));
  const request = { ...preview, revision: old.revision, idempotencyKey: 'retire-slot-three' };
  const applied = f.seriesService.apply(old.id, request);
  assert.equal(f.seriesService.apply(old.id, request).revision, applied.revision);
  assert.equal(f.store.get(ep.id).revision, ep.revision);
  assert.equal(f.store.get(old.id, old.revision).data.production.targetEpisodes, 20);
});
test('episode runtime override wins over slot and series; explicit series is mandatory', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(2);
  assert.equal(episodeRuntime(f.store, ep).targetFrames, 120);
  assert.throws(() => f.service.createEpisode(f.project.id, {}), /明确选择系列/);
  assert.throws(
    () =>
      f.service.createEpisode(f.project.id, {
        seriesId: f.series.id,
        slotId: ep.data.seriesProduction.slotId,
      }),
    /尚未关联/,
  );
});

test('five minutes by ten episodes preserves stable planning IDs, third-slot override and read-only progress', async (t) => {
  const f = await fixture(t),
    before = f.store.get(f.series.id);
  const data = {
    ...before.data.production,
    targetEpisodes: 10,
    runtime: { targetFrames: 7200, toleranceFrames: 0 },
  };
  data.slots[2].runtime = { targetFrames: 8640, toleranceFrames: 24 };
  const preview = f.seriesService.preview(before.id, data);
  assert.equal(preview.data.slots.filter((s) => s.active).length, 10);
  assert.equal(f.store.list('episode').length, 0);
  assert.equal(f.store.jobs().length, 0);
  const applied = f.seriesService.apply(before.id, {
    ...preview,
    revision: before.revision,
    idempotencyKey: 'five-minutes-ten-episodes',
  });
  assert.deepEqual(
    applied.data.production.slots.map((s: any) => s.id),
    before.data.production.slots.map((s: any) => s.id),
  );
  const ep = f.service.createEpisode(f.project.id, {
    seriesId: before.id,
    slotId: applied.data.production.slots[2].id,
  });
  assert.deepEqual(episodeRuntime(f.store, ep), { targetFrames: 8640, toleranceFrames: 24 });
  const records = f.store.db.prepare('SELECT * FROM documents ORDER BY id').all();
  const progress = f.seriesService.progress(before.id);
  assert.equal(progress.targetEpisodes, 10);
  assert.equal(
    progress.slots.filter((s) => s.active).reduce((n, s) => n + s.runtime.targetFrames, 0),
    9 * 7200 + 8640,
  );
  assert.equal(progress.delivered, 0);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM documents ORDER BY id').all(), records);
  assert.equal(f.store.jobs().length, 0);
});
test('V7 deterministic generation consumes fixed series profile, dependencies and v4 template', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode();
  const other = f.domain.save(f.project.id, 'creation_profile', {
    ...f.profile.data,
    name: 'Other series',
    composition: {
      ...f.profile.data.composition,
      overrides: { visual: 'Unrelated bright cartoon.' },
    },
  });
  const req = {
    episodeId: ep.id,
    episodeRevision: ep.revision,
    segmentId: 'g',
    width: 1024,
    height: 576,
    steps: 20,
    seed: 9,
  };
  const cloud = { baseUrl: 'http://127.0.0.1:9999', instanceId: 'offline' };
  const a = f.service.prepareGeneration(req, cloud),
    b = f.service.prepareGeneration(req, cloud);
  assert.equal(a.digest, b.digest);
  assert.equal(a.input.prepared.rulesVersion, 'h3-base-v4');
  assert.equal(a.input.creativeBrief.profile.id, f.profile.id);
  assert.ok(!a.input.prepared.finalPrompt.includes('Unrelated bright cartoon'));
  assert.ok(generationDependencies(a.input).some((r) => r.id === f.series.id));
  assert.ok(!generationDependencies(a.input).some((r) => r.id === other.id));
  assert.equal(f.store.jobs().length, 0);
});
test('nearer stale Canon blocks direct predecessor instead of falling back to older confirmed record', async (t) => {
  const f = await fixture(t),
    first = f.createEpisode(),
    second = f.createEpisode(1),
    third = f.createEpisode(2);
  for (const [ep, stale] of [
    [first, false],
    [second, true],
  ] as const)
    f.store.create(
      'continuity',
      f.project.id,
      {
        schemaVersion: 3,
        seriesId: f.series.id,
        episodeNumber: ep.data.number,
        confirmed: true,
        stale,
        facts: [],
      },
      ep.id,
    );
  assert.equal(predecessorCanon(f.store, third).canon, null);
  assert.ok(predecessorCanon(f.store, third).waiting);
});
test('multi-source continuation rejects unknown, missing critical state, duplicate decisions and future selection', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    adopted = f.adopt(ep);
  const shot = structuredClone(ep.data.shots[0]);
  shot.id = 'next';
  const segment = {
    ...ep.data.segments[0],
    id: 'next',
    shotIds: ['next'],
    incoming: incomingV2Schema.parse({
      version: 2,
      mode: 'continue',
      cut: 'angle',
      sources: [{ id: 'a', selection: ref(adopted.selection), boundary: 'end' }],
      decisions: [
        { instanceId: 'device', key: 'powered', decision: 'inherit', sourceId: 'a', reason: '' },
      ],
    }),
  };
  const context = {
    ...ep,
    data: { ...ep.data, shots: [...ep.data.shots, shot], segments: [...ep.data.segments, segment] },
  };
  const prepared = prepareContinuation(f.store, context, segment);
  assert.equal(prepared.snapshot.facts[0].value, false);
  assert.match(
    prepareContinuation(f.store, context, {
      ...segment,
      incoming: { ...segment.incoming, decisions: [] },
    }).warnings.join(';'),
    /缺少必查/,
  );
  assert.match(
    prepareContinuation(f.store, context, {
      ...segment,
      incoming: {
        ...segment.incoming,
        decisions: [...segment.incoming.decisions, ...segment.incoming.decisions],
      },
    }).warnings.join(';'),
    /冲突/,
  );
  f.store.update(adopted.selection.id, 1, {
    ...adopted.selection.data,
    boundary: {
      ...adopted.selection.data.boundary,
      end: { facts: [fact(null)], relations: [], relationObjectIds: [] },
    },
  });
  assert.match(prepareContinuation(f.store, context, segment).warnings.join(';'), /已改变/);
});
test('action-only correction invalidates its consumer, not independent properties', () => {
  const action = { id: 'turn', instanceId: 'device', phase: 'rotating' };
  const change = boundaryChanges(
    { end: { facts: [fact(false)], actions: [action] } },
    { end: { facts: [fact(false)], actions: [{ ...action, phase: 'stopped' }] } },
  );
  const base = {
    dependencies: [{ id: 'selection', revision: 1 }],
    segment: {
      incoming: {
        version: 2,
        sources: [{ id: 'a', selection: { id: 'selection', revision: 1 }, boundary: 'end' }],
        decisions: [{ sourceId: 'a', instanceId: 'device', key: 'powered' }],
        relationDecisions: [],
        actionDecisions: [],
      },
    },
  };
  assert.equal(
    correctionAffectsInput(base, { source: 'selection', selectionChange: change }),
    false,
  );
  base.segment.incoming.actionDecisions.push({
    sourceId: 'a',
    instanceId: 'device',
    actionId: 'turn',
  } as never);
  assert.equal(
    correctionAffectsInput(base, { source: 'selection', selectionChange: change }),
    true,
  );
});
test('changing adoption crop removes incompatible boundary window observations', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    specs = [{ version: 3, state: ep.data.shots[0].state }];
  const review = {
    observations: [],
    boundaryWindows: [
      {
        side: 'end',
        startFrame: 96,
        endFrame: 120,
        inspection: 'motion',
        status: 'pass',
        actions: [{ id: 'turn', instanceId: 'device', phase: 'half', unfinished: true }],
      },
    ],
  };
  assert.equal(selectedBoundary(specs, review, { in: 0, out: 5 }).end.actions.length, 1);
  assert.equal(selectedBoundary(specs, review, { in: 0, out: 4 }).end.actions.length, 0);
});
test('all clips adopted without scene/episode review cannot confirm release or Canon', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, exported, selection } = f.timeline(ep);
  assert.doesNotThrow(() =>
    f.assembly.previewRelease(edl.id, {
      exportAsset: ref(exported),
      canon: f.canon(ep, selection),
    }),
  );
  const facts = f.domain.confirmCanon(f.project.id, f.canon(ep, selection));
  assert.equal(facts.document.data.schemaVersion, 3);
  assert.equal(f.store.list('continuity').length, 1);
});
test('reviewed actual export commits release and evidence-supported Canon atomically and idempotently', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, exported, selection } = f.timeline(ep);
  f.reviewAll(edl, exported);
  const body = { exportAsset: ref(exported), canon: f.canon(ep, selection) },
    preview = f.assembly.previewRelease(edl.id, body);
  const args = { ...body, digest: preview.digest, idempotencyKey: 'first-reviewed-release' };
  const release = f.assembly.release(edl.id, args);
  assert.equal(f.assembly.release(edl.id, args).id, release.id);
  assert.equal(f.store.list('continuity').length, 0);
  assert.equal(f.store.list('episode_release').length, 1);
  assert.equal(release.data.canon, null);
  const facts = f.domain.confirmCanon(f.project.id, f.canon(ep, selection));
  assert.equal(facts.document.data.attributes[0].value, false);
  assert.equal(f.seriesService.progress(f.series.id).delivered, 1);
});
test('release digest races reject with no partially confirmed Canon', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, exported, selection } = f.timeline(ep);
  f.reviewAll(edl, exported);
  const body = { exportAsset: ref(exported), canon: f.canon(ep, selection) };
  const preview = f.assembly.previewRelease(edl.id, body);
  f.service.saveEdl(
    f.project.id,
    { ...edl.data, clips: edl.data.clips.map((c: any) => ({ ...c, volume: 0 })) },
    edl.revision,
    { id: edl.id },
  );
  assert.throws(() =>
    f.assembly.release(edl.id, { ...body, digest: preview.digest, idempotencyKey: 'race-release' }),
  );
  assert.equal(f.store.list('continuity').length, 0);
  assert.equal(f.store.list('episode_release').length, 0);
});
test('media facts cannot use missing/cropped evidence or spoken claims as world truth', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { selection, review } = f.adopt(ep);
  const raw = f.canon(ep, selection);
  raw.facts[0].source.evidenceIds = ['missing'];
  assert.throws(() => prepareCanonV3(f.store, ep, raw), /证据/);
  const altered = f.store.update(review.id, review.revision, {
    audioEvidence: [
      {
        requirementId: 'claim',
        status: 'pass',
        inspection: 'audio',
        startFrame: 0,
        endFrame: 120,
        actualText: 'device is off',
      },
    ],
  });
  const selected = f.store.update(selection.id, selection.revision, {
    ...selection.data,
    review: ref(altered),
  });
  const claim: any = f.canon(ep, selected);
  claim.facts[0].source.evidenceIds = ['claim'];
  delete claim.facts[0].attribute;
  claim.attributes = [];
  assert.throws(() => prepareCanonV3(f.store, ep, claim), /对白不能/);
});

test('ordinary joins require joint action and sound review despite identical boundary attributes', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, exported, video } = f.timeline(ep);
  const next = f.service.saveEdl(
    f.project.id,
    {
      ...edl.data,
      clips: [
        edl.data.clips[0],
        { assetId: video.id, revision: 1, in: 0, out: 5, volume: 1, role: 'recap' },
      ],
    },
    edl.revision,
    { id: edl.id },
  );
  const snap = f.assembly.inspect(next.id),
    join = snap.scopes.find((s) => s.scope === 'join');
  assert.equal(join.passed, false);
  assert.deepEqual(join.window, { startFrame: 96, endFrame: 144, cutFrame: 120 });
  const raw = {
    version: 1,
    edl: ref(next),
    scope: join.scope,
    key: join.key,
    digest: join.digest,
    startFrame: 96,
    endFrame: 144,
    watched: true,
    listened: true,
    conclusion: 'Offline fixture: action restarted at cut',
    dimensions: Object.fromEntries(
      assemblyDimensions.map((d) => [d, d === 'action' ? 'issues' : 'pass']),
    ),
  };
  f.assembly.review(raw);
  assert.equal(f.assembly.inspect(next.id).scopes.find((s) => s.scope === 'join').passed, false);
  assert.throws(() => f.assembly.review({ ...raw, startFrame: 119, endFrame: 120 }), /覆盖/);
  assert.throws(() => f.assembly.review({ ...raw, listened: false }));
  void exported;
});
test('v3 join evidence remains local when an unrelated earlier clip changes duration', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl } = f.timeline(ep);
  const clips = ['a', 'b', 'c'].map((id) => ({ ...edl.data.clips[0], id }));
  clips[0] = { ...clips[0], selection: undefined, role: 'intro' };
  clips[2].transition = { kind: 'dissolve', fromClipId: 'b', frames: 24 };
  let current = f.service.saveEdl(
    f.project.id,
    { ...edl.data, schemaVersion: 3, clips },
    edl.revision,
    { id: edl.id },
  );
  const before = f.assembly.inspect(current.id).scopes.filter((s) => s.scope === 'join');
  assert.ok(before[1].content.recheckEvidence.length > 0);
  current = f.service.saveEdl(
    f.project.id,
    {
      ...current.data,
      clips: current.data.clips.map((c: any, i: number) => (i === 0 ? { ...c, out: 4 } : c)),
    },
    current.revision,
    { id: current.id },
  );
  const after = f.assembly.inspect(current.id).scopes.filter((s) => s.scope === 'join');
  assert.notEqual(before[0].digest, after[0].digest);
  assert.equal(before[1].digest, after[1].digest);
  assert.equal(after[1].startFrame, before[1].startFrame - 24);
});

test('changing effective audio expires only the intersecting join fingerprints', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, video } = f.timeline(ep);
  const audio = f.store.create('asset', f.project.id, {
    mediaType: 'audio',
    duration: 1,
    adopted: true,
  });
  const next = f.service.saveEdl(
    f.project.id,
    {
      ...edl.data,
      clips: [
        edl.data.clips[0],
        ...[1, 2, 3].map(() => ({
          assetId: video.id,
          revision: 1,
          in: 0,
          out: 5,
          volume: 1,
          role: 'recap',
        })),
      ],
    },
    edl.revision,
    { id: edl.id },
  );
  const before = f.assembly.inspect(next.id).scopes.filter((s) => s.scope === 'join');
  f.service.saveEdl(
    f.project.id,
    {
      ...next.data,
      audio: [{ assetId: audio.id, revision: 1, in: 0, out: 1, start: 1, volume: 1 }],
    },
    next.revision,
    { id: next.id },
  );
  const after = f.assembly.inspect(next.id).scopes.filter((s) => s.scope === 'join');
  assert.notEqual(before[0].digest, after[0].digest);
  assert.equal(before[1].digest, after[1].digest);
  assert.equal(before[2].digest, after[2].digest);
});
test('voice assets are fixed per series, require real listening assertions, and imported dialogue cannot double original sound', async (t) => {
  const f = await fixture(t),
    audio = f.store.create('asset', f.project.id, {
      mediaType: 'audio',
      duration: 5,
      adopted: true,
    });
  const raw = {
    version: 1,
    name: 'Calm narrator',
    entity: ref(f.entity),
    language: 'zh-CN',
    timbre: 'Low clear tone',
    samples: [{ asset: ref(audio), in: 0, out: 5, inspected: false, notes: 'Offline fixture' }],
  };
  assert.throws(() => f.domain.save(f.project.id, 'voice_profile', raw));
  let voice = f.domain.save(f.project.id, 'voice_profile', {
    ...raw,
    samples: [{ ...raw.samples[0], inspected: true }],
  });
  voice = f.domain.publish(voice.id, voice.revision, {
    inspected: true,
    conclusion: 'Offline asserted fixture',
  });
  const series = f.store.get(f.series.id),
    p = f.seriesService.preview(series.id, {
      ...series.data.production,
      voices: [{ instanceId: 'device', profile: ref(voice) }],
    });
  f.seriesService.apply(series.id, {
    ...p,
    revision: series.revision,
    idempotencyKey: 'voice-series-binding',
  });
  let ep = f.createEpisode();
  ep = f.store.update(ep.id, ep.revision, {
    ...ep.data,
    shots: ep.data.shots.map((s: any) => ({
      ...s,
      directing: {
        ...s.directing,
        sound: {
          ...s.directing.sound,
          dialogue: [
            {
              id: 'line1',
              instanceId: 'device',
              text: '你好',
              language: 'zh-CN',
              delivery: 'offscreen',
              voice: 'calm',
              voiceProfile: ref(voice),
            },
          ],
        },
      },
    })),
  });
  const take = saveDialogueTake(f.store, f.project.id, {
    version: 1,
    episode: ref(ep),
    shotId: 's',
    lineId: 'line1',
    instanceId: 'device',
    voice: ref(voice),
    asset: ref(audio),
    in: 0,
    out: 5,
    actualText: '你好',
    source: 'imported',
    listened: true,
    voiceMatch: true,
    conclusion: 'Synthetic fixture',
  });
  assert.throws(
    () => saveDialogueTake(f.store, f.project.id, { ...take.data, instanceId: 'twin' }),
    /说话者/,
  );
  const { edl } = f.timeline(ep),
    overlay = {
      assetId: audio.id,
      revision: 1,
      in: 0,
      out: 5,
      start: 0,
      volume: 1,
      dialogueTake: ref(take),
      originalAudio: 'muted',
    };
  const doubled = f.service.saveEdl(f.project.id, { ...edl.data, audio: [overlay] }, edl.revision, {
    id: edl.id,
  });
  assert.ok(f.assembly.inspect(doubled.id).warnings.some((b: string) => b.includes('静音')));
  f.service.saveEdl(
    f.project.id,
    { ...doubled.data, clips: doubled.data.clips.map((c: any) => ({ ...c, volume: 0 })) },
    doubled.revision,
    { id: doubled.id },
  );
  assert.ok(!f.assembly.inspect(doubled.id).blockers.some((b) => b.includes('静音')));
});
test('branch series share identity references but cannot inherit their current timeline implicitly', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, exported, selection } = f.timeline(ep);
  f.reviewAll(edl, exported);
  const body = { exportAsset: ref(exported), canon: f.canon(ep, selection) },
    preview = f.assembly.previewRelease(edl.id, body);
  const release = f.assembly.release(edl.id, {
    ...body,
    digest: preview.digest,
    idempotencyKey: 'branch-source-release',
  });
  const confirmed = f.domain.confirmCanon(f.project.id, f.canon(ep, selection));
  const canonRef = ref(confirmed.document);
  const branch = f.store.create(
    'series',
    f.project.id,
    { title: 'Historical branch', bible: {}, approved: false },
    f.project.id,
  );
  const plan = f.seriesService.preview(branch.id, {
    version: 1,
    profile: ref(f.profile),
    sharedReferences: [ref(f.entity)],
    chronology: { mode: 'branch', fromCanon: canonRef },
  });
  f.seriesService.apply(branch.id, {
    ...plan,
    revision: branch.revision,
    idempotencyKey: 'branch-plan',
  });
  const child = f.service.createEpisode(f.project.id, {
    seriesId: branch.id,
    slotId: plan.data.slots[0].id,
  });
  assert.equal(predecessorCanon(f.store, child).canon.id, canonRef.id);
  assert.equal(resolveSeries(f.store, child).shared[0].id, f.entity.id);
  assert.equal(f.store.get(canonRef.id).revision, 1);
  f.store.update(selection.id, selection.revision, { ...selection.data, out: 4 });
  assert.equal(predecessorCanon(f.store, child).canon, null);
  assert.ok(predecessorCanon(f.store, child, true).waiting);
});
test('corrected or cropped adopted evidence makes nearer Canon unusable without mutating archived release', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    { edl, exported, selection } = f.timeline(ep);
  f.reviewAll(edl, exported);
  const body = { exportAsset: ref(exported), canon: f.canon(ep, selection) },
    preview = f.assembly.previewRelease(edl.id, body);
  const released = f.assembly.release(edl.id, {
    ...body,
    digest: preview.digest,
    idempotencyKey: 'later-cut-release',
  });
  const confirmed = f.domain.confirmCanon(f.project.id, f.canon(ep, selection));
  const next = f.createEpisode(1);
  f.store.update(selection.id, selection.revision, { ...selection.data, out: 4 });
  assert.ok(predecessorCanon(f.store, next).waiting);
  assert.equal(f.store.get(released.id, released.revision).data.frames, 120);
  assert.equal(f.seriesService.progress(f.series.id).delivered, 1);
  f.domain.propagateSelectionCorrection(f.project.id, {
    source: selection.id,
    affected: [],
    selectionChange: boundaryChanges(selection.data.boundary, selection.data.boundary),
    reason: 'Crop changed',
  });
  assert.equal(f.store.get(confirmed.document.id).data.stale, true);
  assert.equal(f.store.get(released.id).data.stale, false); // Fixed export no longer depends on Canon.
  assert.equal(f.store.get(released.id, released.revision).data.stale, false);
});

test('corrected series can explicitly rebind a reviewed fixed basis without silently upgrading history', async (t) => {
  const f = await fixture(t),
    old = f.store.get(f.series.id);
  const stale = f.store.update(old.id, old.revision, { ...old.data, stale: true });
  assert.doesNotThrow(() => resolveSeries(f.store, stale));
  const preview = f.seriesService.preview(stale.id, stale.data.production);
  assert.equal(f.store.get(stale.id).data.stale, true);
  const fixed = f.seriesService.apply(stale.id, {
    ...preview,
    revision: stale.revision,
    idempotencyKey: 'explicit-rebind',
  });
  assert.equal(resolveSeries(f.store, fixed).profile.revision, f.profile.revision);
  assert.equal(f.store.get(stale.id, stale.revision).data.stale, true);
});

test('two fixed sources with conflicting values require an explicit source and reason', async (t) => {
  const f = await fixture(t),
    ep = f.createEpisode(),
    a = f.adopt(ep, 1),
    b = f.adopt(ep, 2);
  const bSelection = f.store.update(b.selection.id, 1, {
    ...b.selection.data,
    boundary: {
      ...b.selection.data.boundary,
      end: { ...b.selection.data.boundary.end, facts: [fact(true)] },
    },
  });
  const shot = { ...ep.data.shots[0], id: 'next' };
  const segment = {
    ...ep.data.segments[0],
    id: 'next',
    shotIds: ['next'],
    incoming: incomingV2Schema.parse({
      version: 2,
      mode: 'continue',
      cut: 'angle',
      sources: [
        { id: 'a', selection: ref(a.selection), boundary: 'end' },
        { id: 'b', selection: ref(bSelection), boundary: 'end' },
      ],
      decisions: [
        { instanceId: 'device', key: 'powered', decision: 'inherit', sourceId: 'a', reason: '' },
      ],
    }),
  };
  const ctx = {
    ...ep,
    data: { ...ep.data, shots: [...ep.data.shots, shot], segments: [...ep.data.segments, segment] },
  };
  assert.match(prepareContinuation(f.store, ctx, segment).warnings.join(';'), /同一属性冲突/);
  segment.incoming.decisions[0].reason =
    'Source A is the adopted chronology for this object; B is a separate view before shutdown.';
  assert.equal(prepareContinuation(f.store, ctx, segment).snapshot.facts[0].value, false);
});

test('finite project phases and referenced event lifecycle reject undeclared action phases', () => {
  const a = { id: 'installation', phase: 'connected' },
    definitions = [{ id: 'installation', phases: ['held', 'aligned', 'connected'] }];
  assert.deepEqual(actionPhaseIssues([a], definitions, []), []);
  assert.match(
    actionPhaseIssues([{ ...a, phase: 'invented' }], definitions, []).join(''),
    /未在系列有限阶段/,
  );
  assert.deepEqual(
    actionPhaseIssues([{ id: 'turn-on', phase: 'in_progress' }], [], [{ id: 'turn-on' }]),
    [],
  );
});

test('planned information is not confirmed payoff evidence for a later episode', async (t) => {
  const f = await fixture(t),
    first = f.createEpisode(),
    second = f.createEpisode(1);
  const series = f.store.get(f.series.id),
    slots = series.data.production.slots;
  const plan = f.seriesService.preview(series.id, {
    ...series.data.production,
    information: [
      {
        id: 'clue',
        kind: 'audience_knowledge',
        statement: 'A clue is presented.',
        milestones: [{ slotId: slots[0].id, purpose: 'reveal', description: 'Introduce clue' }],
      },
      {
        id: 'answer',
        kind: 'audience_knowledge',
        statement: 'The clue is explained.',
        afterIds: ['clue'],
        milestones: [{ slotId: slots[1].id, purpose: 'payoff', description: 'Explain clue' }],
      },
    ],
  });
  f.seriesService.apply(series.id, {
    ...plan,
    revision: series.revision,
    idempotencyKey: 'information-plan',
  });
  const ep = {
    ...second,
    data: {
      ...second.data,
      seriesProduction: {
        ...second.data.seriesProduction,
        information: [{ informationId: 'answer', shotIds: ['s'] }],
      },
      shots: [
        {
          ...second.data.shots[0],
          directing: {
            ...second.data.shots[0].directing,
            information: [{ informationId: 'answer', purpose: 'reveal' }],
          },
        },
      ],
    },
  };
  assert.equal(seriesInformationForEpisode(f.store, ep).length, 1);
  const canon = f.store.create(
    'continuity',
    f.project.id,
    { schemaVersion: 3, seriesId: series.id, confirmed: true, stale: false, facts: [] },
    first.id,
  );
  assert.ok(seriesInformationForEpisode(f.store, ep, true).some((i: any) => i.warning));
  f.store.update(canon.id, canon.revision, {
    ...canon.data,
    facts: [
      {
        id: 'clue-shown',
        informationId: 'clue',
        informationStage: 'reveal',
        source: { kind: 'baseline' },
      },
    ],
  });
  // Even a persisted information stage cannot count as actual presentation without media provenance.
  assert.ok(seriesInformationForEpisode(f.store, ep, true).some((i: any) => i.warning));
});
