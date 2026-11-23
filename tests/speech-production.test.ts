import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { voiceFixture, providerMock } from './fixtures/speech.js';
import { speechProtocols, voiceHandleIdentity } from '../src/shared/speech.js';
import { prepareSpeech, submitSpeech } from '../src/server/speech-production.js';
import { speechUsage, saveSpeechAllowance } from '../src/server/speech-usage.js';
import { Worker } from '../src/server/worker.js';
import { taskSummary } from '../src/server/task-summary.js';
import { saveDialogueTake } from '../src/server/voices.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { upgradeVoiceDatabase, migrateDatabase } from '../src/server/migrations.js';
import { speechContext, tencentHeaders } from '../src/server/speech-transport.js';
import { speechAdapters } from '../src/server/speech-providers.js';

test('remote unavailability follows provider identity across note revisions; archive recovery cannot erase a newer failure', async (t) => {
  const f = await voiceFixture(t),
    mock = providerMock('minimax-speech', f.audio);
  const v = f.library.register(f.voice.id, 1, {
    connection: f.selection.connection,
    modelId: f.selection.modelId,
    voiceId: 'OfflineVoice01',
    providerStatus: 'registered',
  });
  const request = {
    voice: { id: v.id, revision: v.revision },
    selection: f.selection,
    text: '试听',
  };
  const prepared = prepareSpeech(f.store, null, 'speech', request);
  const job = submitSpeech(f.store, null, 'speech', {
    request,
    digest: prepared.digest,
    idempotencyKey: 'availability-proof',
    approved: true,
  });
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, mock.request);
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded');
  const key = `voice_probe:${generationDigest(voiceHandleIdentity(v.data.handle))}`;
  const unavailable = {
    state: 'failed',
    providerStatus: 'deleted',
    at: Date.now() + 1,
    expiresAt: null,
  };
  f.store.setSetting(key, unavailable);
  const next = f.library.save({ ...v.data, description: '仅更新备注' }, v.id, v.revision);
  assert.equal(f.library.list({ offset: 0, limit: 10 }).items[0].availability?.state, 'failed');
  assert.throws(
    () =>
      prepareSpeech(f.store, null, 'speech', {
        ...request,
        voice: { id: next.id, revision: next.revision },
      }),
    /失效/,
  );
  f.store.patchJob(job.id, { state: 'archiving' });
  worker.requestModel = (async () => {
    throw new Error('Archive recovery cannot generate');
  }) as any;
  await worker.tick();
  assert.equal(f.store.job(job.id).state, 'succeeded');
  assert.deepEqual(f.store.setting(key, null), unavailable);
  assert.notDeepEqual(
    voiceHandleIdentity(v.data.handle),
    voiceHandleIdentity({
      ...v.data.handle,
      connection: { ...v.data.handle.connection, id: 'another-account' },
    }),
  );
});

for (const protocol of speechProtocols)
  test(`${protocol}: clone/query/synthesize/archive retain distinct identities and never adopt implicitly`, async (t) => {
    const f = await voiceFixture(t, protocol),
      { store, library, selection } = f,
      mock = providerMock(protocol, f.audio, f.mp3);
    const worker = new Worker(store, f.root, undefined, undefined, undefined, mock.request);
    t.after(() => worker.stop());
    const request = {
      voice: { id: f.voice.id, revision: f.voice.revision },
      selection,
      sampleIndex: 0,
      authorized: true,
      providerOptions: {
        voiceId: 'OfflineVoice01',
        prefix: 'studio',
        voiceName: 'offline',
        slotMode: 'postpaid',
        textId: 'training-123',
        gender: 1,
      },
    };
    const p = prepareSpeech(store, null, 'voice_clone', request);
    assert.deepEqual(prepareSpeech(store, null, 'voice_clone', request), p);
    assert.equal(store.jobs().length, 0);
    const body = { request, digest: p.digest, idempotencyKey: crypto.randomUUID(), approved: true };
    const j = submitSpeech(store, null, 'voice_clone', body);
    assert.equal(submitSpeech(store, null, 'voice_clone', body).id, j.id);
    for (let i = 0; i < 5 && store.job(j.id).state !== 'succeeded'; i++) {
      await worker.tick();
      const latest = store.job(j.id);
      if (latest.output.lastCheckedAt)
        store.patchJob(j.id, { output: { ...latest.output, lastCheckedAt: 0 } });
    }
    assert.equal(store.job(j.id).state, 'succeeded', store.job(j.id).error || '');
    assert.equal(store.job(j.id).projectId, null);
    const v = library.voice(store.job(j.id).output.voiceResult.id);
    assert.equal(v.data.state, 'auditionable');
    assert.equal(v.data.handle?.modelId, selection.modelId);
    assert.equal(store.list('project').length, 1);
    const req = {
      voice: { id: v.id, revision: v.revision },
      selection,
      text: '现在开始。',
      performance: { instructions: '克制，人工听审' },
      activateTemporaryVoice: true,
    };
    const sp = prepareSpeech(store, null, 'speech', req);
    assert.equal(sp.warnings.length, 1);
    const sj = submitSpeech(store, null, 'speech', {
      request: req,
      digest: sp.digest,
      idempotencyKey: crypto.randomUUID(),
      approved: true,
    });
    await worker.tick();
    assert.equal(store.job(sj.id).state, 'succeeded', store.job(sj.id).error || '');
    const out = store.job(sj.id).output;
    assert.ok(out.libraryMedia);
    assert.equal(out.audioTiming.sampleRate, 24000);
    assert.equal(
      taskSummary(store, { scope: 'workspace', kind: 'speech' }).items[0].qualityLabel,
      '可使用 · 未听审',
    );
    const confirmed = library.confirm(v.id, v.revision, {
      audition: out.libraryMedia,
      listened: true,
      notes: '测试夹具人工断言，不代表真实声音质量',
    });
    assert.equal(confirmed.data.state, 'confirmed');
    assert.equal(speechUsage(store, null).speechRequests, 1);
    assert.equal(speechUsage(store, f.project.id).speechRequests, 0);
    const submits = mock.calls.filter(
      (c) =>
        c.path.endsWith('voice_clone') ||
        c.headers.get('x-tc-action') === 'CreateVRSTask' ||
        c.body?.input?.action === 'create_voice' ||
        c.path.endsWith('/create'),
    );
    assert.equal(submits.length, 1);
    if (protocol === 'tencent-speech') {
      const tts = mock.calls.find((c) => c.headers.get('x-tc-action') === 'TextToVoice');
      assert.equal(tts.body.VoiceType, 200000000);
      assert.equal(tts.body.FastVoiceType, 'WCHN-test');
      assert.match(tts.headers.get('authorization'), /^TC3-HMAC-SHA256/);
    }
    if (protocol === 'doubao-speech')
      assert.equal(
        mock.calls.find((c) => c.path.includes('unidirectional')).headers.get('x-api-resource-id'),
        'seed-icl-2.0',
      );
    if (protocol === 'minimax-speech') {
      assert.equal(store.job(j.id).output.uploads.fileId, 101);
      assert.equal(v.data.handle?.voiceId, 'OfflineVoice01');
    }
  });

test('global folders are independent of fixed voice versions; cycles, nonempty deletion and stale writes reject', async (t) => {
  const f = await voiceFixture(t),
    l = f.library,
    v = l.voice(f.voice.id);
  const a = l.folder({ name: '中文', parentId: null, revision: 0 })!,
    b = l.folder({ name: '青年', parentId: a.id, revision: 0 })!;
  const fixed = JSON.stringify(v.data);
  l.metadata(v.id, { revision: v.metadataRevision, folderId: b.id, enabled: true, favorite: true });
  l.folder({ name: '华语', parentId: null, revision: 1 }, String(a.id));
  assert.equal(JSON.stringify(l.voice(v.id, v.revision).data), fixed);
  assert.equal(l.list({ offset: 0, limit: 10, favorite: true }).total, 1);
  assert.deepEqual(
    l.folderPath(String(b.id)).map((f) => f.name),
    ['华语', '青年'],
  );
  assert.throws(
    () => l.folder({ name: 'cycle', parentId: b.id, revision: 2 }, String(a.id)),
    /循环/,
  );
  assert.throws(() => l.deleteFolder(String(b.id), 1), /先移动/);
  const newV = l.save({ ...v.data, name: '新显示名' }, v.id, v.revision);
  assert.throws(() => l.save(v.data, v.id, v.revision), /变化/);
  assert.equal(l.voice(v.id, 1).data.name, '小岚');
  assert.equal(newV.revision, 2);
});

test('unknown speech and missing cached response never issue a second POST; saved receipt resumes without a network call', async (t) => {
  const f = await voiceFixture(t),
    v = f.library.register(f.voice.id, 1, {
      connection: f.selection.connection,
      modelId: f.selection.modelId,
      voiceId: 'OfflineVoice01',
      providerStatus: 'registered',
    });
  const req = { voice: { id: v.id, revision: v.revision }, selection: f.selection, text: '试听' },
    p = prepareSpeech(f.store, null, 'speech', req),
    j = submitSpeech(f.store, null, 'speech', {
      request: req,
      digest: p.digest,
      approved: true,
      idempotencyKey: 'unknown-test',
    });
  let requests = 0;
  const w = new Worker(f.store, f.root, undefined, undefined, undefined, (async () => {
    requests++;
    throw new Error('connection lost after send');
  }) as any);
  t.after(() => w.stop());
  await w.tick();
  assert.equal(f.store.job(j.id).state, 'unknown');
  await w.tick();
  assert.equal(requests, 1);
  w.stop();
  const mock = providerMock('minimax-speech', f.audio),
    dir = path.join(f.root, 'cached');
  const execution = f.registry.resolveSelection(f.selection);
  let submissions = 0;
  const ctx = speechContext(
    f.store,
    execution.connection,
    execution.modelId,
    j.id,
    {
      checkpoint: {},
      saveCheckpoint() {},
      beforeSubmit() {
        submissions++;
      },
      receiptDir: dir,
    },
    undefined,
    mock.request,
  );
  await speechAdapters['minimax-speech'].synthesize(ctx, p.input);
  const replay = speechContext(
    f.store,
    execution.connection,
    execution.modelId,
    j.id,
    { checkpoint: {}, saveCheckpoint() {}, beforeSubmit() {}, receiptDir: dir, replayOnly: true },
    undefined,
    (async () => {
      throw new Error('network forbidden');
    }) as any,
  );
  const restored = await speechAdapters['minimax-speech'].synthesize(replay, p.input);
  assert.deepEqual(restored.audio?.bytes, f.audio);
  assert.equal(submissions, 1);
});

test('draft samples have purpose, provider limits and explicit scope; quotas and selection snapshots cannot be bypassed', async (t) => {
  const f = await voiceFixture(t);
  const v = f.library.save({ name: '无样本草稿' });
  assert.equal(v.data.state, 'draft');
  assert.throws(
    () =>
      prepareSpeech(f.store, null, 'voice_clone', {
        voice: { id: v.id, revision: 1 },
        selection: f.selection,
        sampleIndex: 0,
        authorized: true,
      }),
    /样本/,
  );
  const registered = f.library.register(v.id, 1, {
    connection: f.selection.connection,
    modelId: f.selection.modelId,
    voiceId: 'OfflineVoice01',
    providerStatus: 'registered',
  });
  const req = {
    voice: { id: registered.id, revision: registered.revision },
    selection: f.selection,
    text: '试听',
  };
  const p = prepareSpeech(f.store, null, 'speech', req);
  const policy = f.store.setting<any>('speech_allowance:workspace', {});
  saveSpeechAllowance(f.store, null, {
    revision: policy.revision,
    data: { ...policy.data, maxSpeechRequests: 0 },
  });
  assert.throws(
    () =>
      submitSpeech(f.store, null, 'speech', {
        request: req,
        digest: p.digest,
        approved: true,
        idempotencyKey: 'zero-quota',
      }),
    /额度/,
  );
  assert.equal(f.store.jobs().length, 0);
  assert.equal(prepareSpeech(f.store, f.project.id, 'speech', req).input.line, null); // Standalone project dubbing no longer needs a fictitious episode line.
  assert.throws(() => f.store.createJob('lipsync', null, null, {}, 'no-fake-project'), /归属/);
});

test('v5 to v6 migration is explicit and preserves exact frozen jobs and history', async (t) => {
  const f = await voiceFixture(t);
  f.store.createJob(
    'generation',
    f.project.id,
    null,
    { frozen: true, template: 'native-h3-directed-v4', prompt: '历史输入不重新编译' },
    'migration-original',
  );
  const jobs = f.store.db.prepare('SELECT * FROM jobs').all();
  f.store.db.exec(
    'DROP TABLE library_metadata; DROP TABLE voice_folders; DROP INDEX events_job_stage; PRAGMA user_version=5;',
  );
  const before = f.store.db.prepare('SELECT * FROM revisions').all();
  assert.throws(() => migrateDatabase(f.store.db), /migrate:voices/);
  f.store.acquire('migration-test');
  assert.throws(() => upgradeVoiceDatabase(f.store.db), /租约/);
  f.store.release('migration-test');
  upgradeVoiceDatabase(f.store.db);
  assert.equal(f.store.db.prepare('PRAGMA user_version').get()?.user_version, 6);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM revisions').all(), before);
  assert.deepEqual(f.store.db.prepare('SELECT * FROM jobs').all(), jobs);
});

test('task list and counts use identical owner/type/review filters, including empty pagination', async (t) => {
  const f = await voiceFixture(t);
  f.store.createJob('creative', f.project.id, null, { name: '剧情提案' }, 'project-task');
  assert.equal(taskSummary(f.store, { scope: 'all' }).total, 1);
  assert.equal(taskSummary(f.store, { scope: 'workspace' }).total, 0);
  assert.equal(
    taskSummary(f.store, {
      scope: 'project',
      projectId: f.project.id,
      kind: 'creative',
      offset: 25,
    }).items.length,
    0,
  );
  assert.equal(
    taskSummary(f.store, {
      scope: 'project',
      projectId: f.project.id,
      kind: 'creative',
      offset: 25,
    }).total,
    1,
  );
  assert.throws(() => taskSummary(f.store, { scope: 'project' }), /作品/);
});

test('accepted async clone remains trackable after its connection is disabled', async (t) => {
  const f = await voiceFixture(t, 'cosyvoice'),
    mock = providerMock('cosyvoice', f.audio),
    worker = new Worker(f.store, f.root, undefined, undefined, undefined, mock.request);
  t.after(() => worker.stop());
  const request = {
      voice: { id: f.voice.id, revision: f.voice.revision },
      selection: f.selection,
      sampleIndex: 0,
      authorized: true,
      providerOptions: { prefix: 'studio' },
    },
    p = prepareSpeech(f.store, null, 'voice_clone', request);
  const j = submitSpeech(f.store, null, 'voice_clone', {
    request,
    digest: p.digest,
    approved: true,
    idempotencyKey: 'accepted-disabled',
  });
  await worker.tick();
  assert.equal(f.store.job(j.id).state, 'submitted');
  f.registry.saveConnection(
    { revision: f.connection.revision, data: { ...f.connection.data, enabled: false } },
    f.connection.id,
  );
  const current = f.store.job(j.id);
  f.store.patchJob(j.id, { output: { ...current.output, lastCheckedAt: 0 } });
  await worker.tick();
  assert.equal(f.store.job(j.id).state, 'succeeded');
  assert.equal(mock.calls.filter((c) => c.body?.input?.action === 'create_voice').length, 1);
});

test('Baidu JSON errors and incomplete Doubao audio streams cannot be archived as successful audio', async (t) => {
  for (const protocol of ['baidu-speech', 'doubao-speech'] as const) {
    const f = await voiceFixture(t, protocol),
      e = f.registry.resolveSelection(f.selection);
    const ctx = speechContext(
      f.store,
      e.connection,
      e.modelId,
      'offline',
      { checkpoint: {}, saveCheckpoint() {}, beforeSubmit() {} },
      undefined,
      (async () =>
        new Response(
          protocol === 'baidu-speech'
            ? JSON.stringify({ status: 111, message: 'sample rejected' })
            : JSON.stringify({ code: 0, data: 'AA==' }),
          { headers: { 'Content-Type': 'application/json' } },
        )) as any,
    );
    await assert.rejects(
      () =>
        speechAdapters[protocol].synthesize(ctx, {
          voice: { data: { handle: { voiceId: '1234' }, language: 'zh' } },
          text: '台词',
          performance: {},
        }),
      /失败|未完整/,
    );
  }
});
