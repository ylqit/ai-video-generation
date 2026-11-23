import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { prepareData } from '../src/server/config.js';
import { compileH3, ComfyClient } from '../src/server/comfy.js';
import {
  prepareGuidedH3,
  guidedCapability,
  guidedTemplateVersion,
} from '../src/server/h3-guided.js';
import { Worker } from '../src/server/worker.js';
import { createApp } from '../src/server/app.js';
import { runProcess } from '../src/server/media.js';
import { z } from 'zod';

const nodeFixture = JSON.parse(await fs.readFile('tests/fixtures/comfy-0.35-guided.json', 'utf8'));
const profile = { baseUrl: 'http://127.0.0.1:9990', instanceId: 'guided-test' };
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-guided-'));
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite'));
  const service = new StudioService(store);
  const project = service.createProject({ title: 'Guided', mode: 'short', brief: '' });
  const front = store.create(
    'asset',
    project.id,
    {
      name: 'front',
      entityId: 'robot',
      mediaType: 'image',
      width: 1536,
      height: 1024,
      path: 'assets/front.png',
      sha256: 'front',
      adopted: true,
    },
    project.id,
  );
  const back = store.create(
    'asset',
    project.id,
    { ...front.data, name: 'back', path: 'assets/back.png', sha256: 'back' },
    project.id,
  );
  const tail = store.create(
    'asset',
    project.id,
    {
      ...front.data,
      name: 'tail',
      entityId: 'frame',
      width: 864,
      height: 480,
      path: 'assets/tail.png',
      sha256: 'tail',
    },
    project.id,
  );
  let episode = service.createEpisode(project.id, { title: 'Guide test' });
  const segment = {
    id: 'guided',
    shotIds: ['s1'],
    mode: 'ref2va',
    duration: 5,
    prompt: 'Original editable intent',
    references: [front, back].map((a) => ({
      assetId: a.id,
      revision: a.revision,
      role: 'identity',
      instruction: 'Same paper robot with black circular eyes.',
    })),
    guides: [
      {
        assetId: tail.id,
        revision: tail.revision,
        frameIndex: 0,
        instruction: 'Continue this composition.',
      },
    ],
    guidedPrompt: {
      summary: 'Reference generation with an opening anchor.',
      detailedDescription:
        'Stop-motion miniature. [Shot 1] <Subject 1> starts from <Picture 3> and slowly turns toward the camera.',
      overallSoundscape: 'Soft paper rustling.',
      nonDiegeticMusic: 'N/A',
    },
  };
  const plan = {
    title: 'Guide test',
    summary: '',
    script: '',
    sourceChapterIds: [],
    shots: [
      {
        id: 's1',
        scene: 'greenhouse',
        description: 'turn',
        dialogue: '',
        continuity: 'black eyes',
        duration: 5,
      },
    ],
    segments: [segment],
    incoming: {},
    outgoing: {},
    openLoops: [],
  };
  episode = service.saveEpisode(episode.id, episode.revision, plan);
  episode = service.approveEpisode(episode.id, episode.revision);
  const request = {
    episodeId: episode.id,
    episodeRevision: episode.revision,
    segmentId: 'guided',
    width: 864,
    height: 480,
    steps: 20,
    seed: 42,
  };
  t.after(async () => {
    store.close();
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'studio-guided-'),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  const preview = service.prepareGeneration(request, profile);
  return {
    root,
    store,
    service,
    project,
    front,
    back,
    tail,
    episode,
    segment,
    plan,
    request,
    preview,
  };
}
function graphFor(input: any) {
  return compileH3(
    input,
    new Map(
      input.assets.map((a: any) => [
        `${a.reference.assetId}:${a.reference.revision}`,
        a.asset.data.path,
      ]),
    ),
    'test-job',
  );
}
function submit(f: Awaited<ReturnType<typeof fixture>>) {
  return f.service.generation(
    {
      ...f.request,
      approved: true,
      idempotencyKey: 'guided-test-request',
      previewDigest: f.preview.digest,
    },
    profile,
  );
}

test('guided graph uses correct single conditioning output and original AV latent', async (t) => {
  const f = await fixture(t);
  const graph = graphFor(f.preview.input);
  assert.equal(f.preview.input.templateVersion, guidedTemplateVersion);
  assert.deepEqual(graph.guide_0.inputs.positive, ['condition', 0]);
  assert.deepEqual(graph.guide_0.inputs.latent, ['condition', 1]);
  assert.deepEqual(graph.sample.inputs.latent_image, ['condition', 1]);
  assert.deepEqual(graph.guider.inputs.conditioning, ['guide_0', 0]);
  assert.deepEqual(graph.guide_0.inputs.image, ['guided_image_2', 0]);
  assert.deepEqual(graph.condition.inputs['ref_images.ref_image_2'], ['guided_image_2', 0]);
  const client = new ComfyClient(profile.baseUrl);
  client.json = async () => nodeFixture;
  await client.validate(graph);
});

test('anchor ordering, last-frame resolution, center crop and subject grouping are deterministic', async (t) => {
  const f = await fixture(t);
  const input = structuredClone(f.preview.input);
  delete input.prepared;
  input.segment.guides = [
    { assetId: f.front.id, revision: 1, frameIndex: -1, instruction: 'End' },
    { assetId: f.back.id, revision: 1, frameIndex: 60, instruction: 'Middle' },
    ...input.segment.guides,
  ];
  const p = prepareGuidedH3(input),
    graph = graphFor(input);
  assert.equal(p.images.length, 3);
  assert.equal(p.subjects.length, 1);
  assert.deepEqual(p.subjects[0].pictures, ['<Picture 1>', '<Picture 2>']);
  assert.deepEqual(
    p.anchors.map((a) => a.resolvedFrameIndex),
    [0, 60, 123],
  );
  assert.equal(p.duration, 124 / 24);
  assert.equal(p.anchors[2].seconds, 123 / 24);
  assert.deepEqual(p.anchors[2].crop, { x: 0, y: 85, width: 1536, height: 854 });
  assert.deepEqual(graph.guide_2.inputs.positive, ['guide_1', 0]);
  assert.deepEqual(graph.guider.inputs.conditioning, ['guide_2', 0]);
  assert.deepEqual(graph.guide_2.inputs.latent, ['condition', 1]);
  assert.equal(graph.guide_2.inputs.frame_idx, 123);
  input.width = input.height = 512;
  for (const item of input.assets) {
    item.asset.data.width = 1024;
    item.asset.data.height = 1025;
  }
  assert.deepEqual(prepareGuidedH3(input).anchors[0].crop, {
    x: 0,
    y: 0,
    width: 1024,
    height: 1025,
  });
});

test('bounds, duplicate anchors, wrong media, missing adoption and dangling labels fail visibly', async (t) => {
  const f = await fixture(t);
  for (const [edit, pattern] of [
    [
      (i: any) => {
        i.segment.guides[0].frameIndex = 124;
      },
      /越界/,
    ],
    [
      (i: any) => {
        i.segment.guides.push({ ...i.segment.guides[0] });
      },
      /冲突/,
    ],
    [
      (i: any) => {
        i.assets[2].asset.data.mediaType = 'video';
      },
      /图片/,
    ],

    [
      (i: any) => {
        i.segment.guidedPrompt.summary = '<Picture 9>';
      },
      /未绑定/,
    ],
    [
      (i: any) => {
        i.segment.guidedPrompt.detailedDescription += ' [Shot 2] At 00:06.000, stop.';
      },
      /片长/,
    ],
    [
      (i: any) => {
        i.segment.mode = 'i2v';
      },
      /Ref2VA/,
    ],
  ] as const) {
    const input = structuredClone(f.preview.input);
    edit(input);
    assert.throws(() => prepareGuidedH3(input), pattern);
  }
  const unreviewed = structuredClone(f.preview.input);
  unreviewed.assets[0].asset.data.adopted = false;
  assert.doesNotThrow(() => prepareGuidedH3(unreviewed));
  assert.throws(
    () => graphFor({ ...f.preview.input, templateVersion: 'native-h3-v1' }),
    /不能降级/,
  );
});

test('picture limit counts deduplicated image versions; conflicting same-frame last anchor is rejected', async (t) => {
  const f = await fixture(t);
  const input = structuredClone(f.preview.input);
  for (let n = 0; n < 7; n++) {
    const ref = { assetId: `extra-${n}`, revision: 1, role: 'identity', instruction: 'extra' };
    input.segment.references.push(ref);
    input.assets.push({
      reference: ref,
      asset: { ...f.front, data: { ...f.front.data, entityId: `extra-${n}` } },
    });
  }
  assert.throws(() => prepareGuidedH3(input), /最多 9/);
  const second = structuredClone(f.preview.input);
  second.segment.guides.push({ ...second.segment.guides[0], frameIndex: -1 });
  second.segment.guides.push({ ...second.segment.guides[0], frameIndex: 123 });
  assert.throws(() => prepareGuidedH3(second), /冲突/);
});

test('preview digest gates changed parameters, asset heads, episode versions and frozen compiler drift', async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.jobs().length, 0);
  assert.throws(
    () =>
      f.service.generation(
        { ...f.request, approved: true, idempotencyKey: 'without-preview' },
        profile,
      ),
    /重新预览/,
  );
  assert.throws(
    () =>
      f.service.generation(
        {
          ...f.request,
          seed: 43,
          approved: true,
          idempotencyKey: 'changed-seed',
          previewDigest: f.preview.digest,
        },
        profile,
      ),
    /重新预览/,
  );
  const job = submit(f);
  assert.equal(submit(f).id, job.id);
  f.store.update(f.front.id, f.front.revision, { ...f.front.data, name: 'new metadata' });
  assert.throws(
    () =>
      f.service.generation(
        {
          ...f.request,
          approved: true,
          idempotencyKey: 'changed-head',
          previewDigest: f.preview.digest,
        },
        profile,
      ),
    /重新预览/,
  );
  const changed = structuredClone(job.input);
  changed.prepared.finalPrompt += ' drift';
  assert.throws(() => graphFor(changed), /冻结/);
  const edited = f.service.saveEpisode(f.episode.id, f.episode.revision, f.plan);
  assert.ok(edited.revision > f.episode.revision);
  assert.throws(() => f.service.prepareGeneration(f.request, profile), /版本变化/);
  assert.equal(f.store.job(job.id).input.assets[0].asset.revision, 1);
});

test('anchors are project-owned and exact historical versions remain separate', async (t) => {
  const f = await fixture(t);
  const other = f.service.createProject({ title: 'Other', mode: 'short', brief: '' });
  const foreign = f.store.create('asset', other.id, { ...f.tail.data }, other.id);
  const invalid = structuredClone(f.plan);
  invalid.segments[0].guides[0].assetId = foreign.id;
  assert.throws(() => f.service.saveEpisode(f.episode.id, f.episode.revision, invalid), /不匹配/);
  const newer = f.store.update(f.front.id, 1, {
    ...f.front.data,
    path: 'assets/front-v2.png',
    sha256: 'front-v2',
  });
  const input = structuredClone(f.preview.input);
  delete input.prepared;
  input.segment.guides = [
    { assetId: newer.id, revision: newer.revision, frameIndex: 0, instruction: '' },
  ];
  input.assets.push({ reference: input.segment.guides[0], asset: newer });
  const prepared = prepareGuidedH3(input),
    graph = graphFor(input);
  assert.equal(prepared.images.length, 3);
  assert.equal(graph.guided_image_0.inputs.image, 'assets/front.png');
  assert.equal(graph.guided_image_2.inputs.image, 'assets/front-v2.png');
});

test('capability verifies actual contracts and rejects output index/type mistakes before upload', async (t) => {
  const f = await fixture(t),
    graph = graphFor(f.preview.input);
  assert.equal(guidedCapability(nodeFixture).available, true);
  const client = new ComfyClient(profile.baseUrl);
  const missing = structuredClone(nodeFixture);
  delete missing.MiniMaxH3AddGuide;
  client.json = async () => missing;
  await assert.rejects(client.validate(graph), /缺少/);
  const changed = structuredClone(nodeFixture);
  changed.MiniMaxH3AddGuide.output.push('LATENT');
  client.json = async () => changed;
  await assert.rejects(client.validate(graph), /仅输出/);
  client.json = async () => nodeFixture;
  graph.sample.inputs.latent_image = ['guide_0', 1];
  await assert.rejects(client.validate(graph), /不存在/);
  graph.sample.inputs.latent_image = ['guide_0', 0];
  await assert.rejects(client.validate(graph), /需要 LATENT/);
});

test('worker deduplicates uploads, preserves unknown submission and restart reconciles without a second POST', async (t) => {
  const f = await fixture(t);
  // Distinct asset records can point to the same content file.
  f.store.update(f.back.id, 1, {
    ...f.back.data,
    path: f.front.data.path,
    sha256: f.front.data.sha256,
  });
  f.plan.segments[0].references[1].revision = 2;
  f.episode = f.service.saveEpisode(f.episode.id, f.episode.revision, f.plan);
  f.episode = f.service.approveEpisode(f.episode.id, f.episode.revision);
  f.request.episodeRevision = f.episode.revision;
  f.preview = f.service.prepareGeneration(f.request, profile);
  const job = submit(f);
  let uploads = 0,
    posts = 0;
  const client = new ComfyClient(profile.baseUrl);
  client.json = async () => nodeFixture;
  client.upload = async () => `upload-${++uploads}.png`;
  client.submit = async () => {
    posts++;
    throw new Error('response lost');
  };
  const worker = new Worker(f.store, f.root, () => client);
  await worker.tick();
  assert.equal(uploads, 2);
  assert.equal(posts, 1);
  assert.equal(f.store.job(job.id).state, 'unknown');
  assert.equal(Object.keys(f.store.job(job.id).output.receipts).length, 3);
  f.store.release(worker.owner);
  client.json = async (route) =>
    route === '/queue'
      ? {
          queue_running: [],
          queue_pending: [
            [
              0,
              'remote-guided',
              {},
              { studio: { job_id: job.id, instance_id: profile.instanceId } },
            ],
          ],
        }
      : {};
  const resumed = new Worker(f.store, f.root, () => client);
  await resumed.tick();
  assert.equal(f.store.job(job.id).promptId, 'remote-guided');
  assert.equal(posts, 1);
  assert.equal(uploads, 2);
  assert.match(
    await fs.readFile(path.join(f.store.job(job.id).output.executionDir, 'prompt.txt'), 'utf8'),
    /subject_definitions:/,
  );
});

test('guided download failure and restart retain prompt identity and archive media without automatic review frames', async (t) => {
  const f = await fixture(t),
    job = submit(f);
  const sample = path.join(f.root, 'sample.mp4');
  await runProcess('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=s=320x192:r=24:d=1',
    '-c:v',
    'libx264',
    sample,
  ]);
  const video = await fs.readFile(sample);
  f.store.patchJob(job.id, {
    state: 'archiving',
    promptId: 'known-guided',
    output: { descriptor: { filename: 'sample.mp4' } },
  });
  const client = new ComfyClient(profile.baseUrl);
  let submits = 0,
    downloads = 0;
  client.submit = async () => {
    submits++;
    return 'unexpected';
  };
  client.request = async () => {
    downloads++;
    if (downloads === 1) throw new Error('download lost');
    return new Response(video);
  };
  const worker = new Worker(f.store, f.root, () => client);
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'failed');
  assert.equal(f.store.job(job.id).promptId, 'known-guided');
  f.store.patchJob(job.id, { state: 'archiving' });
  await worker.tick();
  const result = f.store.job(job.id);
  assert.equal(result.state, 'succeeded');
  assert.equal(result.output.reviewFrames, undefined);
  assert.equal(result.output.mediaCheck.frameCount, 24);
  assert.equal(result.output.mediaCheck.frameCountMatches, false);
  assert.equal(submits, 0);
  assert.equal(downloads, 2);
  await worker.archive(result, client);
  assert.equal(downloads, 2);
  assert.equal(f.store.list('asset').filter((a) => a.data.category === 'review_frame').length, 0);
});

test('HTTP preview has no mutations, upload or generation and submission requires its digest', async (t) => {
  const f = await fixture(t);
  for (const asset of f.store.list('asset'))
    await fs.writeFile(
      path.join(f.root, asset.data.path),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
        'base64',
      ),
    );
  const original = ComfyClient.prototype.json;
  ComfyClient.prototype.json = async () => nodeFixture;
  t.after(() => {
    ComfyClient.prototype.json = original;
  });
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const base = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const before = f.store.list().length;
  const response = await fetch(base + '/generations/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(f.request),
  });
  assert.equal(response.status, 200);
  const p = (await response.json()) as any;
  assert.equal(p.validation.uploaded, false);
  assert.equal(p.validation.submitted, false);
  assert.equal(f.store.list().length, before);
  assert.equal(f.store.jobs().length, 0);
  const rejected = await fetch(base + '/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...f.request,
      seed: 123,
      approved: true,
      idempotencyKey: 'http-guided',
      previewDigest: p.digest,
    }),
  });
  assert.equal(rejected.status, 409);
  assert.equal(f.store.jobs().length, 0);
  const accepted = await fetch(base + '/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...f.request,
      approved: true,
      idempotencyKey: 'http-guided-valid',
      previewDigest: p.digest,
    }),
  });
  assert.equal(accepted.status, 201);
  assert.equal(((await accepted.json()) as any).input.previewDigest, p.digest);
});

test('pre-existing saved I2V workflow is byte-for-byte equivalent as a graph', async () => {
  const legacy = JSON.parse(await fs.readFile('tests/fixtures/legacy-i2v.json', 'utf8'));
  const files = new Map<string, string>([
    [legacy.input.segment.references[0].assetId, legacy.graph.reference_0.inputs.image],
  ]);
  assert.deepEqual(compileH3(legacy.input, files, legacy.jobId), legacy.graph);
});
