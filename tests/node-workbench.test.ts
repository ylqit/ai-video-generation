import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHmac } from 'node:crypto';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CanvasService } from '../src/server/canvas.js';
import { patchCanvas, canvasConversion } from '../src/server/canvas-patches.js';
import { nodeOperation } from '../src/server/node-execution.js';
import { attachCanvasResults } from '../src/server/canvas-results.js';
import { materializeAnalysis } from '../src/server/analysis-materialization.js';
import { prepareCanvasGeneration } from '../src/server/canvas-generation.js';
import { saveCanvasObject } from '../src/server/canvas-objects.js';
import { directorSceneSchema } from '../src/shared/director-scene.js';
import { Worker } from '../src/server/worker.js';
import { config } from '../src/server/config.js';
import { ingestAsset, runProcess } from '../src/server/media.js';
import { configureModel } from './fixtures/models.js';
import { ModelRegistry } from '../src/server/model-registry.js';
import { saveSpeechAllowance, speechUsage } from '../src/server/speech-usage.js';
import { flashSignature, flashSegments } from '../src/server/tencent-transcription.js';
import { transcriptCues } from '../src/shared/node-operations.js';
import { compositeImageEdit } from '../src/server/image-edit-media.js';
import { DomainService } from '../src/server/domain-service.js';
import { directingSchema } from '../src/shared/directing.js';
import { shotStateSchema } from '../src/shared/domain.js';
import { projectNodeInputs } from '../src/server/node-context.js';
import { sendCanvasMessage, conversationMessages } from '../src/server/canvas-conversation.js';
import { ProductionAssistant } from '../src/server/production-assistant.js';
import { performAssistantTool } from '../src/server/assistant-tools.js';
import { voiceFixture, wav } from './fixtures/speech.js';
import { prepareLipSync } from '../src/server/sync-lipsync.js';

async function fixture(t: any, media = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-nodes-')),
    store = new Store(':memory:');
  await fs.mkdir(path.join(root, 'assets'), { recursive: true });
  t.after(async () => {
    store.db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = new StudioService(store).createProject({
      title: '节点测试',
      mode: 'series',
      brief: '',
    }),
    service = new CanvasService(store);
  let canvas = service.create(project.id, { version: 2, title: '节点制作', nodes: [], edges: [] });
  let asset: any;
  if (media) {
    const file = path.join(root, 'sample.mp4');
    await runProcess(config.ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=128x128:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '2',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      file,
    ]);
    asset = await ingestAsset(store, root, project.id, file, {
      name: '合成媒体',
      category: 'source',
    });
    canvas = service.save(canvas.id, canvas.revision, {
      ...canvas.data,
      nodes: [
        {
          id: 'source',
          type: 'video',
          title: '源视频',
          text: '',
          x: 0,
          y: 0,
          asset: { id: asset.id, revision: asset.revision },
        },
      ],
    });
  }
  return { root, store, project, service, canvas, asset };
}
function execute(f: any, node: string, action: string, request: any = {}) {
  const op = { action, request },
    p: any = nodeOperation(f.store, f.canvas.id, node, op);
  return nodeOperation(f.store, f.canvas.id, node, op, {
    digest: p.digest,
    idempotencyKey: crypto.randomUUID(),
  }) as any;
}

test('H3 API uses one ordered plan for image, video and audio; unsupported routes reject rather than drop references', async (t) => {
  const f = await fixture(t),
    api = configureModel(f.store, f.project.id, 'minimax-video');
  const nodes = ['image', 'video', 'audio'].map((kind, i) => {
    const a = f.store.create('asset', f.project.id, {
      name: kind,
      mediaType: kind,
      width: 640,
      height: 360,
      duration: 3,
      bytes: 1000,
      path: kind + (kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : '.wav'),
      sha256: kind,
    });
    return {
      id: kind,
      type: kind,
      title: kind,
      text: '',
      x: i * 300,
      y: 0,
      asset: { id: a.id, revision: 1 },
    };
  });
  const c = f.service.save(f.canvas.id, 1, {
    ...f.canvas.data,
    nodes: [
      ...nodes,
      {
        id: 'g',
        type: 'video_generate',
        title: '参考',
        text: 'Turn and stop.',
        x: 0,
        y: 500,
        generation: { model: api.selection, mode: 'ref2va', seconds: 5 },
      },
    ],
    edges: nodes.map((n, i) => ({
      id: String(100 - i),
      source: n.id,
      target: 'g',
      sourceHandle: n.type,
      targetHandle: 'references',
      relation: 'input',
      purpose: ['identity', 'motion', 'audio'][i],
      order: i,
      instruction: '',
    })),
  });
  const p = prepareCanvasGeneration(f.store, c.id, 'g');
  assert.deepEqual(
    p.input.prepared.request.content.slice(1).map((r: any) => [r.type, r.role]),
    [
      ['image_url', 'reference_image'],
      ['video_url', 'reference_video'],
      ['audio_url', 'reference_audio'],
    ],
  );
  assert.deepEqual(
    p.input.prepared.inputBindings.map((r: any) => r.label),
    ['<Picture 1>', '<Video 1>', '<Audio 1>'],
  );
  assert.equal(p.input.prepared.rulesVersion, 'canvas-h3-v2');
  const comfy = configureModel(f.store, f.project.id, 'comfy-h3'),
    data = structuredClone(c.data);
  data.nodes[3].generation.model = comfy.selection;
  f.service.save(c.id, c.revision, data);
  assert.throws(() => prepareCanvasGeneration(f.store, c.id, 'g'), /当前图片|适配器/);
  assert.equal(f.store.jobs().length, 0);
});

test('standalone lip-sync uses direct unreviewed audio and video in a blank canvas and returns its candidate there', async (t) => {
  const f = await voiceFixture(t, 'sync-lipsync'),
    service = new CanvasService(f.store),
    file = path.join(f.root, 'standalone.mp4');
  await runProcess(config.ffmpeg, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=320x240:r=24:d=1',
    '-f',
    'lavfi',
    '-i',
    'anullsrc=r=24000:cl=mono',
    '-t',
    '1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file,
  ]);
  const v = await ingestAsset(f.store, f.root, f.project.id, file, {
      name: '试作画面',
      category: 'source',
    }),
    audioFile = path.join(f.root, 'dialogue.wav');
  await fs.writeFile(audioFile, wav(0.5));
  const a = await ingestAsset(f.store, f.root, f.project.id, audioFile, {
      name: '外部配音',
      category: 'audio',
    }),
    canvas = service.create(f.project.id, {
      version: 2,
      title: '口型试作',
      nodes: [{ id: 'lip', type: 'lipsync', title: '独立口型', text: '', x: 0, y: 0 }],
      edges: [],
    });
  const request = {
    selection: f.selection,
    video: { id: v.id, revision: v.revision },
    audio: { id: a.id, revision: a.revision },
    range: { inFrame: 0, outFrame: 24 },
    face: { frame: 0, x: 160, y: 120, instanceId: 'screen-speaker' },
    originalAudio: 'replace',
    singleSpeaker: true,
  };
  const p = prepareLipSync(f.store, f.project.id, request);
  assert.equal(p.input.episode, null);
  assert.equal(p.input.face.inspected, false);
  assert.equal(p.input.silencePaddingSeconds, 0.5);
  const job: any = nodeOperation(
    f.store,
    canvas.id,
    'lip',
    { action: 'lipsync', request },
    { digest: p.digest, idempotencyKey: 'standalone-lip-test' },
  );
  let submissions = 0;
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async (
    url: any,
    init: any = {},
  ) => {
    const route = new URL(String(url)).pathname;
    if (route === '/v2/models') return Response.json([{ id: 'sync-3' }]);
    if (route === '/v2/generate') {
      submissions++;
      assert.equal(JSON.parse(String(init.body.get('options'))).sync_mode, 'silence');
      return Response.json({ id: 'single', status: 'PENDING' });
    }
    if (route === '/v2/generate/single')
      return Response.json({
        id: 'single',
        status: 'COMPLETED',
        outputUrl: 'https://mock.invalid/out.mp4',
      });
    if (route === '/out.mp4') return new Response(new Uint8Array(await fs.readFile(file)));
    throw new Error('Unexpected mock route');
  }) as any);
  t.after(() => worker.stop());
  await worker.tick();
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  assert.equal(submissions, 1);
  assert.equal(service.get(canvas.id).data.nodes[0].outputs.length, 1);
  assert.equal(f.store.list('episode').length, 0);
  assert.equal(f.store.list('dialogue_take').length, 0);
});

test('partial analysis advances its generated node; deleted nodes keep archived output without being recreated', async (t) => {
  const f = await fixture(t),
    canvas = f.service.save(f.canvas.id, 1, {
      ...f.canvas.data,
      nodes: [{ id: 'source', type: 'analysis', title: '分析', text: '', x: 0, y: 0 }],
    }),
    job = f.store.createJob(
      'media_process',
      f.project.id,
      null,
      {
        canvas: { id: canvas.id, revision: canvas.revision },
        canvasNodeId: 'source',
        nodeOperation: { action: 'analyze' },
      },
      'partial-analysis',
    );
  const d = f.store.create(
    'node_analysis',
    f.project.id,
    { jobId: job.id, title: '切镜', kind: 'shot_detection', complete: false, shots: [] },
    canvas.id,
  );
  f.store.patchJob(job.id, { state: 'failed', output: { documentIds: [d.id] } });
  attachCanvasResults(f.store, job.id);
  const next = f.store.update(d.id, 1, { ...d.data, complete: true });
  f.store.patchJob(job.id, { state: 'succeeded' });
  attachCanvasResults(f.store, job.id);
  assert.equal(
    f.service.get(canvas.id).data.nodes.find((n: any) => n.id === 'result:' + d.id).binding
      .revision,
    next.revision,
  );
  const head = f.service.get(canvas.id);
  f.service.save(head.id, head.revision, { ...head.data, nodes: [], edges: [] });
  attachCanvasResults(f.store, job.id);
  assert.equal(f.service.get(head.id).data.nodes.length, 0);
  assert.equal(f.store.get(d.id).data.complete, true);
});

test('new upstream candidates never replace fixed input edges until an explicit rebind', async (t) => {
  const f = await fixture(t),
    api = configureModel(f.store, f.project.id, 'minimax-video');
  const make = (name: string) =>
    f.store.create('asset', f.project.id, {
      name,
      mediaType: 'image',
      width: 640,
      height: 360,
      bytes: 100,
      path: name + '.png',
      sha256: name,
    });
  const old = make('old'),
    fresh = make('fresh');
  let c = f.service.save(f.canvas.id, 1, {
    ...f.canvas.data,
    nodes: [
      {
        id: 'i',
        type: 'image',
        title: '身份图',
        text: '',
        x: 0,
        y: 0,
        asset: { id: old.id, revision: 1 },
      },
      {
        id: 'g',
        type: 'video_generate',
        title: '片段',
        text: 'Look left.',
        x: 300,
        y: 0,
        generation: { model: api.selection, mode: 'ref2va', seconds: 5 },
      },
    ],
    edges: [
      {
        id: 'input',
        source: 'i',
        target: 'g',
        relation: 'input',
        purpose: 'identity',
        sourceHandle: 'image',
        targetHandle: 'references',
        order: 0,
      },
    ],
  });
  const initial = prepareCanvasGeneration(f.store, c.id, 'g');
  c = patchCanvas(f.store, c.id, {
    revision: c.revision,
    idempotencyKey: 'replace-upstream',
    operations: [
      {
        target: 'node',
        id: 'i',
        action: 'update',
        values: { asset: { id: fresh.id, revision: 1 } },
      },
    ],
  });
  assert.equal(prepareCanvasGeneration(f.store, c.id, 'g').digest, initial.digest);
  assert.ok(f.service.snapshot(c.id).assets.some((a) => a.id === old.id));
  patchCanvas(f.store, c.id, {
    revision: c.revision,
    idempotencyKey: 'explicit-rebind',
    operations: [
      {
        target: 'edge',
        id: 'input',
        action: 'update',
        values: { asset: { id: fresh.id, revision: 1 } },
      },
    ],
  });
  assert.equal(prepareCanvasGeneration(f.store, c.id, 'g').input.assets[0].asset.id, fresh.id);
});

test('v2 patches merge layout, user text and worker results; same-field conflicts preserve the head', async (t) => {
  const f = await fixture(t),
    base = f.service.save(f.canvas.id, 1, {
      ...f.canvas.data,
      nodes: [{ id: 'n', type: 'document', title: '正文', text: '原文', x: 0, y: 0 }],
    });
  const change = (revision: number, values: any) =>
    patchCanvas(f.store, base.id, {
      revision,
      idempotencyKey: crypto.randomUUID(),
      operations: [{ target: 'node', id: 'n', action: 'update', values }],
    });
  change(base.revision, { text: '用户修改' });
  const moved = change(base.revision, { x: 300 });
  assert.equal(moved.data.nodes[0].text, '用户修改');
  assert.equal(moved.data.nodes[0].x, 300);
  assert.throws(() => change(base.revision, { text: '旧助手决定' }), /已变化/);
  assert.throws(
    () =>
      patchCanvas(f.store, base.id, {
        revision: moved.revision,
        idempotencyKey: crypto.randomUUID(),
        operations: [
          {
            target: 'node',
            id: 'fake',
            action: 'add',
            values: { type: 'document', outputs: [{ jobId: 'invented' }] },
          },
        ],
      }),
    /执行结果/,
  );
  assert.equal(f.store.list('generation_review').length, 0);
});

test('v1 conversion keeps history; v2 media order is explicit and layout does not invalidate preparation', async (t) => {
  const f = await fixture(t),
    video = configureModel(f.store, f.project.id, 'minimax-video');
  const image = f.store.create('asset', f.project.id, {
    name: '身份',
    mediaType: 'image',
    width: 1024,
    height: 576,
    bytes: 500,
    path: 'x.png',
    sha256: 'fixed',
  });
  const a = f.service.save(f.canvas.id, 1, {
    ...f.canvas.data,
    version: 1,
    nodes: [
      {
        id: 'i',
        type: 'image',
        title: '图',
        text: '',
        x: 0,
        y: 0,
        asset: { id: image.id, revision: 1 },
      },
      {
        id: 'v',
        type: 'video',
        title: '动作',
        text: 'Turn to the left.',
        x: 1,
        y: 1,
        generation: { model: video.selection, mode: 'ref2va', seconds: 5 },
      },
    ],
    edges: [
      { id: 'z', source: 'i', target: 'v', relation: 'input', purpose: 'identity', order: 0 },
      { id: 'a', source: 'i', target: 'v', relation: 'input', purpose: 'style', order: 1 },
    ],
  });
  const old = prepareCanvasGeneration(f.store, a.id, 'v');
  assert.equal(old.input.prepared.inputBindings[0].purpose, 'style');
  canvasConversion(f.store, a.id, true, a.revision);
  const p = prepareCanvasGeneration(f.store, a.id, 'v');
  assert.equal(p.input.prepared.inputBindings[0].purpose, 'identity');
  const head = f.store.get(a.id);
  patchCanvas(f.store, a.id, {
    revision: head.revision,
    idempotencyKey: crypto.randomUUID(),
    operations: [{ target: 'node', id: 'v', action: 'update', values: { x: 700 } }],
  });
  assert.equal(prepareCanvasGeneration(f.store, a.id, 'v').digest, p.digest);
  assert.equal(f.store.get(a.id, a.revision).data.version, 1);
  assert.equal(f.store.jobs().length, 0);
});

test('local video→analysis→frame→clip→EDL→export uses original Worker without review records', async (t) => {
  const f = await fixture(t, true),
    worker = new Worker(f.store, f.root);
  t.after(() => worker.stop());
  const analysis = execute(f, 'source', 'analyze', { threshold: 0.3, maxShots: 4 });
  await worker.tick();
  assert.equal(f.store.job(analysis.id).state, 'succeeded', f.store.job(analysis.id).error || '');
  const doc = f.store.get(f.store.job(analysis.id).output.documentIds[0]);
  assert.equal(doc.data.complete, true);
  assert.ok(doc.data.shots[0].frame);
  let c = f.service.get(f.canvas.id);
  const materialization = {
    revision: c.revision,
    analysis: { id: doc.id, revision: doc.revision },
    action: 'frames',
    idempotencyKey: crypto.randomUUID(),
  };
  const first = materializeAnalysis(f.store, c.id, materialization);
  assert.deepEqual(
    materializeAnalysis(f.store, c.id, {
      ...materialization,
      revision: f.service.get(c.id).revision,
    }),
    first,
  );
  const frames = f.service.get(c.id).data.nodes.filter((n: any) => n.type === 'image');
  assert.ok(frames.length);
  const trim = execute(f, 'source', 'trim', { start: 0.5, end: 1.5 });
  await worker.tick();
  assert.equal(f.store.job(trim.id).state, 'succeeded', f.store.job(trim.id).error || '');
  const clip = f.store.get(f.store.job(trim.id).output.assetIds[0]);
  assert.equal(clip.data.processingSource.sources[0].id, f.asset.id);
  c = f.service.get(c.id);
  assert.ok(c.data.nodes.some((n: any) => n.asset?.id === clip.id));
  const rev = c.revision;
  attachCanvasResults(f.store, trim.id);
  assert.equal(f.service.get(c.id).revision, rev);
  const edl = f.service.saveTimeline(c.id, c.revision, {
    schemaVersion: 3,
    episodeId: '',
    width: 128,
    height: 128,
    fps: 24,
    clips: [{ id: 'one', assetId: clip.id, revision: clip.revision, in: 0, out: 1, volume: 1 }],
    audio: [],
  });
  c = f.service.get(c.id);
  const job = f.service.export(c.id, {
    revision: c.revision,
    edl: { id: edl.id, revision: edl.revision },
    idempotencyKey: crypto.randomUUID(),
  });
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  assert.equal(f.store.list('generation_review').length, 0);
  assert.equal(f.store.list('assembly_review').length, 0);
});

test('Tencent flash signature, timestamp mapping, mock dispatch and unknown acceptance do not resubmit', async (t) => {
  process.env.STUDIO_NODE_ID = 'offline-id';
  process.env.STUDIO_NODE_KEY = 'offline-secret';
  const f = await fixture(t, true),
    registry = new ModelRegistry(f.store);
  const conn = registry.saveConnection({
    revision: 0,
    data: {
      name: 'ASR mock',
      protocol: 'tencent-asr',
      baseUrl: 'https://asr.cloud.tencent.com',
      enabled: true,
      compatible: false,
      appId: '123456',
      credentials: {
        secretId: { kind: 'env', key: 'STUDIO_NODE_ID' },
        secretKey: { kind: 'env', key: 'STUDIO_NODE_KEY' },
      },
      capacityGroup: 'asr',
      concurrency: 1,
      models: [{ id: '16k_zh', name: '极速识别', preset: 'tencent-asr' }],
    },
  });
  const selection = {
    connection: { id: conn.id, revision: conn.revision },
    modelId: '16k_zh',
    mode: 'authored',
    promptProfile: 'automatic',
    parameters: {},
  };
  saveSpeechAllowance(f.store, f.project.id, {
    revision: 0,
    data: {
      enabled: true,
      connections: [selection.connection],
      maxTranscriptionRequests: 2,
      maxTranscriptionSeconds: 10,
    },
  });
  assert.equal(
    flashSignature('asr.cloud.tencent.com', '/asr/flash/v1/1', { z: '2', a: '1' }, 'key'),
    createHmac('sha1', 'key')
      .update('POSTasr.cloud.tencent.com/asr/flash/v1/1?a=1&z=2')
      .digest('base64'),
  );
  let calls = 0,
    fail = false;
  const response = {
    code: 0,
    request_id: 'offline-asr',
    flash_result: [
      {
        channel_id: 0,
        sentence_list: [
          {
            start_time: 100,
            end_time: 700,
            text: '校园展览',
            speaker_id: 0,
            word_list: [{ word: '校园', start_time: 100, end_time: 400 }],
          },
        ],
      },
    ],
  };
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async (
    url: any,
    init: any,
  ) => {
    calls++;
    assert.match(String(url), /\/asr\/flash\/v1\/123456/);
    assert.match(init.headers.Authorization, /^[a-zA-Z0-9+/]+=*$/);
    if (fail) throw new Error('lost response');
    return new Response(JSON.stringify(response));
  }) as any);
  t.after(() => worker.stop());
  const job = execute(f, 'source', 'transcribe', {
    model: selection,
    source: { id: f.asset.id, revision: 1 },
    start: 0.5,
    end: 1.5,
  });
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  const doc = f.store.get(f.store.job(job.id).output.documentIds[0]);
  assert.equal(doc.data.segments[0].start, 0.6);
  assert.equal(doc.data.segments[0].words[0].end, 0.9);
  assert.equal(doc.data.segments[0].speaker, 0);
  const cues = transcriptCues(flashSegments(response, 0.5), 0.75, 1.5, 2);
  assert.deepEqual(cues, [{ startFrame: 48, endFrame: 59, text: '校园展览' }]);
  fail = true;
  const lost = execute(f, 'source', 'transcribe', {
    model: selection,
    source: { id: f.asset.id, revision: 1 },
    start: 0,
    end: 1,
  });
  await worker.tick();
  assert.equal(f.store.job(lost.id).state, 'unknown');
  await worker.tick();
  assert.equal(calls, 2);
  assert.equal(speechUsage(f.store, f.project.id).transcriptionRequests, 2);
});

test('image edit preserves outside pixels and archived raw response', async (t) => {
  const f = await fixture(t),
    original = path.join(f.root, 'original.png'),
    edited = path.join(f.root, 'edited.png');
  for (const [file, color] of [
    [original, 'red'],
    [edited, 'blue'],
  ])
    await runProcess(config.ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=${color}:s=64x64`,
      '-frames:v',
      '1',
      file,
    ]);
  const a = await ingestAsset(f.store, f.root, f.project.id, original, {
    name: 'original',
    category: 'source',
  });
  const job = f.store.createJob(
    'media_process',
    f.project.id,
    null,
    {
      imageEdit: {
        source: { id: a.id, revision: 1 },
        box: { x: 16, y: 16, width: 16, height: 16 },
      },
      assets: [{ asset: a }],
    },
    crypto.randomUUID(),
  );
  const out = await compositeImageEdit(f.store, f.root, job, edited, 0);
  const decode = async (file: string, target: string) => {
    await runProcess(config.ffmpeg, [
      '-y',
      '-i',
      file,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgba',
      target,
    ]);
    return fs.readFile(target);
  };
  const before = await decode(original, path.join(f.root, 'before.raw')),
    after = await decode(out.file, path.join(f.root, 'after.raw'));
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++)
      if (x < 16 || x >= 32 || y < 16 || y >= 32)
        assert.deepEqual(
          after.subarray((y * 64 + x) * 4, (y * 64 + x + 1) * 4),
          before.subarray((y * 64 + x) * 4, (y * 64 + x + 1) * 4),
        );
  assert.notDeepEqual(after, before);
  assert.equal(f.store.get(out.sourceId).data.category, 'image_edit_raw');
});

test('headless director render produces fixed frame count and can be resumed without a provider', async (t) => {
  const f = await fixture(t);
  let c = f.service.save(f.canvas.id, 1, {
    ...f.canvas.data,
    nodes: [{ id: 'director', type: 'director', title: '预演', text: '', x: 0, y: 0 }],
  });
  saveCanvasObject(f.store, c.id, 'director', {
    canvasRevision: c.revision,
    objectRevision: 0,
    data: { scene: directorSceneSchema.parse({ frames: 2, width: 128, height: 128 }) },
  });
  const job = execute(f, 'director', 'previs_video'),
    worker = new Worker(f.store, f.root);
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  const a = f.store.get(f.store.job(job.id).output.assetIds[0]);
  assert.equal(a.data.frameCount, 2);
  assert.equal(a.data.processingSource.previewOnly, true);
});

test('professional shot consumes visible identities, fixed appearance, visual scope, events and camera through the shared renderer', async (t) => {
  const f = await fixture(t),
    domain = new DomainService(f.store),
    ref = (v: any) => ({ id: v.id, revision: v.revision });
  const entity = domain.save(f.project.id, 'entity', {
      name: 'device',
      type: 'object',
      instances: [{ id: 'device', name: 'device' }],
      description: 'Compact casing.',
      fixedFeatures: ['Silver shell.'],
    }),
    unused = domain.save(f.project.id, 'entity', {
      name: 'future',
      type: 'character',
      instances: [{ id: 'future', name: 'future' }],
      description: 'FUTURE_CHARACTER',
    });
  const appearance = f.store.create('appearance', f.project.id, {
    description: 'A scratched red cover.',
    features: { paint: 'red' },
  });
  const profile = domain.save(f.project.id, 'creation_profile', {
    name: '局部投影',
    rulesVersion: 'director-v6',
    composition: {
      moduleRefs: [],
      overrides: { visual: 'Soft ink outlines.' },
      artEntries: [
        {
          id: 'keep',
          target: { kind: 'instance', id: 'device' },
          aspect: 'identity',
          text: 'Matte silver material.',
          stable: true,
        },
        {
          id: 'omit',
          target: { kind: 'instance', id: 'future' },
          aspect: 'identity',
          text: 'FUTURE_ART',
          stable: true,
        },
      ],
    },
  });
  const shot = {
    id: 's1',
    scene: 'desk',
    duration: 5,
    state: shotStateSchema.parse({
      instances: [
        { instanceId: 'device', entity: ref(entity), appearance: ref(appearance) },
        { instanceId: 'future', entity: ref(unused) },
      ],
    }),
    directing: directingSchema.parse({
      version: 2,
      presence: { visible: ['device'] },
      execution: { action: 'Connect the object, then light the indicator.' },
      camera: { composition: 'Keep the socket visible.', motion: 'static' },
    }),
  };
  const ep = f.store.create('episode', f.project.id, {
    title: '分集',
    shots: [shot],
    creationProfile: ref(profile),
  });
  const c = f.service.save(f.canvas.id, 1, {
    ...f.canvas.data,
    nodes: [
      {
        id: 'shot',
        type: 'shot',
        title: '镜头',
        text: '',
        x: 0,
        y: 0,
        binding: { ...ref(ep), shotId: 's1' },
      },
      { id: 'generator', type: 'video_generate', title: '生成', text: '', x: 0, y: 0 },
    ],
    edges: [
      {
        id: 'context',
        source: 'shot',
        target: 'generator',
        relation: 'input',
        sourceHandle: 'context',
        targetHandle: 'context',
      },
    ],
  });
  const p = projectNodeInputs(f.store, f.project.id, c.data, c.data.nodes[1]);
  for (const text of [
    'Silver shell',
    'scratched red',
    'Soft ink',
    'Matte silver',
    'Connect the object',
    'socket visible',
  ])
    assert.ok(p.text.includes(text), text);
  assert.doesNotMatch(p.text, /FUTURE_CHARACTER|FUTURE_ART/);
  assert.equal(p.shot?.shotId, 's1');
  assert.ok(p.dependencies.some((d) => d.id === appearance.id));
  assert.equal(f.store.jobs().length, 0);
});

test('explicit vision samples produce image content; text rewrite cannot overwrite a concurrent user edit', async (t) => {
  process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline';
  const f = await fixture(t, true),
    model = configureModel(f.store, f.project.id, 'chat-completions');
  const updated = model.registry.saveConnection(
    {
      revision: 1,
      data: {
        ...model.connection.data,
        models: model.connection.data.models.map((m) => ({ ...m, imageInput: true })),
      },
    },
    model.connection.id,
  );
  const selection = {
    ...model.selection,
    connection: { id: updated.id, revision: updated.revision },
  };
  const cfg = model.registry.config(f.project.id)!;
  model.registry.saveConfig(f.project.id, f.project.id, {
    revision: cfg.revision,
    data: {
      ...cfg.data,
      allowance: { ...cfg.data.allowance, connections: [selection.connection] },
    },
  });
  const local = execute(f, 'source', 'frame', { frame: 'first' }),
    worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async (
      _url: any,
      init: any,
    ) => {
      const body = JSON.parse(init.body);
      if (body.messages[0].content.length > 1) {
        assert.equal(body.messages[0].content[1].type, 'image_url');
        assert.match(body.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '修订内容' } }] }));
    }) as any);
  t.after(() => worker.stop());
  await worker.tick();
  const frame = f.store.get(f.store.job(local.id).output.assetIds[0]);
  let c = f.service.get(f.canvas.id);
  c = f.service.save(c.id, c.revision, {
    ...c.data,
    nodes: [
      ...c.data.nodes,
      { id: 'analysis', type: 'analysis', title: '视觉分析', text: '', x: 0, y: 0 },
      { id: 'text', type: 'document', title: '原文', text: '开头 中间 结尾', x: 0, y: 0 },
    ],
  });
  const vision = execute(f, 'analysis', 'vision', {
    model: selection,
    images: [{ id: frame.id, revision: frame.revision }],
    instruction: 'Describe the sample',
  });
  await worker.tick();
  assert.equal(f.store.job(vision.id).state, 'succeeded', f.store.job(vision.id).error || '');
  const rewrite = execute(f, 'text', 'rewrite', {
    model: selection,
    instruction: '改写选区',
    textRange: { start: 3, end: 5, expected: '中间' },
  });
  await worker.tick();
  const doc = f.store.get(f.store.job(rewrite.id).output.documentIds[0]);
  c = f.service.get(c.id);
  patchCanvas(f.store, c.id, {
    revision: c.revision,
    idempotencyKey: crypto.randomUUID(),
    operations: [{ target: 'node', id: 'text', action: 'update', values: { text: '用户已修改' } }],
  });
  c = f.service.get(c.id);
  assert.throws(
    () =>
      materializeAnalysis(f.store, c.id, {
        revision: c.revision,
        analysis: { id: doc.id, revision: doc.revision },
        action: 'apply_text',
        idempotencyKey: crypto.randomUUID(),
      }),
    /原文已被修改/,
  );
});

test('persistent conversation and scoped v4 tools share operations without per-step approval or forged results', async (t) => {
  process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline';
  const f = await fixture(t, true),
    model = configureModel(f.store, f.project.id, 'chat-completions');
  const body = {
    text: '讨论这段素材',
    mode: 'discussion',
    references: ['source'],
    model: model.selection,
    idempotencyKey: crypto.randomUUID(),
  };
  const receipt = sendCanvasMessage(f.store, f.root, f.canvas.id, body);
  assert.equal(sendCanvasMessage(f.store, f.root, f.canvas.id, body).jobId, receipt.jobId);
  const worker = new Worker(
    f.store,
    f.root,
    undefined,
    undefined,
    undefined,
    (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '只根据给出的资料讨论。' } }] }),
      )) as any,
  );
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(conversationMessages(f.store, f.canvas.id).length, 2);
  const assistant = new ProductionAssistant(f.store, f.root),
    c = f.service.get(f.canvas.id),
    run = assistant.create(c.id, {
      revision: c.revision,
      goal: '提取帧',
      nodeIds: ['source'],
      models: [model.selection],
      permissions: ['derive'],
      budget: { maxSteps: 2 },
      idempotencyKey: crypto.randomUUID(),
    });
  assert.equal(run.data.version, 4);
  const intent = {
    action: 'node_operation',
    key: crypto.randomUUID(),
    request: JSON.stringify({
      nodeId: 'source',
      operation: { action: 'frame', request: { frame: 'last' } },
    }),
  };
  const a: any = performAssistantTool(f.store, f.root, run, intent),
    b: any = performAssistantTool(f.store, f.root, run, intent);
  assert.equal(a.jobIds[0], b.jobIds[0]);
  assistant.control(run.id, { revision: run.revision, action: 'pause' });
  await worker.tick();
  assert.equal(f.store.job(a.jobIds[0]).state, 'queued');
});

test('thousand-node snapshots exclude unrelated assets and do not load task request bodies', async (t) => {
  const f = await fixture(t);
  for (let n = 0; n < 40; n++)
    f.store.create('asset', f.project.id, {
      name: 'unrelated ' + n,
      mediaType: 'image',
      path: 'not-fetched.png',
    });
  const nodes = Array.from({ length: 1000 }, (_, i) => ({
    id: 'n' + i,
    type: 'note',
    title: '节点 ' + i,
    text: '',
    x: (i % 40) * 300,
    y: Math.floor(i / 40) * 200,
  }));
  const c = f.service.save(f.canvas.id, 1, { ...f.canvas.data, nodes });
  const snapshot = f.service.snapshot(c.id);
  assert.equal(snapshot.canvas.data.nodes.length, 1000);
  assert.equal(snapshot.assets.length, 0);
  assert.equal(snapshot.documents.length, 0);
});

test('replayed object intent returns its receipt after a later edit; audio selections retain source precision', async (t) => {
  const f = await fixture(t);
  let c = f.service.save(f.canvas.id, 1, {
    ...f.canvas.data,
    nodes: [{ id: 'director', type: 'director', title: '预演', text: '', x: 0, y: 0 }],
  });
  const body = {
    canvasRevision: c.revision,
    objectRevision: 0,
    data: { scene: directorSceneSchema.parse({}) },
    idempotencyKey: crypto.randomUUID(),
  };
  const first = saveCanvasObject(f.store, c.id, 'director', body);
  const scene = { ...first.object.data.scene, frames: 24 };
  const changed = saveCanvasObject(f.store, c.id, 'director', {
    canvasRevision: first.canvas.revision,
    objectRevision: first.object.revision,
    data: { scene },
  });
  const replay = saveCanvasObject(f.store, c.id, 'director', {
    ...body,
    canvasRevision: changed.canvas.revision,
    objectRevision: changed.object.revision,
  });
  assert.equal(replay.object.revision, first.object.revision);
  assert.equal(f.store.get(first.object.id).revision, changed.object.revision);
  const audio = f.store.create('asset', f.project.id, {
    name: '声音',
    mediaType: 'audio',
    duration: 1,
    sampleRate: 48000,
  });
  c = f.service.get(c.id);
  const saved = f.service.save(c.id, c.revision, {
    ...c.data,
    nodes: [
      ...c.data.nodes,
      {
        id: 'audio',
        type: 'audio',
        title: '声音',
        text: '',
        x: 0,
        y: 0,
        asset: { id: audio.id, revision: audio.revision },
        range: { in: 0.123, out: 0.987 },
      },
    ],
  });
  assert.equal(saved.data.nodes.find((n: any) => n.id === 'audio').range.in, 0.123);
});
