import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { fixture } from '../tests/fixtures/workspace.js';
import { DomainService } from '../src/server/domain-service.js';
import { SeriesProductionService } from '../src/server/series-production.js';
import { createApp } from '../src/server/app.js';
import { prepareData } from '../src/server/config.js';

const evidence = path.resolve('../docs/architecture/2026-11-22-studio-evolution/evidence');
const reference = (d: any) => ({ id: d.id, revision: d.revision });
if (!process.argv.includes('--serve')) {
  const cleanup: (() => void)[] = [];
  const f = fixture(
    { after: (fn: () => void) => cleanup.push(fn) },
    false,
    false,
    (outputs) => {
      const scene = outputs.script.scenes[0],
        shot = outputs.director.shots[0],
        design = outputs.director.sceneDesigns[0];
      outputs.script.scenes = Array.from({ length: 100 }, (_, i) => ({
        ...structuredClone(scene),
        id: `scene${i}`,
        events: [{ id: `event${i}`, description: 'The device is shown.', sourceFactIds: [] }],
      }));
      outputs.director.shots = Array.from({ length: 100 }, (_, i) => ({
        ...structuredClone(shot),
        id: `shot${i}`,
        sceneId: `scene${i}`,
        events: [{ eventId: `event${i}`, phase: 'whole' }],
      }));
      outputs.director.sceneDesigns = Array.from({ length: 100 }, (_, i) => ({
        ...structuredClone(design),
        id: `design${i}`,
        sceneId: `scene${i}`,
      }));
      outputs.director.groups = Array.from({ length: 100 }, (_, i) => ({
        id: `P${i}`,
        shotIds: [`shot${i}`],
        transition: 'independent',
        reason: 'Offline benchmark view',
      }));
    },
    { request: '20 分钟产品展示，离线元数据验证' },
  );
  try {
    // Large unrelated media have real document/revision overhead, but no physical
    // files or generation requests. They must not enter the selected episode view.
    const otherSeries = f.store.create(
      'series',
      f.project.id,
      { title: 'Other metadata branch' },
      f.project.id,
    );
    for (let i = 0; i < 20; i++)
      f.store.create(
        'episode',
        f.project.id,
        { seriesId: otherSeries.id, title: `Other ${i}`, shots: [], segments: [] },
        otherSeries.id,
      );
    for (let i = 0; i < 2000; i++)
      f.store.create('asset', f.project.id, {
        mediaType: 'image',
        category: 'review_frame',
        name: `offline metadata ${i}`,
        description: 'unrelated '.repeat(100),
      });
    const times: number[] = [];
    let snapshot: any;
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      snapshot = f.workspace.snapshot(f.project.id, f.run.id);
      if (i) times.push(performance.now() - start);
    }
    assert.equal(snapshot.timing.totalFrames, 28800);
    assert.equal(snapshot.assets.length, 0);
    assert.equal(snapshot.episodes.length, 1);
    assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
    const report = {
      measuredAt: new Date().toISOString(),
      node: process.version,
      platform: process.platform,
      cpu: os.cpus()[0]?.model,
      kind: 'offline metadata only, no model or 20-minute video rendering',
      shots: 100,
      totalFrames: 28800,
      unrelatedEpisodes: 20,
      unrelatedAssets: 2000,
      selectedAssets: snapshot.assets.length,
      snapshotBytes: Buffer.byteLength(JSON.stringify(snapshot)),
      samplesMs: times,
      medianMs: [...times].sort((a, b) => a - b)[2],
      maxMs: Math.max(...times),
      generatedRequests: 0,
    };
    await fs.writeFile(
      path.join(evidence, 'ENGINEERING_BENCHMARK.json'),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } finally {
    cleanup.forEach((fn) => fn());
  }
} else {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-evolution-browser-'));
  prepareData(root);
  const f = fixture({ after: () => {} }, false, false, undefined, {
    database: path.join(root, 'studio.sqlite'),
  });
  f.store.update(f.project.id, f.project.revision, {
    ...f.project.data,
    title: '非声音工程验收（隔离数据）',
    mode: 'series',
  });
  const domain = new DomainService(f.store),
    plans = new SeriesProductionService(f.store);
  let profile = domain.save(f.project.id, 'creation_profile', {
    name: '验收固定视觉配置',
    rulesVersion: 'director-v7',
    composition: {
      moduleRefs: [],
      overrides: { visual: 'Silver product in soft light.' },
      artEntries: [],
    },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'Offline fixture only',
  });
  const series = f.store.list('series', f.project.id)[0];
  const plan = plans.preview(series.id, {
    version: 1,
    profile: reference(profile),
    targetEpisodes: 10,
    runtime: { targetFrames: 7200, toleranceFrames: 0 },
    slots: [{ id: 'episode-1', title: '验收第一集', episodeId: f.run.data.episodeId }],
  });
  plans.apply(series.id, {
    ...plan,
    revision: series.revision,
    idempotencyKey: 'browser-plan-fixture',
  });
  const other = f.store.create(
    'series',
    f.project.id,
    { title: '独立外传（隔离验收）' },
    f.project.id,
  );
  const otherPlan = plans.preview(other.id, {
    version: 1,
    profile: reference(profile),
    targetEpisodes: 2,
  });
  plans.apply(other.id, {
    ...otherPlan,
    revision: other.revision,
    idempotencyKey: 'browser-other-plan',
  });
  let run = f.run;
  f.store.update(run.id, run.revision, {
    ...run.data,
    targetRevision: f.store.get(run.data.episodeId).revision,
  });
  const chosen = f.workspace.saveScope(
    run.id,
    f.run.revision,
    {
      name: '验收两组范围',
      mode: 'selection',
      groupIds: ['P01', 'P02'],
      output: { width: 864, height: 480, steps: 20, seed: 1 },
    },
    true,
  );
  const prepared = f.workspace.preview(chosen.scope.id, chosen.scope.revision, f.run.revision);
  assert.equal(prepared.preview.inputs.length, 2, JSON.stringify(prepared.issues));
  const clips: any[] = [];
  for (let i = 0; i < 2; i++) {
    const relative = `assets/fixture-${i}.mp4`,
      filename = path.join(root, relative);
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `color=c=${i ? 'blue' : 'red'}:s=128x128:r=24:d=12`,
      '-an',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-y',
      filename,
    ]);
    const job = f.store.createJob(
      'generation',
      f.project.id,
      run.data.episodeId,
      { ...prepared.preview.inputs[i], offlineFixture: true },
      `synthetic-browser-${i}`,
    );
    const video = f.store.create('asset', f.project.id, {
      name: '合成色卡（仅界面验收）',
      path: relative,
      mediaType: 'video',
      category: 'generated',
      adopted: true,
      jobId: job.id,
      frameCount: 288,
      duration: 12,
      width: 128,
      height: 128,
      hasAudio: false,
      sha256: createHash('sha256')
        .update(await fs.readFile(filename))
        .digest('hex'),
    });
    const review = f.store.create(
      'generation_review',
      f.project.id,
      {
        schemaVersion: 3,
        inspected: true,
        jobId: job.id,
        video: reference(video),
        observations: [],
        issues: [],
        eventEvidence: [],
        audioEvidence: [],
        conclusion: 'Synthetic UI fixture; not a story quality judgment',
      },
      run.data.episodeId,
    );
    const boundary = { facts: [], relations: [], relationObjectIds: [], actions: [] };
    const selection = f.store.create(
      'segment_selection',
      f.project.id,
      {
        schemaVersion: 3,
        creationRunId: run.id,
        segmentId: `P0${i + 1}`,
        video: reference(video),
        review: reference(review),
        in: 0,
        out: 12,
        volume: 0,
        boundary: { start: boundary, end: boundary },
      },
      run.data.episodeId,
    );
    f.store.patchJob(job.id, {
      state: 'succeeded',
      output: { assetIds: [video.id], videoAssetId: video.id, offlineFixture: true },
    });
    clips.push({
      assetId: video.id,
      revision: 1,
      in: 0,
      out: 12,
      volume: 0,
      selection: reference(selection),
    });
  }
  const edl = f.studio.saveEdl(f.project.id, {
    schemaVersion: 2,
    episodeId: run.data.episodeId,
    fps: 24,
    width: 128,
    height: 128,
    clips,
    audio: [],
  });
  const info = {
    root,
    projectId: f.project.id,
    runId: run.id,
    episodeId: run.data.episodeId,
    seriesId: series.id,
    otherSeriesId: other.id,
    edlId: edl.id,
    url: 'http://127.0.0.1:4179',
    note: 'Isolated synthetic media; no Worker or remote calls. Delete this temporary fixture after verification.',
  };
  await fs.writeFile(
    path.join(evidence, 'ENGINEERING_BROWSER_FIXTURE.json'),
    JSON.stringify(info, null, 2),
  );
  const server = createApp(f.store, root).listen(4179, '127.0.0.1', () =>
    console.log(JSON.stringify(info)),
  );
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () =>
      server.close(() => {
        f.store.close();
        process.exit(0);
      }),
    );
}
