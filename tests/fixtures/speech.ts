import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../../src/server/db.js';
import { ModelRegistry } from '../../src/server/model-registry.js';
import { VoiceLibrary } from '../../src/server/voice-library.js';
import { saveSpeechAllowance } from '../../src/server/speech-usage.js';
import { config, prepareData } from '../../src/server/config.js';
import { runProcess } from '../../src/server/media.js';

export function wav(seconds = 1) {
  const samples = Math.round(24000 * seconds),
    b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(24000, 24);
  b.writeUInt32LE(48000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    b.writeInt16LE(Math.round(2000 * Math.sin((i * 2 * Math.PI * 220) / 24000)), 44 + 2 * i);
  return b;
}
export async function voiceFixture(t: any, protocol = 'minimax-speech') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-voice-'));
  prepareData(root);
  const store = new Store(path.join(root, 'studio.sqlite'));
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  process.env.STUDIO_OFFLINE_VOICE = 'offline-only';
  process.env.STUDIO_OFFLINE_SIGN_ID = 'offline-id';
  const registry = new ModelRegistry(store),
    library = new VoiceLibrary(store),
    modelId = (
      {
        'minimax-speech': 'speech-2.8-hd',
        cosyvoice: 'cosyvoice-v3-plus',
        'doubao-speech': 'seed-tts-2.0-standard',
        'baidu-speech': 'voice-clone',
        'tencent-speech': 'YTLX_V2',
        'sync-lipsync': 'sync-3',
      } as any
    )[protocol];
  const connection = registry.saveConnection({
    revision: 0,
    data: {
      name: protocol,
      protocol,
      baseUrl: 'https://mock.invalid',
      compatible: true,
      enabled: true,
      credential:
        protocol === 'tencent-speech' ? null : { kind: 'env', key: 'STUDIO_OFFLINE_VOICE' },
      ...(protocol === 'tencent-speech'
        ? {
            credentials: {
              secretId: { kind: 'env', key: 'STUDIO_OFFLINE_SIGN_ID' },
              secretKey: { kind: 'env', key: 'STUDIO_OFFLINE_VOICE' },
            },
            ttsBaseUrl: 'https://mock.invalid',
          }
        : {}),
      speechResourceId: 'seed-icl-2.0',
      capacityGroup: protocol,
      concurrency: 1,
      models: [{ id: modelId, name: modelId, preset: protocol }],
    },
  });
  const selection = { connection: { id: connection.id, revision: connection.revision }, modelId };
  const project = store.create('project', '', { title: '校园季', mode: 'short' });
  for (const owner of [null, project.id])
    saveSpeechAllowance(store, owner, {
      revision: 0,
      data: {
        enabled: true,
        connections: [selection.connection],
        maxVoiceCreations: 10,
        maxSpeechRequests: 20,
        maxSpeechCharacters: 10000,
        maxLipSyncRequests: 10,
        maxLipSyncSeconds: 60,
      },
    });
  const file = path.join(root, 'sample.wav');
  await fs.writeFile(file, wav(11));
  const media = await library.importAudio(root, file, '离线合成样本');
  const voice = library.save({
    name: '小岚',
    description: '测试声音',
    samples: [
      {
        media: { id: media.id, revision: media.revision },
        in: 0,
        out: 11,
        purpose: 'clone',
        source: 'isolated synthetic sine wave',
        transcript: '离线测试',
        listened: true,
        notes: '测试夹具，不作为真实音色证据',
      },
    ],
  });
  const mp3 = path.join(root, 'result.mp3');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    file,
    '-t',
    '1',
    '-c:a',
    'libmp3lame',
    mp3,
  ]);
  return {
    store,
    root,
    registry,
    library,
    connection,
    selection,
    project,
    media,
    voice,
    audio: wav(),
    mp3: await fs.readFile(mp3),
  };
}
export function providerMock(protocol: string, audio: Buffer, mp3 = audio) {
  const calls: any[] = [];
  const json = (data: any) =>
    new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  const request = (async (url: any, init: any = {}) => {
    const u = new URL(String(url)),
      headers = new Headers(init.headers),
      body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({ path: u.pathname, headers, body, method: init.method || 'GET' });
    if (u.pathname === '/audio.wav')
      return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/wav' } });
    if (u.pathname === '/audio.mp3')
      return new Response(new Uint8Array(mp3), { headers: { 'Content-Type': 'audio/mpeg' } });
    if (protocol === 'minimax-speech') {
      if (u.pathname.endsWith('files/upload'))
        return json({ base_resp: { status_code: 0 }, file: { file_id: 101 } });
      if (u.pathname.endsWith('voice_clone')) return json({ base_resp: { status_code: 0 } });
      if (u.pathname.endsWith('get_voice'))
        return json({
          base_resp: { status_code: 0 },
          voice_cloning: [{ voice_id: 'OfflineVoice01' }],
        });
      if (u.pathname.endsWith('t2a_v2'))
        return json({
          base_resp: { status_code: 0 },
          data: { audio: audio.toString('hex') },
          extra_info: { audio_length: 1000 },
        });
    }
    if (protocol === 'cosyvoice') {
      if (body.input?.action === 'create_voice')
        return json({ output: { voice_id: 'cosyvoice-fixed' } });
      if (body.input?.action === 'query_voice')
        return json({
          output: { voice_id: 'cosyvoice-fixed', status: 'OK', target_model: 'cosyvoice-v3-plus' },
        });
      return json({
        output: { finish_reason: 'stop', audio: { url: 'https://mock.invalid/audio.wav' } },
        usage: { characters: 4 },
      });
    }
    if (protocol === 'doubao-speech') {
      if (u.pathname.endsWith('voice_clone')) return json({ status: 1 });
      if (u.pathname.endsWith('get_voice')) return json({ status: 4, speaker_status: [] });
      return new Response(
        JSON.stringify({ code: 0, data: mp3.toString('base64') }) +
          '\n' +
          JSON.stringify({ code: 20000000, usage: { text_words: 4 } }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (protocol === 'baidu-speech') {
      if (u.pathname.endsWith('/tts'))
        return new Response(new Uint8Array(audio), { headers: { 'Content-Type': 'audio/wav' } });
      return json({ status: 0, data: { voice_id: 1234 } });
    }
    if (protocol === 'tencent-speech') {
      switch (headers.get('x-tc-action')) {
        case 'DetectEnvAndSoundQuality':
          return json({ Response: { Data: { DetectionCode: 0, AudioId: 'audio-123' } } });
        case 'CreateVRSTask':
          return json({ Response: { Data: { TaskId: 'vrs-123' } } });
        case 'DescribeVRSTaskStatus':
          return json({
            Response: {
              Data: {
                TaskId: 'vrs-123',
                Status: 2,
                FastVoiceType: 'WCHN-test',
                ExpireTime: '2099-01-01T00:00:00Z',
              },
            },
          });
        case 'GetVRSVoiceTypeInfo':
          return json({ Response: { Data: { FastVoiceType: 'WCHN-test', IsDeployed: true } } });
        case 'TextToVoice':
          return json({
            Response: {
              Audio: audio.toString('base64'),
              SessionId: body.SessionId,
              RequestId: 'tts-123',
            },
          });
      }
    }
    throw new Error('Unexpected mock request ' + u.pathname);
  }) as typeof fetch;
  return { request, calls };
}
