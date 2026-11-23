import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CanvasService } from '../src/server/canvas.js';
import { resolveWorkbenchContext, queryContextSources } from '../src/server/workbench-context.js';
import { sendCanvasMessage } from '../src/server/canvas-conversation.js';
import { ModelRegistry } from '../src/server/model-registry.js';
import { configureModel } from './fixtures/models.js';
import { Worker } from '../src/server/worker.js';
import { ProductionAssistant } from '../src/server/production-assistant.js';
import { contextReferenceKey } from '../src/shared/workbench-context.js';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-context-')),
    store = new Store(':memory:');
  t.after(async () => {
    store.db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = new StudioService(store).createProject({
      title: 'context',
      mode: 'short',
      brief: '',
    }),
    service = new CanvasService(store);
  const canvas = service.create(project.id, {
    version: 2,
    title: 'current',
    nodes: [{ id: 'n', type: 'note', title: 'A', text: '正文ABCDE', x: 0, y: 0 }],
    edges: [],
  });
  return { root, store, project, service, canvas };
}
test('CTX-001 fixed cross-canvas context and text selection never merge project identity or follow later edits', async (t) => {
  const f = await fixture(t),
    c = f.service.create(f.project.id, {
      version: 2,
      title: 'other',
      nodes: [{ id: 'n', type: 'note', title: 'B', text: '另一份正文', x: 0, y: 0 }],
      edges: [],
    });
  const refs = [
    {
      kind: 'node',
      canvas: { id: f.canvas.id, revision: f.canvas.revision },
      nodeId: 'n',
      textRange: { start: 2, end: 5, expected: 'ABC' },
    },
    { kind: 'node', canvas: { id: c.id, revision: c.revision }, nodeId: 'n' },
  ];
  const before = resolveWorkbenchContext(f.store, f.project.id, refs);
  f.service.save(c.id, c.revision, { ...c.data, nodes: [{ ...c.data.nodes[0], text: 'later' }] });
  assert.equal(resolveWorkbenchContext(f.store, f.project.id, refs).digest, before.digest);
  assert.deepEqual(
    before.items.map((i) => i.text),
    ['ABC', '另一份正文'],
  );
  const other = new StudioService(f.store).createProject({
    title: 'other project',
    mode: 'short',
    brief: '',
  });
  assert.throws(() => resolveWorkbenchContext(f.store, other.id, refs), /当前作品/);
  assert.equal(f.store.jobs().length, 0);
});
test('CTX-002 output references select exact candidates and enforce real ranges without adopting', async (t) => {
  const f = await fixture(t);
  const a = f.store.create('asset', f.project.id, {
    name: 'video',
    mediaType: 'video',
    duration: 2,
  });
  const job = f.store.createJob('media_process', f.project.id, null, {}, 'context-output');
  const c = f.store.update(f.canvas.id, f.canvas.revision, {
    ...f.canvas.data,
    nodes: [
      {
        ...f.canvas.data.nodes[0],
        outputs: [
          {
            key: 'one',
            jobId: job.id,
            asset: { id: a.id, revision: 1 },
            slot: 'video',
            label: '候选一',
          },
        ],
      },
    ],
  });
  const r = {
    kind: 'output',
    canvas: { id: c.id, revision: c.revision },
    nodeId: 'n',
    outputKey: 'one',
    range: { in: 0.25, out: 1.5 },
  };
  const p = resolveWorkbenchContext(f.store, f.project.id, [r]);
  assert.equal(p.items[0].consumption, 'metadata-needs-analysis');
  assert.equal(p.assets.length, 0);
  assert.equal(p.items[0].media.range.in, 0.25);
  assert.throws(
    () => resolveWorkbenchContext(f.store, f.project.id, [{ ...r, range: { in: 0, out: 3 } }]),
    /区间/,
  );
  assert.throws(
    () => resolveWorkbenchContext(f.store, f.project.id, [{ ...r, outputKey: 'missing' }]),
    /候选/,
  );
  assert.equal(f.store.get(c.id).data.nodes[0].selected, false);
});
test('CTX-003 images are explicit actual Chat inputs; text-only requires metadata choice; replay is one job', async (t) => {
  process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline';
  const f = await fixture(t),
    { connection, selection } = configureModel(f.store, f.project.id, 'chat-completions');
  const registry = new ModelRegistry(f.store),
    enabled = registry.saveConnection(
      {
        revision: connection.revision,
        data: {
          ...connection.data,
          models: connection.data.models.map((m: any) => ({ ...m, imageInput: true })),
        },
      },
      connection.id,
    );
  const vision = { ...selection, connection: { id: enabled.id, revision: enabled.revision } };
  const conf = registry.config(f.project.id)!;
  registry.saveConfig(f.project.id, f.project.id, {
    revision: conf.revision,
    data: { ...conf.data, allowance: { ...conf.data.allowance, connections: [vision.connection] } },
  });
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jC1sAAAAASUVORK5CYII=',
    'base64',
  );
  await fs.writeFile(path.join(f.root, 'i.png'), bytes);
  const a = f.store.create('asset', f.project.id, {
    name: 'image',
    mediaType: 'image',
    path: 'i.png',
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.length,
  });
  const reference = { kind: 'asset', object: { id: a.id, revision: 1 } };
  assert.match(
    resolveWorkbenchContext(
      f.store,
      f.project.id,
      [reference],
      registry.resolveSelection(selection),
    ).issues.join(),
    /图像输入/,
  );
  assert.equal(
    resolveWorkbenchContext(
      f.store,
      f.project.id,
      [{ ...reference, imageHandling: 'metadata' }],
      registry.resolveSelection(selection),
    ).assets.length,
    0,
  );
  const body = {
    version: 2,
    text: '说明实际图片',
    mode: 'discussion',
    references: [reference],
    model: vision,
    idempotencyKey: 'image-context-once',
  };
  const receipt = sendCanvasMessage(f.store, f.root, f.canvas.id, body);
  assert.deepEqual(sendCanvasMessage(f.store, f.root, f.canvas.id, body), receipt);
  let count = 0;
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async (
    _url: any,
    init: any,
  ) => {
    count++;
    const request = JSON.parse(init.body);
    assert.match(request.messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
    return Response.json({
      choices: [
        {
          message: {
            content: request.response_format
              ? JSON.stringify({
                  action: 'finish',
                  reason: '实际图像已传入，本测试不判断图像质量',
                  request: null,
                  requirementId: null,
                })
              : 'offline',
          },
        },
      ],
    });
  }) as any);
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(
    f.store.job(receipt.jobId!).state,
    'succeeded',
    f.store.job(receipt.jobId!).error || '',
  );
  assert.equal(count, 1);
  const assistant = new ProductionAssistant(f.store, f.root);
  const run = assistant.create(f.canvas.id, {
    revision: f.store.get(f.canvas.id).revision,
    goal: '参考固定图片',
    writeScope: 'new',
    nodeIds: [],
    references: [reference],
    models: [vision],
    permissions: ['write'],
    budget: { maxSteps: 2, analysisImages: 1 },
    idempotencyKey: crypto.randomUUID(),
  });
  const step = await assistant.advance(run.id);
  const job = f.store.job(step.data.pendingDecision);
  assert.equal(job.input.assistantCharge.analysisImages, 1);
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  assert.equal(count, 2);
  await assistant.advance(run.id);
  assert.equal((await assistant.advance(run.id)).data.state, 'completed');

  assert.throws(
    () => sendCanvasMessage(f.store, f.root, f.canvas.id, { ...body, text: 'changed' }),
    /回执冲突/,
  );
});
test('CTX-004 source queries paginate metadata, not full media paths or documents', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 35; i++)
    f.store.create('asset', f.project.id, {
      name: 'item ' + i,
      path: 'private',
      mediaType: 'image',
      prompt: 'long private prompt',
    });
  const p = queryContextSources(f.store, f.project.id, { scope: 'assets', limit: 10, offset: 10 });
  assert.equal(p.total, 35);
  assert.equal(p.items.length, 10);
  assert.doesNotMatch(JSON.stringify(p), /private/);
  assert.equal(f.store.jobs().length, 0);
});

test('CTX-005 reference identity is independent of key order and long source pages can be selected without sending the whole document', async (t) => {
  const f = await fixture(t);
  const text = 'x'.repeat(31000) + '可见行动' + 'y'.repeat(6000);
  const d = f.store.create('chapter', f.project.id, { title: 'long', content: text });
  const r: any = { kind: 'document', object: { id: d.id, revision: 1 }, imageHandling: 'image' };
  assert.equal(
    contextReferenceKey(r),
    contextReferenceKey({ object: r.object, kind: 'document', imageHandling: 'image' }),
  );
  assert.throws(() => resolveWorkbenchContext(f.store, f.project.id, [r]), /30000/);
  const page = resolveWorkbenchContext(f.store, f.project.id, [r], undefined, {
    offset: 30000,
    limit: 6000,
  }).items[0];
  assert.equal(page.textOffset, 30000);
  assert.equal(page.textLength, text.length);
  assert.equal(page.text.slice(1000, 1004), '可见行动');
  const selected = { ...r, textRange: { start: 31000, end: 31004, expected: '可见行动' } };
  assert.equal(
    resolveWorkbenchContext(f.store, f.project.id, [selected]).items[0].text,
    '可见行动',
  );
  assert.equal(f.store.jobs().length, 0);
});
