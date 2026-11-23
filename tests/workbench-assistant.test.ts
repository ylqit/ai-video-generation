import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CanvasService } from '../src/server/canvas.js';
import { ProductionAssistant } from '../src/server/production-assistant.js';
import { performAssistantTool } from '../src/server/assistant-tools.js';
import { inspectAssistantWorkspace } from '../src/server/assistant-inspection.js';
import { configureModel } from './fixtures/models.js';
import { sendCanvasMessage } from '../src/server/canvas-conversation.js';
function fixture(t: any, n = 2) {
  const store = new Store(':memory:');
  t.after(() => store.db.close());
  const project = new StudioService(store).createProject({
    title: 'SDD',
    mode: 'short',
    brief: '',
  });
  const service = new CanvasService(store),
    canvas = service.create(project.id, {
      version: 2,
      title: 'work',
      nodes: Array.from({ length: n }, (_, i) => ({
        id: 'n' + i,
        type: 'note',
        title: 'node ' + i,
        text: 'original ' + i,
        x: 0,
        y: 0,
      })),
      edges: [],
    });
  const model = configureModel(store, project.id, 'chat-completions'),
    assistant = new ProductionAssistant(store, '.');
  const create = (extra: any = {}) =>
    assistant.create(canvas.id, {
      revision: store.get(canvas.id).revision,
      goal: '在范围内制作',
      nodeIds: [],
      writeScope: 'new',
      models: [model.selection],
      permissions: ['write', 'edit'],
      budget: { maxSteps: 4 },
      idempotencyKey: crypto.randomUUID(),
      ...extra,
    });
  return { store, project, service, canvas, model, assistant, create };
}
test('AGENT-001 fixed references do not grant mutation rights, including edge replacement and timeline overwrite', (t) => {
  const f = fixture(t),
    run = f.create({
      references: [
        { kind: 'node', canvas: { id: f.canvas.id, revision: f.canvas.revision }, nodeId: 'n0' },
      ],
    });
  assert.equal(run.data.version, 4);
  const call = (action: string, request: any) =>
    performAssistantTool(f.store, '.', run, {
      action,
      request: JSON.stringify(request),
      key: crypto.randomUUID(),
    });
  assert.throws(
    () => call('write', { node: { ...f.canvas.data.nodes[0], text: 'forbidden' } }),
    /授权范围/,
  );
  const added: any = call('write', {
    node: { id: 'new', type: 'note', title: 'new', x: 0, y: 0, text: 'safe' },
  });
  assert.deepEqual(added.createdNodes, ['new']);
  const c = f.store.get(f.canvas.id);
  const edge = { id: 'protected', source: 'n0', target: 'n1', relation: 'organize' };
  f.service.save(c.id, c.revision, { ...c.data, edges: [edge] });
  run.data.createdNodes = ['new'];
  assert.throws(() => call('connect', { edge: { ...edge, target: 'new' } }), /授权范围/);
  assert.equal(f.store.get(f.canvas.id).data.nodes[0].text, 'original 0');
  assert.equal(f.store.jobs().length, 0);
});
test('AGENT-002 safe-point guidance discards stale decisions without resubmitting accepted media; legacy runs stay paused', async (t) => {
  const f = fixture(t);
  let run = f.create({ writeScope: 'canvas' });
  run = await f.assistant.advance(run.id);
  const decision = run.data.pendingDecision;
  run = f.assistant.control(run.id, {
    revision: run.revision,
    action: 'guide',
    message: '先修改开头',
  });
  assert.equal(run.data.state, 'active');
  assert.equal(run.data.pendingDecision, null);
  assert.equal(f.store.job(decision).cancelRequested, true);
  run = await f.assistant.advance(run.id);
  assert.notEqual(run.data.pendingDecision, decision);
  assert.equal(f.store.jobs().length, 2);
  const media = f.store.createJob('media_process', f.project.id, null, {}, 'accepted-original');
  f.store.patchJob(media.id, { state: 'running', promptId: 'accepted' });
  run = f.store.update(run.id, run.revision, {
    ...run.data,
    state: 'waiting_job',
    waiting: { key: 'original', jobs: [media.id] },
    intent: { action: 'write' },
    pendingDecision: null,
  });
  run = f.assistant.control(run.id, {
    revision: run.revision,
    action: 'guide',
    message: '保留当前任务',
  });
  assert.equal(run.data.state, 'waiting_job');
  assert.equal(f.store.job(media.id).cancelRequested, false);
  assert.equal(run.data.intent, null);
  run = f.store.update(run.id, run.revision, { ...run.data, version: 3 });
  run = f.assistant.control(run.id, {
    revision: run.revision,
    action: 'guide',
    message: '旧运行保留原策略',
  });
  assert.equal(run.data.state, 'paused');
});
test('AGENT-003 thousand nodes and long text are paged; methods have real versioned sources; unrelated layout is not a basis change', async (t) => {
  const f = fixture(t, 1000);
  let c = f.store.get(f.canvas.id);
  c = f.service.save(c.id, c.revision, {
    ...c.data,
    nodes: c.data.nodes.map((n: any) => ({ ...n, text: 'x'.repeat(3000) })),
  });
  const run = f.create({ writeScope: 'canvas' }),
    next = await f.assistant.advance(run.id),
    context = f.store.job(next.data.pendingDecision).input.context;
  assert.equal(context.state.nodes.length, 40);
  assert.equal(context.state.nodeCount, 1000);
  assert.ok(JSON.stringify(context).length < 100000);
  const page = inspectAssistantWorkspace(f.store, run, { nodes: true, offset: 950, limit: 20 });
  assert.equal(page.content.nodes[0].id, 'n950');
  assert.equal(page.content.total, 1000);
  const text = inspectAssistantWorkspace(f.store, run, { nodeId: 'n999', offset: 100 });
  assert.equal(text.content.text.length, 2900);
  const method = inspectAssistantWorkspace(f.store, run, { method: 'directing' });
  assert.match(method.method.source, /director.md/);
  assert.equal(method.method.sha256.length, 64);
  assert.ok(method.method.rules.length > 500);
  const catalog = inspectAssistantWorkspace(f.store, run, { catalog: true }).catalog!;
  for (const d of catalog) for (const op of d.operations) assert.ok(op.tool, op.action);
  assert.equal(
    catalog.find((d) => d.type === 'image')!.operations.find((o) => o.action === 'inpaint')!.tool,
    'write',
  );
  assert.equal(
    catalog.find((d) => d.type === 'shot')!.operations.find((o) => o.action === 'bind')!.tool,
    'write',
  );

  const basis = f.assistant.state(run).basis;
  const now = f.store.get(c.id);
  f.service.save(c.id, now.revision, {
    ...now.data,
    nodes: now.data.nodes.map((n: any) => ({ ...n, x: n.x + 10 })),
  });
  assert.equal(f.assistant.state(run).basis, basis);
});
test('AGENT-004 production message receipt covers references and scope, and guide replaces read context without expanding permission', (t) => {
  const f = fixture(t),
    ref = { kind: 'node', canvas: { id: f.canvas.id, revision: f.canvas.revision }, nodeId: 'n0' },
    body = {
      version: 2,
      mode: 'production',
      text: '只新增一个提纲',
      references: [ref],
      model: f.model.selection,
      executionScope: {
        writeScope: 'new',
        nodeIds: [],
        models: [f.model.selection],
        permissions: ['write'],
        budget: { maxSteps: 3 },
      },
      idempotencyKey: crypto.randomUUID(),
    };
  const receipt = sendCanvasMessage(f.store, '.', f.canvas.id, body);
  assert.deepEqual(sendCanvasMessage(f.store, '.', f.canvas.id, body), receipt);
  assert.equal(f.store.list('assistant_run').length, 1);
  assert.throws(
    () => sendCanvasMessage(f.store, '.', f.canvas.id, { ...body, text: 'different' }),
    /冲突/,
  );
  sendCanvasMessage(f.store, '.', f.canvas.id, {
    version: 2,
    mode: 'guide',
    text: '也参考另一段',
    references: [{ ...ref, nodeId: 'n1' }],
    idempotencyKey: crypto.randomUUID(),
  });
  const run = f.store.list('assistant_run')[0];
  assert.equal(run.data.referenceContext.items[0].reference.nodeId, 'n1');
  assert.equal(run.data.writeScope, 'new');
  assert.deepEqual(run.data.nodeIds, []);
});
