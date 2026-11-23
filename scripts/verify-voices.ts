// Isolated browser fixture: every provider request is intercepted in process.
// Synthetic audio and color video exercise plumbing, not perceptual quality.
import fs from 'node:fs/promises';
import path from 'node:path';
import { voiceFixture, providerMock } from '../tests/fixtures/speech.js';
import { Worker } from '../src/server/worker.js';
import { DomainService } from '../src/server/domain-service.js';
import { prepareSpeech, submitSpeech } from '../src/server/speech-production.js';
import { saveSpeechAllowance } from '../src/server/speech-usage.js';
import { saveDialogueTake } from '../src/server/voices.js';
import { config } from '../src/server/config.js';
import { ingestAsset, runProcess } from '../src/server/media.js';
import { createApp } from '../src/server/app.js';
const f = await voiceFixture({ after() {} }, 'minimax-speech');
const { store, root, library, registry, project } = f;
store.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9', instanceId: 'offline-only' });
const source = path.join(root, 'source.mp4');
await runProcess(config.ffmpeg, [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=blue:s=320x240:r=24:d=2',
  '-f',
  'lavfi',
  '-i',
  'anullsrc=r=24000:cl=mono',
  '-t',
  '2',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  '-c:a',
  'aac',
  source,
]);
const video = await ingestAsset(store, root, project.id, source, {
  name: '合成色卡视频（无人物）',
  category: 'video',
});
const mock = providerMock('minimax-speech', f.audio);
const lipRequests: any[] = [];
const guarded: typeof fetch = async (url, init = {}) => {
  const u = new URL(String(url));
  if (u.host !== 'mock.invalid') throw new Error('离线验收禁止访问真实供应商：' + u.host);
  if (u.pathname === '/v2/models') return Response.json([{ id: 'sync-3' }]);
  if (u.pathname === '/v2/generate') {
    lipRequests.push({ path: u.pathname, method: init.method });
    return Response.json({ id: 'fixture-sync-' + lipRequests.length, status: 'PENDING' });
  }
  if (u.pathname.startsWith('/v2/generate/'))
    return Response.json({
      id: u.pathname.split('/').at(-1),
      status: 'COMPLETED',
      outputUrl: 'https://mock.invalid/video.mp4',
    });
  if (u.pathname === '/video.mp4') return new Response(new Uint8Array(await fs.readFile(source)));
  return mock.request(url, init);
};
globalThis.fetch = guarded;
const worker = new Worker(
  store,
  root,
  undefined,
  async () => {
    throw new Error('离线验收不执行 Codex');
  },
  undefined,
  guarded,
);
let voice = library.register(f.voice.id, f.voice.revision, {
  connection: f.selection.connection,
  modelId: f.selection.modelId,
  voiceId: 'OfflineVoice01',
  providerStatus: 'fixture',
});
async function synthesize(owner: string | null, request: any) {
  const p = prepareSpeech(store, owner, 'speech', request),
    j = submitSpeech(store, owner, 'speech', {
      request,
      digest: p.digest,
      idempotencyKey: crypto.randomUUID(),
      approved: true,
    });
  await worker.tick();
  return store.job(j.id);
}
const audition = await synthesize(null, {
  voice: { id: voice.id, revision: voice.revision },
  selection: f.selection,
  text: '测试夹具',
});
voice = library.confirm(voice.id, voice.revision, {
  audition: audition.output.libraryMedia,
  listened: true,
  notes: '仅离线合成夹具，非真实音色确认',
});
const entity = store.create('entity', project.id, {
  name: '小岚',
  instances: [{ id: 'actor', name: '小岚' }],
});
const domain = new DomainService(store);
let profile = domain.save(project.id, 'voice_profile', {
  version: 2,
  name: '小岚（离线）',
  entity: { id: entity.id, revision: entity.revision },
  globalVoice: { id: voice.id, revision: voice.revision },
  language: 'zh',
  timbre: '合成测试',
  route: 'tts',
  requireVoiceIdentity: true,
});
profile = domain.publish(profile.id, profile.revision, {
  inspected: true,
  conclusion: '离线角色绑定夹具',
});
const ep = store.create('episode', project.id, {
  title: '第 1 集（离线）',
  approved: true,
  shots: [
    {
      id: 's1',
      directing: {
        contractRevision: 2,
        sound: {
          dialogue: [
            {
              id: 'line',
              text: '现在开始。',
              instanceId: 'actor',
              voiceProfile: { id: profile.id, revision: profile.revision },
              production: 'tts',
              delivery: 'onscreen',
            },
          ],
        },
      },
    },
  ],
  segments: [{ id: 'g1', shotIds: ['s1'] }],
});
const line = {
  episode: { id: ep.id, revision: ep.revision },
  shotId: 's1',
  lineId: 'line',
  instanceId: 'actor',
  voiceProfile: { id: profile.id, revision: profile.revision },
};
const speech = await synthesize(project.id, {
  voice: { id: voice.id, revision: voice.revision },
  selection: f.selection,
  text: '现在开始。',
  line,
});
let asset = store.get(speech.output.assetIds[0]);
asset = store.update(asset.id, asset.revision, { ...asset.data, adopted: true });
const take = saveDialogueTake(store, project.id, {
  version: 1,
  ...line,
  voice: line.voiceProfile,
  voiceProfile: undefined,
  asset: { id: asset.id, revision: asset.revision },
  in: 0,
  out: 1,
  sampleRange: { sampleRate: 24000, inSample: 0, outSample: 24000 },
  source: 'tts',
  synthesisJobId: speech.id,
  actualText: '现在开始。',
  listened: true,
  voiceMatch: true,
  conclusion: '合成夹具，不是实际对白评价',
});
const sync = registry.saveConnection({
  revision: 0,
  data: {
    name: '离线 Sync',
    protocol: 'sync-lipsync',
    baseUrl: 'https://mock.invalid',
    compatible: true,
    enabled: true,
    credential: { kind: 'env', key: 'STUDIO_OFFLINE_VOICE' },
    capacityGroup: 'sync-offline',
    concurrency: 1,
    models: [{ id: 'sync-3', name: 'Sync 3（模拟）', preset: 'sync-lipsync' }],
  },
});
const allowance = store.setting<any>('speech_allowance:project:' + project.id, {});
saveSpeechAllowance(store, project.id, {
  revision: allowance.revision,
  data: {
    ...allowance.data,
    connections: [...allowance.data.connections, { id: sync.id, revision: sync.revision }],
  },
});
const port = Number(process.env.STUDIO_VOICE_VERIFY_PORT || 4387);
const server = createApp(store, root).listen(port, '127.0.0.1');
const evidence = path.resolve('../docs/architecture/2026-11-23-voice-production/evidence');
await fs.mkdir(evidence, { recursive: true });
const manifest = {
  isolated: true,
  realModelCalls: 0,
  url: `http://127.0.0.1:${port}`,
  root,
  projectId: project.id,
  episodeId: ep.id,
  voiceId: voice.id,
  video: { id: video.id, revision: video.revision },
  take: { id: take.id, revision: take.revision },
  sampleFile: path.join(root, 'sample.wav'),
};
console.log(JSON.stringify(manifest));
await fs.writeFile(
  path.join(evidence, `BROWSER_FIXTURE_${port}.json`),
  JSON.stringify(manifest, null, 2),
);
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await worker.tick();
    await fs.writeFile(
      path.join(evidence, `BROWSER_STATE_${port}.json`),
      JSON.stringify(
        {
          ...manifest,
          mockedRequests: mock.calls.length + lipRequests.length,
          jobs: store.jobs().map((j) => ({
            id: j.id,
            kind: j.kind,
            projectId: j.projectId,
            state: j.state,
            error: j.error,
          })),
          voices: library.list({ offset: 0, limit: 100 }).items.map((v) => ({
            id: v.id,
            revision: v.revision,
            name: v.data.name,
            state: v.data.state,
          })),
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(e);
  } finally {
    running = false;
  }
}, 700);
function stop() {
  clearInterval(timer);
  worker.stop();
  server.close();
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
