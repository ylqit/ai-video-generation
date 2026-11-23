import { WorkspaceService } from '../src/server/workspace.js';
import { productionHead } from '../src/server/creation-heads.js';
import { resolveAuthoringStates } from '../src/shared/authoring-state.js';
import { validateShotCues } from '../src/shared/authoring-timing.js';
import { auditShotSemantics } from '../src/shared/shot-semantics.js';
import { CreationMediaService } from '../src/server/creation-media.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { DeliveryService } from '../src/server/delivery.js';
import { StudioService } from '../src/server/service.js';
import { CreationService } from '../src/server/creation.js';
import { DomainService } from '../src/server/domain-service.js';
import { creationMediaStatus } from '../src/server/creation-production.js';
import { createApp } from '../src/server/app.js';
import { Worker } from '../src/server/worker.js';
import {
  creationSettingsSchema,
  authoringSchemas,
  inferDurationIntent,
  durationBounds,
  type AuthoringStage,
} from '../src/shared/creation.js';
import {
  validateAuthoringResult,
  authoringExecutionIssues,
} from '../src/shared/creation-validation.js';
import { authoringPrompt } from '../src/server/creation-prompts.js';
import { edlSchema } from '../src/shared/contracts.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { SubjectBindings } from '../src/server/subject-bindings.js';
import { ingestAsset, runProcess } from '../src/server/media.js';
import { config, prepareData } from '../src/server/config.js';
import { soundRequirements } from '../src/shared/shot-semantics.js';
import { SeriesProductionService } from '../src/server/series-production.js';
import { spatialFixture } from './fixtures/spatial-authoring.js';
import { authoringPrevisManifest } from '../src/server/previs-manifest.js';

const common = {
  schemaVersion: 9,
  contractRevision: 2,
  title: '产品灯光',
  summary: '指示灯亮起',
  assumptions: [],
  openQuestions: [],
  sources: [],
  contentChange: 'preserved',
};
const outputs: Record<AuthoringStage, any> = {
  brief: {
    ...common,
    stage: 'brief',
    intent: 'commercial',
    goal: '展示指示灯启动',
    audience: '设备用户',
    lockedFacts: [{ id: 'fact', kind: 'event', statement: '指示灯亮起', source: null }],
    requirements: [],
  },
  script: {
    ...common,
    stage: 'script',
    screenplayText: '桌面上的设备指示灯亮起。',
    subjects: [
      {
        key: 'device',
        name: 'Device',
        kind: 'object',
        description: 'A silver device.',
        attributes: [{ key: 'power', label: '电源', values: ['off', 'on'] }],
      },
    ],
    scenes: [
      {
        id: 'table',
        title: '桌面',
        setting: 'Neutral table',
        narrative: '指示灯启动',
        events: [{ id: 'on', description: 'The indicator turns on.', sourceFactIds: ['fact'] }],
        dialogue: [],
      },
    ],
  },
  direction: {
    ...common,
    stage: 'direction',
    visual: 'Photographic product lighting.',
    narrative: 'Read the change.',
    directing: 'Camera responds to the indicator.',
    editing: 'One clear event.',
    sound: 'Soft click, no speech.',
    assetPolicy: 'Text-only is sufficient for this generic device.',
  },
  director: {
    ...common,
    stage: 'director',
    sceneDesigns: [
      {
        id: 'table-design',
        sceneId: 'table',
        environmentKey: null,
        applicability: 'not_applicable',
        reason: 'Isolated indicator close-up, no spatial interaction.',
        source: null,
        scale: 'schematic',
        space: null,
        regions: [],
        barriers: [],
        anchors: [],
        cameras: [],
        proxies: [],
        assumptions: [],
      },
    ],
    shots: [
      {
        id: 'shot',
        sceneId: 'table',
        frames: 120,
        purpose: '展示启动',
        visibleSubjectKeys: ['device'],
        events: [{ eventId: 'on', phase: 'whole' }],
        dialogue: [],
        cues: [],
        action: 'The indicator on the silver device turns on and stays lit.',
        staging: null,
        interactions: [],
        visibleSpace: 'An isolated device on a neutral surface.',
        audienceFocus: 'The indicator.',
        informationChange: 'Power turns on.',
        cutReason: 'The light is stable.',
        visualTreatment: 'Photographic product lighting.',
        performances: [],
        camera: {
          shotSize: 'close-up',
          position: 'Front of the device',
          composition: 'Centered',
          motion: 'static',
          reason: 'Read the indicator',
        },
        entryState: [{ subjectKey: 'device', key: 'power', value: 'off' }],
        exitState: [{ subjectKey: 'device', key: 'power', value: 'on' }],
        entryRelations: [],
        exitRelations: [],
        environmentSound: 'Quiet room tone.',
        actionSound: 'A click.',
        soundContinuation: 'Room tone continues.',
      },
    ],
    groups: [
      {
        id: 'group',
        shotIds: ['shot'],
        transition: 'independent',
        reason: 'Standalone product view',
      },
    ],
  },
  assets: { ...common, stage: 'assets', items: [] },
  editorial: {
    ...common,
    stage: 'editorial',
    musicDecision: 'no_music',
    musicReason: 'Keep the actual click.',
    audio: [],
    overlays: [],
  },
};
async function fixture(t: any, automatic = false, seconds = 5) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-creation-v9-'));
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite')),
    studio = new StudioService(store),
    service = new CreationService(store);
  t.after(async () => {
    store.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'studio-creation-v9-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = studio.createProject({ title: 'V9 offline', mode: 'short', brief: '' });
  store.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9', instanceId: 'offline-only' });
  service.saveSettings(project.id, 0, {
    progression: automatic ? 'automatic' : 'review',
    allowance: { enabled: true, maxGenerations: 2, maxGeneratedSeconds: 10 },
  });
  let run = service.create(project.id, {
    request: `${seconds} 秒产品短片`,
    idempotencyKey: crypto.randomUUID(),
  });
  const accept = (stage: AuthoringStage, output = outputs[stage]) => {
    run = service.get(run.id);
    const draft = service.saveResult(run.id, stage, structuredClone(output), run.revision);
    service.approve(run.id, draft.id, draft.revision, crypto.randomUUID());
    run = service.get(run.id);
    return draft;
  };
  const throughAssets = () => {
    for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[])
      accept(stage);
    return service.get(run.id);
  };
  return {
    root,
    store,
    studio,
    service,
    project,
    get run() {
      return service.get(run.id);
    },
    accept,
    throughAssets,
  };
}

test('generic spatial authoring reaches fixed previews, inspected reference coverage and frozen generation without another model', async (t) => {
  const f = await fixture(t);
  const { script, director } = spatialFixture();
  f.accept('brief', { ...outputs.brief, lockedFacts: [] });
  f.accept('script', script);
  f.accept('direction');
  const result = f.accept('director', director);
  const state = generationDigest({ docs: f.store.list(), jobs: f.store.jobs() });
  const previs = authoringPrevisManifest(
    f.store,
    result.id,
    f.run.data.results.director.revision,
    'shot',
    0,
    256,
    256,
  );
  assert.equal(generationDigest({ docs: f.store.list(), jobs: f.store.jobs() }), state);
  assert.equal(previs.manifest.kind, 'authoring_previs');
  const item = {
    id: 'operation-reference',
    subjectKey: 'device',
    mediaType: 'image',
    purpose: 'composition',
    description: 'Inspection drawing for operation.',
    prompt: 'A side view of the device being operated.',
    layout: 'One clean frame',
    shotIds: ['shot'],
    view: 'left',
    preserve: ['Operating side and actor relation'],
    allow: ['Authored movement'],
    coverage: [
      { shotId: 'shot', interactionIds: ['use'], aspects: ['composition', 'interaction'] },
    ],
  };
  f.accept('assets', { ...outputs.assets, items: [item] });
  f.service.advance(f.run.id);
  assert.ok(!f.run.data.issues.some((i: any) => i.code === 'reference_coverage_missing'));
  const file = path.join(f.root, 'gray-previs-fixture.png');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=256x256',
    '-frames:v',
    '1',
    file,
  ]);
  let asset = await ingestAsset(f.store, f.root, f.project.id, file, {
    name: 'Offline renderer stand-in',
    previsualSource: previs.manifest,
  });
  const replay = await ingestAsset(f.store, f.root, f.project.id, file, {
    name: 'Offline renderer stand-in',
    previsualSource: previs.manifest,
  });
  assert.equal(replay.id, asset.id);
  await new CreationMediaService(f.store, f.root).confirmReferences(f.run.id, {
    runRevision: f.run.revision,
    idempotencyKey: 'spatial-reference-once',
    items: [
      {
        requirementId: item.id,
        asset: { id: asset.id, revision: asset.revision },
        inspected: true,
        conclusion: 'Offline user-review double, not a real visual claim.',
      },
    ],
  });
  f.service.advance(f.run.id);
  const preview = f.run.data.productionPreview;
  assert.ok(preview, JSON.stringify(f.run.data.issues));
  const compiled = preview.inputs[0].prepared;
  assert.match(compiled.finalPrompt, /Interaction use/);
  assert.equal(compiled.shotSpecs[0].directing.interactions[0].anchorId, 'control');
  assert.equal(compiled.shotSpecs[0].directing.sound.dialogue[0].mouth.visibility, 'occluded');
  assert.equal(preview.inputs[0].referenceCoverage[0].status, 'inspected_reference');
  const layout = f.store.list('layout', f.project.id)[0];
  assert.throws(
    () =>
      new DomainService(f.store).save(
        f.project.id,
        'layout',
        layout.data,
        layout.id,
        layout.revision,
      ),
    /导演/,
  );
  new WorkspaceService(f.store).submit(
    f.run.data.scope.id,
    f.run.data.scope.revision,
    f.run.revision,
    preview.digest,
    'spatial-video-once',
  );
  const generation = f.store.jobs().filter((j) => j.kind === 'generation');
  assert.equal(generation.length, 1);
  assert.deepEqual(generation[0].input.prepared, compiled);
});

test('exact, approximate and absent duration preserve distinct intent', () => {
  assert.deepEqual(inferDurationIntent('60 秒影片'), { mode: 'exact', seconds: 60 });
  assert.deepEqual(inferDurationIntent('大约一分钟'), {
    mode: 'approximate',
    seconds: 60,
    tolerancePercent: 5,
  });
  assert.deepEqual(inferDurationIntent('60秒左右'), {
    mode: 'approximate',
    seconds: 60,
    tolerancePercent: 5,
  });
  assert.deepEqual(inferDurationIntent('展示设备'), { mode: 'derive' });
  assert.deepEqual(durationBounds(inferDurationIntent('大约60秒')), {
    minFrames: 1368,
    maxFrames: 1512,
  });
});
test('closed authoring contracts accept product without facial performance and separate H3 readiness', () => {
  const director = authoringSchemas.director.parse(outputs.director);
  assert.equal(
    validateAuthoringResult(director, outputs, creationSettingsSchema.parse({})).length,
    0,
  );
  assert.throws(() => authoringSchemas.director.parse({ ...director, hiddenCommand: 'write DB' }));
  director.shots[0].frames = 720;
  assert.equal(
    validateAuthoringResult(director, outputs, creationSettingsSchema.parse({})).length,
    0,
  );
  assert.equal(authoringExecutionIssues(director)[0].category, 'execution');
});
test('fixed dialogue, declared state conflicts and completed event repetition are located', () => {
  const script = structuredClone(outputs.script);
  script.scenes[0].dialogue = [
    { id: 'line', speakerKey: 'device', text: '启动', sourceFactId: 'line-fact', language: 'zh' },
  ];
  const brief = {
    ...outputs.brief,
    lockedFacts: [{ id: 'line-fact', kind: 'dialogue', statement: '启动。', source: null }],
  };
  assert.ok(
    validateAuthoringResult(script, { brief }, creationSettingsSchema.parse({})).some(
      (i) => i.code === 'locked_dialogue_changed',
    ),
  );
  const director = structuredClone(outputs.director);
  director.shots.push({ ...structuredClone(director.shots[0]), id: 'repeat' });
  director.groups[0].shotIds.push('repeat');
  const issues = validateAuthoringResult(director, outputs, creationSettingsSchema.parse({}));
  assert.ok(issues.some((i) => i.code === 'planned_boundary_conflict'));
  assert.ok(issues.some((i) => /completed|repeat/.test(i.code)));
});
test('draft persists missing assets, then adopted production creates real asset request and blocks generation', async (t) => {
  const f = await fixture(t);
  for (const s of ['brief', 'script', 'direction', 'director'] as AuthoringStage[]) f.accept(s);
  f.accept('assets', {
    ...outputs.assets,
    items: [
      {
        id: 'identity',
        subjectKey: 'device',
        mediaType: 'image',
        purpose: 'identity',
        description: '设备参考',
        prompt: 'A silver device at rest.',
        layout: 'One visible instant.',
        shotIds: ['shot'],
        view: 'front',
      },
    ],
  });
  f.service.advance(f.run.id);
  assert.equal(f.run.data.state, 'awaiting_assets');
  assert.equal(f.store.list('asset_task', f.project.id).length, 1);
  assert.equal(f.store.jobs(f.project.id).filter((j) => j.kind === 'generation').length, 0);
  assert.equal(f.store.get(f.run.data.episodeId).data.segments.length, 0);
});
test('adopted product maps to fixed V6 profile and real H3 frozen input; review mode waits', async (t) => {
  const f = await fixture(t);
  f.throughAssets();
  f.service.advance(f.run.id);
  assert.equal(f.run.data.state, 'awaiting_production_approval', JSON.stringify(f.run.data.issues));
  assert.ok(f.run.data.productionPreview.digest);
  const episode = f.store.get(f.run.data.episodeId);
  assert.ok(episode.data.creationProfile);
  assert.equal(episode.data.shots[0].directing.performance.length, 0);
  assert.equal(episode.data.shots[0].state.attributes.end[0].value, 'on');
  assert.equal(f.store.jobs(f.project.id).filter((j) => j.kind === 'generation').length, 0);
});
test('automatic dispatch reserves once, pause leaves accepted work intact, success cannot auto-review', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  let jobs = f.store.jobs(f.project.id).filter((j) => j.kind === 'generation');
  assert.equal(jobs.length, 1, JSON.stringify(f.run.data.issues));
  assert.equal(jobs[0].input.creationCharge.seconds, 5);
  f.service.advance(f.run.id);
  assert.equal(f.store.jobs(f.project.id).filter((j) => j.kind === 'generation').length, 1);
  f.store.patchJob(jobs[0].id, { state: 'submitted', promptId: 'accepted' });
  f.service.pause(f.run.id, f.run.revision, true);
  assert.equal(f.store.job(jobs[0].id).state, 'submitted');
  f.service.pause(f.run.id, f.run.revision, false);
  f.store.patchJob(jobs[0].id, { state: 'succeeded' });
  f.service.advance(f.run.id);
  assert.equal(f.run.data.state, 'awaiting_review');
  assert.ok(f.run.data.issues.some((i: any) => i.code === 'actual_review_required'));
  assert.equal(creationMediaStatus(f.store, f.run).ready, false);
});
test('quota is transactional across connections, failed jobs keep reservations, and idempotent replay is free', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  const first = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
  const secondStore = new Store(path.join(f.root, 'studio.sqlite'));
  const key = crypto.randomUUID();
  const second = secondStore.createJob(
    'generation',
    f.project.id,
    first.episodeId,
    { ...first.input, retryOf: first.id },
    key,
  );
  assert.equal(
    secondStore.createJob(
      'generation',
      f.project.id,
      first.episodeId,
      { ...first.input, retryOf: first.id },
      key,
    ).id,
    second.id,
  );
  secondStore.close();
  f.store.patchJob(first.id, { state: 'failed' });
  assert.throws(
    () =>
      f.store.createJob(
        'generation',
        f.project.id,
        first.episodeId,
        first.input,
        crypto.randomUUID(),
      ),
    /额度不足/,
  );
  assert.equal(f.service.allowance(f.project.id).usedGenerations, 2);
});
test('project provider change requires renewed authorization', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  const job = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
  assert.throws(
    () =>
      f.store.createJob(
        'generation',
        f.project.id,
        job.episodeId,
        { ...job.input, profile: { ...job.input.profile, instanceId: 'new' } },
        crypto.randomUUID(),
      ),
    /连接已改变/,
  );
});
test('late cancelled text output cannot replace revised run, and prompts retain frozen versions', async (t) => {
  const f = await fixture(t),
    job = f.store.jobs(f.project.id)[0],
    oldPrompt = authoringPrompt(job.input.context);
  f.service.revise(f.run.id, 'brief', '新的需求');
  const late = f.service.complete(job, outputs.brief);
  assert.equal(late.data.stale, true);
  assert.equal(f.run.data.stage, 'brief');
  assert.equal(authoringPrompt(job.input.context), oldPrompt);
  assert.match(oldPrompt, /director-v8|权威|唯一/);
});
test('source identity and optimistic adoption cannot be forged', async (t) => {
  const f = await fixture(t);
  assert.throws(
    () =>
      f.service.saveResult(
        f.run.id,
        'brief',
        { ...outputs.brief, sources: [{ id: 'invented', revision: 1 }] },
        f.run.revision,
      ),
    /引用/,
  );
  const good = f.service.saveResult(f.run.id, 'brief', outputs.brief, f.run.revision),
    key = crypto.randomUUID();
  f.service.approve(f.run.id, good.id, good.revision, key);
  assert.equal(f.service.approve(f.run.id, good.id, good.revision, key).data.stage, 'script');
  assert.doesNotThrow(() =>
    f.service.approve(f.run.id, good.id, good.revision, crypto.randomUUID()),
  );
});
test('duration settings can change before the director stage without skipping prerequisites', async (t) => {
  const f = await fixture(t);
  f.service.saveSettings(f.project.id, f.service.settings(f.project.id).revision, {
    duration: { mode: 'approximate', seconds: 60 },
    allowance: { enabled: false },
  });
  assert.equal(f.run.data.stage, 'brief');
  assert.equal(f.run.data.duration.mode, 'approximate');
});
test('EDL exact overlays reject overflow and preserve no-overlay legacy shape', () => {
  const data = {
    schemaVersion: 2,
    episodeId: 'e',
    width: 256,
    height: 256,
    fps: 24,
    clips: [{ assetId: 'v', revision: 1, in: 0, out: 5, volume: 1 }],
    audio: [],
  };
  assert.equal('overlays' in edlSchema.parse(data), false);
  assert.throws(
    () =>
      edlSchema.parse({
        ...data,
        overlays: [
          {
            id: 'subtitle',
            text: '启动',
            sourceDialogueId: null,
            startFrame: 100,
            endFrame: 130,
            position: 'bottom',
            fontSize: 24,
            color: '#ffffff',
          },
        ],
      }),
    /实际成片/,
  );
});

async function adoptFixtureMedia(f: Awaited<ReturnType<typeof fixture>>) {
  const job = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
  const seconds = job.input.segment.duration,
    frames = Math.round(seconds * 24);
  const file = path.join(f.root, 'fixture.mp4');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=c=black:s=256x256:r=24:d=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=48000:cl=stereo',
    '-t',
    String(seconds),
    '-c:v',
    'libx264',
    '-c:a',
    'aac',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  let video = await ingestAsset(f.store, f.root, f.project.id, file, {
    name: 'Offline render fixture, not model quality evidence',
    jobId: job.id,
  });
  video = f.store.update(video.id, video.revision, { ...video.data, adopted: true });
  f.store.patchJob(job.id, { state: 'succeeded', output: { videoAssetId: video.id } });
  const domain = new DomainService(f.store),
    shot = f.store.get(f.run.data.episodeId).data.shots[0];
  const reference = (d: any) => ({ id: d.id, revision: d.revision });
  const review = domain.review(f.project.id, {
    jobId: job.id,
    video: reference(video),
    in: 0,
    out: seconds,
    inspected: true,
    dimensions: {
      identity: 'pass',
      props: 'pass',
      space: 'pass',
      action: 'pass',
      style: 'pass',
      audio: 'pass',
    },
    notes: 'Mock assertions for integration tests only, not evidence of generated quality.',
    observations: [
      {
        id: 'off',
        ...shot.state.attributes.start[0],
        startFrame: 0,
        endFrame: 24,
        inspection: 'motion',
      },
      {
        id: 'on',
        ...shot.state.attributes.end[0],
        startFrame: 24,
        endFrame: frames,
        inspection: 'motion',
      },
    ],
    eventEvidence: [
      {
        shotId: shot.id,
        eventId: shot.directing.events[0].id,
        status: 'pass',
        inspection: 'motion',
        startFrame: 0,
        endFrame: 25,
        observed: 'occurred',
      },
    ],
    audioEvidence: soundRequirements(shot.directing).map((r) => ({
      shotId: shot.id,
      requirementId: r.id,
      status: 'pass',
      inspection: 'audio',
      startFrame: 0,
      endFrame: frames,
      notes: 'Offline test double',
    })),
  });
  const selection = domain.select(f.project.id, {
    episode: reference(f.store.get(f.run.data.episodeId)),
    segmentId: 'group',
    jobId: job.id,
    video: reference(video),
    review: reference(review),
    in: 0,
    out: seconds,
    coverage: [{ shotId: 'shot', in: 0, out: seconds }],
  });
  return { video, selection, review };
}
test('actual FFmpeg overlay frames, existing export Worker, and version-bound final confirmation', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  await adoptFixtureMedia(f);
  f.service.advance(f.run.id);
  assert.equal(f.run.data.stage, 'editorial');
  f.accept('editorial', {
    ...outputs.editorial,
    overlays: [
      {
        id: 'caption',
        text: '启动 100% : \\ $()',
        sourceDialogueId: null,
        startFrame: 24,
        endFrame: 72,
        position: 'bottom',
        fontSize: 30,
        color: '#ffffff',
      },
    ],
  });
  f.service.advance(f.run.id);
  assert.ok(f.run.data.exportJobId, JSON.stringify(f.run.data.issues));
  const job = f.store.job(f.run.data.exportJobId),
    worker = new Worker(f.store, f.root);
  await worker.execute(job, 'media', new AbortController().signal);
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  f.service.advance(f.run.id);
  const media = creationMediaStatus(f.store, f.run),
    exported = media.exportAsset!;
  assert.equal(exported.data.frameCount, 120);
  const md5 = await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-i',
    path.join(f.root, exported.data.path),
    '-an',
    '-f',
    'framemd5',
    '-',
  ]);
  const hashes = md5
    .split(/\r?\n/)
    .filter((s) => s && !s.startsWith('#'))
    .map((s) => s.split(',').at(-1)!.trim());
  assert.notEqual(hashes[0], hashes[35]);
  assert.equal(hashes[0], hashes[100]);
  const body = {
    revision: f.run.revision,
    exportAsset: { id: exported.id, revision: exported.revision },
    watched: true,
    listened: true,
    conclusion: 'Offline confirmation test',
    idempotencyKey: crypto.randomUUID(),
  };
  const unobserved = f.service.confirmDelivery(f.run.id, {
    ...body,
    watched: false,
    listened: false,
  });
  assert.equal(unobserved.data.watched, false);
  const receipt = f.service.confirmDelivery(f.run.id, { ...body, watched: false, listened: false });
  assert.equal(receipt.data.sha256, exported.data.sha256);
  assert.equal(f.run.data.state, 'complete');
  assert.equal(
    f.service.confirmDelivery(f.run.id, { ...body, watched: false, listened: false }).id,
    receipt.id,
  );
  // A subsequent revision does not mutate the frozen export or reuse confirmation.
  f.service.revise(f.run.id, 'editorial', '调整片尾字幕');
  assert.throws(
    () => f.service.confirmDelivery(f.run.id, { ...body, idempotencyKey: crypto.randomUUID() }),
    /状态|变化/,
  );
  assert.deepEqual(f.store.job(job.id).input, job.input);
});
test('changing actual export or EDL before final confirmation rejects old attestation', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  await adoptFixtureMedia(f);
  f.service.advance(f.run.id);
  f.accept('editorial');
  f.service.advance(f.run.id);
  const worker = new Worker(f.store, f.root);
  await worker.execute(f.store.job(f.run.data.exportJobId), 'media', new AbortController().signal);
  f.service.advance(f.run.id);
  const exported = creationMediaStatus(f.store, f.run).exportAsset!,
    edl = f.store.get(f.run.data.edl.id);
  const plan = f.store.get(f.run.data.deliveryPlan.id);
  const service = new DeliveryService(f.store);
  const edits = [
    { ...edl.data, clips: edl.data.clips.map((c: any) => ({ ...c, volume: 0.5 })) },
    {
      ...edl.data,
      overlays: [
        {
          id: 'new-subtitle',
          text: 'Changed subtitle',
          sourceDialogueId: null,
          startFrame: 0,
          endFrame: 24,
          position: 'bottom',
          fontSize: 24,
          color: '#ffffff',
        },
      ],
    },
    {
      ...edl.data,
      audio: [
        {
          assetId: edl.data.clips[0].assetId,
          revision: edl.data.clips[0].revision,
          in: 0,
          out: 1,
          start: 0,
          volume: 0.5,
        },
      ],
    },
  ];
  for (const edit of edits) {
    service.update(plan.id, {
      revision: f.store.get(plan.id).revision,
      runRevision: f.run.revision,
      duration: plan.data.duration,
      edlDraft: edit,
    });
    assert.throws(
      () =>
        f.service.confirmDelivery(f.run.id, {
          revision: f.run.revision,
          exportAsset: { id: exported.id, revision: exported.revision },
          watched: true,
          listened: true,
          conclusion: 'Old cut',
          idempotencyKey: crypto.randomUUID(),
        }),
      /变化/,
    );
    assert.equal(f.store.list('creation_delivery', f.project.id).length, 0);
    assert.equal(service.inspect(plan.id).validConfirmation, false);
  }
  assert.doesNotThrow(() =>
    service.update(plan.id, {
      revision: f.store.get(plan.id).revision,
      runRevision: f.run.revision,
      duration: plan.data.duration,
      edlDraft: {
        ...edl.data,
        clips: edl.data.clips.map((c: any) => ({ ...c, in: c.in + 1 / 24 })),
      },
    }),
  );
  const selection = f.store.get(edl.data.clips[0].selection.id);
  f.store.update(selection.id, selection.revision, {
    ...selection.data,
    in: selection.data.in + 1 / 24,
    coverage: selection.data.coverage.map((c: any) => ({ ...c, in: c.in + 1 / 24 })),
  });
  assert.equal(service.inspect(plan.id).blockers.length, 0); // Fixed media remains editable without another quality review.
});
test('two scope deliveries and full work own separate EDLs and scope confirmation does not finish work', async (t) => {
  const f = await fixture(t, true);
  const policy = f.service.settings(f.project.id);
  f.service.saveSettings(f.project.id, policy.revision, {
    ...policy.data.policy,
    duration: { mode: 'exact', seconds: 60 },
    allowance: { enabled: true, maxGenerations: 3, maxGeneratedSeconds: 60 },
  });
  f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    duration: { mode: 'exact', seconds: 60 },
  });
  const director = structuredClone(outputs.director);
  director.shots[0].frames = 288;
  for (let i = 1; i < 6; i++) {
    director.shots.push({
      ...structuredClone(director.shots[0]),
      id: `shot${i}`,
      frames: i === 5 ? 192 : 240,
      events: [],
      entryState: [{ subjectKey: 'device', key: 'power', value: 'on' }],
    });
    director.groups.push({
      id: `group${i}`,
      shotIds: [`shot${i}`],
      transition: 'independent',
      reason: 'Another product view',
    });
  }
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[])
    f.accept(stage, stage === 'director' ? director : outputs[stage]);
  const workspace = new WorkspaceService(f.store);
  workspace.saveScope(
    f.run.id,
    f.run.revision,
    { name: '12 second sample', mode: 'selection', shotIds: ['shot'], groupIds: [] },
    true,
  );
  f.service.advance(f.run.id);
  await adoptFixtureMedia(f);
  const service = new DeliveryService(f.store, f.root);
  const originalScope = f.store.get(f.run.data.scope.id);
  const secondScope = f.store.create(
    'creation_scope',
    f.project.id,
    { ...originalScope.data, version: 1 },
    f.run.id,
  );
  const plans = [originalScope, secondScope].map((scope) => {
    const {
      windows: _windows,
      missingGroups: _missing,
      ...draft
    } = service.draft(f.run.id, {
      mode: 'scope',
      scope: { id: scope.id, revision: scope.revision },
    });
    const body = { ...draft, idempotencyKey: crypto.randomUUID() };
    const plan = service.create(f.run.id, body);
    assert.equal(service.create(f.run.id, body).id, plan.id);
    return plan;
  });
  const {
    windows: _windows,
    missingGroups: _missing,
    ...draft
  } = service.draft(f.run.id, { mode: 'work' });
  const work = service.create(f.run.id, {
    ...draft,
    duration: { mode: 'exact', seconds: 60 },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(new Set([...plans, work].map((p) => p.data.edl.id)).size, 3);
  assert.equal(service.inspect(work.id).blockers.length, 0);
  const first = plans[0];
  const body = {
    revision: first.revision,
    basisDigest: first.data.basisDigest,
    idempotencyKey: crypto.randomUUID(),
  };
  const job = service.export(first.id, body);
  assert.equal(service.export(first.id, body).id, job.id);
  const worker = new Worker(f.store, f.root);
  await worker.execute(job, 'media', new AbortController().signal);
  assert.equal(f.store.job(job.id).state, 'succeeded');
  const asset = service.inspect(first.id).assets[0];
  assert.equal(asset.data.frameCount, 288);
  assert.equal(first.data.duration.seconds, 12);
  assert.equal(f.run.data.duration.seconds, 60);
  const current = f.run;
  f.store.update(current.id, current.revision, {
    ...current.data,
    messages: [...current.data.messages, { role: 'user', text: 'ordinary progress message' }],
  });
  assert.equal(service.inspect(first.id).blockers.length, 0);
  const confirmation = {
    revision: f.run.revision,
    planRef: { id: first.id, revision: first.revision },
    exportAsset: { id: asset.id, revision: asset.revision },
    watched: true,
    listened: true,
    conclusion: 'Offline fixture only',
    idempotencyKey: crypto.randomUUID(),
  };
  const receipt = service.confirm(f.run.id, confirmation);
  assert.equal(service.confirm(f.run.id, confirmation).id, receipt.id);
  assert.notEqual(f.run.data.state, 'complete');
  assert.equal(f.store.list('episode_release').length, 0);
  assert.equal(service.inspect(first.id).validConfirmation, true);
  const edl = f.store.get(first.data.edl.id);
  assert.throws(() => f.studio.saveEdl(f.project.id, edl.data, edl.revision), /时间线/);
  service.update(first.id, {
    revision: first.revision,
    runRevision: f.run.revision,
    duration: first.data.duration,
    edlDraft: { ...edl.data, clips: edl.data.clips.map((c: any) => ({ ...c, volume: 0.5 })) },
  });
  assert.equal(service.inspect(first.id).validConfirmation, false);
  assert.equal(f.store.get(plans[1].data.edl.id).revision, plans[1].data.edl.revision);
  assert.equal(f.store.get(work.data.edl.id).revision, work.data.edl.revision);
});

test('delivery projects discontinuous ranges using actual per-shot coverage and retains unmappable subtitle text', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  const { video, selection } = await adoptFixtureMedia(f);
  const reference = (d: any) => ({ id: d.id, revision: d.revision });
  const source = f.store.get(f.run.data.results.director.id);
  const shots = [48, 24, 48].map((frames, index) => ({
    ...structuredClone(source.data.result.shots[0]),
    id: `s${index}`,
    frames,
  }));
  const groups = shots.map((s, index) => ({
    id: `g${index}`,
    shotIds: [s.id],
    transition: 'independent',
    reason: 'fixture',
  }));
  const director = f.store.create(
    'authoring_result',
    f.project.id,
    { ...source.data, result: { ...source.data.result, shots, groups } },
    f.run.id,
  );
  const ep = f.store.get(f.run.data.episodeId);
  f.store.update(ep.id, ep.revision, {
    ...ep.data,
    segments: groups.map((g, index) => ({ ...g, duration: shots[index].frames / 24 })),
  });
  const selections = [
    [0, 2],
    [2, 3],
    [3, 5],
  ].map(([start, end], index) =>
    f.store.create(
      'segment_selection',
      f.project.id,
      {
        ...selection.data,
        segmentId: groups[index].id,
        in: start,
        out: end,
        coverage: [{ shotId: shots[index].id, in: start, out: end }],
      },
      ep.id,
    ),
  );
  const editorial = f.store.create(
    'authoring_result',
    f.project.id,
    {
      stage: 'editorial',
      adopted: true,
      schemaVersion: 9,
      context: { dependencies: [] },
      result: {
        ...outputs.editorial,
        audio: [{ asset: reference(video), inFrame: 0, outFrame: 120, startFrame: 0, volume: 1 }],
        overlays: [
          {
            id: 'caption',
            text: 'Original subtitle',
            sourceDialogueId: null,
            startFrame: 90,
            endFrame: 108,
            position: 'bottom',
            fontSize: 24,
            color: '#ffffff',
          },
        ],
      },
    },
    f.run.id,
  );
  f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    results: {
      ...f.run.data.results,
      director: reference(director),
      editorial: reference(editorial),
    },
  });
  const oldScope = f.store.get(f.run.data.scope.id);
  const scope = f.store.create(
    'creation_scope',
    f.project.id,
    {
      ...oldScope.data,
      version: 1,
      authoring: f.run.data.results,
      mode: 'selection',
      shotIds: ['s0', 's2'],
      groupIds: ['g0', 'g2'],
      windows: [
        { shotId: 's0', startFrame: 0, endFrame: 48 },
        { shotId: 's2', startFrame: 72, endFrame: 120 },
      ],
      totalFrames: 120,
      requestedFrames: 96,
    },
    f.run.id,
  );
  const service = new DeliveryService(f.store, f.root),
    target = { mode: 'scope' as const, scope: reference(scope) };
  const draft = service.draft(f.run.id, target);
  assert.deepEqual(draft.windows, [
    { sourceStart: 0, sourceEnd: 48, outputStart: 0 },
    { sourceStart: 72, sourceEnd: 120, outputStart: 48 },
  ]);
  assert.deepEqual(
    draft.edlDraft.audio.map((a: any) => [a.in, a.out, a.start]),
    [
      [0, 2, 0],
      [3, 5, 2],
    ],
  );
  assert.deepEqual(
    draft.edlDraft.overlays.map((o: any) => [o.text, o.startFrame, o.endFrame]),
    [['Original subtitle', 66, 84]],
  );
  assert.deepEqual(draft.pendingChecks, []);
  f.store.update(selections[2].id, selections[2].revision, {
    ...selections[2].data,
    out: 4,
    coverage: [{ shotId: 's2', in: 3, out: 4 }],
  });
  const trimmed = service.draft(f.run.id, target);
  assert.equal(trimmed.windows.length, 1);
  assert.equal(trimmed.edlDraft.overlays.length, 0);
  assert.match(trimmed.pendingChecks.join(';'), /Original subtitle/);
  assert.match(trimmed.pendingChecks.join(';'), /未映射区间/);
  // Equal overall duration cannot hide changed internal shot timing.
  const changedEp = f.store.get(ep.id);
  f.store.update(ep.id, changedEp.revision, {
    ...changedEp.data,
    segments: [{ id: 'combined', shotIds: ['s0', 's1', 's2'], duration: 5 }],
  });
  f.store.create(
    'segment_selection',
    f.project.id,
    {
      ...selection.data,
      segmentId: 'combined',
      coverage: [
        { shotId: 's0', in: 0, out: 1 },
        { shotId: 's1', in: 1, out: 3 },
        { shotId: 's2', in: 3, out: 5 },
      ],
    },
    ep.id,
  );
  const newDirector = f.store.create(
    'authoring_result',
    f.project.id,
    {
      ...director.data,
      result: {
        ...director.data.result,
        groups: [
          {
            id: 'combined',
            shotIds: ['s0', 's1', 's2'],
            transition: 'independent',
            reason: 'fixture',
          },
        ],
      },
    },
    f.run.id,
  );
  f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    results: { ...f.run.data.results, director: reference(newDirector) },
  });
  const work = service.draft(f.run.id, { mode: 'work' });
  assert.equal(
    work.edlDraft.clips.reduce((n: number, c: any) => n + c.out - c.in, 0),
    5,
  );
  assert.equal(work.windows.length, 1);
  assert.match(work.pendingChecks.join(';'), /s0/);
  assert.match(work.pendingChecks.join(';'), /s1/);
});

test('only V9 onscreen dialogue requires lip-sync evidence; voiceover and offscreen preserve audio review', () => {
  for (const delivery of ['onscreen', 'offscreen', 'voiceover']) {
    const directing = {
      version: 2,
      events: [],
      cues: [],
      sound: { dialogue: [{ id: 'line', instanceId: 'speaker', text: 'Words', delivery }] },
    };
    const evidence = {
      audioEvidence: [
        {
          shotId: 'shot',
          requirementId: 'dialogue:0',
          speakerId: 'speaker',
          text: 'Words',
          status: 'pass',
          inspection: 'audio',
          startFrame: 0,
          endFrame: 24,
          notes: 'Offline fixture',
        },
      ],
    };
    const errors = auditShotSemantics({ shotId: 'shot', directing }, evidence, { in: 0, out: 1 });
    assert.equal(
      errors.some((e) => e.includes('口型')),
      delivery === 'onscreen',
    );
    assert.deepEqual(
      auditShotSemantics(
        { shotId: 'shot', directing },
        { audioEvidence: [{ ...evidence.audioEvidence[0], lipSyncReviewed: true }] },
        { in: 0, out: 1 },
      ),
      [],
    );
    assert.ok(
      auditShotSemantics({ shotId: 'shot', directing }, {}, { in: 0, out: 1 }).some((e) =>
        e.includes('听审'),
      ),
    );
  }
});

test('HTTP mutation boundaries reject forged actors, version conflicts, and unknown retry', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const address = server.address() as any,
    url = `http://127.0.0.1:${address.port}`;
  try {
    const post = (route: string, body: any) =>
      fetch(url + '/api' + route, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal(
      (await post(`/creation-runs/${f.run.id}/pause`, { revision: 0, paused: true })).status,
      409,
    );
    assert.equal(
      (
        await post(`/creation-runs/${f.run.id}/approve`, {
          result: { id: 'fake', revision: 1 },
          idempotencyKey: crypto.randomUUID(),
          actor: 'agent',
        })
      ).status,
      400,
    );
    const job = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
    f.store.patchJob(job.id, { state: 'unknown' });
    assert.equal(
      (
        await post(`/creation-runs/${f.run.id}/retry`, {
          revision: f.run.revision,
          jobId: job.id,
          idempotencyKey: crypto.randomUUID(),
        })
      ).status,
      409,
    );
    assert.equal(f.service.allowance(f.project.id).usedGenerations, 1);
    f.store.patchJob(job.id, { state: 'failed', error: 'Definite offline failure' });
    const requests = await Promise.all(
      [0, 1].map(() =>
        post(`/creation-runs/${f.run.id}/retry`, {
          revision: f.run.revision,
          jobId: job.id,
          idempotencyKey: crypto.randomUUID(),
        }),
      ),
    );
    assert.deepEqual(requests.map((r) => r.status).sort(), [200, 409]);
    assert.equal(f.service.allowance(f.project.id).usedGenerations, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('automatic to review holds queued work, preserves accepted receipts, and restores only reviewed queue', async (t) => {
  const f = await fixture(t, true);
  f.throughAssets();
  f.service.advance(f.run.id);
  const job = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
  const policy = structuredClone(f.service.settings(f.project.id).data.policy);
  policy.progression = 'review';
  f.service.saveSettings(f.project.id, f.service.settings(f.project.id).revision, policy);
  f.service.advance(f.run.id);
  assert.equal(f.store.job(job.id).holdReason, 'creation_mode_review');
  const preview = f.run.data.productionPreview;
  f.service.pause(f.run.id, f.run.revision, true);
  f.service.pause(f.run.id, f.run.revision, false);
  assert.equal(f.store.job(job.id).holdReason, 'creation_mode_review');
  assert.equal(preview.digest, generationDigest([{ id: job.id, input: job.input }]));
  assert.equal(f.service.allowance(f.project.id).usedGenerations, 1);
  policy.progression = 'automatic';
  f.service.saveSettings(f.project.id, f.service.settings(f.project.id).revision, policy);
  f.service.pause(f.run.id, f.run.revision, true);
  policy.progression = 'review';
  f.service.saveSettings(f.project.id, f.service.settings(f.project.id).revision, policy);
  f.service.pause(f.run.id, f.run.revision, false);
  assert.equal(f.store.job(job.id).holdReason, 'creation_mode_review');
});
test('professional source changes block reuse; unrelated records do not invalidate adopted work', async (t) => {
  const f = await fixture(t);
  const source = f.store.create('chapter', f.project.id, { title: 'source', text: '设备启动' });
  f.service.revise(f.run.id, 'brief', '复用原文', [{ id: source.id, revision: source.revision }]);
  f.accept('brief');
  f.store.create('chapter', f.project.id, { title: 'unrelated', text: '别的故事' });
  assert.ok(f.service.adopted(f.run).brief);
  f.store.update(source.id, source.revision, { ...source.data, text: '设备关闭' });
  assert.throws(() => f.service.adopted(f.run), /新版本/);
  assert.equal(f.store.jobs(f.project.id).filter((j) => j.kind === 'generation').length, 0);
});
test('V9 series uses fixed V7 profile and v4 inputs with explicit runtime, without requiring human assets', async (t) => {
  const f = await fixture(t, true),
    domain = new DomainService(f.store);
  const project = f.studio.createProject({ title: 'V9 series', mode: 'series', brief: '' });
  let profile = domain.save(project.id, 'creation_profile', {
    name: 'Series specification',
    rulesVersion: 'director-v7',
    composition: { moduleRefs: [], overrides: { visual: 'Photographic product' }, artEntries: [] },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'Offline written rules',
  });
  let series = f.store.list('series', project.id)[0];
  const seriesService = new SeriesProductionService(f.store);
  const preview = seriesService.preview(series.id, {
    version: 1,
    profile: { id: profile.id, revision: profile.revision },
    targetEpisodes: 2,
    runtime: { targetFrames: 120, toleranceFrames: 0 },
  });
  series = seriesService.apply(series.id, {
    ...preview,
    revision: series.revision,
    idempotencyKey: crypto.randomUUID(),
  });
  const ep = f.studio.createEpisode(project.id, {
    seriesId: series.id,
    slotId: series.data.production.slots[0].id,
  });
  f.service.saveSettings(project.id, 0, {
    progression: 'automatic',
    allowance: { enabled: true, maxGenerations: 1, maxGeneratedSeconds: 5 },
  });
  const run = f.service.create(project.id, {
    episodeId: ep.id,
    request: '5 秒设备展示',
    idempotencyKey: crypto.randomUUID(),
  });
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[]) {
    const current = f.service.get(run.id),
      draft = f.service.saveResult(run.id, stage, outputs[stage], current.revision);
    if (stage === 'script')
      new SubjectBindings(f.store).save(run.id, {
        revision: f.service.get(run.id).revision,
        script: { id: draft.id, revision: draft.revision },
        bindings: draft.data.result.subjects.map((s: any) => ({
          subjectKey: s.key,
          subjectDigest: generationDigest(s),
          decision: 'new',
          entity: null,
          instanceId: null,
          reason: '首次出场产品，明确新建实例',
        })),
        idempotencyKey: 'series-product-mapping',
      });
    f.service.approve(run.id, draft.id, draft.revision, crypto.randomUUID());
  }
  f.service.advance(run.id);
  const jobs = f.store.jobs(project.id).filter((j) => j.kind === 'generation');
  assert.equal(jobs.length, 1, JSON.stringify(f.service.get(run.id).data.issues));
  assert.equal(jobs[0].input.templateVersion, 'native-h3-base-v4');
  assert.deepEqual(jobs[0].input.creativeBrief.profile, {
    id: profile.id,
    revision: profile.revision,
  });
  assert.equal(f.store.get(ep.id).data.seriesProduction.runtime, undefined);
  assert.equal(jobs[0].input.effectivePlan.runtime.targetFrames, 120);
  assert.equal(f.store.list('voice_profile', project.id).length, 0);
});
test('real imported product reference resumes the draft into a published Ref plan', async (t) => {
  const f = await fixture(t, true);
  for (const s of ['brief', 'script', 'direction', 'director'] as AuthoringStage[]) f.accept(s);
  f.accept('assets', {
    ...outputs.assets,
    items: [
      {
        id: 'identity',
        subjectKey: 'device',
        mediaType: 'image',
        purpose: 'identity',
        description: 'Silver device identity',
        prompt: 'A silver device.',
        layout: 'One reference view',
        shotIds: ['shot'],
        view: 'front',
      },
    ],
  });
  f.service.advance(f.run.id);
  assert.equal(f.run.data.state, 'awaiting_assets');
  const file = path.join(f.root, 'reference.png');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=256x256',
    '-frames:v',
    '1',
    file,
  ]);
  let asset = await ingestAsset(f.store, f.root, f.project.id, file, {
    name: 'Offline product reference fixture',
  });
  asset = f.store.update(asset.id, asset.revision, { ...asset.data, adopted: true });
  f.service.bindAsset(f.run.id, {
    revision: f.run.revision,
    requirementId: 'identity',
    asset: { id: asset.id, revision: asset.revision },
    inspected: true,
    conclusion: 'Offline user review double',
  });
  assert.equal(f.run.data.bindings.identity.reviewer, 'user');
  f.service.bindAsset(
    f.run.id,
    {
      revision: f.run.revision,
      requirementId: 'identity',
      asset: { id: asset.id, revision: asset.revision },
      inspected: true,
      conclusion: 'Offline agent review double; never attributed to a user',
    },
    'agent',
  );
  assert.equal(f.run.data.bindings.identity.reviewer, 'agent');
  f.service.advance(f.run.id);
  const jobs = f.store.jobs(f.project.id).filter((j) => j.kind === 'generation');
  assert.equal(jobs.length, 1, JSON.stringify(f.run.data.issues));
  assert.equal(jobs[0].input.templateVersion, 'native-h3-directed-v3');
  assert.equal(f.store.list('reference_plan', f.project.id)[0].data.published, true);
});
test('existing Worker performs bounded V9 text repair and records automatic adoption actor', async (t) => {
  const f = await fixture(t, true);
  let calls = 0;
  const worker = new Worker(
    f.store,
    f.root,
    () => {
      throw new Error('No cloud in authoring test');
    },
    async (context) => {
      calls++;
      assert.equal(context.schemaVersion, 9);
      return calls === 1 ? { bad: 'malformed professional output' } : outputs.brief;
    },
  );
  try {
    await worker.tick();
    await worker.tick();
    await worker.tick();
    assert.equal(calls, 2);
    assert.equal(f.run.data.stage, 'script');
    assert.equal(f.run.data.decisions[0].actor, 'agent');
    const documents = f.store
      .list('authoring_result', f.project.id)
      .sort((a, b) => a.data.ordinal - b.data.ordinal);
    assert.equal(documents[0].data.valid, false);
    assert.equal(documents[1].data.adopted, true);
    assert.ok(documents[1].data.context.repairIssues.length);
  } finally {
    worker.stop();
    await worker.drain();
  }
});

test('V9 offscreen and voiceover dialogue and cue IDs survive authoring, H3 preview and frozen job', async (t) => {
  const f = await fixture(t);
  const script = structuredClone(outputs.script),
    director = structuredClone(outputs.director);
  script.subjects.push({
    key: 'narrator',
    name: 'Narrator',
    kind: 'human',
    description: 'An unseen narrator.',
    attributes: [],
  });
  script.screenplayText += ' Narrator: Starting. Ready.';
  script.scenes[0].dialogue = [
    { id: 'off', speakerKey: 'narrator', text: 'Starting.', language: 'en', sourceFactId: null },
    { id: 'voice', speakerKey: 'narrator', text: 'Ready.', language: 'en', sourceFactId: null },
  ];
  director.shots[0].dialogue = [
    { lineId: 'off', delivery: 'offscreen', mouth: { visibility: 'out_of_frame', window: null } },
    { lineId: 'voice', delivery: 'voiceover', mouth: { visibility: 'out_of_frame', window: null } },
  ];
  director.shots[0].cues = [
    {
      id: 'event',
      target: { kind: 'event', eventId: 'on' },
      window: { startFrame: 0, endFrame: 24 },
      afterIds: [],
    },
    {
      id: 'speech',
      target: { kind: 'dialogue', lineId: 'off' },
      window: { startFrame: 24, endFrame: 60 },
      afterIds: ['event'],
    },
    {
      id: 'narration',
      target: { kind: 'dialogue', lineId: 'voice' },
      window: { startFrame: 60, endFrame: 120 },
      afterIds: ['speech'],
    },
  ];
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[])
    f.accept(stage, stage === 'script' ? script : stage === 'director' ? director : outputs[stage]);
  f.service.advance(f.run.id);
  const preview = f.run.data.productionPreview;
  assert.ok(preview, JSON.stringify(f.run.data.issues));
  const shot = preview.inputs[0].prepared.shotSpecs[0];
  assert.deepEqual(
    shot.directing.sound.dialogue.map((l: any) => l.delivery),
    ['offscreen', 'voiceover'],
  );
  assert.equal(shot.directing.presence.audible.length, 1);
  assert.equal(shot.directing.presence.visible.length, 1);
  assert.equal(shot.directing.events[0].strictWindow, true);
  assert.equal(shot.directing.events[0].endFrame, 24);
  assert.equal(
    preview.inputs[0].prepared.trace.filter((r: any) => r.field === 'directing.cues').length,
    1,
  );
  assert.equal(
    preview.inputs[0].prepared.trace.find((r: any) => r.field === 'directing.cues').status,
    'text_request',
  );
  assert.match(JSON.stringify(preview.inputs[0].prepared), /Timing cue speech/);
  assert.equal(preview.inputs[0].capabilities.authoringVersion, 9);
  new WorkspaceService(f.store).submit(
    f.run.data.scope.id,
    f.run.data.scope.revision,
    f.run.revision,
    preview.digest,
    crypto.randomUUID(),
  );
  const jobs = f.store.jobs().filter((j) => j.kind === 'generation');
  assert.equal(jobs.length, 1);
  assert.deepEqual(jobs[0].input.prepared.shotSpecs[0].directing.cues, shot.directing.cues);
});

test('V9 cue target, window, order and real observation audit reject invalid evidence', () => {
  const shot = authoringSchemas.director.parse(outputs.director).shots[0];
  shot.cues = [
    {
      id: 'a',
      target: { kind: 'event', eventId: 'missing' },
      window: { startFrame: 20, endFrame: 121 },
      afterIds: ['a'],
    },
  ];
  assert.ok(validateShotCues(shot).some((i) => i.code === 'cue_target'));
  assert.ok(validateShotCues(shot).some((i) => i.code === 'cue_window'));
  assert.ok(validateShotCues(shot).some((i) => i.code === 'cue_cycle'));
  const cues = [
    {
      id: 'a',
      target: { kind: 'event', eventId: 'on' },
      window: { startFrame: 0, endFrame: 24 },
      afterIds: [],
    },
    {
      id: 'b',
      target: { kind: 'performance', performanceId: 'reaction' },
      window: null,
      afterIds: ['a'],
    },
  ];
  const spec = {
    shotId: 'shot',
    directing: { version: 2, events: [], cues, sound: { dialogue: [] } },
  };
  const evidence = {
    cueEvidence: [
      {
        shotId: 'shot',
        cueId: 'a',
        startFrame: 0,
        endFrame: 24,
        status: 'pass',
        inspection: 'motion',
        notes: 'Observed event',
      },
      {
        shotId: 'shot',
        cueId: 'b',
        startFrame: 24,
        endFrame: 50,
        status: 'pass',
        inspection: 'motion',
        notes: 'Observed reaction',
      },
    ],
  };
  assert.deepEqual(auditShotSemantics(spec, evidence, { in: 0, out: 5 }), []);
  evidence.cueEvidence[1].startFrame = 20;
  assert.ok(auditShotSemantics(spec, evidence, { in: 0, out: 5 }).some((s) => s.includes('先后')));
  assert.ok(auditShotSemantics(spec, {}, { in: 0, out: 5 }).some((s) => s.includes('缺少')));
});

test('13 V9 shots and 12 lines freeze into six Ref2VA requests, then export a 1440-frame review without adoption', async (t) => {
  const f = await fixture(t, false, 60);
  const settings = f.service.settings(f.project.id);
  f.service.saveSettings(f.project.id, settings.revision, {
    ...settings.data.policy,
    output: { width: 1280, height: 736, steps: 20 },
    allowance: { enabled: true, maxGenerations: 6, maxGeneratedSeconds: 60 },
  });
  const script = structuredClone(outputs.script),
    director = structuredClone(outputs.director);
  script.subjects.push({
    key: 'second',
    name: 'Second device',
    kind: 'object',
    description: 'Blue device',
    attributes: [],
  });
  script.scenes[0].events = Array.from({ length: 13 }, (_, i) => ({
    id: `e${i}`,
    description: `Fixture action ${i}`,
    sourceFactIds: i === 0 ? ['fact'] : [],
  }));
  script.scenes[0].dialogue = Array.from({ length: 12 }, (_, i) => ({
    id: `d${i}`,
    speakerKey: i === 10 ? 'second' : 'device',
    text: `はい、${i + 1}。`,
    translation: `第${i + 1}句`,
    language: 'ja',
    sourceFactId: null,
  }));
  script.screenplayText = script.scenes[0].dialogue.map((l: any) => l.text).join('\n');
  const frames = [36, 156, 96, 144, 36, 144, 108, 144, 144, 120, 120, 60, 132];
  const membership = [[], [0, 1], [2], [3, 4], [], [5], [6], [7], [8], [9, 10], [11], [], []];
  director.shots = frames.map((count, i) => ({
    ...structuredClone(outputs.director.shots[0]),
    id: `s${i}`,
    frames: count,
    entryState: [],
    exitState: [],
    events: [{ eventId: `e${i}`, phase: 'whole' }],
    dialogue: membership[i].map((line) => ({
      lineId: `d${line}`,
      delivery: line === 10 ? 'offscreen' : 'onscreen',
      mouth: { visibility: line === 10 ? 'out_of_frame' : 'unknown', window: null },
    })),
    action: `Fixture action ${i}`,
    cues: [],
  }));
  director.groups = [
    [0, 1],
    [2, 3],
    [4, 5, 6],
    [7, 8],
    [9, 10],
    [11, 12],
  ].map((ids, i) => ({
    id: `g${i}`,
    shotIds: ids.map((n) => `s${n}`),
    transition: 'independent',
    reason: 'Isolated software fixture',
  }));
  script.subjects.push(
    {
      key: 'room',
      name: 'Room',
      kind: 'environment',
      description: 'A worn workshop.',
      attributes: [{ key: 'light', label: 'Light', values: ['afternoon', 'morning'] }],
    },
    {
      key: 'paper',
      name: 'Paper',
      kind: 'object',
      description: 'A plain work notice.',
      attributes: [],
    },
    {
      key: 'tray',
      name: 'Tray',
      kind: 'object',
      description: 'A wooden repair tray.',
      attributes: [],
    },
  );
  for (const shot of director.shots) shot.visibleSubjectKeys.push('room', 'tray');
  director.sceneDesigns[0] = {
    ...director.sceneDesigns[0],
    applicability: 'spatial',
    environmentKey: 'room',
    reason: 'Paper attaches to the device in the workshop.',
    cameras: [
      {
        id: 'fixture-camera',
        name: 'Side',
        position: { x: 0.2, y: 0.7 },
        heading: 60,
        height: 1.6,
        pitch: 0,
        fov: 60,
      },
    ],
  };
  for (const shot of director.shots)
    shot.staging = {
      sceneDesignId: 'table-design',
      cameraId: 'fixture-camera',
      entry: [],
      exit: [],
      paths: [],
      cameraKeys: [],
      doors: [],
      axis: null,
    };
  director.shots[1].visibleSubjectKeys.push('paper');
  director.shots[11].visibleSubjectKeys.push('paper');
  director.shots[0].entryState = [{ subjectKey: 'room', key: 'light', value: 'afternoon' }];
  director.shots[1].entryRelations = [
    { objectKey: 'paper', type: 'attachedTo', targetKey: 'device', anchor: 'paper slot' },
  ];
  director.shots[11].entryState = [{ subjectKey: 'room', key: 'light', value: 'morning' }];
  director.shots[11].entryRelations = [
    { objectKey: 'paper', type: 'locatedIn', targetKey: 'room', anchor: 'workbench' },
  ];
  director.groups[5].transition = 'ellipsis';
  director.groups[5].reason = 'The next morning, the notice has been placed on the workbench.';
  f.accept('brief');
  f.accept('script', script);
  f.accept('direction');
  f.accept('director', director);
  f.accept('assets', {
    ...outputs.assets,
    items: [
      {
        id: 'identity',
        subjectKey: 'device',
        mediaType: 'image',
        purpose: 'identity',
        description: 'Fixture identity',
        prompt: 'Silver device',
        layout: 'Single view',
        shotIds: director.shots.map((s: any) => s.id),
        view: 'front',
      },
      ...director.groups.map((group: any) => ({
        id: `opening-${group.id}`,
        subjectKey: 'device',
        mediaType: 'image',
        purpose: 'composition',
        description: `Opening composition for ${group.id}`,
        prompt: 'Single opening frame',
        layout: 'Single view',
        shotIds: group.shotIds,
        view: 'front',
      })),
    ],
  });
  const file = path.join(f.root, 'reference.png');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=silver:s=128x128',
    '-frames:v',
    '1',
    file,
  ]);
  const image = await ingestAsset(f.store, f.root, f.project.id, file, {
    name: 'Software fixture',
  });
  const media = new CreationMediaService(f.store, f.root);
  await media.confirmReferences(f.run.id, {
    runRevision: f.run.revision,
    idempotencyKey: crypto.randomUUID(),
    items: [
      {
        requirementId: 'identity',
        asset: { id: image.id, revision: image.revision },
        inspected: true,
        conclusion: 'Software fixture assertion only',
      },
      ...director.groups.map((group: any) => ({
        requirementId: `opening-${group.id}`,
        asset: { id: image.id, revision: image.revision },
        inspected: true,
        conclusion: `Inspected opening fixture for ${group.id}`,
        asGroupStart: true,
      })),
    ],
  });
  const workspace = new WorkspaceService(f.store);
  workspace.saveScope(
    f.run.id,
    f.run.revision,
    {
      name: 'Partial group excludes its original opening',
      mode: 'selection',
      shotIds: ['s1'],
      groupIds: [],
      output: { width: 1280, height: 736, steps: 20 },
    },
    true,
  );
  const partial = workspace.preview(f.run.data.scope.id, f.run.data.scope.revision, f.run.revision);
  assert.ok(partial.preview, JSON.stringify(f.run.data.issues));
  assert.equal(partial.preview.inputs.length, 1);
  assert.equal(partial.preview.inputs[0].prepared.anchors.length, 0);
  workspace.saveScope(
    f.run.id,
    f.run.revision,
    {
      name: 'Full six-group fixture',
      mode: 'full',
      shotIds: [],
      groupIds: [],
      output: { width: 1280, height: 736, steps: 20 },
    },
    true,
  );
  const prepared = workspace.preview(
    f.run.data.scope.id,
    f.run.data.scope.revision,
    f.run.revision,
  );
  const preview = prepared.preview;
  assert.ok(preview, JSON.stringify(f.run.data.issues));
  assert.deepEqual(
    preview.inputs.map((i: any) => i.segment.duration),
    [8, 10, 12, 12, 10, 8],
  );
  const specs = preview.inputs.flatMap((i: any) => i.prepared.shotSpecs);
  for (const input of preview.inputs) {
    assert.equal(input.prepared.anchors.length, 1);
    assert.equal(input.prepared.anchors[0].resolvedFrameIndex, 0);
    assert.equal(input.prepared.anchors[0].assetId, image.id);
    assert.equal(input.prepared.anchors[0].revision, image.revision + 1);
  }
  assert.equal(specs.length, 13);
  assert.ok(
    preview.inputs.every((input: any) =>
      input.planning.plan.data.textIdentityInstanceIds.includes(`${f.run.id}:tray`),
    ),
  );
  assert.ok(specs[2].state.startRelations.some((r: any) => r.objectId === `${f.run.id}:paper`));
  assert.ok(!specs[2].directing.presence.visible.includes(`${f.run.id}:paper`));
  assert.ok(
    specs[11].directing.transition.changes.some((c: any) => c.property === 'attribute:light'),
  );
  assert.ok(specs[11].directing.transition.changes.some((c: any) => c.property === 'relationship'));
  assert.ok(!specs[11].state.startRelations.some((r: any) => r.objectId === `${f.run.id}:paper`));
  const lines = specs.flatMap((s: any) => s.directing.sound.dialogue);
  assert.equal(lines.length, 12);
  assert.equal(new Set(lines.map((l: any) => l.id)).size, 12);
  assert.equal(lines.filter((l: any) => l.delivery === 'offscreen').length, 1);
  assert.ok(
    preview.inputs.every(
      (i: any) =>
        i.segment.mode === 'ref2va' && i.width === 1280 && i.height === 736 && i.steps === 20,
    ),
  );
  const key = crypto.randomUUID(),
    runRevision = f.run.revision;
  workspace.submit(
    f.run.data.scope.id,
    f.run.data.scope.revision,
    runRevision,
    preview.digest,
    key,
  );
  workspace.submit(
    f.run.data.scope.id,
    f.run.data.scope.revision,
    runRevision,
    preview.digest,
    key,
  );
  const jobs = f.store.jobs().filter((j) => j.kind === 'generation');
  assert.equal(jobs.length, 6);
  assert.ok(jobs.every((job) => job.input.prepared.anchors[0].resolvedFrameIndex === 0));
  assert.equal(f.service.allowance(f.project.id).usedSeconds, 60);
  assert.equal(f.service.allowance(f.project.id).remainingGenerations, 0);
  const videoPath = path.join(f.root, 'native-fixture.mp4');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=128x128:r=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:sample_rate=48000',
    '-t',
    '12.25',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    videoPath,
  ]);
  const clips = [];
  for (const job of jobs) {
    const video = await ingestAsset(f.store, f.root, f.project.id, videoPath, {
      name: `Fixture ${job.input.segment.id}`,
      jobId: job.id,
    });
    f.store.patchJob(job.id, {
      state: 'succeeded',
      output: { assetIds: [video.id], fixture: true },
    });
    clips.push({
      assetId: video.id,
      revision: video.revision,
      in: 0,
      out: job.input.segment.duration,
      volume: 1,
    });
  }
  const edit = await media.saveReview(f.run.id, {
    runRevision: f.run.revision,
    name: 'Offline six-group review',
    edl: {
      schemaVersion: 2,
      episodeId: f.run.data.episodeId,
      width: 1920,
      height: 1080,
      fps: 24,
      clips,
      audio: [],
      overlays: [
        {
          id: 'title',
          text: 'Software fixture',
          sourceDialogueId: null,
          startFrame: 1392,
          endFrame: 1440,
          position: 'center',
          fontSize: 48,
          color: '#ffffff',
        },
      ],
    },
  });
  const body = { revision: edit.revision, idempotencyKey: crypto.randomUUID() };
  const exported = await media.exportReview(edit.id, body);
  assert.equal((await media.exportReview(edit.id, body)).id, exported.id);
  await new Worker(f.store, f.root).execute(exported, 'media', new AbortController().signal);
  const finished = f.store.job(exported.id);
  assert.equal(finished.state, 'succeeded', finished.error || '');
  const asset = f.store.get(finished.output.assetIds[0]);
  assert.equal(asset.data.frameCount, 1440);
  assert.equal(asset.data.width, 1920);
  assert.equal(asset.data.height, 1080);
  assert.equal(f.store.list('segment_selection').length, 0);
  assert.equal(f.store.list('creation_delivery').length, 0);
});

test('V9 omitted state carries known intent, while continuous contradictions receive no invented explanation', () => {
  const director = structuredClone(outputs.director);
  const first = director.shots[0];
  first.entryRelations = [
    { objectKey: 'paper', type: 'attachedTo', targetKey: 'device', anchor: 'slot' },
  ];
  first.exitRelations = [];
  director.shots.push({
    ...structuredClone(first),
    id: 'closeup',
    entryState: [],
    exitState: [],
    entryRelations: [],
    exitRelations: [],
  });
  director.shots.push({
    ...structuredClone(first),
    id: 'return',
    entryState: [{ subjectKey: 'device', key: 'power', value: 'off' }],
    exitState: [],
    entryRelations: [],
    exitRelations: [],
  });
  director.groups[0].shotIds = ['shot', 'closeup', 'return'];
  const before = structuredClone(director);
  const resolved = resolveAuthoringStates(director);
  assert.deepEqual(director, before);
  assert.deepEqual(resolved.get('closeup')!.entryRelations, first.entryRelations);
  assert.equal(resolved.get('closeup')!.entryState[0].value, 'on');
  assert.equal(resolved.get('return')!.entryState[0].value, 'off');
  assert.deepEqual(resolved.get('return')!.transitionChanges, []);
});

test('V9 activation owns its lifecycle, prerequisites, revision and replay independently of upgrades', async (t) => {
  const f = await fixture(t);
  const previous = f.run;
  const next = f.service.create(f.project.id, {
    request: '第二个 V9 制作版本',
    episodeId: previous.data.episodeId,
    idempotencyKey: crypto.randomUUID(),
  });
  const body = () => ({
    runRevision: f.service.get(next.id).revision,
    expectedHeadRevision: productionHead(f.store, previous.data.episodeId).revision,
    expectedPreviousRunId: previous.id,
    idempotencyKey: crypto.randomUUID(),
  });
  assert.throws(() => f.service.activate(next.id, body()), /前置/);
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[]) {
    const current = f.service.get(next.id);
    const draft = f.service.saveResult(next.id, stage, outputs[stage], current.revision);
    f.service.approve(next.id, draft.id, draft.revision, crypto.randomUUID());
  }
  for (const job of f.store.jobs())
    if (job.state === 'queued') f.store.patchJob(job.id, { state: 'cancelled' });
  const input = body();
  const result = f.service.activate(next.id, input);
  assert.equal(result.head.runId, next.id);
  assert.equal(f.service.activate(next.id, input).head.revision, result.head.revision);
  assert.throws(() => f.service.activate(next.id, { ...input, runRevision: 999 }), /幂等/);
  assert.equal(f.store.get(previous.id).data.schemaVersion, 9);
  assert.equal(f.store.list('segment_selection').length, 0);
});

test('batch reference confirmation verifies bytes and rolls back every adoption and binding on any failure', async (t) => {
  const f = await fixture(t);
  for (const stage of ['brief', 'script', 'direction', 'director'] as AuthoringStage[])
    f.accept(stage);
  const items = ['first', 'second'].map((id) => ({
    id,
    subjectKey: 'device',
    mediaType: 'image',
    purpose: 'identity',
    description: 'Silver device',
    prompt: 'Silver device',
    layout: 'single view',
    shotIds: ['shot'],
    view: 'front',
  }));
  items.push(
    ...['start-a', 'start-b'].map((id) => ({
      ...items[0],
      id,
      purpose: 'composition',
    })),
  );
  f.accept('assets', { ...outputs.assets, items });
  const file = path.join(f.root, 'reference.png');
  await runProcess(config.ffmpeg, [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=silver:s=128x128',
    '-frames:v',
    '1',
    file,
  ]);
  const asset = await ingestAsset(f.store, f.root, f.project.id, file, {
    name: 'Offline image',
    category: 'reference',
  });
  const service = new CreationMediaService(f.store, f.root);
  const body = {
    runRevision: f.run.revision,
    idempotencyKey: crypto.randomUUID(),
    items: items.map((i) => ({
      requirementId: i.id,
      asset: { id: asset.id, revision: asset.revision },
      inspected: true,
      conclusion: 'Offline atomicity fixture',
    })),
  };
  const before = generationDigest({ run: f.run, asset: f.store.get(asset.id) });
  await assert.rejects(
    () =>
      service.confirmReferences(f.run.id, {
        ...body,
        items: [{ ...body.items[0], asGroupStart: true }],
      }),
    /首帧/,
  );
  assert.equal(generationDigest({ run: f.run, asset: f.store.get(asset.id) }), before);
  await assert.rejects(
    () =>
      service.confirmReferences(f.run.id, {
        ...body,
        items: body.items.slice(2).map((item) => ({ ...item, asGroupStart: true })),
      }),
    /同一生成组/,
  );
  assert.equal(generationDigest({ run: f.run, asset: f.store.get(asset.id) }), before);
  await assert.rejects(
    () =>
      service.confirmReferences(f.run.id, {
        ...body,
        items: [body.items[0], { ...body.items[1], requirementId: 'missing' }],
      }),
    /需求/,
  );
  assert.equal(generationDigest({ run: f.run, asset: f.store.get(asset.id) }), before);
  const confirmed = await service.confirmReferences(f.run.id, body);
  assert.equal(f.store.get(asset.id).revision, asset.revision + 1);
  assert.equal(confirmed.data.bindings.first.asset.revision, asset.revision + 1);
  assert.deepEqual(confirmed.data.bindings.first.asset, confirmed.data.bindings.second.asset);
  assert.equal((await service.confirmReferences(f.run.id, body)).revision, confirmed.revision);
  await assert.rejects(
    () => service.confirmReferences(f.run.id, { ...body, items: [body.items[0]] }),
    /幂等/,
  );
  const current = f.store.get(asset.id);
  await fs.writeFile(path.join(f.root, current.data.path), 'changed bytes');
  await assert.rejects(
    () =>
      service.confirmReferences(f.run.id, {
        ...body,
        runRevision: f.run.revision,
        idempotencyKey: crypto.randomUUID(),
        items: [{ ...body.items[0], asset: { id: current.id, revision: current.revision } }],
      }),
    /哈希/,
  );
});
