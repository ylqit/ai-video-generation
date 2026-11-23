import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CanvasService } from '../src/server/canvas.js';
import { bindNodeReferences } from '../src/server/node-references.js';
import { prepareCanvasGeneration } from '../src/server/canvas-generation.js';
import { ProductionAssistant } from '../src/server/production-assistant.js';
import { performAssistantTool } from '../src/server/assistant-tools.js';
import { configureModel } from './fixtures/models.js';
import { modelCapabilities } from '../src/shared/models.js';
import { generationCompatibility } from '../src/shared/model-parameters.js';
test('GEN-001 fixed reference binding and explicit ordering feed the same preview and Agent submission', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const p = new StudioService(store).createProject({ title: 'GEN', mode: 'short', brief: '' }),
    service = new CanvasService(store);
  const video = configureModel(store, p.id, 'comfy-h3'),
    text = configureModel(store, p.id, 'codex');
  const a = store.create('asset', p.id, {
    name: 'identity',
    mediaType: 'image',
    width: 1024,
    height: 576,
    bytes: 123,
    path: 'image.png',
    sha256: 'fixed',
  });
  let c = service.create(p.id, {
    version: 2,
    title: 'work',
    nodes: [
      {
        id: 'v',
        type: 'video_generate',
        title: 'turn',
        text: 'A student turns and looks at a notebook.',
        x: 0,
        y: 0,
        generation: { model: video.selection, mode: 'ref2va', seconds: 5 },
      },
    ],
    edges: [],
  });
  const request = {
    revision: c.revision,
    references: [{ kind: 'asset', object: { id: a.id, revision: 1 } }],
    purpose: 'identity',
    idempotencyKey: crypto.randomUUID(),
  };
  const bound = bindNodeReferences(store, c.id, 'v', request);
  assert.deepEqual(bindNodeReferences(store, c.id, 'v', request), bound);
  c = service.get(c.id);
  bindNodeReferences(store, c.id, 'v', {
    ...request,
    revision: c.revision,
    purpose: 'first_frame',
    idempotencyKey: crypto.randomUUID(),
  });
  const preview = prepareCanvasGeneration(store, c.id, 'v');
  assert.equal(store.jobs().length, 0);
  assert.equal(preview.input.prepared.inputBindings[0].purpose, 'identity');
  assert.equal(preview.input.prepared.inputBindings[1].purpose, 'first_frame');
  c = service.get(c.id);
  const run = new ProductionAssistant(store, '.').create(c.id, {
    revision: c.revision,
    goal: 'generate one',
    nodeIds: ['v'],
    writeScope: 'selected',
    models: [text.selection, video.selection],
    permissions: ['generate'],
    budget: { maxSteps: 2, videoRequests: 1, videoSeconds: 5 },
    idempotencyKey: crypto.randomUUID(),
  });
  const intent = {
    action: 'generate',
    request: JSON.stringify({ nodeId: 'v' }),
    key: crypto.randomUUID(),
  };
  const result: any = performAssistantTool(store, '.', run, intent);
  assert.equal(
    store.job(result.jobIds[0]).input.prepared.finalPrompt,
    preview.input.prepared.finalPrompt,
  );
  assert.deepEqual(
    store.job(result.jobIds[0]).input.prepared.inputBindings,
    preview.input.prepared.inputBindings,
  );
  assert.equal((performAssistantTool(store, '.', run, intent) as any).jobIds[0], result.jobIds[0]);
});
test('GEN-002 switching protocols reports preserved incompatible parameters rather than silently dropping them', () => {
  const g = {
    mode: 'ref2va',
    seconds: 10,
    model: { parameters: { steps: 20, seed: 123, width: 1024 } },
  };
  const before = JSON.stringify(g);
  const issues = generationCompatibility(g, 'ark-video', modelCapabilities('seedance-2'));
  assert.ok(issues.some((s) => s.includes('steps')));
  assert.ok(issues.some((s) => s.includes('seed')));
  assert.equal(JSON.stringify(g), before);
  assert.equal(generationCompatibility(g, 'comfy-h3', modelCapabilities('h3-comfy')).length, 0);
  assert.ok(
    generationCompatibility(g, 'openai-images', modelCapabilities('image')).some((s) =>
      s.includes('模式'),
    ),
  );
});

test('GEN-003 a selected video range cannot silently submit its full source as a motion reference', (t) => {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const p = new StudioService(store).createProject({ title: 'range', mode: 'short', brief: '' });
  const model = configureModel(store, p.id, 'minimax-video');
  const a = store.create('asset', p.id, {
    name: 'source',
    mediaType: 'video',
    width: 1024,
    height: 576,
    duration: 10,
    bytes: 123,
    path: 'fixed.mp4',
    sha256: 'fixed',
  });
  const service = new CanvasService(store);
  const c = service.create(p.id, {
    version: 2,
    title: 'ranges',
    nodes: [
      {
        id: 'source',
        type: 'video',
        title: 'selected 2–5',
        x: 0,
        y: 0,
        text: '',
        asset: { id: a.id, revision: 1 },
        range: { in: 2, out: 5 },
      },
      {
        id: 'target',
        type: 'video_generate',
        title: 'motion',
        text: 'Continue the movement.',
        x: 400,
        y: 0,
        generation: { model: model.selection, mode: 'ref2va', seconds: 5 },
      },
    ],
    edges: [
      {
        id: 'e',
        source: 'source',
        target: 'target',
        relation: 'input',
        purpose: 'motion',
        sourceHandle: 'video',
        targetHandle: 'references',
        instruction: '',
      },
    ],
  });
  assert.throws(() => prepareCanvasGeneration(store, c.id, 'target'), /先用截取/);
  assert.equal(store.jobs().length, 0);
});
