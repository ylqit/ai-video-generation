import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './fixtures/workspace.js';
import { configureModel } from './fixtures/models.js';
import { ModelRegistry } from '../src/server/model-registry.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { prepareApiVideo } from '../src/server/video-api-compile.js';
import { modelUsage } from '../src/server/model-usage.js';
import { protectCredential, resolveCredential } from '../src/server/model-credentials.js';
import { modelRequest } from '../src/server/model-http.js';
import { providerMediaRequest } from '../src/server/provider-media.js';
import { projectModelCapabilities } from '../src/server/capabilities.js';
import { compileH3 } from '../src/server/comfy.js';
import { createApp } from '../src/server/app.js';
import { runProcess, ingestAsset } from '../src/server/media.js';
import { config, prepareData } from '../src/server/config.js';

test('global connection enablement and read-only catalogs create no jobs or uploads', async (t) => {
  const f = fixture(t),
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-catalog-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const app = createApp(f.store, root);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/api`;
  const before = f.store.jobs().length;
  const configured = configureModel(f.store, f.project.id, 'minimax-video');
  const revisions = f.store.db.prepare('SELECT * FROM revisions ORDER BY id,revision').all();
  const listing = await (await fetch(url + '/model-connections')).json();
  assert.equal(listing.connections[0].models[0].capabilities.verification, 'catalog_declared');
  assert.equal(listing.connections[0].probe, null);
  await fetch(url + `/projects/${f.project.id}/model-config`);
  await fetch(url + '/prompt-profiles');
  assert.deepEqual(
    f.store.db.prepare('SELECT * FROM revisions ORDER BY id,revision').all(),
    revisions,
  );
  assert.equal(f.store.jobs().length, before);
  assert.throws(
    () =>
      configured.registry.saveConnection(
        { revision: 0, data: configured.connection.data },
        configured.connection.id,
      ),
    /已变化/,
  );
});

test('project, series, episode and group selectors resolve explicit fixed versions', (t) => {
  const f = fixture(t),
    { store, project } = f;
  const seriesA = store.create('series', project.id, { title: 'A' }),
    seriesB = store.create('series', project.id, { title: 'B' });
  const a = store.create('episode', project.id, { seriesId: seriesA.id, segments: [{ id: 'g' }] }),
    b = store.create('episode', project.id, { seriesId: seriesB.id });
  const first = configureModel(store, project.id, 'minimax-video');
  const second = configureModel(store, project.id, 'ark-video', seriesB.id);
  assert.equal(first.registry.resolve(project.id, a.id, 'video')!.protocol, 'minimax-video');
  assert.equal(first.registry.resolve(project.id, b.id, 'video')!.protocol, 'ark-video');
  first.registry.saveConfig(project.id, a.id, {
    revision: 0,
    data: { slots: { 'video:g': second.selection } },
  });
  assert.equal(first.registry.resolve(project.id, a.id, 'video', 'g')!.protocol, 'ark-video');
  assert.equal(
    first.registry.resolve(project.id, a.id, 'video', 'other')!.protocol,
    'minimax-video',
  );
  assert.throws(
    () =>
      first.registry.saveConfig(project.id, seriesA.id, {
        revision: 0,
        data: { slots: { 'video:g': first.selection } },
      }),
    /生成组/,
  );
  const frozen = first.registry.resolve(project.id, a.id, 'video');
  first.registry.saveConnection(
    { revision: 1, data: { ...first.connection.data, baseUrl: 'http://127.0.0.1:8' } },
    first.connection.id,
  );
  assert.deepEqual(first.registry.resolve(project.id, a.id, 'video'), frozen);
});

test('native MiniMax and Ark preparation is deterministic and preserves reviewed content', (t) => {
  for (const protocol of ['minimax-video', 'ark-video'] as const) {
    const f = fixture(t, false, false, undefined, { canvasTreatment: 'letterbox' }),
      { registry } = configureModel(f.store, f.project.id, protocol);
    const chosen = f.select();
    const a = f.workspace.preview(chosen.scope.id, chosen.scope.revision, f.run.revision);
    assert.deepEqual(a.issues, []);
    const input = a.preview.inputs[0];
    assert.equal(input.modelExecution.protocol, protocol);
    assert.equal(
      input.prepared.request.model,
      registry.resolve(f.project.id, f.run.data.episodeId, 'video')!.modelId,
    );
    assert.equal(input.prepared.request.duration, 12);
    assert.equal(input.prepared.request.content[0].type, 'text');
    assert.match(input.prepared.finalPrompt, /The device is shown/);
    assert.equal(input.prepared.anchors.length, 0);
    assert.equal(
      a.preview.digest,
      f.workspace.preview(chosen.scope.id, chosen.scope.revision, f.run.revision).preview.digest,
    );
    const jobResult = f.workspace.submit(
      chosen.scope.id,
      chosen.scope.revision,
      f.run.revision,
      a.preview.digest,
      crypto.randomUUID(),
    );
    assert.ok(jobResult);
    const job = f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
    assert.equal(
      job.input.modelExecution.promptProfile,
      protocol === 'minimax-video' ? 'minimax-h3-api-base-v1' : 'ark-directed-v1',
    );
    assert.equal(modelUsage(f.store, f.project.id).videoSeconds, 12);
  }
});

test('API mode switches, Guides and unsupported parameters require an explicit revision', (t) => {
  const f = fixture(t, false, false, undefined, { canvasTreatment: 'letterbox' }),
    { registry, selection } = configureModel(f.store, f.project.id, 'minimax-video');
  const chosen = f.select(),
    preview = f.workspace.preview(chosen.scope.id, chosen.scope.revision, f.run.revision);
  const input = preview.preview.inputs[0],
    execution = input.modelExecution;
  assert.throws(
    () => prepareApiVideo({ ...input, segment: { ...input.segment, duration: 5.5 } }, execution),
    /整数秒/,
  );
  assert.throws(
    () => prepareApiVideo({ ...input, segment: { ...input.segment, guides: [{}] } }, execution),
    /Guide/,
  );
  assert.throws(
    () => prepareApiVideo(input, { ...execution, selection: { ...selection, mode: 'i2v' } }),
    /模式/,
  );
  assert.throws(
    () => registry.resolveSelection({ ...selection, parameters: { steps: 20 } }),
    /不支持参数/,
  );
  assert.throws(
    () => registry.resolveSelection({ ...selection, parameters: { seed: 20 } }),
    /不支持参数/,
  );
  assert.throws(
    () => registry.resolveSelection({ ...selection, promptProfile: 'native-h3-directed-v4' }),
    /方案/,
  );
});

test('four-second API groups materialize and submit while Comfy retains its five-second minimum', (t) => {
  for (const protocol of ['minimax-video', 'ark-video'] as const) {
    const f = fixture(
      t,
      false,
      false,
      (outputs) => {
        for (const shot of outputs.director.shots) shot.frames = 96;
      },
      { request: '20 秒产品短片', canvasTreatment: 'letterbox' },
    );
    configureModel(f.store, f.project.id, protocol);
    const selected = f.select();
    const preview = f.workspace.preview(selected.scope.id, selected.scope.revision, f.run.revision);
    assert.deepEqual(preview.issues, []);
    const input = preview.preview.inputs[0];
    assert.equal(input.prepared.request.duration, 4);
    assert.equal(input.segment.duration, 4);
    f.workspace.submit(
      selected.scope.id,
      selected.scope.revision,
      f.run.revision,
      preview.preview.digest,
      crypto.randomUUID(),
    );
    assert.equal(
      f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!.input.segment.duration,
      4,
    );
    configureModel(f.store, f.project.id, 'comfy-h3');
    assert.throws(
      () =>
        f.studio.prepareGeneration(
          {
            episodeId: input.episode.id,
            episodeRevision: input.episode.revision,
            segmentId: input.segment.id,
            width: 864,
            height: 480,
            steps: 20,
            seed: 1,
          },
          input.profile,
        ),
      /ComfyUI 片段需要 5–15 秒/,
    );
  }
});

test('model quotas are atomic, idempotent and cannot be bypassed by altered snapshots', (t) => {
  const f = fixture(t),
    { registry } = configureModel(f.store, f.project.id, 'minimax-video');
  const execution = registry.resolve(f.project.id, f.run.data.episodeId, 'video')!;
  const input = { modelExecution: execution, segment: { duration: 15 }, prepared: {} };
  const one = f.store.createJob('generation', f.project.id, null, input, 'one-attempt');
  assert.equal(
    f.store.createJob('generation', f.project.id, null, input, 'one-attempt').id,
    one.id,
  );
  const old = registry.config(f.project.id)!;
  registry.saveConfig(f.project.id, f.project.id, {
    revision: old.revision,
    data: { ...old.data, allowance: { ...old.data.allowance, maxVideoRequests: 1 } },
  });
  assert.throws(
    () => f.store.createJob('generation', f.project.id, null, input, 'second-attempt'),
    /额度不足/,
  );
  assert.equal(modelUsage(f.store, f.project.id).videoRequests, 1);
  const forged = structuredClone(execution);
  forged.connection.data.baseUrl = 'http://127.0.0.1:1';
  const { digest: _, ...content } = forged;
  forged.digest = generationDigest(content);
  assert.throws(
    () =>
      f.store.createJob(
        'generation',
        f.project.id,
        null,
        { ...input, modelExecution: forged },
        'forged',
      ),
    /固定版本/,
  );
});

test('disabled video connection remains visible to planning but prevents new preparation', (t) => {
  const f = fixture(t),
    { registry, connection } = configureModel(f.store, f.project.id, 'minimax-video');
  const jobsBefore = f.store.jobs().length;
  registry.saveConnection(
    { revision: 1, data: { ...connection.data, enabled: false } },
    connection.id,
  );
  assert.equal(
    projectModelCapabilities(f.store, f.project.id, f.run.data.episodeId).provider,
    'minimax-video',
  );
  assert.throws(() => registry.resolve(f.project.id, f.run.data.episodeId, 'video'), /停用/);
  assert.equal(f.store.jobs().length, jobsBefore);
});

test('explicit Comfy selection preserves the legacy compiler output and isolates probe facts', (t) => {
  const f = fixture(t),
    selected = f.select();
  const oldInput = f.workspace.preview(selected.scope.id, selected.scope.revision, f.run.revision)
    .preview.inputs[0];
  const oldGraph = compileH3(oldInput, new Map(), 'same-job');
  const { registry, connection } = configureModel(f.store, f.project.id, 'comfy-h3');
  assert.throws(
    () =>
      registry.saveConnection(
        {
          revision: 1,
          data: { ...connection.data, credential: { kind: 'env', key: 'IGNORED_KEY' } },
        },
        connection.id,
      ),
    /不支持网关鉴权/,
  );
  assert.throws(
    () =>
      registry.saveConnection(
        {
          revision: 1,
          data: {
            ...connection.data,
            models: [{ id: 'unimplemented-model', name: 'Unsupported', preset: 'h3-comfy' }],
          },
        },
        connection.id,
      ),
    /仅核对了 MiniMax-H3/,
  );
  f.store.setSetting('discovery', {
    capabilities: { guidedImages: { available: false, reason: 'Different legacy connection' } },
    nativeNodes: ['wrong-connection'],
  });
  assert.equal(
    projectModelCapabilities(f.store, f.project.id, f.run.data.episodeId).guidedImages.available,
    null,
  );
  f.store.setSetting(`model_probe:${connection.id}:1`, {
    discovery: {
      capabilities: { guidedImages: { available: true, reason: 'Isolated fixture' } },
      nativeNodes: ['this-connection'],
    },
  });
  const caps = projectModelCapabilities(f.store, f.project.id, f.run.data.episodeId);
  assert.deepEqual(caps.nativeNodes, ['this-connection']);
  assert.equal(caps.guidedImages.available, true);
  const current = f.workspace.preview(selected.scope.id, selected.scope.revision, f.run.revision);
  assert.deepEqual(current.issues, []);
  assert.deepEqual(current.preview.inputs[0].prepared, oldInput.prepared);
  assert.deepEqual(compileH3(current.preview.inputs[0], new Map(), 'same-job'), oldGraph);
  const config = registry.config(f.project.id)!;
  registry.saveConfig(f.project.id, f.project.id, {
    revision: config.revision,
    data: {
      ...config.data,
      slots: { video: { ...config.data.slots.video, parameters: { steps: 7 } } },
    },
  });
  assert.throws(
    () =>
      f.workspace.submit(
        selected.scope.id,
        selected.scope.revision,
        f.run.revision,
        current.preview.digest,
        crypto.randomUUID(),
      ),
    /变化|预览/,
  );
  assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
});

test('Windows encrypted credentials never appear in connection JSON, and errors redact secrets', async (t) => {
  const f = fixture(t),
    secret = 'offline-fixture-secret-no-account';
  if (process.platform === 'win32') {
    const ref = await protectCredential(f.store, secret);
    assert.equal(await resolveCredential(f.store, ref), secret);
    assert.ok(
      !JSON.stringify(f.store.db.prepare('SELECT * FROM model_secrets').all()).includes(secret),
    );
  }
  process.env.STUDIO_PROTOCOL_TEST_KEY = secret;
  t.after(() => {
    delete process.env.STUDIO_PROTOCOL_TEST_KEY;
  });
  const { connection } = configureModel(f.store, f.project.id, 'responses');
  await assert.rejects(
    modelRequest(f.store, connection, '/responses', {}, (async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ' + secret);
      return Response.json({ error: { message: secret + ' rejected' } }, { status: 401 });
    }) as typeof fetch),
    (e) => !String(e).includes(secret) && String(e).includes('[redacted]'),
  );
});

test('reference binding uses identical ordering for labels and real API slots, and validates file hashes', async (t) => {
  const f = fixture(t, false, false, undefined, { canvasTreatment: 'letterbox' }),
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-bindings-'));
  prepareData(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { registry } = configureModel(f.store, f.project.id, 'minimax-video');
  const png = path.join(root, 'offline.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=320x320',
    '-frames:v',
    '1',
    png,
  ]);
  const asset = await ingestAsset(f.store, root, f.project.id, png, { category: 'reference' });
  const selection = f.select(),
    p = f.workspace.preview(selection.scope.id, selection.scope.revision, f.run.revision);
  const input = structuredClone(p.preview.inputs[0]);
  input.segment.mode = 'i2v';
  input.assets = [
    {
      asset,
      reference: {
        role: 'first_frame',
        usage: {
          purpose: 'action_start',
          reviewed: true,
          preserve: [],
          allow: [],
          shotIds: [],
          depictedState: [],
        },
      },
    },
  ];
  const exec = registry.resolve(f.project.id, f.run.data.episodeId, 'video')!;
  input.prepared = prepareApiVideo(input, exec);
  assert.equal(input.prepared.inputBindings[0].role, 'first_frame');
  assert.equal(input.prepared.request.ratio, 'adaptive');
  assert.throws(
    () =>
      prepareApiVideo(input, {
        ...exec,
        selection: { ...exec.selection, parameters: { ratio: '16:9' } },
      }),
    /被忽略的比例/,
  );
  const tailOnly = structuredClone(input);
  tailOnly.assets[0].reference.role = 'last_frame';
  tailOnly.assets[0].reference.usage.purpose = 'action_end';
  assert.equal(prepareApiVideo(tailOnly, exec).inputBindings[0].role, 'last_frame');
  const ark = configureModel(f.store, f.project.id, 'ark-video');
  assert.throws(
    () =>
      prepareApiVideo(tailOnly, ark.registry.resolve(f.project.id, f.run.data.episodeId, 'video')!),
    /不能仅提交尾帧/,
  );
  const wire = await providerMediaRequest(root, { kind: 'generation', input } as any);
  const content = JSON.parse(String(wire.body)).content;
  assert.equal(content[1].role, 'first_frame');
  assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
  assert.equal(input.prepared.inputBindings[0].label, '<Picture 1>');
  const refInput = structuredClone(input);
  refInput.segment.mode = 'ref2va';
  refInput.planning.selected = ['first-device', 'second-device'].map((id) => ({
    id,
    asset: { id: asset.id, revision: asset.revision },
    role: 'identity',
    instanceIds: [id],
    usage: {
      purpose: 'identity',
      reviewed: true,
      preserve: ['Shape'],
      allow: ['Background'],
      shotIds: [],
      depictedState: [],
    },
  }));
  const refPrepared = prepareApiVideo(refInput, exec);
  assert.equal(refPrepared.inputBindings.length, 1);
  assert.deepEqual(refPrepared.inputBindings[0].instanceIds, ['first-device', 'second-device']);
  assert.equal(refPrepared.subjects.length, 2);
  const boundImage = refPrepared.request.content[1];
  assert.equal('role' in boundImage && boundImage.role, 'reference_image');
  assert.ok(
    refPrepared.consumption.some(
      (t: any) => t.field === 'directing.staging' && t.status === 'planning_check',
    ),
  );
  assert.ok(
    refPrepared.consumption.some(
      (t: any) => t.field === 'cutReason' && t.status === 'not_consumed',
    ),
  );
  assert.ok(
    !refPrepared.consumption.some(
      (t: any) => t.field === 'directing.contractRevision' && t.status === 'text_request',
    ),
  );
  await fs.appendFile(path.join(root, asset.data.path), 'changed');
  await assert.rejects(providerMediaRequest(root, { kind: 'generation', input } as any), /哈希/);
});
