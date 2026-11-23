// Explicit isolated browser fixture. Every model operation is intercepted locally;
// the normal API, durable Worker, archive and FFmpeg export remain real.
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/server/db.js';
import { createApp } from '../src/server/app.js';
import { StudioService } from '../src/server/service.js';
import { ModelRegistry } from '../src/server/model-registry.js';
import { Worker } from '../src/server/worker.js';
import { ComfyClient } from '../src/server/comfy.js';
import { config, prepareData } from '../src/server/config.js';
import { runProcess } from '../src/server/media.js';
import type { Job } from '../src/shared/contracts.js';

process.env.STUDIO_DEMO_KEY = 'offline-no-provider';
const root = path.resolve(process.argv[2] || '.artifacts/node-workbench-demo-' + Date.now());
if (
  !root.startsWith(path.resolve('.artifacts') + path.sep) ||
  !path.basename(root).startsWith('node-workbench-demo-')
)
  throw new Error('Demo can only use its isolated artifact directories');
prepareData(root);
const store = new Store(path.join(root, 'studio.sqlite'));
store.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9', instanceId: 'isolated-mock' });
const sample = path.join(root, 'synthetic.mp4');
if (!(await fs.stat(sample).catch(() => null)))
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '5',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    sample,
  ]);
const sampleImage = path.join(root, 'synthetic.png');
if (!(await fs.stat(sampleImage).catch(() => null)))
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    sample,
    '-frames:v',
    '1',
    sampleImage,
  ]);
const registry = new ModelRegistry(store);
const models = ['codex', 'comfy-h3', 'chat-completions', 'openai-images', 'ark-video'].map(
  (protocol) => {
    const c =
      registry.connections().find((c) => c.data.capacityGroup === 'demo-' + protocol) ||
      registry.saveConnection({
        revision: 0,
        data: {
          name: '隔离模拟 · ' + protocol,
          protocol,
          baseUrl: 'http://127.0.0.1:9',
          enabled: true,
          compatible: true,
          credential: protocol !== 'comfy-h3' ? { kind: 'env', key: 'STUDIO_DEMO_KEY' } : null,
          capacityGroup: 'demo-' + protocol,
          concurrency: 1,
          ...(protocol === 'comfy-h3' ? { instanceId: 'isolated-mock' } : {}),
          models: [
            {
              id: protocol === 'comfy-h3' ? 'MiniMax-H3' : 'mock-text',
              name:
                protocol === 'comfy-h3'
                  ? 'H3 协议模拟'
                  : protocol === 'ark-video'
                    ? 'Seedance 协议模拟'
                    : protocol === 'openai-images'
                      ? 'Images 协议模拟'
                      : '文字协议模拟',
              preset:
                protocol === 'comfy-h3'
                  ? 'h3-comfy'
                  : protocol === 'ark-video'
                    ? 'seedance-2'
                    : protocol === 'openai-images'
                      ? 'image'
                      : 'text',
              ...(protocol === 'chat-completions' ? { imageInput: true } : {}),
            },
          ],
        },
      });
    return {
      connection: { id: c.id, revision: c.revision },
      modelId: c.data.models[0].id,
      mode: 'authored',
      promptProfile: 'automatic',
      parameters: {},
    };
  },
);
if (!store.list('project').length)
  new StudioService(store).createProject({
    title: '隔离演练 · 自由创作',
    mode: 'short',
    brief: '本作品仅使用模拟模型与合成媒体',
  });
function configure() {
  for (const p of store.list('project'))
    if (!registry.config(p.id))
      registry.saveConfig(p.id, p.id, {
        revision: 0,
        data: {
          version: 1,
          slots: { text: models[0], video: models[1], image: models[3] },
          allowance: {
            enabled: true,
            connections: models.map((m) => m.connection),
            maxTextRequests: 100,
            maxVideoRequests: 10,
            maxVideoSeconds: 100,
            maxImageRequests: 20,
            maxImages: 20,
          },
        },
      });
}
configure();
class LocalComfy extends ComfyClient {
  history: Record<string, any> = {};
  override async validate() {}
  override async upload(_file: string, name: string) {
    return name;
  }
  override async submit(graph: any, job: Job) {
    const id = 'mock-' + job.id;
    this.history[id] = {
      prompt: [0, id, graph, { studio: { job_id: job.id, instance_id: 'isolated-mock' } }],
      status: { completed: true, status_str: 'success' },
      outputs: { save: { videos: [{ filename: 'synthetic.mp4', type: 'output' }] } },
    };
    return id;
  }
  override async json(url: string) {
    return url === '/queue' ? { queue_running: [], queue_pending: [] } : this.history;
  }
  override async request(url: string) {
    if (!url.startsWith('/view?')) throw new Error('Mock forbids external transport');
    return new Response(await fs.readFile(sample));
  }
  override watch() {
    return { close() {} } as any;
  }
}
const cloud = new LocalComfy('http://127.0.0.1:9');
const worker = new Worker(
  store,
  root,
  () => cloud,
  async (context) => {
    if (context.mode === 'discussion') return { answer: 'Studio 已读取固定原文（隔离模拟）' };
    if (context.mode !== 'assistant') throw new Error('此模拟只执行画布助手');
    const nodes = context.state.nodes,
      request = (action: string, data: any, reason: string) => ({
        action,
        request: data === null ? null : JSON.stringify(data),
        reason,
        requirementId: null,
      });
    if (!nodes.some((n: any) => n.type === 'document'))
      return request(
        'write',
        {
          node: {
            id: 'demo-script',
            type: 'document',
            title: '校园模型展 · 剧本草稿',
            x: 30,
            y: 40,
            text: '小岚发现模型桥的一处缺口。她停下，伸手指向破损的位置，邀请同伴一起修复。此处为模拟剧本，画面使用合成测试图。',
          },
        },
        '建立可编辑文档',
      );
    if (!nodes.some((n: any) => n.type === 'video_generate'))
      return request(
        'write',
        {
          node: {
            id: 'demo-shot',
            type: 'video_generate',
            title: '镜头 01 · 发现缺口',
            x: 350,
            y: 40,
            text: 'A student stops at a model bridge and points at the broken edge. Static medium shot.',
            generation: { model: models[1], mode: 't2v', seconds: 5 },
          },
        },
        '建立视频制作节点',
      );
    const generated = nodes.find((n: any) => n.outputs?.some((o: any) => o.asset));
    if (generated && !generated.asset)
      return request(
        'write',
        {
          node: {
            ...store.get(context.canvasId).data.nodes.find((n: any) => n.id === generated.id),
            asset: generated.outputs.find((o: any) => o.asset).asset,
          },
        },
        '选用真实归档输出',
      );
    const made = nodes.find((n: any) => n.type === 'video_generate' && n.asset);
    if (!made)
      return request('generate', { nodeId: 'demo-shot' }, '在本次授权内提交一次模拟视频请求');
    if (!made.selected)
      return request('select', { nodeId: made.id }, '选用实际归档结果；不声明质量通过');
    if (!context.state.edl)
      return request(
        'timeline',
        {
          edl: {
            schemaVersion: 3,
            episodeId: context.state.episodeId || '',
            width: 640,
            height: 360,
            fps: 24,
            clips: [
              {
                id: 'demo-clip',
                assetId: made.asset.id,
                revision: made.asset.revision,
                in: 0,
                out: 5,
                volume: 1,
              },
            ],
            audio: [],
            overlays: [],
          },
        },
        '将实际片段加入剪辑',
      );
    if (!context.state.receipts.some((r: any) => r.action === 'export'))
      return request('export', null, '从真实时间线导出本机 MP4');
    return request('finish', null, '已生成合成候选并导出；未做画质或听审判断');
  },
  undefined,
  async (url: any, init: any) => {
    if (String(url).includes('/images/generations') || String(url).includes('/images/edits'))
      return Response.json({
        data: [{ b64_json: (await fs.readFile(sampleImage)).toString('base64') }],
      });
    if (String(url).includes('/chat/completions'))
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content:
                  '[离线模拟结果] 已读取明确提供的文字与采样图片。本结果仅用于验证操作链路。',
              },
            },
          ],
        }),
      );
    throw new Error('隔离演练禁止外部供应商网络请求');
  },
);
const app = createApp(store, root),
  server = app.listen(Number(process.env.STUDIO_TEST_API_PORT || 4393), '127.0.0.1', () =>
    console.log(
      JSON.stringify({ url: 'http://127.0.0.1:4393', root, models: 'all mocked', paidRequests: 0 }),
    ),
  );
let active = false;
const timer = setInterval(async () => {
  if (active) return;
  active = true;
  try {
    configure();
    await worker.tick();
  } catch (e) {
    console.error(e);
  } finally {
    active = false;
  }
}, 500);
process.on('SIGINT', async () => {
  clearInterval(timer);
  worker.stop();
  await worker.drain();
  server.close();
  store.db.close();
  process.exit(0);
});
