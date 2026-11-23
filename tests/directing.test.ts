import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import {
  directingSchema,
  prepareShot,
  continuityIssues,
  eventCoverageIssues,
} from '../src/shared/directing.js';
import { shotStateSchema } from '../src/shared/domain.js';
import { sampleShot, worldPoint, screenPoint, spatialIssues } from '../src/shared/spatial.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { prepareDirectedH3 } from '../src/server/directed-h3.js';
import { previsManifest } from '../src/server/previs-manifest.js';
import { ingestAsset, runProcess } from '../src/server/media.js';
import { episodePlanSchema } from '../src/shared/contracts.js';
import { config } from '../src/server/config.js';
import { compileH3 } from '../src/server/comfy.js';
import { createApp } from '../src/server/app.js';
import { previsExamples } from '../src/shared/previs-examples.js';

const ref = (d: any) => ({ id: d.id, revision: d.revision });
const shot = (id = 's1', scene = 'room') => ({
  id,
  scene,
  description: 'A visible action',
  dialogue: '',
  continuity: '',
  duration: 5,
});
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-directing-'));
  await fs.mkdir(path.join(root, 'assets'));
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store);
  const project = service.createProject({ title: 'Generic', mode: 'short', brief: '' });
  let ep = service.createEpisode(project.id, { title: 'Episode' });
  ep = service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: [shot('s1', 'one'), shot('s2', 'one'), shot('s3', 'two')],
    segments: [],
  });
  t.after(async () => {
    store.close();
    assert.ok(
      path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'studio-directing-'),
    );
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, service, project, ep };
}
test('camera prose never exempts handoff; layout revisions and heading boundaries are checked', () => {
  const a = {
    ...shot('a'),
    state: shotStateSchema.parse({
      layout: { id: 'L', revision: 1 },
      start: [],
      end: [{ instanceId: 'A', position: { x: 0.2, y: 0.3 }, heading: 0 }],
      endRelations: [
        {
          objectId: 'prop',
          type: 'heldBy',
          targetId: 'A',
          anchor: 'socket',
          quantity: 1,
          maxQuantity: 1,
          confirmed: true,
        },
      ],
    }),
  };
  const b = {
    ...shot('b'),
    state: shotStateSchema.parse({
      layout: { id: 'L', revision: 1 },
      cameraIntent: 'Static camera, intentional axis crossing',
      start: [{ instanceId: 'A', position: { x: 0.3, y: 0.3 }, heading: 90 }],
      startRelations: [
        {
          objectId: 'prop',
          type: 'heldBy',
          targetId: 'B',
          anchor: 'socket',
          quantity: 1,
          maxQuantity: 1,
          confirmed: true,
        },
      ],
    }),
  };
  const codes = continuityIssues([a, b]).map((i) => i.code);
  assert.ok(codes.some((c) => c.startsWith('handoff')));
  assert.ok(codes.some((c) => c.startsWith('position')));
  assert.ok(codes.some((c) => c.startsWith('heading')));
  b.state.layout!.revision = 2;
  assert.ok(continuityIssues([a, b]).some((i) => i.code.startsWith('layout-boundary')));
  const directed = {
    ...b,
    directing: directingSchema.parse({
      version: 1,
      transition: {
        kind: 'continuous',
        changes: [{ objectId: 'prop', property: 'relationship', reason: 'Visible handoff' }],
      },
    }),
  };
  assert.ok(!continuityIssues([a, directed]).some((i) => i.code.startsWith('handoff')));
});

test('explicit relation knowledge distinguishes first observation from an unexplained detachment', () => {
  const relation = {
    objectId: 'paper',
    type: 'attachedTo',
    targetId: 'writer',
    anchor: 'slot',
    confirmed: true,
  };
  const before = {
    ...shot('before'),
    state: shotStateSchema.parse({ relationKnowledge: { start: [], end: [] } }),
  };
  const current = {
    ...shot('current'),
    state: shotStateSchema.parse({
      startRelations: [relation],
      relationKnowledge: { start: ['paper'], end: ['paper'] },
    }),
  };
  assert.equal(continuityIssues([before, current]).length, 0);
  before.state.endRelations = [relation as any];
  before.state.relationKnowledge!.end = ['paper'];
  current.state.startRelations = [];
  assert.ok(continuityIssues([before, current]).some((i) => i.code.startsWith('handoff')));
});
function spatialFixture(shape = 'box') {
  const layout = {
    id: 'L',
    revision: 1,
    data: {
      space: { width: 10, depth: 10, height: 3 },
      cameras: [
        {
          id: 'cam',
          name: 'Camera',
          position: { x: 0.5, y: 0.9 },
          heading: 0,
          optics: { height: 1, pitch: 0, fov: 50 },
        },
      ],
      barriers: [
        {
          id: 'door',
          name: 'Door',
          kind: 'door',
          start: { x: 0, y: 0.5 },
          end: { x: 1, y: 0.5 },
          height: 2,
          thickness: 0.1,
          open: false,
        },
      ],
    },
  };
  const state = shotStateSchema.parse({
    layout: ref(layout),
    cameraId: 'cam',
    instances: [{ instanceId: 'A', entity: { id: 'E', revision: 1 } }],
    start: [{ instanceId: 'A', position: { x: 0.5, y: 0.7 }, heading: 0 }],
    end: [{ instanceId: 'A', position: { x: 0.5, y: 0.2 }, heading: 0 }],
  });
  return {
    layout,
    shot: {
      ...shot(),
      state,
      directing: directingSchema.parse({
        version: 1,
        execution: { action: 'The subject moves through the doorway.' },
        proxies: [{ instanceId: 'A', shape, width: 1, depth: 1, height: 1, color: '#aabbcc' }],
      }),
    },
  };
}
test('generic geometry uses shared coordinates, FOV and per-frame paths for three subject shapes', () => {
  for (const example of previsExamples) {
    assert.equal(example.spec.issues.filter((i) => i.severity === 'blocking').length, 0);
    const first = sampleShot(example.spec, 0),
      middle = sampleShot(example.spec, 60);
    assert.notDeepEqual(first.instances[0].pose, middle.instances[0].pose);
    assert.ok(Math.abs(first.instances[1].position!.x - middle.instances[1].position!.x) < 1e-9);
    assert.ok(Math.abs(first.instances[1].position!.z - middle.instances[1].position!.z) < 1e-9);
  }
  const isolation = previsExamples[0].spec;
  assert.equal(sampleShot(isolation, 89).barriers.find((b: any) => b.id === 'side').open, true);
  assert.equal(sampleShot(isolation, 90).barriers.find((b: any) => b.id === 'side').open, false);
  assert.ok(!spatialIssues(isolation).some((i) => i.code.startsWith('barrier:')));
  const occlusion = spatialFixture();
  occlusion.layout.data.barriers[0].open = true;
  occlusion.shot.state.instances.push({
    instanceId: 'B',
    entity: { id: 'E', revision: 1 },
    appearance: null,
    pack: null,
  });
  for (const key of ['start', 'end'] as const)
    occlusion.shot.state[key].push({
      instanceId: 'B',
      position: { x: 0.5, y: 0.8 },
      heading: 0,
      phase: '',
      regionId: '',
    });
  assert.ok(
    spatialIssues(prepareShot(occlusion.shot, [occlusion.layout])).some((i) =>
      i.code.startsWith('proxy-occluded:A:B'),
    ),
  );
  for (const key of ['start', 'end'] as const) occlusion.shot.state[key][1].position.x = 0.9;
  assert.ok(
    !spatialIssues(prepareShot(occlusion.shot, [occlusion.layout])).some((i) =>
      i.code.startsWith('proxy-occluded:A:B'),
    ),
  );
  assert.deepEqual(worldPoint({ x: 0.2, y: 0.3, height: 1 }, { width: 10, depth: 20 }), {
    x: 2,
    y: 1,
    z: 6,
  });
  for (const shape of ['box', 'capsule', 'cylinder']) {
    const f = spatialFixture(shape),
      spec = prepareShot(f.shot, [f.layout]);
    assert.equal(sampleShot(spec, 119).instances[0].pose.position.y, 0.2);
    assert.ok(spatialIssues(spec).some((i) => i.code.startsWith('barrier:')));
    const camera = sampleShot(spec, 0).camera!;
    const p = screenPoint({ x: 5, y: 1, z: 5 }, camera, f.layout.data.space, 9 / 16);
    assert.equal(p.x, 0);
    assert.equal(p.y, 0);
    assert.ok(p.depth > 0);
    const edge = { x: 6, y: 1, z: 5 };
    assert.ok(
      Math.abs(screenPoint(edge, camera, f.layout.data.space, 9 / 16).x) >
        Math.abs(screenPoint(edge, camera, f.layout.data.space, 16 / 9).x),
    );
  }
});
test('half-open media selection excludes an event at frame 144 and motion needs matching evidence', () => {
  const events = [{ id: 'close', required: true, inspection: 'motion' }],
    evidence = [
      { eventId: 'close', status: 'pass', inspection: 'motion', startFrame: 144, endFrame: 150 },
    ];
  assert.equal(eventCoverageIssues(events, evidence, 0, 144).length, 1);
  assert.equal(eventCoverageIssues(events, evidence, 0, 151).length, 0);
  assert.equal(
    eventCoverageIssues(events, [{ ...evidence[0], inspection: 'frame' }], 0, 151).length,
    1,
  );
});
test('directed compiler consumes camera intent without a layout, isolates metadata and preserves legacy graph', () => {
  const state = shotStateSchema.parse({
    instances: [{ instanceId: 'A', entity: { id: 'E', revision: 1 } }],
    cameraIntent: 'Keep attention to the same offscreen point.',
  });
  const input: any = {
    templateVersion: 'native-h3-directed-v1',
    width: 576,
    height: 1024,
    steps: 20,
    seed: 1,
    segment: {
      mode: 'ref2va',
      duration: 5,
      guidedPrompt: {
        summary: '[reference generation] One subject moves.',
        detailedDescription: '[Shot 1] {{subject:A}} moves.',
        overallSoundscape: 'Wind.',
        nonDiegeticMusic: 'N/A',
      },
    },
    assets: [
      {
        reference: { assetId: 'img', revision: 1 },
        asset: {
          id: 'img',
          revision: 1,
          data: {
            name: 'image',
            mediaType: 'image',
            adopted: true,
            width: 576,
            height: 1024,
            sha256: 'hash',
          },
        },
      },
    ],
    planning: {
      plan: { data: { guides: [] } },
      selected: [
        {
          id: 'front',
          asset: { id: 'img', revision: 1 },
          instanceIds: ['A'],
          role: 'identity',
          reason: 'Identity',
          retain: ['Preserve shape.'],
          allow: ['pose'],
          inheritBackground: false,
        },
      ],
      instances: state.instances,
      records: [
        {
          id: 'E',
          revision: 1,
          data: {
            description: 'An object',
            instances: [{ id: 'A', name: 'Object' }],
            fixedFeatures: [],
            allowedChanges: [],
          },
        },
      ],
      shots: [
        {
          ...shot(),
          state,
          directing: directingSchema.parse({
            version: 1,
            execution: { action: '{{subject:A}} turns slowly.' },
          }),
        },
      ],
    },
  };
  const files = new Map([['img:1', 'image.png']]);
  const legacy = { ...input, templateVersion: 'native-h3-reference-plan-v2' };
  const before = compileH3(legacy, files, 'job');
  const prepared = prepareDirectedH3(input);
  assert.match(prepared.finalPrompt, /same offscreen point/);
  assert.match(prepared.finalPrompt, /Camera movement: static/);
  assert.ok(prepared.trace.length);
  const changed = structuredClone(input);
  changed.planning.shots[0].directing.camera.motion = 'pan';
  assert.notEqual(prepareDirectedH3(changed).finalPrompt, prepared.finalPrompt);
  assert.deepEqual(compileH3(legacy, files, 'job'), before);
  input.prepared = prepared;
  assert.ok(compileH3(input, files, 'job'));
});
test('reference index searches past loaded page without returning domain bodies', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 55; i++)
    f.store.create('asset', f.project.id, { name: 'asset-' + i, huge: 'x'.repeat(10000) });
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const page = (await (
    await fetch(`${url}/api/projects/${f.project.id}/record-index?kind=asset&q=asset-54`)
  ).json()) as any;
  assert.equal(page.total, 1);
  assert.equal(page.items[0].name, 'asset-54');
  assert.ok(JSON.stringify(page).length < 500);
});

test('previsual media verifies fixed source, is idempotent and never becomes approved on import', async (t) => {
  const f = await fixture(t);
  const layout = f.store.create('layout', f.project.id, {
    name: 'Room',
    space: { width: 10, depth: 10, height: 3 },
    regions: [],
    markers: [],
    barriers: [],
    cameras: [
      {
        id: 'cam',
        position: { x: 0.5, y: 0.9 },
        heading: 0,
        optics: { height: 1.6, pitch: 0, fov: 50 },
      },
    ],
  });
  const ep = f.service.saveEpisode(f.ep.id, f.ep.revision, {
    ...f.ep.data,
    shots: [{ ...shot(), state: shotStateSchema.parse({ layout: ref(layout), cameraId: 'cam' }) }],
    segments: [],
  });
  const prepared = previsManifest(f.store, ep.id, ep.revision, 's1', 0, 128, 128);
  const file = path.join(f.root, 'previs.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=c=gray:s=128x128',
    '-frames:v',
    '1',
    file,
  ]);
  const info = {
    name: 'composition',
    category: 'previsualization',
    previsualSource: prepared.manifest,
  };
  const a = await ingestAsset(f.store, f.root, f.project.id, file, info);
  const b = await ingestAsset(f.store, f.root, f.project.id, file, info);
  assert.equal(a.id, b.id);
  assert.equal(a.data.adopted, false);
  assert.equal(a.data.previsualSource.kind, 'scene_previs');
  assert.equal(a.data.derivedSource, undefined);
  assert.equal(f.store.list('asset', f.project.id).length, 1);
  const forged = structuredClone(info);
  forged.previsualSource.sampled.frame = 3;
  await assert.rejects(() => ingestAsset(f.store, f.root, f.project.id, file, forged), /固定版本/);
});

test('workspace query returns episode labels without loading unrelated episode bodies', async (t) => {
  const f = await fixture(t);
  f.store.create('proposal', f.project.id, { huge: 'x'.repeat(200000) });
  const server = createApp(f.store, f.root).listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  t.after(() => new Promise<void>((r) => server.close(() => r())));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const page: any = await (
    await fetch(`${url}/api/projects/${f.project.id}/records?workspace=layouts&exclude=asset`)
  ).json();
  assert.ok(!page.items.some((d: any) => d.kind === 'proposal'));
  assert.equal(page.items.find((d: any) => d.id === f.ep.id).data.summaryOnly, 1);
  assert.ok(JSON.stringify(page).length < 2000);
});
