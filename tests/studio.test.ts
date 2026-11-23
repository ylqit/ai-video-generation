import { extractFrameAsset } from '../src/server/media-evidence.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { compileH3, ComfyClient, frameCount } from '../src/server/comfy.js';
import { Worker } from '../src/server/worker.js';
import { prepareData, inside } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import parseNovel from '../src/shared/toonflow/parseNovel.js';
import parseScript from '../src/shared/toonflow/parseScript.js';
import { runProcess, ingestAsset, exportMovie, probeMedia } from '../src/server/media.js';
import type { EditDecisionList, Job } from '../src/shared/contracts.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-test-'));
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store);
  t.after(async () => {
    store.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'studio-test-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = service.createProject({
    title: '雨后邮局',
    mode: 'series',
    brief: '温暖的冒险故事',
  });
  return { root, store, service, project };
}
const plan = (title = '第一集') => ({
  title,
  summary: '纸质机器人送出第一封信',
  script: '机器人在温室中找到信封。',
  sourceChapterIds: [] as string[],
  shots: [
    {
      id: 's1',
      scene: '温室',
      description: '机器人拿起信封',
      dialogue: '出发吧。',
      continuity: '同一个信封',
      duration: 5,
    },
  ],
  segments: [
    {
      id: 'g1',
      shotIds: ['s1'],
      prompt: 'A paper robot in a greenhouse picks up an envelope. Static camera, soft daylight.',
      mode: 't2v' as const,
      duration: 5,
      references: [] as any[],
    },
  ],
  incoming: {},
  outgoing: { location: '温室', envelopeOwner: 'robot' },
  openLoops: ['信件的收件人是谁'],
});
function approvedEpisode(service: StudioService, projectId: string) {
  let e = service.createEpisode(projectId, { title: '第一集' });
  e = service.saveEpisode(e.id, e.revision, plan());
  return service.approveEpisode(e.id, e.revision);
}
const profile = { baseUrl: 'http://127.0.0.1:9990', instanceId: 'test-instance' };

test('Ref2VA compiles video/audio reference slots separately from images', () => {
  const refs = [
    { assetId: 'v', revision: 1, role: 'video', instruction: 'motion' },
    { assetId: 'a', revision: 1, role: 'audio', instruction: 'voice' },
  ];
  const input = {
    segment: { ...plan().segments[0], mode: 'ref2va', references: refs },
    assets: [
      { reference: refs[0], asset: { data: { mediaType: 'video', duration: 5, hasAudio: true } } },
      { reference: refs[1], asset: { data: { mediaType: 'audio', duration: 5 } } },
    ],
    width: 864,
    height: 480,
    steps: 20,
    seed: 1,
  };
  const graph = compileH3(
    input,
    new Map([
      ['v', 'video.mp4'],
      ['a', 'voice.wav'],
    ]),
    'job',
  );
  assert.equal(graph.reference_0.inputs.force_rate, 24);
  assert.deepEqual(graph.condition.inputs['ref_video_audios.ref_video_audio_0'], [
    'reference_0',
    2,
  ]);
  assert.deepEqual(graph.condition.inputs['ref_audios.ref_audio_0'], ['reference_1', 0]);
  assert.match(graph.condition.inputs.prompt, /<Video 1>/);
});

test('dynamic upload filename choices do not reject newly uploaded assets during discovery', async () => {
  const client = new ComfyClient(profile.baseUrl);
  client.json = async () => ({
    LoadImage: { input: { required: { image: [['previous.png']] } } },
    LoadAudio: { input: { required: { audio: [['previous.wav']] } } },
  });
  await client.validate({
    img: { class_type: 'LoadImage', inputs: { image: 'new.png' } },
    sound: { class_type: 'LoadAudio', inputs: { audio: 'new.wav' } },
  });
});

test('download interruption and disk failure retain the remote identity and retry only archival', async (t) => {
  const { store, service, project, root } = await fixture(t);
  const episode = approvedEpisode(service, project.id),
    job = service.generation(request(episode), profile);
  const sample = path.join(root, 'sample.mp4');
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
  const bytes = await fs.readFile(sample);
  const cloud = new MockComfy(profile.baseUrl);
  let downloads = 0;
  cloud.request = async () => {
    downloads++;
    if (downloads === 1)
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes.subarray(0, 128));
            setTimeout(() => c.error(new Error('connection reset')), 10);
          },
        }),
      );
    return new Response(bytes);
  };
  store.patchJob(job.id, {
    state: 'archiving',
    promptId: 'retained-prompt',
    output: { descriptor: { filename: 'out.mp4' } },
  });
  const worker = new Worker(store, root, () => cloud);
  await worker.tick();
  assert.equal(store.job(job.id).state, 'failed');
  assert.equal(store.job(job.id).promptId, 'retained-prompt');
  assert.equal(store.list('asset', project.id).length, 0);
  // Inject the disk failure at the current execution's isolated download path.
  const partial = path.join(root, 'jobs', job.id, 'runs', worker.owner, 'result.mp4.part');
  await fs.unlink(partial).catch((e) => {
    if (e.code !== 'ENOENT') throw e;
  });
  await fs.mkdir(partial);
  store.patchJob(job.id, { state: 'archiving' });
  await worker.tick();
  assert.equal(store.job(job.id).state, 'failed');
  assert.ok(store.job(job.id).output.descriptor);
  await fs.rmdir(partial);
  store.patchJob(job.id, { state: 'archiving' });
  await worker.tick();
  assert.equal(store.job(job.id).state, 'succeeded');
  assert.equal(cloud.posts, 0);
  assert.equal(downloads, 3);
  assert.equal(store.job(job.id).promptId, 'retained-prompt');
  assert.equal(
    store.list('asset', project.id).filter((a) => a.data.category === 'generated').length,
    1,
  );
  worker.stop();
});

test('extracted continuation frame is exactly the last decoded frame', async (t) => {
  const { root, store, project } = await fixture(t),
    sample = path.join(root, 'motion.mp4');
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
  const video = await ingestAsset(store, root, project.id, sample, { category: 'generated' });
  const frame = await extractFrameAsset(store, root, video.id, video.revision, 'last');
  const last = path.join(root, frame.data.path);
  const videoHash = await runProcess('ffmpeg', [
    '-v',
    'error',
    '-i',
    sample,
    '-pix_fmt',
    'rgb24',
    '-f',
    'framemd5',
    '-',
  ]);
  const imageHash = await runProcess('ffmpeg', [
    '-v',
    'error',
    '-i',
    last,
    '-pix_fmt',
    'rgb24',
    '-f',
    'framemd5',
    '-',
  ]);
  const lastHash = (s: string) =>
    s
      .trim()
      .split('\n')
      .filter((l) => !l.startsWith('#'))
      .at(-1)!
      .split(',')
      .at(-1)!
      .trim();
  assert.equal(lastHash(imageHash), lastHash(videoHash));
});

test('backup and restore preserve historical assets and task identities', async (t) => {
  const { store, service, project, root } = await fixture(t);
  const e = approvedEpisode(service, project.id),
    job = service.generation(request(e), profile);
  store.patchJob(job.id, { state: 'unknown', promptId: 'kept' });
  const sample = path.join(root, 'tone.wav');
  await runProcess('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=duration=0.2',
    sample,
  ]);
  const asset = await ingestAsset(store, root, project.id, sample, { name: 'tone' });
  store.update(asset.id, 1, { ...asset.data, adopted: true });
  const previous = process.env.STUDIO_DATA_DIR;
  process.env.STUDIO_DATA_DIR = root;
  try {
    const dest = path.join(root, 'snapshot'),
      restored = path.join(root, 'restored');
    await runProcess(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', dest]);
    await runProcess(process.execPath, [
      '--import',
      'tsx',
      'scripts/backup.ts',
      'restore',
      dest,
      restored,
    ]);
    const db = new Store(path.join(restored, 'studio.sqlite'));
    try {
      assert.equal(db.get(asset.id, 1).data.adopted, false);
      assert.equal(db.get(asset.id).data.adopted, true);
      assert.equal(db.job(job.id).promptId, 'kept');
      assert.equal(db.job(job.id).state, 'unknown');
      await fs.access(path.join(restored, asset.data.path));
    } finally {
      db.close();
    }
    await assert.rejects(
      runProcess(process.execPath, [
        '--import',
        'tsx',
        'scripts/backup.ts',
        'restore',
        dest,
        restored,
      ]),
      /必须不存在/,
    );
  } finally {
    if (previous === undefined) delete process.env.STUDIO_DATA_DIR;
    else process.env.STUDIO_DATA_DIR = previous;
  }
});
function request(e: any, key = 'test-request-1') {
  return {
    episodeId: e.id,
    episodeRevision: e.revision,
    segmentId: 'g1',
    width: 864,
    height: 480,
    steps: 20,
    seed: 42,
    approved: true,
    idempotencyKey: key,
  };
}

test('Toonflow parsers preserve chapter groups and normalize full-width digits', () => {
  const parsed = parseNovel('第一卷 起点\n第１章 雨\n一封信\n第２章 晴\n一次出发');
  assert.equal(parsed[0].chapters.length, 2);
  assert.equal(parsed[0].chapters[1].index, 2);
  assert.equal(parseScript('第２集 出发\n继续冒险')[0].index, 2);
  assert.equal(parseNovel('无章节的独立故事')[0].chapters[0].text, '无章节的独立故事');
});
test('revision conflicts reject stale writes and preserve old snapshots', async (t) => {
  const { store, project } = await fixture(t);
  const revised = store.update(project.id, 1, { ...project.data, title: '新标题' });
  assert.equal(revised.revision, 2);
  assert.equal(store.get(project.id, 1).data.title, '雨后邮局');
  assert.throws(() => store.update(project.id, 1, {}), /更新/);
});
test('transaction rollback removes documents and their revision snapshots', async (t) => {
  const { store, project } = await fixture(t);
  let id = '';
  assert.throws(() =>
    store.transaction(() => {
      id = store.create('chapter', project.id, {}).id;
      throw new Error('fail');
    }),
  );
  assert.throws(() => store.get(id));
  assert.throws(() => store.get(id, 1));
});
test('three-episode story retains canonical facts and marks dependent later episodes stale', async (t) => {
  const { store, service, project } = await fixture(t);
  const first = approvedEpisode(service, project.id);
  const canon = service.confirmContinuity(first.id, first.revision, {
    facts: { envelopeOwner: 'robot' },
    openLoops: ['收件人'],
    references: [],
  });
  const second = approvedEpisode(service, project.id);
  store.update(second.id, second.revision, {
    ...second.data,
    dependencies: [{ id: canon.id, revision: canon.revision }],
  });
  const third = approvedEpisode(service, project.id);
  store.update(third.id, third.revision, {
    ...third.data,
    dependencies: [{ id: second.id, revision: store.get(second.id).revision }],
  });
  assert.equal(store.get(canon.id).data.facts.envelopeOwner, 'robot');
  service.confirmContinuity(first.id, first.revision, {
    facts: { envelopeOwner: 'postmaster' },
    openLoops: [],
    references: [],
  });
  assert.equal(store.get(second.id).data.stale, true);
  assert.equal(store.get(third.id).data.stale, true);
  assert.equal(store.get(canon.id, 1).data.facts.envelopeOwner, 'robot');
});
test('project boundaries reject source and asset references from other projects', async (t) => {
  const { service, project } = await fixture(t);
  const other = service.createProject({ title: '广告片', mode: 'short', brief: '' });
  const chapter = service.importNovel(other.id, '第一章\n别的故事')[0];
  const e = service.createEpisode(project.id, {});
  assert.throws(
    () => service.saveEpisode(e.id, e.revision, { ...plan(), sourceChapterIds: [chapter.id] }),
    /不匹配/,
  );
});
test('approved generation is idempotent, immutable, and revision-bound', async (t) => {
  const { store, service, project } = await fixture(t);
  const e = approvedEpisode(service, project.id);
  const one = service.generation(request(e), profile),
    two = service.generation(request(e), profile);
  assert.equal(one.id, two.id);
  assert.equal(store.jobs().length, 1);
  assert.throws(() => service.generation({ ...request(e), seed: 77 }, profile), /幂等键/);
  service.saveEpisode(e.id, e.revision, { ...plan(), summary: '改变后的剧情' });
  assert.equal(store.job(one.id).input.segment.prompt, plan().segments[0].prompt);
  assert.throws(() => service.generation(request(e, 'different-request'), profile), /版本变化/);
});
test('H3 graph has native AV decode chain, int4 encoder and explicit reference ordering', () => {
  const p = plan();
  const refs = [
    { assetId: 'a', revision: 1, role: 'identity', instruction: 'identity' },
    { assetId: 'b', revision: 1, role: 'scene', instruction: 'scene' },
  ];
  const input = {
    segment: { ...p.segments[0], mode: 'ref2va', references: refs },
    assets: refs.map((r) => ({ reference: r, asset: { data: { mediaType: 'image' } } })),
    width: 864,
    height: 480,
    steps: 20,
    seed: 42,
  };
  const graph = compileH3(
    input,
    new Map([
      ['a', 'a.png'],
      ['b', 'b.png'],
    ]),
    'job',
  );
  assert.equal(graph.clip.inputs.clip_name, 'qwen3vl_32b_minimax_h3_int4_convrot.safetensors');
  assert.deepEqual(graph.condition.inputs['ref_images.ref_image_1'], ['reference_1', 0]);
  assert.deepEqual(graph.combine.inputs.audio, ['decode_audio', 0]);
  assert.equal(graph.condition.inputs.length, 124);
  assert.ok(Object.values(graph).every((n) => !n.class_type.includes('Turbo')));
  assert.throws(
    () =>
      compileH3(
        {
          ...input,
          segment: { ...input.segment, references: [{ ...refs[0], role: 'first_frame' }] },
        },
        new Map([['a', 'a.png']]),
        'job',
      ),
    /首尾帧/,
  );
  assert.equal(frameCount(10) % 17, 5);
});
test('worker lease excludes second process and interrupted submission becomes unknown', async (t) => {
  const { store, service, project, root } = await fixture(t);
  const e = approvedEpisode(service, project.id),
    job = service.generation(request(e), profile);
  assert.equal(store.acquire('first'), true);
  const second = new Store(path.join(root, 'studio.sqlite'));
  assert.equal(second.acquire('second'), false);
  store.patchJob(job.id, { state: 'submitting' });
  store.recover();
  assert.equal(store.job(job.id).state, 'unknown');
  store.release('first');
  assert.equal(second.acquire('second'), true);
  second.close();
});

test('a stale worker cannot commit state after another owner takes over', async (t) => {
  const { store, project } = await fixture(t);
  store.acquire('old');
  store.writeLeaseOwner = 'old';
  store.db.prepare('UPDATE leases SET expires=0').run();
  assert.equal(store.acquire('new'), true);
  assert.throws(
    () => store.update(project.id, project.revision, { ...project.data, title: 'stale' }),
    /失去租约/,
  );
  assert.equal(store.get(project.id).revision, 1);
  store.writeLeaseOwner = 'new';
  store.update(project.id, project.revision, { ...project.data, title: 'current' });
  assert.equal(store.get(project.id).revision, 2);
});

class MockComfy extends ComfyClient {
  posts = 0;
  uploadCount = 0;
  queue: any = { queue_running: [], queue_pending: [] };
  history: any = {};
  loseReply = false;
  override async validate() {}
  override async upload(_file: string, name: string) {
    this.uploadCount++;
    return name;
  }
  override async submit(graph: any, job: Job) {
    this.posts++;
    this.queue.queue_pending.push([
      1,
      'remote-1',
      graph,
      { studio: { job_id: job.id, instance_id: job.input.profile.instanceId } },
    ]);
    if (this.loseReply) throw new Error('reply lost');
    return 'remote-1';
  }
  override async json(p: string): Promise<any> {
    if (p === '/queue') return this.queue;
    if (p.startsWith('/history')) return this.history;
    return {};
  }
  override watch() {
    return { close() {} } as any;
  }
}
test('lost submit reply reconciles by marker without a second POST', async (t) => {
  const { store, service, project, root } = await fixture(t);
  const e = approvedEpisode(service, project.id),
    j = service.generation(request(e), profile),
    cloud = new MockComfy(profile.baseUrl);
  cloud.loseReply = true;
  const worker = new Worker(store, root, () => cloud);
  await worker.tick();
  assert.equal(store.job(j.id).state, 'unknown');
  await worker.tick();
  assert.equal(store.job(j.id).promptId, 'remote-1');
  assert.equal(cloud.posts, 1);
  await worker.tick();
  assert.equal(cloud.posts, 1);
});
test('missing remote history preserves prompt identity and does not regenerate', async (t) => {
  const { store, service, project, root } = await fixture(t);
  const e = approvedEpisode(service, project.id),
    j = service.generation(request(e), profile),
    cloud = new MockComfy(profile.baseUrl);
  store.patchJob(j.id, { state: 'submitted', promptId: 'known-id' });
  const worker = new Worker(store, root, () => cloud);
  await worker.tick();
  assert.equal(store.job(j.id).promptId, 'known-id');
  assert.equal(store.job(j.id).state, 'submitted');
  assert.equal(cloud.posts, 0);
});
test('queued cancellation never sends a generation request', async (t) => {
  const { store, service, project, root } = await fixture(t);
  const e = approvedEpisode(service, project.id),
    j = service.generation(request(e), profile),
    cloud = new MockComfy(profile.baseUrl);
  store.patchJob(j.id, { cancelRequested: true });
  await new Worker(store, root, () => cloud).tick();
  assert.equal(store.job(j.id).state, 'cancelled');
  assert.equal(cloud.posts, 0);
});

test('suspending tracking during a pending poll retains identity and can resume without POST', async (t) => {
  const { store, service, project, root } = await fixture(t),
    e = approvedEpisode(service, project.id),
    job = service.generation(request(e), profile),
    cloud = new MockComfy(profile.baseUrl);
  store.patchJob(job.id, { state: 'submitted', promptId: 'known' });
  let release!: (value: any) => void;
  cloud.json = async (p) =>
    p === '/queue'
      ? new Promise((r) => {
          release = r;
        })
      : {};
  const worker = new Worker(store, root, () => cloud);
  const polling = worker.tick();
  store.patchJob(job.id, { state: 'cancelled', output: { waitSuspended: true } });
  release({ queue_pending: [], queue_running: [] });
  await polling;
  assert.equal(store.job(job.id).state, 'cancelled');
  assert.equal(store.job(job.id).promptId, 'known');
  assert.equal(cloud.posts, 0);
  store.patchJob(job.id, { state: 'submitted', output: { waitSuspended: false } });
  cloud.json = async () => ({ queue_running: [], queue_pending: [] });
  await worker.tick();
  assert.equal(store.job(job.id).promptId, 'known');
  assert.equal(cloud.posts, 0);
  worker.stop();
});
test('API persists project across requests, rejects stale review, and exposes no auto image capability', async (t) => {
  const { store, root } = await fixture(t);
  const server = createApp(store, root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const address = server.address() as any,
    base = `http://127.0.0.1:${address.port}`;
  const health = (await (await fetch(base + '/api/health')).json()) as any;
  assert.equal(health.imageAutomation, false);
  const rejected = await fetch(base + '/api/projects', {
    method: 'POST',
    headers: { Origin: 'https://evil.invalid', 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'bad', mode: 'short', brief: '' }),
  });
  assert.equal(rejected.status, 403);
  const state = (await (await fetch(base + '/api/state')).json()) as any;
  assert.equal(state.projects.length, 1);
});
test('asset storage rejects traversal', () => {
  assert.throws(() => inside('D:/assets', '../secret'), /目录/);
});

test('assets under the default hidden data directory support versioned range requests', async (t) => {
  const { store, root, project } = await fixture(t);
  const hidden = path.join(root, '.data');
  prepareData(hidden);
  await fs.writeFile(path.join(hidden, 'assets', 'clip.mp4'), Buffer.from('0123456789'));
  const asset = store.create('asset', project.id, { path: 'assets/clip.mp4' });
  const server = createApp(store, hidden).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.on('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const port = (server.address() as any).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/assets/${asset.id}/file?revision=1`, {
    headers: { Range: 'bytes=2-5' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-type'), 'video/mp4');
  assert.equal(await response.text(), '2345');
});
test('FFmpeg export matches trim durations, silence and external audio without input mutation', async (t) => {
  const { store, root, project, service } = await fixture(t);
  const video = path.join(root, 'fixture.mp4'),
    tone = path.join(root, 'tone.wav');
  await runProcess('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=320x192:r=24:d=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=220:duration=2',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    video,
  ]);
  await runProcess('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=880:duration=1',
    tone,
  ]);
  const va = await ingestAsset(store, root, project.id, video, { name: '样片' }),
    aa = await ingestAsset(store, root, project.id, tone, { name: '音轨' });
  const v = store.update(va.id, 1, { ...va.data, adopted: true }),
    a = store.update(aa.id, 1, { ...aa.data, adopted: true }),
    ep = approvedEpisode(service, project.id);
  const edl: EditDecisionList = {
    episodeId: ep.id,
    width: 320,
    height: 192,
    fps: 24,
    clips: [
      { assetId: v.id, revision: v.revision, in: 0.25, out: 1.25, volume: 0 },
      { assetId: v.id, revision: v.revision, in: 1, out: 2, volume: 0 },
    ],
    audio: [{ assetId: a.id, revision: a.revision, in: 0, out: 1, start: 0.5, volume: 0.5 }],
  };
  service.validateEdl(project.id, edl);
  const before = JSON.stringify(edl);
  const output = path.join(root, 'export.mp4'),
    metadata = await exportMovie(edl, [v, a], root, output);
  assert.ok(Math.abs(metadata.duration - 2) < 0.1);
  assert.equal(metadata.hasAudio, true);
  assert.equal(metadata.width, 320);
  assert.equal(JSON.stringify(edl), before);
  assert.throws(
    () => service.validateEdl(project.id, { ...edl, clips: [{ ...edl.clips[0], out: 8 }] }),
    /实际时长/,
  );
  const pcm = path.join(root, 'audio.pcm');
  await runProcess('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    output,
    '-vn',
    '-ar',
    '8000',
    '-ac',
    '1',
    '-f',
    's16le',
    pcm,
  ]);
  const bytes = await fs.readFile(pcm);
  const energy = (start: number, end: number) => {
    let n = 0;
    for (let i = start * 8000; i < end * 8000; i++) n += Math.abs(bytes.readInt16LE(i * 2));
    return n / ((end - start) * 8000);
  };
  assert.ok(energy(0.1, 0.3) < 10);
  assert.ok(energy(0.7, 0.9) > 100);
});
