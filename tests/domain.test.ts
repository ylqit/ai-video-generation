import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import { prepareData, config, inside } from '../src/server/config.js';
import { compileH3, ComfyClient } from '../src/server/comfy.js';
import { Worker } from '../src/server/worker.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { derivationKey } from '../src/server/migrations.js';
import { runProcess, ingestAsset, exportMovie, probeMedia } from '../src/server/media.js';
import { shotStateSchema, reviewDimensions } from '../src/shared/domain.js';
import { createApp } from '../src/server/app.js';
import { resolveReferencePlan } from '../src/server/reference-plan.js';

const refOf = (d: any) => ({ id: d.id, revision: d.revision });
const profile = { baseUrl: 'http://127.0.0.1:9990', instanceId: 'domain-offline' };
test('formal reference plans accept scene/style/prop roles for their subject types', async (t) => {
  const f = await fixture(t);
  for (const [type, role] of [
    ['environment', 'scene'],
    ['style', 'style'],
    ['object', 'prop'],
  ]) {
    const id = type;
    const e = entity(f, type, type, [{ id, name: type }]);
    const a = asset(f, type),
      p = pack(f, e, a);
    const poses = [{ instanceId: id, position: { x: 0.5, y: 0.5 }, heading: 0 }];
    const ep = episode(f, {
      instances: [{ instanceId: id, entity: refOf(e), pack: refOf(p) }],
      start: poses,
      end: poses,
      confirmed: true,
    });
    let plan = f.domain.save(f.project.id, 'reference_plan', {
      name: type,
      episodeId: ep.id,
      segmentId: 'g1',
      bindings: [
        { id, asset: refOf(a), pack: refOf(p), instanceIds: [id], role, priority: 1, reason: type },
      ],
    });
    plan = f.domain.publish(plan.id, plan.revision, {
      inspected: true,
      conclusion: 'offline fixture',
    });
    const segment = {
      ...ep.data.segments[0],
      referencePlan: refOf(plan),
      generationMode: 'formal',
    };
    assert.deepEqual(resolveReferencePlan(f.store, ep, segment).checks, []);
    const wrong = f.domain.save(f.project.id, 'reference_plan', {
      ...plan.data,
      bindings: [{ ...plan.data.bindings[0], role: type === 'style' ? 'scene' : 'style' }],
    });
    const published = f.domain.publish(wrong.id, wrong.revision, {
      inspected: true,
      conclusion: 'offline negative fixture',
    });
    assert.doesNotThrow(() =>
      resolveReferencePlan(f.store, ep, { ...segment, referencePlan: refOf(published) }),
    );
  }
});
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-domain-'));
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store),
    domain = new DomainService(store);
  const project = service.createProject({ title: '通用离线验收', mode: 'series', brief: '' });
  t.after(async () => {
    store.close();
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'studio-domain-'),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, service, domain, project };
}
function entity(f: any, name = '主体', type = 'character', instances = [{ id: 'A', name: 'A' }]) {
  return f.domain.save(f.project.id, 'entity', {
    name,
    type,
    description: '通用主体',
    anchors: ['right_socket', 'left_socket'],
    fixedFeatures: ['stable geometry'],
    allowedChanges: ['pose'],
    instances,
  });
}
function asset(f: any, name = 'front') {
  return f.store.create('asset', f.project.id, {
    name,
    category: 'reference',
    mediaType: 'image',
    adopted: true,
    width: 864,
    height: 480,
    sha256: name,
    path: `assets/${name}.png`,
    entityId: 'legacy',
  });
}
function pack(f: any, e: any, a: any, views = ['front']) {
  const p = f.domain.save(f.project.id, 'reference_pack', {
    name: '参考包',
    entity: refOf(e),
    views: views.map((view, n) => ({ id: `v${n}`, asset: refOf(a), view, label: view })),
    relations: [],
  });
  return f.domain.publish(p.id, p.revision, { inspected: true, conclusion: '离线固定素材审核' });
}
function episode(f: any, state?: any, number = 1) {
  let ep = f.service.createEpisode(f.project.id, { title: `第 ${number} 集` });
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: [
      {
        id: 's1',
        scene: '',
        description: '动作',
        dialogue: '',
        continuity: '',
        duration: 5,
        ...(state ? { state } : {}),
      },
    ],
    segments: [
      {
        id: 'g1',
        shotIds: ['s1'],
        mode: 'ref2va',
        duration: 5,
        prompt: 'intent',
        references: [],
        guides: [],
        guidedPrompt: {
          summary: 'Task',
          detailedDescription: '[Shot 1] {{subject:A}} turns.',
          overallSoundscape: 'Ambient.',
          nonDiegeticMusic: 'N/A',
        },
      },
    ],
  });
  return f.service.approveEpisode(ep.id, ep.revision);
}
function planned(
  f: any,
  opts: { requiredViews?: string[]; instances?: any[]; guides?: boolean } = {},
) {
  const e = entity(f, '产品', 'object', opts.instances || [{ id: 'A', name: 'A' }]),
    a = asset(f),
    p = pack(f, e, a, ['front', 'left', 'back']);
  const entries = e.data.instances.map((i: any) => ({
    instanceId: i.id,
    entity: refOf(e),
    appearance: null,
    pack: refOf(p),
  }));
  const poses = entries.map((i: any) => ({
    instanceId: i.instanceId,
    position: { x: 0.5, y: 0.5 },
    heading: 0,
  }));
  const state = shotStateSchema.parse({
    instances: entries,
    start: poses,
    end: poses,
    confirmed: true,
    action: 'turn',
    requiredViews: (opts.requiredViews || []).map((view) => ({
      instanceId: 'A',
      view,
      reason: '动作可见',
    })),
  });
  let ep = episode(f, state);
  let rp = f.domain.save(f.project.id, 'reference_plan', {
    name: '镜头参考',
    episodeId: ep.id,
    segmentId: 'g1',
    bindings: [
      {
        id: 'image-front',
        asset: refOf(a),
        pack: refOf(p),
        view: 'front',
        instanceIds: entries.map((i: any) => i.instanceId),
        role: 'identity',
        priority: 1,
        required: true,
        reason: '主体外观',
        retain: ['shape'],
        allow: ['rotation'],
      },
    ],
    guides: opts.guides
      ? [{ bindingId: 'image-front', frameIndex: 0, instruction: 'opening' }]
      : [],
  });
  rp = f.domain.publish(rp.id, rp.revision, { inspected: true, conclusion: '已确认本次绑定' });
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    segments: ep.data.segments.map((s: any) => ({
      ...s,
      referencePlan: refOf(rp),
      generationMode: 'formal',
    })),
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const req = {
    episodeId: ep.id,
    episodeRevision: ep.revision,
    segmentId: 'g1',
    width: 864,
    height: 480,
    steps: 20,
    seed: 5,
  };
  return { ...f, e, a, p, ep, rp, req };
}
test('generic subjects, immutable appearances and published views have independent revisions', async (t) => {
  const f = await fixture(t);
  for (const [type, name] of [
    ['character', '人物'],
    ['character', '动物'],
    ['object', '产品'],
    ['environment', '空间'],
    ['style', '水彩'],
  ]) {
    const e = entity(f, name, type, [{ id: name, name }]);
    assert.equal(e.data.type, type);
  }
  const e = f.store.list('entity', f.project.id)[0],
    a = asset(f),
    p = pack(f, e, a);
  const first = f.domain.save(f.project.id, 'appearance', {
    name: '白色',
    entity: refOf(e),
    description: '白色陶瓷',
    features: { material: 'ceramic' },
  });
  const second = f.domain.save(
    f.project.id,
    'appearance',
    { ...first.data, name: '蓝色' },
    first.id,
    first.revision,
  );
  assert.equal(f.store.get(first.id, 1).data.name, '白色');
  assert.equal(second.revision, 2);
  const changed = f.domain.save(
    f.project.id,
    'reference_pack',
    { ...p.data, notes: '补充约束' },
    p.id,
    p.revision,
  );
  assert.equal(changed.data.published, false);
  assert.equal(f.store.get(p.id, p.revision).data.published, true);
  assert.throws(() => f.domain.save(f.project.id, 'entity', e.data, e.id, 999), /更新|冲突/);
});
test('template library copies IDs, instances, relationships and ownership into independent projects', async (t) => {
  const f = await fixture(t),
    e = entity(f),
    a = asset(f),
    p = pack(f, e, a);
  const lib = f.domain.publishLibrary(f.project.id, [refOf(p)], '角色模板');
  const other = f.service.createProject({ title: '产品项目', mode: 'short', brief: '' });
  const one = f.domain.copyLibrary(f.project.id, lib.id, lib.revision),
    two = f.domain.copyLibrary(other.id, lib.id, lib.revision);
  assert.notEqual(one.instanceMapping.A, two.instanceMapping.A);
  const copied = two.documents.find((d) => d.kind === 'entity')!;
  f.domain.save(
    other.id,
    'entity',
    { ...copied.data, name: '独立修改' },
    copied.id,
    copied.revision,
  );
  assert.equal(f.store.get(e.id).data.name, '主体');
  const copiedPack = two.documents.find((d) => d.kind === 'reference_pack')!;
  assert.equal(copiedPack.data.entity.id, copied.id);
  assert.equal(copiedPack.data.published, false);
  assert.doesNotThrow(() =>
    f.domain.publish(copiedPack.id, copiedPack.revision, {
      inspected: true,
      conclusion: '未经采用',
    }),
  );
  assert.equal(two.documents.find((d) => d.kind === 'asset')!.data.path, a.data.path);
});
test('anatomical anchors, distinct identical instances and 2D positions validate independently', async (t) => {
  const f = await fixture(t),
    e = entity(f, '器材', 'object', [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
    ]);
  const env = entity(f, '实验台', 'environment', [{ id: 'room', name: 'room' }]);
  const layout = f.domain.save(f.project.id, 'layout', {
    name: '台面',
    environment: refOf(env),
    regions: [{ id: 'zone', name: '区域', x: 0, y: 0, width: 1, height: 1 }],
    cameras: [{ id: 'cam', name: '机位', position: { x: 0.1, y: 0.2 }, heading: 180 }],
  });
  const state = shotStateSchema.parse({
    layout: refOf(layout),
    cameraId: 'cam',
    instances: ['A', 'B'].map((instanceId) => ({ instanceId, entity: refOf(e) })),
    start: [{ instanceId: 'A', position: { x: 0.8, y: 0.2 }, heading: 0 }],
    startRelations: [
      { objectId: 'B', type: 'attachedTo', targetId: 'A', anchor: 'right_socket', confirmed: true },
    ],
  });
  const valid = f.domain.validateShot(f.project.id, state);
  assert.equal(valid.start[0].heading, 0);
  assert.equal(valid.startRelations[0].anchor, 'right_socket');
  assert.throws(
    () =>
      f.domain.validateShot(f.project.id, {
        ...state,
        startRelations: [{ ...state.startRelations[0], anchor: 'human_right_hand' }],
      }),
    /附着点/,
  );
  assert.throws(
    () =>
      f.domain.validateShot(f.project.id, {
        ...state,
        startRelations: [...state.startRelations, ...state.startRelations],
      }),
    /冲突/,
  );
});
test('stable picture tokens support many-to-many subjects and correctly chain guides without changing latent', async (t) => {
  const f = planned(await fixture(t), {
    instances: [
      { id: 'A', name: '同款 1' },
      { id: 'B', name: '同款 2' },
    ],
    guides: true,
  });
  const preview = f.service.prepareGeneration(f.req, profile),
    input = preview.input;
  assert.equal(input.templateVersion, 'native-h3-reference-plan-v2');
  assert.equal(input.prepared.images.length, 1);
  assert.equal(input.prepared.subjects.length, 2);
  const graph = compileH3(input, new Map([[`${f.a.id}:1`, 'img.png']]), 'offline');
  assert.deepEqual(graph.guide_0.inputs.latent, ['condition', 1]);
  assert.deepEqual(graph.sample.inputs.latent_image, ['condition', 1]);
  assert.deepEqual(graph.guider.inputs.conditioning, ['guide_0', 0]);
  assert.match(graph.condition.inputs.prompt, /Do not inherit reference backgrounds/);
  assert.doesNotMatch(graph.condition.inputs.prompt, /fully_preserved/);
  const changed = structuredClone(input);
  changed.prepared.finalPrompt = 'tamper';
  assert.throws(
    () => compileH3(changed, new Map([[`${f.a.id}:1`, 'img.png']]), 'offline'),
    /不一致/,
  );
});
test('formal view gaps block; exploration requires explicit risk codes; no generated job on preview', async (t) => {
  const f = planned(await fixture(t), { requiredViews: ['back'] });
  assert.doesNotThrow(() => f.service.prepareGeneration(f.req, profile));
  let ep = f.service.saveEpisode(f.ep.id, f.ep.revision, {
    ...f.ep.data,
    segments: f.ep.data.segments.map((s: any) => ({ ...s, generationMode: 'exploration' })),
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  assert.doesNotThrow(() =>
    f.service.prepareGeneration({ ...f.req, episodeRevision: ep.revision }, profile),
  );
  let p = f.domain.save(
    f.project.id,
    'reference_plan',
    { ...f.rp.data, acknowledgedRisks: ['view:A:back'] },
    f.rp.id,
    f.rp.revision,
  );
  p = f.domain.publish(p.id, p.revision, { inspected: true, conclusion: '仅探索背面风险' });
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    segments: ep.data.segments.map((s: any) => ({ ...s, referencePlan: refOf(p) })),
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const preview = f.service.prepareGeneration({ ...f.req, episodeRevision: ep.revision }, profile);
  assert.equal(preview.input.planning.mode, 'exploration');
  assert.equal(f.store.jobs().length, 0);
});
test('nine-image required budget blocks; optional omissions and stale preview are visible', async (t) => {
  const f = planned(await fixture(t));
  const bindings = [
    ...f.rp.data.bindings,
    ...Array.from({ length: 9 }, (_, n) => {
      const a = asset(f, `extra-${n}`);
      return {
        id: `extra-${n}`,
        asset: refOf(a),
        instanceIds: [],
        role: 'style',
        view: 'detail',
        priority: 4,
        required: true,
        reason: '辅助',
      };
    }),
  ];
  let p = f.domain.save(
    f.project.id,
    'reference_plan',
    { ...f.rp.data, bindings },
    f.rp.id,
    f.rp.revision,
  );
  p = f.domain.publish(p.id, p.revision, { inspected: true, conclusion: '预算测试' });
  let ep = f.service.saveEpisode(f.ep.id, f.ep.revision, {
    ...f.ep.data,
    segments: f.ep.data.segments.map((s: any) => ({ ...s, referencePlan: refOf(p) })),
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  assert.throws(
    () => f.service.prepareGeneration({ ...f.req, episodeRevision: ep.revision }, profile),
    /九图限制/,
  );
  p = f.domain.save(
    f.project.id,
    'reference_plan',
    { ...p.data, bindings: bindings.map((b: any) => ({ ...b, required: b.id === 'image-front' })) },
    p.id,
    p.revision,
  );
  p = f.domain.publish(p.id, p.revision, { inspected: true, conclusion: '辅助可省略' });
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    segments: ep.data.segments.map((s: any) => ({ ...s, referencePlan: refOf(p) })),
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const req = { ...f.req, episodeRevision: ep.revision },
    preview = f.service.prepareGeneration(req, profile);
  assert.equal(preview.input.planning.omitted.length, 1);
  assert.throws(
    () =>
      f.service.generation(
        {
          ...req,
          seed: 55,
          approved: true,
          idempotencyKey: 'stale-preview',
          previewDigest: preview.digest,
        },
        profile,
      ),
    /重新预览/,
  );
  f.store.update(f.a.id, 1, { ...f.a.data, name: '新增可选版本' });
  assert.throws(
    () =>
      f.service.generation(
        { ...req, approved: true, idempotencyKey: 'stale-preview', previewDigest: preview.digest },
        profile,
      ),
    /重新预览/,
  );
});
test('three episodes inherit confirmed prop ownership; optional variants do not invalidate, corrections do', async (t) => {
  const f = await fixture(t),
    e = entity(f, '角色', 'character', [
      { id: 'A', name: 'A' },
      { id: 'B', name: 'B' },
    ]),
    prop = entity(f, '包裹', 'object', [{ id: 'parcel', name: '包裹' }]);
  const instances = [
    ...['A', 'B'].map((instanceId) => ({ instanceId, entity: refOf(e) })),
    { instanceId: 'parcel', entity: refOf(prop) },
  ];
  const eps = [episode(f, undefined, 1), episode(f, undefined, 2), episode(f, undefined, 3)];
  let prev: any = null;
  const snapshots: any[] = [];
  for (let n = 0; n < 2; n++) {
    const result = f.domain.confirmCanon(f.project.id, {
      episode: refOf(eps[n]),
      previous: prev,
      facts: [
        {
          id: 'owner',
          text: n ? 'A 将包裹交给 B' : 'A 持有包裹',
          instanceIds: ['A', 'B', 'parcel'],
        },
      ],
      instances,
      relations: [
        {
          objectId: 'parcel',
          type: 'heldBy',
          targetId: n ? 'B' : 'A',
          anchor: 'right_socket',
          confirmed: true,
        },
      ],
      openLoops: [],
    });
    snapshots.push(result.document);
    prev = refOf(result.document);
  }
  asset(f, 'not-relevant');
  assert.equal(snapshots[1].data.relations[0].targetId, 'B');
  f.domain.dependencies(eps[2], [{ ...refOf(snapshots[1]), purpose: 'continuity' }]);
  const variation = f.domain.save(f.project.id, 'appearance', {
    entity: refOf(e),
    name: '雨衣',
    description: '可选外观',
  });
  assert.deepEqual(f.domain.impact(variation.id), []);
  assert.equal(f.store.get(eps[2].id).data.stale, false);
  const correction = f.domain.confirmCanon(
    f.project.id,
    {
      ...snapshots[0].data,
      correctionReason: '第一集持有者改为 B',
      relations: [{ ...snapshots[0].data.relations[0], targetId: 'B' }],
    },
    snapshots[0].revision,
  );
  assert.ok(correction.affected.some((a: any) => a.id === snapshots[1].id));
  assert.ok(correction.affected.some((a: any) => a.id === eps[2].id));
  assert.equal(f.store.get(eps[2].id).data.stale, true);
  assert.equal(f.store.get(snapshots[0].id, 1).data.relations[0].targetId, 'A');
});
test('candidate issues do not change canon; selection requires review, covered intervals and preserves prior EDL', async (t) => {
  const f = await fixture(t);
  let ep = episode(f);
  const job = f.store.createJob(
    'generation',
    f.project.id,
    ep.id,
    { segment: ep.data.segments[0] },
    'offline-candidate',
  );
  f.store.patchJob(job.id, { state: 'succeeded' });
  const v = f.store.create('asset', f.project.id, {
    name: '离线视频',
    mediaType: 'video',
    adopted: true,
    duration: 5,
    frameCount: 120,
    hasAudio: true,
    jobId: job.id,
    path: 'assets/video.mp4',
  });
  const data = {
    jobId: job.id,
    video: refOf(v),
    in: 0,
    out: 5,
    dimensions: Object.fromEntries(reviewDimensions.map((d) => [d, 'pass'])),
    issues: [],
    inspected: true,
  };
  let review = f.domain.review(f.project.id, {
    ...data,
    dimensions: { ...data.dimensions, props: 'issues' },
    issues: [{ category: 'props', severity: 'blocking', description: '重复包裹', frameIndex: 50 }],
  });
  const selection = {
    episode: refOf(ep),
    segmentId: 'g1',
    jobId: job.id,
    video: refOf(v),
    review: refOf(review),
    in: 0,
    out: 5,
    coverage: [{ shotId: 's1', in: 0, out: 5 }],
  };
  const unchecked = f.domain.select(f.project.id, { ...selection, review: null });
  assert.equal(unchecked.data.quality, 'unobserved');
  assert.equal(f.store.list('continuity').length, 0);
  review = f.domain.review(
    f.project.id,
    { ...review.data, issues: [{ ...review.data.issues[0], severity: 'warning' }] },
    review.id,
    review.revision,
  );
  const selected = f.domain.select(
    f.project.id,
    { ...selection, review: refOf(review) },
    unchecked.revision,
  );
  const edl = f.service.saveEdl(f.project.id, f.domain.assemble(f.project.id, ep.id));
  assert.equal(edl.data.clips[0].selection.id, selected.id);
  assert.throws(
    () =>
      f.service.saveEdl(
        f.project.id,
        { ...edl.data, clips: [{ ...edl.data.clips[0], out: 6 }] },
        edl.revision,
        { id: edl.id },
      ),
    /超过|区间/,
  );
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: ep.data.shots.map((s: any) => ({ ...s, description: '局部重做' })),
  });
  assert.equal(f.store.get(selected.id).data.stale, true);
  assert.equal(f.store.get(edl.id, 1).data.clips[0].out, 5);
});
test('derived-media identity survives commit before worker output update, with no second prompt or duplicate frame', async (t) => {
  const f = planned(await fixture(t), { guides: true });
  const sample = path.join(f.root, 'sample.mp4');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=blue:s=160x128:r=24',
    '-t',
    '1',
    '-c:v',
    'libx264',
    sample,
  ]);
  const preview = f.service.prepareGeneration(f.req, profile);
  const job = f.service.generation(
    { ...f.req, approved: true, idempotencyKey: 'derived-crash', previewDigest: preview.digest },
    profile,
  );
  f.store.patchJob(job.id, {
    state: 'archiving',
    promptId: 'already-submitted',
    output: { descriptor: { filename: 'sample.mp4' } },
  });
  let downloads = 0,
    submits = 0;
  const client = {
    request: async () => {
      downloads++;
      return new Response(await fs.readFile(sample));
    },
    submit: async () => {
      submits++;
      return 'forbidden';
    },
  } as any;
  const transaction = f.store.transaction.bind(f.store);
  let crash = true;
  f.store.transaction = function <T>(fn: () => T): T {
    const result = transaction(fn);
    if (
      crash &&
      !f.store.db.isTransaction &&
      f.store.db
        .prepare(
          "SELECT 1 FROM documents WHERE kind='asset' AND json_extract(data,'$.category')='generated'",
        )
        .get()
    ) {
      crash = false;
      throw new Error('fault after media commit');
    }
    return result;
  };
  const worker = new Worker(f.store, f.root, () => client);
  await assert.rejects(
    () => worker.archive(f.store.job(job.id), client),
    /fault after media commit/,
  );
  f.store.transaction = transaction;
  const before = f.store.list('asset').filter((a: any) => a.data.category === 'generated');
  assert.equal(before.length, 1);
  assert.equal(before[0].data.mediaType, 'video');
  assert.equal(f.store.job(job.id).output.reviewFrames, undefined);
  await new Worker(f.store, f.root, () => client).archive(f.store.job(job.id), client);
  assert.equal(
    f.store.list('asset').filter((a: any) => a.data.category === 'review_frame').length,
    0,
  );
  assert.equal(downloads, 1);
  assert.equal(submits, 0);
  assert.equal(f.store.job(job.id).promptId, 'already-submitted');
  const movie = f.store.get(f.store.job(job.id).output.videoAssetId);
  const adopted = f.store.update(movie.id, movie.revision, { ...movie.data, adopted: true });
  const output = path.join(f.root, 'edited.mp4');
  await exportMovie(
    {
      episodeId: f.ep.id,
      width: 160,
      height: 128,
      fps: 24,
      clips: [{ assetId: adopted.id, revision: adopted.revision, in: 0, out: 0.5, volume: 0 }],
      audio: [],
    },
    [adopted],
    f.root,
    output,
  );
  assert.ok(Math.abs((await probeMedia(output)).duration - 0.5) < 0.05);
});
test('HTTP domain endpoints, image task delivery and context previews are local-only and version checked', async (t) => {
  const f = await fixture(t),
    e = entity(f),
    a = asset(f);
  const app = createApp(f.store, f.root);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const req = async (route: string, body: any) => {
    const response = await fetch(url + '/api' + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };
  const task = await req(`/projects/${f.project.id}/domain/asset_task`, {
    data: {
      name: '补侧面',
      entity: refOf(e),
      references: [refOf(a)],
      requirements: '维持结构',
      views: [{ id: 'left', view: 'left', instruction: '左侧独立图片' }],
    },
  });
  assert.equal(task.status, 201);
  const pkg = await (
    await fetch(url + `/api/asset-tasks/${task.data.id}/package?revision=1`)
  ).json();
  assert.equal(pkg.taskId, task.data.id);
  assert.equal(pkg.delivery.assets[0].viewId, 'left');
  assert.equal(f.store.jobs().length, 0);
  const bad = new FormData();
  bad.set('manifest', JSON.stringify({ ...pkg.delivery, taskRevision: 999 }));
  const response = await fetch(url + `/api/asset-tasks/${task.data.id}/delivery`, {
    method: 'POST',
    body: bad,
  });
  assert.equal(response.status, 409);
  assert.equal(f.store.list('reference_pack').length, 0);
  const imageFile = path.join(f.root, 'delivery.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=32x32',
    '-frames:v',
    '1',
    imageFile,
  ]);
  const good = new FormData();
  good.set(
    'manifest',
    JSON.stringify({
      taskId: task.data.id,
      taskRevision: 1,
      deliveryId: 'offline-delivery',
      assets: [{ viewId: 'left', file: 'left.png' }],
    }),
  );
  good.append('files', new Blob([await fs.readFile(imageFile)], { type: 'image/png' }), 'left.png');
  const delivered = await fetch(url + `/api/asset-tasks/${task.data.id}/delivery`, {
    method: 'POST',
    body: good,
  });
  assert.equal(delivered.status, 201);
  const receipt = await delivered.json();
  assert.equal(receipt.task.data.deliveries[0].candidates.length, 1);
  const candidate = f.store.get(receipt.task.data.deliveries[0].candidates[0].asset.id);
  assert.equal(candidate.data.adopted, false);
  assert.equal(candidate.data.production.viewId, 'left');
  const repeated = await fetch(url + `/api/asset-tasks/${task.data.id}/delivery`, {
    method: 'POST',
    body: good,
  });
  assert.equal(repeated.status, 200);
  assert.equal(f.store.list('asset').length, 2);
});

test('v2 submit reply loss reconciles after worker restart with exactly one submission', async (t) => {
  const f = planned(await fixture(t), { guides: true });
  const preview = f.service.prepareGeneration(f.req, profile);
  const job = f.service.generation(
    {
      ...f.req,
      approved: true,
      idempotencyKey: 'v2-unknown-recovery',
      previewDigest: preview.digest,
    },
    profile,
  );
  let submitted = 0,
    uploaded = 0,
    validated = 0;
  const client: any = {
    validate: async () => {
      validated++;
    },
    upload: async (_file: string, name: string) => {
      uploaded++;
      return name;
    },
    submit: async () => {
      submitted++;
      throw new Error('simulated lost reply');
    },
    json: async (url: string) =>
      url === '/queue'
        ? {
            queue_running: [],
            queue_pending: [
              [
                0,
                'known-cloud-id',
                {},
                { studio: { job_id: job.id, instance_id: profile.instanceId } },
              ],
            ],
          }
        : {},
  };
  const first = new Worker(f.store, f.root, () => client);
  await first.tick();
  assert.equal(f.store.job(job.id).state, 'unknown');
  first.stop();
  f.store.release(first.owner);
  f.store.writeLeaseOwner = null;
  const second = new Worker(f.store, f.root, () => client);
  await second.tick();
  second.stop();
  assert.equal(f.store.job(job.id).promptId, 'known-cloud-id');
  assert.equal(submitted, 1);
  assert.equal(uploaded, 1);
  assert.equal(validated, 1);
});

test('v2 reference reordering remaps stable tokens and different asset revisions never share a label', async (t) => {
  const f = planned(await fixture(t));
  const nextAsset = f.store.update(f.a.id, f.a.revision, { ...f.a.data, name: '另一个固定版本' });
  let p = f.domain.save(
    f.project.id,
    'reference_plan',
    {
      ...f.rp.data,
      bindings: [
        {
          id: 'new-version',
          asset: refOf(nextAsset),
          instanceIds: [],
          view: 'custom',
          role: 'scene',
          priority: 0,
          required: true,
          reason: '新版本场景参考',
        },
        ...f.rp.data.bindings,
      ],
    },
    f.rp.id,
    f.rp.revision,
  );
  p = f.domain.publish(p.id, p.revision, { inspected: true, conclusion: '多版本输入分别冻结' });
  let ep = f.service.saveEpisode(f.ep.id, f.ep.revision, {
    ...f.ep.data,
    segments: f.ep.data.segments.map((s: any) => ({
      ...s,
      referencePlan: refOf(p),
      guidedPrompt: {
        ...s.guidedPrompt,
        summary:
          '{{picture:image-front}} defines identity; {{picture:new-version}} defines the scene.',
      },
    })),
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const preview = f.service.prepareGeneration({ ...f.req, episodeRevision: ep.revision }, profile);
  assert.equal(preview.input.prepared.images.length, 2);
  assert.equal(preview.input.prepared.images[0].revision, 2);
  assert.equal(preview.input.prepared.images[1].revision, 1);
  assert.match(
    preview.input.prepared.finalPrompt,
    /<Picture 2> defines identity; <Picture 1> defines the scene/,
  );
});

test('local redo only invalidates the changed segment selection, leaving other selections and old film unchanged', async (t) => {
  const f = await fixture(t);
  let ep = episode(f);
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: [...ep.data.shots, { ...ep.data.shots[0], id: 's2' }],
    segments: [...ep.data.segments, { ...ep.data.segments[0], id: 'g2', shotIds: ['s2'] }],
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const chosen: any[] = [];
  for (const segment of ep.data.segments) {
    const j = f.store.createJob(
      'generation',
      f.project.id,
      ep.id,
      { segment },
      `local-redo-${segment.id}`,
    );
    f.store.patchJob(j.id, { state: 'succeeded' });
    const v = f.store.create('asset', f.project.id, {
      mediaType: 'video',
      duration: 5,
      frameCount: 120,
      adopted: true,
      jobId: j.id,
      path: 'assets/offline.mp4',
    });
    const r = f.domain.review(f.project.id, {
      jobId: j.id,
      video: refOf(v),
      in: 0,
      out: 5,
      dimensions: Object.fromEntries(reviewDimensions.map((d) => [d, 'pass'])),
      issues: [],
      inspected: true,
    });
    chosen.push(
      f.domain.select(f.project.id, {
        episode: refOf(ep),
        segmentId: segment.id,
        jobId: j.id,
        video: refOf(v),
        review: refOf(r),
        in: 0,
        out: 5,
        coverage: [{ shotId: segment.shotIds[0], in: 0, out: 5 }],
      }),
    );
  }
  const film = f.service.saveEdl(f.project.id, f.domain.assemble(f.project.id, ep.id));
  f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: ep.data.shots.map((s: any) =>
      s.id === 's1' ? { ...s, description: '重做第一镜头' } : s,
    ),
  });
  assert.equal(f.store.get(chosen[0].id).data.stale, true);
  assert.deepEqual(f.store.get(chosen[1].id), chosen[1]);
  assert.deepEqual(f.store.get(film.id, 1), film);
});
