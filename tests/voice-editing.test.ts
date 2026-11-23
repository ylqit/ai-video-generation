import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { voiceFixture, providerMock } from './fixtures/speech.js';
import { prepareSpeech, submitSpeech } from '../src/server/speech-production.js';
import { saveSpeechAllowance, speechUsage } from '../src/server/speech-usage.js';
import { Worker } from '../src/server/worker.js';
import { saveDialogueTake } from '../src/server/voices.js';
import { DomainService } from '../src/server/domain-service.js';
import { prepareLipSync, submitLipSync } from '../src/server/sync-lipsync.js';
import { ingestAsset, runProcess, probeMedia } from '../src/server/media.js';
import { edlSchema } from '../src/shared/edit-timeline.js';
import { renderTimeline } from '../src/server/render.js';
import { config } from '../src/server/config.js';
import { taskSummary } from '../src/server/task-summary.js';
import { updateVoiceDependents } from '../src/server/voice-impact.js';
import { validateDeliveryAudio } from '../src/server/delivery-audio.js';
import { retainWorkspace } from '../src/server/workspace-retention.js';

async function spoken(t: any) {
  const f = await voiceFixture(t),
    { store, library, selection } = f,
    mock = providerMock('minimax-speech', f.audio);
  const worker = new Worker(store, f.root, undefined, undefined, undefined, mock.request);
  t.after(() => worker.stop());
  const registered = library.register(f.voice.id, 1, {
    connection: selection.connection,
    modelId: selection.modelId,
    voiceId: 'OfflineVoice01',
    providerStatus: 'registered',
  });
  const request = {
      voice: { id: registered.id, revision: registered.revision },
      selection,
      text: '现在开始。',
    },
    p = prepareSpeech(store, null, 'speech', request);
  const audition = submitSpeech(store, null, 'speech', {
    request,
    digest: p.digest,
    idempotencyKey: crypto.randomUUID(),
    approved: true,
  });
  await worker.tick();
  const voice = library.confirm(registered.id, registered.revision, {
    audition: store.job(audition.id).output.libraryMedia,
    listened: true,
    notes: '合成夹具听审断言',
  });
  const entity = store.create('entity', f.project.id, {
      name: '小岚',
      instances: [{ id: 'actor', name: '小岚' }],
    }),
    domain = new DomainService(store);
  let profile = domain.save(f.project.id, 'voice_profile', {
    version: 2,
    name: '小岚选角',
    entity: { id: entity.id, revision: entity.revision },
    globalVoice: { id: voice.id, revision: voice.revision },
    language: 'zh',
    timbre: '测试声音',
    route: 'tts',
    requireVoiceIdentity: true,
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: '离线断言角色匹配',
  });
  let ep = store.create('episode', f.project.id, {
    title: '第1集',
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
  const req = {
      voice: { id: voice.id, revision: voice.revision },
      selection,
      text: '现在开始。',
      line,
    },
    sp = prepareSpeech(store, f.project.id, 'speech', req);
  const speech = submitSpeech(store, f.project.id, 'speech', {
    request: req,
    digest: sp.digest,
    idempotencyKey: crypto.randomUUID(),
    approved: true,
  });
  await worker.tick();
  let asset = store.get(store.job(speech.id).output.assetIds[0]);
  asset = store.update(asset.id, asset.revision, { ...asset.data, adopted: true });
  const takeData = {
    version: 1,
    episode: { id: ep.id, revision: ep.revision },
    shotId: 's1',
    lineId: 'line',
    instanceId: 'actor',
    voice: { id: profile.id, revision: profile.revision },
    asset: { id: asset.id, revision: asset.revision },
    in: 0,
    out: 1,
    sampleRange: { sampleRate: 24000, inSample: 0, outSample: 24000 },
    source: 'tts',
    synthesisJobId: speech.id,
    actualText: '现在开始。',
    listened: true,
    voiceMatch: true,
    conclusion: '离线夹具',
  };
  const take = saveDialogueTake(store, f.project.id, takeData);
  return { ...f, worker, mock, voice, profile, ep, line, req, sp, speech, asset, take, takeData };
}

test('project synthesis pins speaker, voice and exact text; listened adoption validates samples and keeps owner quotas separate', async (t) => {
  const f = await spoken(t);
  assert.equal(speechUsage(f.store, null).speechRequests, 1);
  assert.equal(speechUsage(f.store, f.project.id).speechRequests, 1);
  assert.equal(
    taskSummary(f.store, { kind: 'speech', scope: 'project', projectId: f.project.id }).items[0]
      .qualityLabel,
    '已选用 · 不代表质量通过',
  );
  assert.throws(
    () => saveDialogueTake(f.store, f.project.id, { ...f.takeData, actualText: '不同台词' }),
    /不符/,
  );
  assert.doesNotThrow(() =>
    saveDialogueTake(f.store, f.project.id, { ...f.takeData, voiceMatch: false }),
  );
  assert.throws(
    () =>
      saveDialogueTake(f.store, f.project.id, {
        ...f.takeData,
        sampleRange: { sampleRate: 24000, inSample: 0, outSample: 24001 },
      }),
    /采样/,
  );
  const preserved = f.library.voice(f.voice.id, f.voice.revision);
  f.library.save({ ...preserved.data, name: '新显示名称' }, preserved.id, preserved.revision);
  assert.deepEqual(prepareSpeech(f.store, f.project.id, 'speech', f.req), f.sp);
  const ep = f.store.get(f.ep.id);
  f.store.update(ep.id, ep.revision, { ...ep.data, title: '无关标题更新' });
  updateVoiceDependents(f.store, ep.id);
  assert.ok(!f.store.get(f.take.id).data.stale);
  const changed = f.store.get(ep.id),
    data = structuredClone(changed.data);
  data.shots[0].directing.sound.dialogue[0].text = '新台词';
  f.store.update(ep.id, changed.revision, data);
  updateVoiceDependents(f.store, ep.id);
  assert.equal(f.store.get(f.take.id).data.stale, true);
  assert.equal(f.store.job(f.speech.id).output.basisCorrected, true);
  assert.equal(
    taskSummary(f.store, { projectId: f.project.id, kind: 'speech' }).items[0].quality,
    'needs_review',
  );
});

test('audio replacement reports overlap and unobserved mouths as optional quality warnings', async (t) => {
  const f = await spoken(t),
    track = {
      assetId: f.asset.id,
      revision: f.asset.revision,
      dialogueTake: { id: f.take.id, revision: f.take.revision },
      sampleRange: f.takeData.sampleRange,
      in: 0,
      out: 1,
      start: 0,
      originalAudio: 'muted',
      mouthObserved: 'visible',
      mouthInspected: true,
      mouthWindows: [{ startFrame: 0, endFrame: 24, lipSyncReviewed: true }],
    };
  assert.deepEqual(
    validateDeliveryAudio(
      f.store,
      f.ep,
      { audio: [track] },
      [{ startFrame: 0, endFrame: 24, volume: 0 }],
      24,
    ).warnings,
    [],
  );
  assert.match(
    validateDeliveryAudio(
      f.store,
      f.ep,
      { audio: [track] },
      [{ startFrame: 0, endFrame: 24, volume: 1 }],
      24,
    ).warnings.join(' '),
    /静音/,
  );
  assert.match(
    validateDeliveryAudio(
      f.store,
      f.ep,
      { audio: [{ ...track, mouthInspected: false }] },
      [{ startFrame: 0, endFrame: 24, volume: 0 }],
      24,
    ).warnings.join(' '),
    /可见性/,
  );
});

test('EDL v3 keeps source audio samples across render blocks while video stays 24 fps; legacy audio stays unchanged', async (t) => {
  const f = await spoken(t),
    file = path.join(f.root, 'sample-timeline.mp4');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=160x128:r=24:d=13',
    '-an',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    file,
  ]);
  const v = await ingestAsset(f.store, f.root, f.project.id, file, {
      name: '13秒色卡',
      category: 'video',
    }),
    sampleRange = { sampleRate: 24000, inSample: 14, outSample: 22051 };
  const edl: any = {
    schemaVersion: 3,
    episodeId: f.ep.id,
    width: 160,
    height: 128,
    fps: 24,
    clips: [{ id: 'c', assetId: v.id, revision: v.revision, in: 0, out: 13, volume: 0 }],
    audio: [
      {
        assetId: f.asset.id,
        revision: f.asset.revision,
        in: 14 / 24000,
        out: 22051 / 24000,
        sampleRange,
        start: 11.5,
        volume: 1,
      },
    ],
  };
  assert.equal(edlSchema.safeParse(edl).success, true);
  assert.equal(edlSchema.safeParse({ ...edl, schemaVersion: 2 }).success, false);
  assert.equal(edlSchema.safeParse({ ...edl, audio: [{ ...edl.audio[0], in: 0 }] }).success, false);
  let checkpoint: any;
  const output = path.join(f.root, 'sample-export', 'final.mp4');
  await renderTimeline(edl, [v, f.asset], f.root, output, undefined, {
    save: (p) => (checkpoint = p),
  });
  assert.equal((await probeMedia(output)).frameCount, 312);
  assert.equal(checkpoint.parts.filter((p: any) => p.kind === 'audio').length, 2);
  const samples = path.join(f.root, 'decoded.f32');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-i',
    path.join(f.root, 'sample-export', 'audio-1-stem-0.wav'),
    '-ac',
    '1',
    '-f',
    'f32le',
    samples,
  ]);
  const pcm = await fs.readFile(samples);
  assert.equal(pcm.length, 48000 * 4);
  const energy = (from: number, to: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += Math.abs(pcm.readFloatLE(i * 4));
    return sum;
  };
  assert.ok(energy(0, 18000) > 1);
  assert.equal(energy(22000, 48000), 0);
  const oldParts = checkpoint.parts.map((p: any) => p.sha256);
  await renderTimeline(edl, [v, f.asset], f.root, output, undefined, {
    previous: checkpoint,
    save: (p) => (checkpoint = p),
  });
  assert.deepEqual(
    checkpoint.parts.map((p: any) => p.sha256),
    oldParts,
  );
});

test('Sync uses one fixed speaker, no bounce/loop/stretch, archives derived candidates and preserves full source history', async (t) => {
  const f = await spoken(t),
    { store } = f;
  const c = f.registry.saveConnection({
      revision: 0,
      data: {
        name: 'Sync fixture',
        protocol: 'sync-lipsync',
        baseUrl: 'https://mock.invalid',
        compatible: true,
        enabled: true,
        credential: { kind: 'env', key: 'STUDIO_OFFLINE_VOICE' },
        capacityGroup: 'sync',
        concurrency: 1,
        models: [{ id: 'sync-3', name: 'Sync 3', preset: 'sync-lipsync' }],
      },
    }),
    selection = { connection: { id: c.id, revision: c.revision }, modelId: 'sync-3' };
  const policy = store.setting<any>('speech_allowance:project:' + f.project.id, {});
  saveSpeechAllowance(store, f.project.id, {
    revision: policy.revision,
    data: { ...policy.data, connections: [...policy.data.connections, selection.connection] },
  });
  const file = path.join(f.root, 'video.mp4');
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
    file,
  ]);
  const video = await ingestAsset(store, f.root, f.project.id, file, {
      name: '原视频',
      category: 'video',
    }),
    request = {
      selection,
      video: { id: video.id, revision: video.revision },
      take: { id: f.take.id, revision: f.take.revision },
      range: { inFrame: 0, outFrame: 48 },
      face: { frame: 0, x: 160, y: 120, instanceId: 'actor', inspected: true },
      singleSpeaker: true,
      originalAudio: 'replace',
    };
  const p = prepareLipSync(store, f.project.id, request);
  assert.equal(p.input.silencePaddingSeconds, 1);
  assert.equal(p.input.requestOptions.sync_mode, 'silence');
  assert.deepEqual(prepareLipSync(store, f.project.id, request), p);
  assert.throws(
    () => prepareLipSync(store, f.project.id, { ...request, range: { inFrame: 0, outFrame: 12 } }),
    /超出/,
  );
  const unobserved = prepareLipSync(store, f.project.id, {
    ...request,
    face: { ...request.face, inspected: false },
  });
  assert.equal(unobserved.input.face.inspected, false);
  assert.throws(
    () => prepareLipSync(store, f.project.id, { ...request, singleSpeaker: false }),
    /true/,
  );
  const submit = { request, digest: p.digest, approved: true, idempotencyKey: 'lip-sync-once' },
    job = submitLipSync(store, f.project.id, submit);
  assert.equal(submitLipSync(store, f.project.id, submit).id, job.id);
  const calls: any[] = [];
  let downloaded = false;
  f.worker.requestModel = (async (url: any, init: any = {}) => {
    const u = new URL(String(url));
    calls.push({ path: u.pathname, init });
    if (u.pathname === '/v2/models') return Response.json([{ id: 'sync-3' }]);
    if (u.pathname === '/v2/generate') {
      assert.equal(init.headers.get('x-api-key'), 'offline-only');
      const form = init.body as FormData;
      const options = JSON.parse(String(form.get('options')));
      assert.equal(options.sync_mode, 'silence');
      assert.equal(options.active_speaker_detection.auto_detect, false);
      assert.equal(form.get('text'), null);
      return Response.json({ id: 'sync-remote', status: 'PENDING' });
    }
    if (u.pathname === '/v2/generate/sync-remote')
      return Response.json({
        id: 'sync-remote',
        status: 'COMPLETED',
        outputUrl: 'https://mock.invalid/result.mp4',
      });
    if (u.pathname === '/result.mp4') {
      downloaded = true;
      return new Response(new Uint8Array(await fs.readFile(file)));
    }
    throw new Error('unexpected route');
  }) as any;
  await f.worker.tick();
  assert.equal(store.job(job.id).state, 'submitted');
  await f.worker.tick();
  assert.equal(store.job(job.id).state, 'succeeded', store.job(job.id).error || '');
  const result = store.job(job.id);
  assert.equal(result.output.timing.actualFrames, 48);
  assert.equal(downloaded, true);
  assert.equal(calls.filter((c) => c.path === '/v2/generate').length, 1);
  const candidate = store.get(result.output.videoAssetId);
  assert.equal(candidate.data.adopted, false);
  assert.ok(candidate.data.sourceAssetIds.includes(video.id));
  assert.equal(store.get(video.id).revision, video.revision);
  assert.equal(
    taskSummary(store, { kind: 'lipsync' }).items[0].qualityLabel,
    '可使用 · 口型未观察',
  );
  store.patchJob(job.id, { state: 'archiving' });
  f.worker.requestModel = (async () => {
    throw new Error('archive recovery cannot re-download or generate');
  }) as any;
  await f.worker.tick();
  assert.equal(store.job(job.id).state, 'succeeded');
  assert.equal(store.list('asset', f.project.id).filter((d) => d.data.jobId === job.id).length, 2);
  const uncertain = submitLipSync(store, f.project.id, {
    ...submit,
    idempotencyKey: 'lost-lipsync-response',
  });
  let submissions = 0;
  f.worker.requestModel = (async (url: any) => {
    if (new URL(String(url)).pathname === '/v2/models') return Response.json([{ id: 'sync-3' }]);
    submissions++;
    throw new Error('connection lost after acceptance');
  }) as any;
  await f.worker.tick();
  assert.equal(store.job(uncertain.id).state, 'unknown');
  await f.worker.tick();
  assert.equal(submissions, 1);
  f.worker.stop();
  const recovered = new Worker(store, f.root, undefined, undefined, undefined, (async () => {
    submissions++;
    throw new Error('restart must not resubmit an uncertain Sync generation');
  }) as any);
  t.after(() => recovered.stop());
  await recovered.tick();
  assert.equal(store.job(uncertain.id).state, 'unknown');
  assert.equal(submissions, 1);
});

test('disabled voice gates queued requests and re-enabling resumes the original prepared request', async (t) => {
  const f = await spoken(t),
    req = f.req,
    p = prepareSpeech(f.store, f.project.id, 'speech', req),
    j = submitSpeech(f.store, f.project.id, 'speech', {
      request: req,
      digest: p.digest,
      idempotencyKey: 'disabled-queue',
      approved: true,
    });
  let v = f.library.voice(f.voice.id);
  f.library.metadata(v.id, {
    revision: v.metadataRevision,
    folderId: null,
    enabled: false,
    favorite: false,
  });
  await f.worker.tick();
  assert.equal(f.store.job(j.id).holdReason, 'voice_disabled');
  const count = f.mock.calls.length;
  v = f.library.voice(v.id);
  f.library.metadata(v.id, {
    revision: v.metadataRevision,
    folderId: null,
    enabled: true,
    favorite: false,
  });
  await f.worker.tick();
  assert.equal(f.store.job(j.id).state, 'succeeded');
  assert.equal(f.mock.calls.length, count + 1);
});

test('legacy conversion preserves exact sample evidence without inventing global confirmation', async (t) => {
  const f = await spoken(t),
    old = new DomainService(f.store).save(f.project.id, 'voice_profile', {
      version: 1,
      name: '旧声音',
      entity: f.profile.data.entity,
      language: 'zh',
      timbre: '旧描述',
      samples: [
        {
          asset: { id: f.asset.id, revision: f.asset.revision },
          in: 0,
          out: 1,
          inspected: true,
          notes: '旧样本记录',
        },
      ],
    });
  const original = JSON.stringify(f.store.get(old.id));
  const converted = await f.library.convertProfile(f.root, old.id, old.revision);
  assert.equal(converted.data.state, 'draft');
  assert.equal(converted.data.handle, null);
  assert.equal(converted.data.samples[0].purpose, 'reference');
  assert.match(converted.data.samples[0].source, /原声音/);
  assert.equal((await f.library.convertProfile(f.root, old.id, old.revision)).id, converted.id);
  assert.equal(JSON.stringify(f.store.get(old.id)), original);
  assert.equal(f.store.get(f.take.id).data.stale, undefined);
});

test('voice creation save receipts survive a lost response and a repeated draft request', async (t) => {
  const f = await voiceFixture(t);
  const data = { name: '幂等草稿' };
  const first = f.library.save(data, undefined, 0, 'voice-save-once');
  assert.equal(f.library.save(data, undefined, 0, 'voice-save-once').id, first.id);
  assert.throws(
    () => f.library.save({ name: '不同内容' }, undefined, 0, 'voice-save-once'),
    /回执与输入不符/,
  );
});

test('offline retention carries global voice versions, global media and workspace receipts with no synthetic project', async (t) => {
  const f = await spoken(t);
  f.worker.stop();
  const target = f.root + '-retained';
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  const report = await retainWorkspace(f.root, target, f.project.id);
  assert.ok(report.globalVoices);
  assert.ok(report.assets.some((a) => a.path.startsWith('media/global/')));
  assert.equal(report.jobs.length, 2);
});
