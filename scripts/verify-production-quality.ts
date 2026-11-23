// Isolated interactive acceptance server. Every generation is a local synthetic response.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { fixture } from '../tests/fixtures/workspace.js';
import { configureModel } from '../tests/fixtures/models.js';
import { createApp } from '../src/server/app.js';
import { config, prepareData } from '../src/server/config.js';
import { runProcess } from '../src/server/media.js';
import { Worker } from '../src/server/worker.js';
import { CreationMediaService } from '../src/server/creation-media.js';

if (!process.argv.includes('--serve'))
  throw new Error('Use --serve for the isolated browser fixture');
const port = Number(process.env.STUDIO_BROWSER_PORT || 4384);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-quality-browser-'));
prepareData(root);
const f = fixture({ after() {} }, true, false, undefined, {
  database: path.join(root, 'studio.sqlite'),
});
for (const job of f.store.jobs()) f.store.patchJob(job.id, { state: 'cancelled' });
f.select();
const imageFile = path.join(root, 'fixture.png'),
  videoFile = path.join(root, 'fixture.mp4');
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
  imageFile,
]);
await runProcess(config.ffmpeg, [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=blue:s=320x240:r=30:d=12',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  videoFile,
]);
const png = await fs.readFile(imageFile);
const mock = express();
mock.use(express.json({ limit: '70mb' }));
const attempts: any[] = [];
mock.get('/models', (_req, res) =>
  res.json({ data: [{ id: 'MiniMax-H3' }, { id: 'offline-model' }] }),
);
mock.get('/v1/models', (_req, res) => res.json({ data: [{ id: 'MiniMax-H3' }] }));
mock.post('/v2/video_generation', (req, res) => {
  const id = 'offline-' + (attempts.length + 1);
  attempts.push({ id, type: 'video', body: req.body });
  res.json({ task_id: id });
});
mock.get('/v2/query/video_generation/:id', (req, res) =>
  res.json({
    task: {
      id: req.params.id,
      model: 'MiniMax-H3',
      status: 'succeeded',
      content: { url: mockUrl + '/media.mp4' },
    },
  }),
);
mock.get('/media.mp4', (_req, res) => res.sendFile(videoFile));
mock.post('/images/generations', (req, res) => {
  attempts.push({ type: 'image', body: req.body });
  res.json({ data: [{ b64_json: png.toString('base64') }], usage: { total_tokens: 1 } });
});
mock.post('/responses', (req, res) => {
  attempts.push({ type: 'text', model: req.body.model });
  res.json({
    model: 'offline-model',
    output_text: JSON.stringify(
      req.body.text?.format?.schema?.properties?.action
        ? {
            action: 'wait',
            reason: '离线模拟：请实际审核候选。',
            requirementId: null,
            request: null,
          }
        : { answer: '离线模拟回复，未调用真实模型。', resultLinks: [] },
    ),
    usage: { total_tokens: 1 },
  });
});
const provider = mock.listen(0, '127.0.0.1');
await new Promise<void>((resolve) => provider.once('listening', resolve));
const mockUrl = `http://127.0.0.1:${(provider.address() as any).port}`;
process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline-no-account';
for (const protocol of ['minimax-video', 'openai-images', 'responses'] as const) {
  const selected = configureModel(f.store, f.project.id, protocol);
  const connection = selected.registry.saveConnection(
    {
      revision: 1,
      data: {
        ...selected.connection.data,
        baseUrl: mockUrl,
        name: protocol + ' · 离线模拟',
        enabled: true,
      },
    },
    selected.connection.id,
  );
  const old = selected.registry.config(f.project.id)!;
  if (connection.data.enabled)
    selected.registry.saveConfig(f.project.id, f.project.id, {
      revision: old.revision,
      data: {
        ...old.data,
        slots: {
          ...old.data.slots,
          [selected.kind]: {
            ...selected.selection,
            connection: { id: connection.id, revision: connection.revision },
          },
        },
        allowance: {
          ...old.data.allowance,
          connections: [
            ...old.data.allowance.connections,
            { id: connection.id, revision: connection.revision },
          ],
        },
      },
    });
}
const task = new CreationMediaService(f.store, root).createAssetTask(f.run.id, {
  revision: f.run.revision,
  requirementId: 'outside',
  maxRevisions: 2,
  idempotencyKey: crypto.randomUUID(),
}).task;
const guardedFetch: typeof fetch = (input, init) => {
  if (!String(input).startsWith(mockUrl + '/'))
    return Promise.reject(new Error('Browser fixture only permits its local mock provider'));
  return fetch(input, init);
};
const worker = new Worker(
  f.store,
  root,
  undefined,
  async () => {
    throw new Error('Real Codex is disabled in browser fixture');
  },
  undefined,
  guardedFetch,
);
const app = createApp(f.store, root);
const server = app.listen(port, '127.0.0.1');
const evidence = path.resolve('../docs/architecture/2026-11-23-studio-production-quality/evidence');
await fs.mkdir(evidence, { recursive: true });
const manifest = {
  isolated: true,
  realModelCalls: 0,
  root,
  projectId: f.project.id,
  runId: f.run.id,
  taskId: task.id,
  url: `http://127.0.0.1:${port}/#project=${f.project.id}`,
  mockUrl,
};
await fs.writeFile(
  path.join(evidence, `BROWSER_FIXTURE_${port}.json`),
  JSON.stringify(manifest, null, 2),
);
console.log(JSON.stringify(manifest));
let ticking = false;
let savedEvidence = '';
async function saveEvidence() {
  const evidenceJson = JSON.stringify(
    {
      ...manifest,
      attempts: attempts.map(({ body, ...rest }) => ({
        ...rest,
        model: rest.model || body?.model,
      })),
      jobs: f.store
        .jobs()
        .filter((j) => j.input.modelExecution)
        .map((j) => ({
          id: j.id,
          kind: j.kind,
          state: j.state,
          error: j.error,
          model: j.input.modelExecution.modelId,
          remote: j.output.remote,
          assets: j.output.assetIds,
        })),
      assets: f.store.list('asset', f.project.id).map((a) => ({
        id: a.id,
        revision: a.revision,
        category: a.data.category,
        adopted: a.data.adopted,
        frameCount: a.data.frameCount,
        frameRate: a.data.frameRate,
        source: a.data.timeBase?.source,
        playbackRate: a.data.timeBase?.playbackRate,
      })),
      bindings: f.creation.get(f.run.id).data.bindings,
    },
    null,
    2,
  );
  if (evidenceJson !== savedEvidence) {
    await fs.writeFile(path.join(evidence, `BROWSER_EXECUTION_${port}.json`), evidenceJson);
    savedEvidence = evidenceJson;
  }
}
const timer = setInterval(async () => {
  if (ticking) return;
  ticking = true;
  try {
    await worker.tick();
    await saveEvidence();
  } catch (e) {
    console.error(e);
  } finally {
    ticking = false;
  }
}, 500);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, async () => {
    clearInterval(timer);
    worker.stop();
    await saveEvidence();
    server.close();
    provider.close();
    f.store.close();
    process.exit(0);
  });
