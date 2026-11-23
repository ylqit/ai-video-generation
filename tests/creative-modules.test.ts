import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import { creativeCatalog } from '../src/server/creative-catalog.js';
import { resolveCreativeBrief } from '../src/server/creative-brief.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { compileH3 } from '../src/server/comfy.js';
import { prepareModularH3 } from '../src/server/modular-h3.js';
import { creationProfileSchema } from '../src/shared/workbench.js';
import { directingSchema } from '../src/shared/directing.js';
import { shotStateSchema } from '../src/shared/domain.js';
import { ReadinessService } from '../src/server/readiness.js';
import { createApp } from '../src/server/app.js';

const ref = (d: any) => ({ id: d.id, revision: d.revision });
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-module-'));
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store),
    domain = new DomainService(store);
  const project = service.createProject({ title: 'Module fixture', mode: 'short', brief: '' });
  const modules = ['modern-anime', 'science-fiction', 'relationship', 'intimate'].map((key) => {
    const doc = domain.save(
      project.id,
      'creative_module',
      creativeCatalog.find((m) => m.key === key)!.data,
    );
    return domain.publish(doc.id, doc.revision, {
      inspected: true,
      conclusion: 'offline rules fixture; no media inspected',
    });
  });
  let profile = domain.save(project.id, 'creation_profile', {
    name: 'Fixture',
    rulesVersion: 'director-v5',
    composition: {
      moduleRefs: modules.map(ref),
      artBible: {
        characters: 'Adult proportions.',
        environments: 'A coherent workshop.',
        props: 'One badge.',
        effects: 'No unmotivated glow.',
      },
    },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'offline fixture',
  });
  t.after(async () => {
    store.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'studio-module-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, store, service, domain, project, modules, profile };
}

test('module catalog separates media from world and optional duration does not silently become 60 seconds', async (t) => {
  const f = await fixture(t);
  assert.equal(creativeCatalog.filter((m) => m.data.category === 'visual').length, 5);
  assert.equal(creativeCatalog.filter((m) => m.data.category === 'world').length, 4);
  assert.equal(f.profile.data.targetSeconds, undefined);
  assert.throws(() => creationProfileSchema.parse({ name: 'legacy' }));
  assert.throws(() =>
    creationProfileSchema.parse({ name: 'broken v2', rulesVersion: 'director-v5' }),
  );
  const brief = resolveCreativeBrief(f.store, f.project.id, f.profile, {}, true);
  assert.ok(
    brief.modules.find((m) => m.data.category === 'world')!.data.stageRules.episode_script.length,
  );
  assert.equal(brief.checks.length, 0);
});

test('module conflicts and unreviewed versions block publication; intentional mixed layers are explicit', async (t) => {
  const f = await fixture(t);
  let extra = f.domain.save(
    f.project.id,
    'creative_module',
    creativeCatalog.find((m) => m.key === 'film-cg')!.data,
  );
  let p = f.domain.save(f.project.id, 'creation_profile', {
    ...f.profile.data,
    composition: { ...f.profile.data.composition, moduleRefs: [...f.modules.map(ref), ref(extra)] },
  });
  p = f.domain.publish(p.id, p.revision, { inspected: false, conclusion: '' });
  extra = f.domain.publish(extra.id, extra.revision, { inspected: true, conclusion: 'test' });
  p = f.domain.save(
    f.project.id,
    'creation_profile',
    {
      ...p.data,
      composition: {
        ...p.data.composition,
        moduleRefs: [...f.modules.map(ref), ref(extra)],
        overrides: {
          mixedMedia:
            '2D characters over a CG environment; match light direction and graphic contrast.',
        },
      },
    },
    p.id,
    p.revision,
  );
  assert.doesNotThrow(() =>
    f.domain.publish(p.id, p.revision, { inspected: true, conclusion: 'intentional mixed layers' }),
  );
});

test('library copies modules and profile independently and resets publication; optional versions preserve frozen brief', async (t) => {
  const f = await fixture(t);
  const before = resolveCreativeBrief(f.store, f.project.id, f.profile);
  const lib = f.domain.publishLibrary(f.project.id, [ref(f.profile)], 'Modular profile');
  const p2 = f.service.createProject({ title: 'Other', mode: 'short', brief: '' });
  const copied = f.domain.copyLibrary(p2.id, lib.id, lib.revision);
  const records = f.store.list('creative_module', p2.id);
  assert.equal(records.length, 4);
  assert.ok(records.every((m) => !m.data.published));
  f.domain.save(
    p2.id,
    'creative_module',
    { ...records[0].data, name: 'Edited' },
    records[0].id,
    records[0].revision,
  );
  assert.equal(f.store.get(f.modules[0].id).data.name, f.modules[0].data.name);
  f.domain.save(
    f.project.id,
    'creative_module',
    { ...f.modules[0].data, name: 'Optional new version' },
    f.modules[0].id,
    f.modules[0].revision,
  );
  assert.equal(resolveCreativeBrief(f.store, f.project.id, f.profile).digest, before.digest);
  assert.ok(copied);
});

test('Base V2 has three sections and versioned first/last files; module changes stale previews without changing old frozen graph', async (t) => {
  const f = await fixture(t);
  let ep = f.service.createEpisode(f.project.id, { title: 'Base clip' });
  const actor = f.domain.save(f.project.id, 'entity', {
    type: 'character',
    name: 'Adult',
    instances: [{ id: 'Adult', name: 'Adult' }],
  });
  const img = f.store.create('asset', f.project.id, {
    name: 'frame',
    mediaType: 'image',
    adopted: true,
    width: 1024,
    height: 576,
    sha256: 'a',
  });
  const newer = f.store.update(img.id, img.revision, { ...img.data, sha256: 'b' });
  ep = f.service.saveEpisode(ep.id, ep.revision, {
    ...ep.data,
    shots: [
      {
        id: 'one',
        scene: 'room',
        duration: 5,
        description: 'Badge action',
        state: shotStateSchema.parse({ instances: [{ instanceId: 'Adult', entity: ref(actor) }] }),
        dialogue: '',
        continuity: '',
        directing: directingSchema.parse({
          version: 1,
          execution: { action: 'The adult picks up the single badge and looks toward the door.' },
          sound: {
            environment: 'Room tone.',
            dialogue: [
              { instanceId: 'Adult', language: 'zh', text: '找到了。', delivery: 'offscreen' },
            ],
          },
        }),
      },
    ],
    segments: [
      {
        id: 'g',
        shotIds: ['one'],
        mode: 'i2v',
        prompt: 'author intent',
        duration: 5,
        executionVersion: 'native-h3-base-v2',
        references: [
          { assetId: img.id, revision: 1, role: 'first_frame' },
          { assetId: img.id, revision: 2, role: 'last_frame' },
        ],
      },
    ],
  });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const req = {
    episodeId: ep.id,
    episodeRevision: ep.revision,
    segmentId: 'g',
    width: 1024,
    height: 576,
    steps: 20,
    seed: 5,
  };
  const cloud = { baseUrl: 'http://127.0.0.1:9999', instanceId: 'fixture' };
  const before = f.service.prepareGeneration(req, cloud);
  const files = new Map([
    [`${img.id}:1`, 'first.png'],
    [`${img.id}:2`, 'last.png'],
  ]);
  const graph = compileH3(before.input, files, 'test');
  assert.equal(Object.values(graph).filter((n) => n.class_type === 'LoadImage').length, 2);
  assert.match(before.input.prepared.finalPrompt, /offscreen/);
  assert.doesNotMatch(
    before.input.prepared.finalPrompt,
    /subject_definitions:|retention_analysis:|summary:/,
  );
  assert.match(before.input.prepared.finalPrompt, /Two or three deliberate cel-shaded values/);
  f.domain.save(
    f.project.id,
    'creation_profile',
    {
      ...f.profile.data,
      composition: {
        ...f.profile.data.composition,
        overrides: { visual: 'Deliberate pencil drawing.' },
      },
    },
    f.profile.id,
    f.profile.revision,
  );
  assert.doesNotThrow(() => f.service.prepareGeneration(req, cloud));
  assert.deepEqual(compileH3(before.input, files, 'test'), graph);
  assert.equal(newer.revision, 2);
});

test('Ref V2 preserves guide conditioning and instance mapping while excluding business metadata', async (t) => {
  const f = await fixture(t);
  const state = shotStateSchema.parse({
    instances: [
      { instanceId: 'a', entity: { id: 'e', revision: 1 } },
      { instanceId: 'b', entity: { id: 'e', revision: 1 } },
    ],
  });
  const input: any = {
    templateVersion: 'native-h3-directed-v2',
    width: 1024,
    height: 576,
    steps: 20,
    seed: 1,
    creativeBrief: resolveCreativeBrief(f.store, f.project.id, f.profile, {}, true),
    segment: {
      mode: 'ref2va',
      duration: 5,
      guidedPrompt: {
        summary: '[reference generation] Two separate products.',
        detailedDescription: '[Shot 1] {{subject:a}} beside {{subject:b}}',
        overallSoundscape: 'Room.',
        nonDiegeticMusic: 'N/A',
      },
    },
    assets: [
      {
        reference: { assetId: 'img', revision: 1 },
        asset: {
          id: 'img',
          revision: 1,
          data: { width: 1024, height: 576, mediaType: 'image', adopted: true, sha256: 'x' },
        },
      },
    ],
    planning: {
      plan: {
        data: {
          guides: [{ bindingId: 'both', frameIndex: 0, instruction: 'Initial composition.' }],
        },
      },
      selected: [
        {
          id: 'both',
          asset: { id: 'img', revision: 1 },
          instanceIds: ['a', 'b'],
          role: 'identity',
          reason: 'two items',
          retain: ['distinct shapes'],
          allow: ['rotation'],
          inheritBackground: false,
        },
      ],
      instances: state.instances,
      records: [
        {
          id: 'e',
          revision: 1,
          kind: 'entity',
          data: {
            instances: [
              { id: 'a', name: 'first' },
              { id: 'b', name: 'second' },
            ],
            fixedFeatures: ['stable dimensions'],
            features: { secret: '待审核 JSON' },
          },
        },
      ],
      shots: [
        {
          id: 'one',
          scene: 'table',
          duration: 5,
          state,
          directing: directingSchema.parse({
            version: 1,
            execution: { action: '{{subject:a}} rotates while {{subject:b}} remains still.' },
          }),
        },
      ],
    },
  };
  input.prepared = prepareModularH3(input);
  const graph = compileH3(input, new Map([['img:1', 'both.png']]), 'ref-test');
  const guide = Object.entries(graph).find(([, n]) => n.class_type === 'MiniMaxH3AddGuide')!;
  assert.deepEqual(guide[1].inputs.latent, ['condition', 1]);
  assert.deepEqual(graph.guider.inputs.conditioning, [guide[0], 0]);
  assert.deepEqual(graph.sample.inputs.latent_image, ['condition', 1]);
  assert.equal(input.prepared.subjects.length, 2);
  assert.doesNotMatch(input.prepared.finalPrompt, /待审核|secret/);
  assert.match(input.prepared.finalPrompt, /<Subject 1>/);
  assert.match(input.prepared.finalPrompt, /<Subject 2>/);
});

test('scene exceptions follow stable scene IDs and only affect the selected scene; ambiguous aliases fail visibly', async (t) => {
  const f = await fixture(t);
  let ep = f.service.createEpisode(f.project.id, { title: 'Two locations' });
  ep = f.store.update(ep.id, ep.revision, {
    ...ep.data,
    shots: [
      { id: 's1', scene: 'Workshop' },
      { id: 's2', scene: 'Street' },
    ],
    dramaturgy: {
      scenes: [
        { id: 'scene-workshop', shotIds: ['s1'] },
        { id: 'scene-street', shotIds: ['s2'] },
      ],
    },
  });
  const p = f.domain.save(
    f.project.id,
    'creation_profile',
    {
      ...f.profile.data,
      composition: {
        ...f.profile.data.composition,
        exceptions: [
          {
            scope: { episodeId: ep.id, sceneId: 'scene-workshop' },
            reason: 'Flashback layer',
            overrides: { visual: 'Graphite line and restrained grayscale.' },
          },
        ],
      },
    },
    f.profile.id,
    f.profile.revision,
  );
  assert.equal(
    resolveCreativeBrief(f.store, f.project.id, p, { episodeId: ep.id, sceneId: 'Workshop' })
      .overrides.visual,
    'Graphite line and restrained grayscale.',
  );
  assert.equal(
    resolveCreativeBrief(f.store, f.project.id, p, { episodeId: ep.id, sceneId: 'Street' })
      .overrides.visual,
    '',
  );
  const conflicts = {
    ...p,
    data: {
      ...p.data,
      composition: {
        ...p.data.composition,
        exceptions: [
          ...p.data.composition.exceptions,
          {
            scope: { episodeId: ep.id, sceneId: 'Workshop' },
            reason: 'Different instruction for same scene',
            overrides: { visual: 'Full color.' },
          },
        ],
      },
    },
  };
  assert.throws(
    () =>
      resolveCreativeBrief(f.store, f.project.id, conflicts, {
        episodeId: ep.id,
        sceneId: 'Workshop',
      }),
    /同范围例外冲突/,
  );
  f.store.update(ep.id, ep.revision, {
    ...ep.data,
    shots: [
      { id: 's1', scene: 'Workshop' },
      { id: 's2', scene: 'Workshop' },
    ],
  });
  assert.throws(
    () => resolveCreativeBrief(f.store, f.project.id, p, { episodeId: ep.id, sceneId: 'Workshop' }),
    /多个稳定 ID/,
  );
});

test('workbench surfaces composition approval before any episode exists', async (t) => {
  const f = await fixture(t);
  f.domain.save(
    f.project.id,
    'creation_profile',
    { ...f.profile.data, name: 'Changed draft' },
    f.profile.id,
    f.profile.revision,
  );
  const readiness = new ReadinessService(f.store).project(f.project.id);
  assert.ok(
    !readiness.issues.some((i) => i.code === 'profile-unpublished' && i.severity === 'blocking'),
  );
});

test('ordinary series edits retain the story blueprint and validate replacements without partial versions', async (t) => {
  const f = await fixture(t);
  const original = f.store.list('series', f.project.id)[0];
  const blueprint = {
    centralQuestion: 'Save a partner?',
    endingDirection: 'Partner safe; robot unpowered.',
    characterChanges: [],
    relationships: ['A costly act builds trust.'],
    setups: [],
  };
  const series = f.store.update(original.id, original.revision, {
    ...original.data,
    storyBlueprint: blueprint,
  });
  const app = createApp(f.store, f.root);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  try {
    const url = `http://127.0.0.1:${(server.address() as any).port}/api/records/${series.id}`;
    const response = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: series.revision,
        data: { title: 'New title', bible: { world: 'Workshop' }, approved: true },
      }),
    });
    assert.equal(response.status, 200);
    const saved: any = await response.json();
    assert.deepEqual(saved.data.storyBlueprint, blueprint);
    const invalid = await fetch(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        revision: saved.revision,
        data: { storyBlueprint: { ...blueprint, centralQuestion: '' } },
      }),
    });
    assert.equal(invalid.status, 400);
    assert.equal(f.store.get(series.id).revision, saved.revision);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
