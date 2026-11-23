import { timelineMap } from '../src/shared/edit-timeline.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { CreationService } from '../src/server/creation.js';
import { CreationMediaService } from '../src/server/creation-media.js';
import { DomainService } from '../src/server/domain-service.js';
import { WorkspaceService } from '../src/server/workspace.js';
import { Worker } from '../src/server/worker.js';
import { runCodex } from '../src/server/codex.js';
import { config, prepareData } from '../src/server/config.js';
import { ingestAsset, runProcess } from '../src/server/media.js';
import { parseSrt, renderSrt } from '../src/shared/creation-media.js';
import { referenceStartGroup } from '../src/shared/workspace.js';
import { executionTextFields } from '../src/shared/execution-text.js';
import { edlSchema } from '../src/shared/contracts.js';
import { parse, compileScript } from '@vue/compiler-sfc';
import ts from 'typescript';
import * as Vue from 'vue';

async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-review-'));
  prepareData(root);
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = new StudioService(store).createProject({
    title: 'Offline review',
    mode: 'short',
    brief: '',
  });
  const creation = new CreationService(store),
    service = new CreationMediaService(store, root);
  const run = creation.create(project.id, {
    request: 'Review an offline candidate',
    idempotencyKey: crypto.randomUUID(),
  });
  return { root, store, project, creation, service, run };
}

test('discussion Worker records real reply with exact references without changing run or authoring', async (t) => {
  const f = await fixture(t),
    source = f.store.create('chapter', f.project.id, { title: 'Facts', text: 'Offline source' });
  const before = JSON.stringify(f.creation.get(f.run.id));
  const request = {
    revision: f.run.revision,
    mode: 'discuss',
    request: 'Explain these facts',
    references: [{ id: source.id, revision: source.revision }],
    idempotencyKey: crypto.randomUUID(),
  };
  const accepted = f.service.message(f.run.id, request);
  assert.equal(f.service.message(f.run.id, request).job!.id, accepted.job!.id);
  assert.throws(
    () => f.service.message(f.run.id, { ...request, request: 'Other request' }),
    /幂等/,
  );
  let calls = 0;
  const worker = new Worker(f.store, f.root, undefined, async (context) => {
    calls++;
    assert.equal(context.mode, 'discussion');
    assert.equal(context.references[0].record.data.text, 'Offline source');
    return {
      answer: 'These are the exact source facts.',
      resultLinks: [{ id: source.id, revision: source.revision, title: 'Read source' }],
    };
  });
  await worker.execute(accepted.job!, 'creative', new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(f.store.job(accepted.job!.id).state, 'succeeded');
  assert.equal(JSON.stringify(f.creation.get(f.run.id)), before);
  assert.equal(f.store.list('authoring_result', f.project.id).length, 0);
  const messages = f.store.list('creation_message', f.project.id);
  assert.equal(messages.length, 2);
  assert.equal(
    messages.find((m) => m.data.role === 'assistant')!.data.resultLinks[0].revision,
    source.revision,
  );
  const snapshot = new WorkspaceService(f.store).snapshot(f.project.id, f.run.id);
  assert.ok(snapshot.messages.some((m) => m.text === 'These are the exact source facts.'));
});

test('discussion refuses foreign objects, invented subobjects/links and oversized fixed context; stale replies remain history', async (t) => {
  const f = await fixture(t),
    other = new StudioService(f.store).createProject({ title: 'Other', mode: 'short', brief: '' });
  const reference = f.store.create('chapter', f.project.id, { text: 'Facts' });
  const body = {
    revision: f.run.revision,
    mode: 'discuss',
    request: 'Discuss',
    references: [],
    idempotencyKey: crypto.randomUUID(),
  };
  assert.throws(
    () =>
      f.service.message(f.run.id, {
        ...body,
        references: [{ id: other.id, revision: other.revision }],
      }),
    /引用/,
  );
  assert.throws(
    () =>
      f.service.message(f.run.id, {
        ...body,
        references: [{ id: reference.id, revision: reference.revision, shotId: 'invented' }],
      }),
    /镜头/,
  );
  const huge = f.store.create('chapter', f.project.id, { text: 'x'.repeat(190000) });
  assert.throws(
    () =>
      f.service.message(f.run.id, {
        ...body,
        references: [{ id: huge.id, revision: huge.revision }],
      }),
    /预算/,
  );
  const { job } = f.service.message(f.run.id, body);
  assert.throws(
    () =>
      f.service.completeDiscussion(job!, {
        answer: 'Invented',
        resultLinks: [{ id: reference.id, revision: reference.revision, title: 'Not in context' }],
      }),
    /固定上下文/,
  );
  const changed = f.store.update(f.run.id, f.run.revision, { ...f.run.data, epoch: 2 });
  const reply = f.service.completeDiscussion(job!, {
    answer: 'Late actual response',
    resultLinks: [],
  });
  assert.equal(reply.data.historical, true);
  assert.deepEqual(f.creation.get(f.run.id), changed);
  assert.equal(
    f.service.completeDiscussion(job!, { answer: 'Late actual response', resultLinks: [] }).id,
    reply.id,
  );
  assert.throws(
    () =>
      f.service.message(f.run.id, {
        ...body,
        revision: changed.revision,
        idempotencyKey: crypto.randomUUID(),
        mode: 'execute',
        action: { type: 'generate_image' },
      }),
    /不支持/,
  );
});

async function handoffFixture(t: any) {
  const f = await fixture(t);
  const script = f.store.create(
    'authoring_result',
    f.project.id,
    {
      stage: 'script',
      adopted: true,
      result: {
        subjects: [
          {
            key: 'device',
            name: 'Device',
            kind: 'object',
            description: 'Silver device',
            attributes: [],
          },
        ],
      },
    },
    f.run.id,
  );
  const assets = f.store.create(
    'authoring_result',
    f.project.id,
    {
      stage: 'assets',
      adopted: true,
      result: {
        items: [
          {
            id: 'front',
            subjectKey: 'device',
            mediaType: 'image',
            purpose: 'identity',
            description: 'Device front',
            prompt: 'Front view',
            layout: 'Single view',
            shotIds: ['shot1'],
            view: 'front',
          },
        ],
      },
    },
    f.run.id,
  );
  f.run = f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    results: {
      script: { id: script.id, revision: script.revision },
      assets: { id: assets.id, revision: assets.revision },
    },
  });
  const { task } = f.service.createAssetTask(f.run.id, {
    revision: f.run.revision,
    requirementId: 'front',
    maxRevisions: 2,
    idempotencyKey: 'handoff-create-key',
  });
  const image = path.join(f.root, 'red.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=red:s=128x128',
    '-frames:v',
    '1',
    '-update',
    '1',
    image,
  ]);
  return {
    ...f,
    task,
    image,
    manifest: {
      taskId: task.id,
      taskRevision: task.revision,
      deliveryId: 'actual-delivery',
      assets: [{ viewId: 'front', file: 'front.png' }],
    },
  };
}

test('handoff prepares directly from script, package GET stays pure, content replay and racing delivery create one candidate', async (t) => {
  const f = await handoffFixture(t);
  assert.equal(f.run.data.materialized, null);
  assert.equal(f.store.jobs(f.project.id).filter((j) => j.kind !== 'creative').length, 0);
  const before = f.store.db.prepare('SELECT count(*) n FROM revisions').get();
  const bundle = new DomainService(f.store).exportTask(f.task.id, f.task.revision);
  assert.equal(bundle.taskRevision, f.task.revision);
  assert.match(bundle.instructions, /源码|数据库/);
  assert.deepEqual(f.store.db.prepare('SELECT count(*) n FROM revisions').get(), before);
  const file = [{ path: f.image, originalname: 'front.png' }];
  const [first, second] = await Promise.all([
    f.service.deliver(f.task.id, f.manifest, file),
    f.service.deliver(f.task.id, f.manifest, file),
  ]);
  assert.equal(first.delivery.candidates[0].asset.id, second.delivery.candidates[0].asset.id);
  assert.equal(f.store.list('asset', f.project.id).length, 1);
  assert.equal(f.store.get(f.task.id).data.state, 'completed');
  assert.equal(f.store.list('asset', f.project.id)[0].data.adopted, false);
  const blue = path.join(f.root, 'blue.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=blue:s=128x128',
    '-frames:v',
    '1',
    '-update',
    '1',
    blue,
  ]);
  await assert.rejects(
    f.service.deliver(f.task.id, f.manifest, [{ path: blue, originalname: 'front.png' }]),
    /不同/,
  );
  assert.equal(f.store.list('asset', f.project.id).length, 1);
});

test('late exact handoff version stays historical, validates all files before any database assets', async (t) => {
  const f = await handoffFixture(t);
  const changed = f.store.update(f.task.id, f.task.revision, {
    ...f.task.data,
    requirements: 'A different view',
    state: 'waiting_delivery',
  });
  const result = await f.service.deliver(f.task.id, f.manifest, [
    { path: f.image, originalname: 'front.png' },
  ]);
  assert.equal(result.delivery.stale, true);
  assert.equal(result.task.data.state, 'waiting_delivery');
  assert.equal(result.task.data.requirements, changed.data.requirements);
  const bad = {
    ...f.manifest,
    taskRevision: result.task.revision,
    deliveryId: 'bad',
    assets: [
      { viewId: 'front', file: 'front.png' },
      { viewId: 'missing', file: 'missing.png' },
    ],
  };
  await assert.rejects(
    f.service.deliver(f.task.id, bad, [
      { path: f.image, originalname: 'front.png' },
      { path: f.image, originalname: 'missing.png' },
    ]),
    /视图/,
  );
  assert.equal(f.store.list('asset', f.project.id).length, 1);
  assert.deepEqual(f.creation.get(f.run.id).data.bindings, {});
});

test('unadopted candidate review edits export with real Worker and fixed original audio trace; no formal writes', async (t) => {
  const f = await fixture(t),
    movie = path.join(f.root, 'fixture.mp4');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=green:s=128x128:r=24:d=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=330:duration=1',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    movie,
  ]);
  f.store.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9', instanceId: 'offline' });
  f.creation.saveSettings(f.project.id, f.creation.settings(f.project.id).revision, {
    allowance: { enabled: true, maxGenerations: 1, maxGeneratedSeconds: 2 },
  });
  const candidate = f.store.createJob(
    'generation',
    f.project.id,
    f.run.data.episodeId,
    {
      creationRunId: f.run.id,
      profile: f.store.setting('comfy', null),
      segment: { id: 'p01', shotIds: ['shot1'], duration: 1 },
    },
    'offline-source',
  );
  f.store.patchJob(candidate.id, { state: 'succeeded' });
  const asset = await ingestAsset(f.store, f.root, f.project.id, movie, {
    name: 'Candidate',
    jobId: candidate.id,
    episodeId: f.run.data.episodeId,
  });
  const edl = {
    schemaVersion: 2,
    episodeId: f.run.data.episodeId,
    width: 128,
    height: 128,
    fps: 24,
    clips: [{ assetId: asset.id, revision: asset.revision, in: 0, out: 1, volume: 0.5 }],
    audio: [],
    overlays: parseSrt('1\n00:00:00,000 --> 00:00:00,500\nOffline subtitle'),
  };
  const edit = await f.service.saveReview(f.run.id, {
    runRevision: f.run.revision,
    name: 'Offline review',
    edl,
  });
  const job = await f.service.exportReview(edit.id, {
    revision: edit.revision,
    idempotencyKey: 'review-export-v1',
  });
  assert.equal(job.input.purpose, 'candidate_review');
  assert.deepEqual(job.input.sourceJobIds, [candidate.id]);
  assert.deepEqual(job.input.sourceAssets, [{ id: asset.id, revision: asset.revision }]);
  assert.equal(
    (
      await f.service.exportReview(edit.id, {
        revision: edit.revision,
        idempotencyKey: 'review-export-v1',
      })
    ).id,
    job.id,
  );
  const worker = new Worker(f.store, f.root);
  await worker.execute(job, 'media', new AbortController().signal);
  assert.equal(f.store.job(job.id).state, 'succeeded', f.store.job(job.id).error || '');
  const exported = f.store.get(f.store.job(job.id).output.assetIds[0]);
  assert.equal(exported.data.hasAudio, true);
  assert.deepEqual(exported.data.sourceAssetIds, [asset.id]);
  assert.equal(exported.data.adopted, false);
  for (const kind of ['edl', 'segment_selection', 'continuity', 'creation_delivery'] as const)
    assert.equal(f.store.list(kind, f.project.id).length, 0);
  assert.equal(f.creation.get(f.run.id).revision, f.run.revision);
  const next = await f.service.saveReview(
    f.run.id,
    {
      revision: edit.revision,
      name: 'Trimmed',
      edl: { ...edl, clips: [{ ...edl.clips[0], out: 0.5 }] },
    },
    edit.id,
  );
  await assert.rejects(
    f.service.exportReview(edit.id, { revision: edit.revision, idempotencyKey: 'stale-export' }),
    /版本/,
  );
  await assert.rejects(
    f.service.saveReview(f.run.id, { revision: edit.revision, name: 'Conflict', edl }, edit.id),
    /更新/,
  );
  const nextJob = await f.service.exportReview(edit.id, {
    revision: next.revision,
    idempotencyKey: 'review-export-v2',
  });
  assert.notEqual(nextJob.id, job.id);
  assert.equal(f.store.job(job.id).input.edl.clips[0].out, 1);
  await assert.rejects(
    f.service.saveReview(f.run.id, {
      runRevision: f.run.revision,
      name: 'Overflow',
      edl: { ...edl, clips: [{ ...edl.clips[0], out: 25 / 24 }] },
    }),
    /实际帧数/,
  );
  const issue = f.service.mediaIssue(f.run.id, {
    object: { id: asset.id, revision: asset.revision },
    jobId: candidate.id,
    category: 'audio',
    description: 'Review tone volume',
    evidence: 'user',
    startFrame: 3,
    endFrame: 9,
  });
  assert.deepEqual(issue.data.object, { id: asset.id, revision: asset.revision });
  assert.throws(
    () =>
      f.service.mediaIssue(f.run.id, {
        object: { id: asset.id, revision: asset.revision },
        category: 'audio',
        description: 'Outside',
        evidence: 'unverified',
        startFrame: 99,
      }),
    /区间/,
  );
});

test('SRT handles multiline cues and 24 fps round trips; malformed and reversed times reject', () => {
  const cues = parseSrt(
    '1\r\n00:00:00,000 --> 00:00:01,000\r\n第一行\r\n第二行\r\n\r\n2\r\n00:00:01,500 --> 00:00:02,000\r\n第二句',
  );
  assert.equal(cues[0].endFrame, 24);
  assert.equal(cues[1].startFrame, 36);
  assert.equal(cues[0].text, '第一行\n第二行');
  assert.deepEqual(parseSrt(renderSrt(cues)), cues);
  assert.throws(() => parseSrt('1\n00:60:00,000 --> 00:61:00,000\nBad'), /时间/);
  assert.throws(() => parseSrt('1\n00:00:02,000 --> 00:00:01,000\nBackwards'), /结束/);
  assert.throws(() => parseSrt('1\nnot a time\nBad'), /格式/);
});

test('explicit revision freezes read-only exact evidence, queues one current authoring job, and returns actual result links', async (t) => {
  const f = await fixture(t);
  const previous = f.store.create(
    'authoring_result',
    f.project.id,
    {
      stage: 'brief',
      adopted: true,
      valid: true,
      ordinal: 0,
      epoch: f.run.data.epoch,
      result: {
        schemaVersion: 9,
        stage: 'brief',
        title: 'Previous brief',
        summary: 'Original source meaning',
        assumptions: [],
        openQuestions: [],
        sources: [],
        contentChange: 'preserved',
        intent: 'commercial',
        goal: 'Original goal',
        audience: 'Owners',
        lockedFacts: [],
        requirements: [],
      },
    },
    f.run.id,
  );
  f.run = f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    results: { brief: { id: previous.id, revision: previous.revision } },
  });
  const body = {
    revision: f.run.revision,
    mode: 'revise',
    stage: 'brief',
    request: 'Clarify the goal while retaining the original facts',
    references: [{ id: previous.id, revision: previous.revision }],
    idempotencyKey: 'explicit-revise-key',
  };
  const accepted = f.service.message(f.run.id, body);
  const evidence = accepted.job!.input.context.records.find(
    (r: any) => r.kind === 'fixed_reference_evidence',
  );
  assert.equal(evidence.data.record.data.result.goal, 'Original goal');
  assert.equal(evidence.revision, previous.revision);
  assert.match(evidence.data.authority, /Read-only/);
  assert.ok(
    !accepted.job!.input.context.dependencies.some(
      (r: any) => r.id === previous.id && r.revision === previous.revision,
    ),
  );
  assert.equal(f.service.message(f.run.id, body).job!.id, accepted.job!.id);
  assert.equal(f.creation.get(f.run.id).data.pendingJobId, accepted.job!.id);
  const user = f.store.list('creation_message', f.project.id).find((m) => m.data.role === 'user')!;
  assert.equal(user.data.at, accepted.run.data.messages.at(-1).at);
  const worker = new Worker(f.store, f.root, undefined, async () => ({
    ...previous.data.result,
    goal: 'Clarified goal',
    title: 'Actual revised brief',
  }));
  await worker.execute(accepted.job!, 'creative', new AbortController().signal);
  assert.equal(f.store.job(accepted.job!.id).state, 'succeeded');
  const result = f.store.get(f.store.job(accepted.job!.id).output.authoringResultId);
  assert.equal(result.data.result.goal, 'Clarified goal');
  assert.equal(result.data.adopted, false);
  assert.ok(
    f.store
      .list('creation_message', f.project.id)
      .some(
        (m) =>
          m.data.role === 'assistant' && m.data.resultLinks?.some((r: any) => r.id === result.id),
      ),
  );
  f.creation.approve(f.run.id, result.id, result.revision, 'approve-referenced-revision', 'user');
  assert.equal(f.creation.get(f.run.id).data.results.brief.id, result.id);
  assert.equal(f.store.get(result.id).data.adopted, true);
});

test('review editing rejects foreign media and fake selection authority without producing formal records', async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, 'still.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=gray:s=128x128',
    '-frames:v',
    '1',
    '-update',
    '1',
    file,
  ]);
  const other = new StudioService(f.store).createProject({
    title: 'Other media',
    mode: 'short',
    brief: '',
  });
  const foreign = await ingestAsset(f.store, f.root, other.id, file, { name: 'Other image' });
  const local = await ingestAsset(f.store, f.root, f.project.id, file, { name: 'Local image' });
  const edl = {
    schemaVersion: 2,
    episodeId: f.run.data.episodeId,
    width: 128,
    height: 128,
    fps: 24,
    clips: [{ assetId: foreign.id, revision: foreign.revision, in: 0, out: 1, volume: 1 }],
    audio: [],
  };
  await assert.rejects(
    f.service.saveReview(f.run.id, { runRevision: f.run.revision, name: 'Foreign', edl }),
    /引用/,
  );
  await assert.rejects(
    f.service.saveReview(f.run.id, {
      runRevision: f.run.revision,
      name: 'Fake selection',
      edl: {
        ...edl,
        clips: [{ ...edl.clips[0], assetId: local.id, selection: { id: 'invented', revision: 1 } }],
      },
    }),
    /正式采用/,
  );
  assert.equal(f.store.list('creation_review_edit', f.project.id).length, 0);
  assert.equal(f.store.list('segment_selection', f.project.id).length, 0);
});

test('offline Codex adapter transmits current authoring rules and strict text discussion output; obsolete protocol fails', async (t) => {
  const f = await fixture(t),
    executable = path.join(f.root, 'mock-codex.js'),
    previous = process.env.STUDIO_CODEX_BIN;
  t.after(() => {
    if (previous === undefined) delete process.env.STUDIO_CODEX_BIN;
    else process.env.STUDIO_CODEX_BIN = previous;
  });
  await fs.writeFile(
    executable,
    `const fs=require('node:fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{fs.writeFileSync('transmitted.txt',input);fs.writeFileSync('args.json',JSON.stringify(process.argv));const c=JSON.parse(fs.readFileSync('context.json','utf8'));fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify(c.mode==='discussion'?{answer:'Actual offline reply',resultLinks:[]}:{schemaVersion:9,stage:'brief',title:'Offline result'}));});`,
  );
  process.env.STUDIO_CODEX_BIN = executable;
  const context = f.creation.context(f.run.id, 'brief'),
    authoringDir = path.join(f.root, 'authoring');
  const output = await runCodex(context, authoringDir);
  assert.ok(output && typeof output === 'object' && 'title' in output);
  assert.equal(output.title, 'Offline result');
  assert.equal(
    await fs.readFile(path.join(authoringDir, 'writing-rules.md'), 'utf8'),
    context.rules.text,
  );
  assert.ok(
    (await fs.readFile(path.join(authoringDir, 'transmitted.txt'), 'utf8')).includes(
      context.rules.text,
    ),
  );
  const { job } = f.service.message(f.run.id, {
    revision: f.run.revision,
    mode: 'discuss',
    request: 'Discuss only',
    idempotencyKey: 'adapter-discuss',
  });
  const discussionDir = path.join(f.root, 'discussion'),
    reply = await runCodex(job!.input.context, discussionDir);
  assert.ok(reply && typeof reply === 'object' && 'answer' in reply);
  assert.equal(reply.answer, 'Actual offline reply');
  const prompt = await fs.readFile(path.join(discussionDir, 'transmitted.txt'), 'utf8');
  assert.match(prompt, /Never execute commands/);
  assert.match(prompt, /exact record IDs/);
  const args = JSON.parse(await fs.readFile(path.join(discussionDir, 'args.json'), 'utf8'));
  assert.ok(args.includes('read-only'));
  await assert.rejects(runCodex({ schemaVersion: 7 }, path.join(f.root, 'obsolete')), /Obsolete/);
});

// Exercise the actual SFC setup/lifecycle with Vue's renderer. The host renders no
// pixels; no copied model of the editor's save or playback implementation is used.
async function mountWorkspaceComponent(
  t: any,
  handler?: (url: string, method: string, body: any) => any,
  options: { file?: string; snapshot?: any; props?: any } = {},
) {
  const image = {
    id: 'image',
    revision: 1,
    kind: 'asset',
    data: { name: 'Still', mediaType: 'image', duration: 0, width: 128, height: 128 },
  };
  const video = {
    id: 'video',
    revision: 1,
    kind: 'asset',
    data: {
      name: 'Video',
      mediaType: 'video',
      duration: 1,
      width: 128,
      height: 128,
      hasAudio: false,
    },
  };
  const snapshot = options.snapshot || {
    project: { id: 'project', data: { mode: 'short' } },
    run: { id: 'run', revision: 1, data: { episodeId: 'episode' } },
    assets: [image, video],
    candidates: [],
    jobs: [],
  };
  const storage = new Map<string, string>();
  const globals: Record<string, any> = {};
  for (const name of [
    'window',
    'localStorage',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'matchMedia',
  ])
    globals[name] = (globalThis as any)[name];
  const lifecycle = { frames: 0, listeners: new Set<string>() };
  Object.assign(globalThis, {
    matchMedia: () => ({ matches: false }),
    window: {
      addEventListener(name: string) {
        lifecycle.listeners.add(name);
      },
      removeEventListener(name: string) {
        lifecycle.listeners.delete(name);
      },
    },
    localStorage: {
      getItem: (key: string) => storage.get(key) || null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    requestAnimationFrame: () => ++lifecycle.frames,
    cancelAnimationFrame() {},
  });
  const source = await fs.readFile(
    path.resolve('src/web', options.file || 'ReviewEditor.vue'),
    'utf8',
  );
  const { descriptor } = parse(source);
  const script = compileScript(descriptor, { id: 'review-editor-test' });
  const javascript = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: any = {};
  const api = async (url: string, method = 'GET', body?: any) => {
    const handled = handler?.(url, method, body);
    if (handled !== undefined) return handled;
    if (url.includes('/review-edits')) return { items: [], jobs: [] };
    if (url.includes('/media-issues')) return { items: [] };
    if (url.includes('/records?')) return { items: [image, video], total: 2 };
    throw new Error(`Unexpected editor request ${method} ${url}`);
  };
  new Function('require', 'exports', javascript)((name: string) => {
    if (name === 'vue') return Vue;
    if (name === './api')
      return { api, assetUrl: (id: string, revision: number) => `/asset/${id}/${revision}` };
    if (name === '../shared/creation-media') return { parseSrt, renderSrt };
    if (name === '../shared/edit-timeline') return { timelineMap };
    if (name === '../shared/workspace') return { referenceStartGroup };
    if (name === '../shared/execution-text') return { executionTextFields };
    if (name.endsWith('.vue')) return { default: { render: () => null } };
    throw new Error(`Unexpected SFC import ${name}`);
  }, exports);
  const component = exports.default,
    setup = component.setup;
  let state: any;
  component.setup = (props: any, context: any) => {
    state = setup(props, context);
    return state;
  };
  component.render = () => null;
  const renderer = Vue.createRenderer<any, any>({
    patchProp() {},
    insert() {},
    remove() {},
    createElement: () => ({}),
    createText: () => ({}),
    createComment: () => ({}),
    setText() {},
    setElementText() {},
    parentNode: () => null,
    nextSibling: () => null,
  });
  const app = renderer.createApp(component, options.props || { snapshot });
  app.mount({});
  t.after(() => {
    if (app._instance) app.unmount();
    for (const [name, value] of Object.entries(globals))
      if (value === undefined) delete (globalThis as any)[name];
      else (globalThis as any)[name] = value;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { state, storage, image, video, app, lifecycle };
}

test('task inspection restores a failed text job once and never resubmits unknown or charged video work', async (t) => {
  let job: any = {
    id: 'text-job',
    projectId: 'project',
    kind: 'creative',
    state: 'failed',
    input: { context: { schemaVersion: 9 } },
    output: {},
    error: 'Provider rejected schema',
  };
  let finish!: () => void;
  const posts: string[] = [];
  const f = await mountWorkspaceComponent(
    t,
    (url, method) => {
      if (method === 'POST') {
        posts.push(url);
        return new Promise((resolve) => {
          finish = () => {
            job = { ...job, state: 'queued', error: null };
            resolve(job);
          };
        });
      }
      if (url === '/jobs/text-job') return structuredClone(job);
      if (url.includes('/records?')) return { items: [], total: 0 };
    },
    { file: 'JobInspection.vue', props: { jobId: 'text-job', documents: [] } },
  );
  assert.equal(f.state.canRecover.value, true);
  assert.equal(f.state.job.value.error, 'Provider rejected schema');
  const pending = f.state.recover();
  await f.state.recover();
  assert.deepEqual(posts, ['/jobs/text-job/retry']);
  finish();
  await pending;
  assert.equal(f.state.job.value.state, 'queued');
  assert.equal(f.state.canRecover.value, false);
  for (const state of ['unknown', 'failed']) {
    f.state.job.value = {
      ...job,
      kind: 'generation',
      state,
      input: { creationCharge: {} },
      output: {},
    };
    assert.equal(f.state.canRecover.value, false);
    await f.state.recover();
  }
  f.state.job.value = {
    ...job,
    kind: 'generation',
    state: 'failed',
    output: { descriptor: { filename: 'original.mp4' } },
  };
  assert.equal(f.state.canRecover.value, true);
  assert.equal(posts.length, 1);
});

test('actual review editor preserves edits made during a deferred save and blocks exporting the older saved EDL', async (t) => {
  let resolveSave!: (value: any) => void,
    submitted: any,
    exportCalls = 0;
  const f = await mountWorkspaceComponent(t, (url, method, body) => {
    if (method === 'POST' && url.endsWith('/review-edits')) {
      submitted = JSON.parse(JSON.stringify(body));
      return new Promise((resolve) => {
        resolveSave = resolve;
      });
    }
    if (url.endsWith('/export')) {
      exportCalls++;
      return {};
    }
  });
  f.state.addAsset(f.video);
  const saving = f.state.save();
  assert.equal(submitted.edl.clips[0].out, 1);
  f.state.edl.value.clips[0].out = 0.5;
  await Vue.nextTick();
  resolveSave({
    id: 'saved-edit',
    revision: 1,
    data: {
      name: submitted.name,
      edl: edlSchema.parse(submitted.edl),
      sourceRefs: [{ id: 'video', revision: 1 }],
    },
  });
  await saving;
  assert.equal(f.state.edl.value.clips[0].out, 0.5);
  assert.equal(JSON.parse(f.state.baseline.value).edl.clips[0].out, 1);
  assert.equal(f.state.dirty.value, true);
  const recovered = JSON.parse(f.storage.get('studio-review-draft:run')!);
  assert.equal(recovered.edl.clips[0].out, 0.5);
  assert.equal(recovered.saved.revision, 1);
  await f.state.exportMovie();
  assert.equal(exportCalls, 0);
});

test('actual review editor adopts real schema canonicalization after an unchanged save and enables exact saved export', async (t) => {
  let canonical: any, exportBody: any;
  const f = await mountWorkspaceComponent(t, (url, method, body) => {
    if (method === 'POST' && url.endsWith('/review-edits')) {
      canonical = edlSchema.parse(body.edl);
      assert.notEqual(
        JSON.stringify(canonical),
        JSON.stringify(body.edl),
        'real schema changes EDL key ordering',
      );
      return {
        id: 'canonical-edit',
        revision: 1,
        data: {
          name: body.name.trim(),
          edl: canonical,
          sourceRefs: [{ id: 'video', revision: 1 }],
        },
      };
    }
    if (url.endsWith('/export')) {
      exportBody = body;
      return { id: 'export-job', state: 'queued' };
    }
  });
  f.state.name.value = '  Canonical review  ';
  f.state.addAsset(f.video);
  await Vue.nextTick();
  await f.state.save();
  await Vue.nextTick();
  assert.equal(f.state.name.value, 'Canonical review');
  assert.equal(JSON.stringify(f.state.edl.value), JSON.stringify(canonical));
  assert.equal(f.state.dirty.value, false);
  assert.equal(f.state.notice.value, '审看编辑已保存');
  assert.equal(f.storage.has('studio-review-draft:run'), false);
  await f.state.exportMovie();
  assert.equal(exportBody.revision, 1);
});

test('actual review editor keeps new edits dirty while fixed source loading for an opened edit is pending', async (t) => {
  let resolveSource!: (value: any) => void;
  const pending = new Promise((resolve) => {
    resolveSource = resolve;
  });
  const f = await mountWorkspaceComponent(t, (url) =>
    url === '/records/historical?revision=1' ? pending : undefined,
  );
  const edl = {
    schemaVersion: 2,
    episodeId: 'episode',
    width: 128,
    height: 128,
    fps: 24,
    clips: [{ assetId: 'historical', revision: 1, in: 0, out: 1, volume: 1 }],
    audio: [],
    overlays: [],
  };
  const opening = f.state.openEdit({
    id: 'edit',
    revision: 2,
    data: { name: 'Opened', edl, sourceRefs: [{ id: 'historical', revision: 1 }] },
  });
  f.state.edl.value.clips[0].out = 0.5;
  await Vue.nextTick();
  resolveSource({ ...f.video, id: 'historical' });
  await opening;
  assert.equal(f.state.dirty.value, true);
  assert.equal(JSON.parse(f.state.baseline.value).edl.clips[0].out, 1);
  assert.equal(JSON.parse(f.storage.get('studio-review-draft:run')!).edl.clips[0].out, 0.5);
});

test('actual image playback advances 72 frames over three seconds at 60 Hz and transitions to video', async (t) => {
  let clock = 0;
  t.mock.method(performance, 'now', () => clock);
  const f = await mountWorkspaceComponent(t);
  f.state.edl.value.clips = [
    { assetId: 'image', revision: 1, in: 0, out: 4, volume: 1 },
    { assetId: 'video', revision: 1, in: 0, out: 1, volume: 1 },
  ];
  await Vue.nextTick();
  await f.state.play();
  for (let tick = 1; tick <= 180; tick++) {
    clock = (tick * 1000) / 60;
    f.state.tick(clock);
  }
  assert.equal(f.state.frame.value, 72);
  let plays = 0;
  f.state.video.value = {
    currentTime: 0,
    volume: 1,
    play: async () => {
      plays++;
    },
    pause() {},
  };
  for (let tick = 181; tick <= 240; tick++) {
    clock = (tick * 1000) / 60;
    f.state.tick(clock);
  }
  await Vue.nextTick();
  await Promise.resolve();
  assert.equal(f.state.frame.value, 96);
  assert.equal(f.state.selected.value, 1);
  assert.equal(f.state.currentAsset.value.id, 'video');
  assert.equal(plays, 1);
});

test('actual editor initial load never overwrites typing or media added before saved edits arrive', async (t) => {
  let resolveList!: (value: any) => void;
  const pending = new Promise((resolve) => {
    resolveList = resolve;
  });
  const f = await mountWorkspaceComponent(t, (url, method) =>
    method === 'GET' && url.endsWith('/review-edits') ? pending : undefined,
  );
  f.state.name.value = 'New title while loading';
  f.state.addAsset(f.image);
  resolveList({
    items: [
      {
        id: 'old-edit',
        revision: 1,
        data: {
          name: 'Old saved title',
          edl: {
            ...JSON.parse(JSON.stringify(f.state.edl.value)),
            clips: [{ assetId: 'video', revision: 1, in: 0, out: 1, volume: 1 }],
          },
          sourceRefs: [{ id: 'video', revision: 1 }],
        },
      },
    ],
    jobs: [],
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.state.name.value, 'New title while loading');
  assert.equal(f.state.edl.value.clips[0].assetId, 'image');
  assert.equal(f.state.dirty.value, true);
  assert.equal(
    JSON.parse(f.storage.get('studio-review-draft:run')!).name,
    'New title while loading',
  );
});

test('actual editor clamps the frame counter and selection after trimming or removing the tail', async (t) => {
  const f = await mountWorkspaceComponent(t);
  f.state.assets.value.push({
    ...f.video,
    id: 'long-video',
    data: { ...f.video.data, duration: 12.25 },
  });
  f.state.edl.value.clips = [{ assetId: 'long-video', revision: 1, in: 0, out: 12.25, volume: 1 }];
  await Vue.nextTick();
  await f.state.seek(293);
  assert.equal(f.state.frame.value, 293);
  assert.equal(f.state.totalFrames.value, 294);
  f.state.edl.value.clips[0].out = 12;
  await Vue.nextTick();
  await Vue.nextTick();
  assert.equal(f.state.totalFrames.value, 288);
  assert.equal(f.state.frame.value, 287);
  f.state.edl.value.clips.splice(0, 1);
  await Vue.nextTick();
  await Vue.nextTick();
  assert.equal(f.state.totalFrames.value, 0);
  assert.equal(f.state.frame.value, 0);
  assert.equal(f.state.selected.value, 0);
});

test('actual editor unmount during initial load preserves draft and never installs a late frame loop or listener', async (t) => {
  let resolveList!: (value: any) => void;
  const pending = new Promise((resolve) => {
    resolveList = resolve;
  });
  const f = await mountWorkspaceComponent(t, (url, method) =>
    method === 'GET' && url.endsWith('/review-edits') ? pending : undefined,
  );
  f.state.name.value = 'Before leaving';
  f.state.addAsset(f.image);
  f.app.unmount();
  resolveList({ items: [], jobs: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.lifecycle.frames, 0);
  assert.equal(f.lifecycle.listeners.size, 0);
  assert.equal(JSON.parse(f.storage.get('studio-review-draft:run')!).name, 'Before leaving');
});

test('actual delivery UI fixes unobserved export, retries a lost receipt and invalidates changed-basis observations', async (t) => {
  const snapshot: any = {
    project: { id: 'project', data: { mode: 'short' } },
    run: { id: 'run', revision: 4, data: { episodeId: 'episode' } },
    episodes: [],
    assets: [],
    candidates: [],
    jobs: [],
  };
  let view: any = {
    plan: {
      id: 'plan',
      revision: 1,
      data: {
        target: { mode: 'scope', scope: { id: 'scope', revision: 1 } },
        duration: { mode: 'derive' },
        pendingChecks: [],
      },
    },
    edl: {
      id: 'edl',
      revision: 1,
      data: { clips: [{ assetId: 'source', revision: 1, in: 0, out: 1 }], audio: [], overlays: [] },
    },
    assets: [{ id: 'actual-film', revision: 1, data: { sha256: 'fixed' } }],
    blockers: [],
    basisDigest: 'fixed-basis',
    exports: [],
    validConfirmation: false,
  };
  const posts: any[] = [];
  let first = true;
  const f = await mountWorkspaceComponent(
    t,
    (url, method, body) => {
      if (url === '/creation-runs/run')
        return { run: structuredClone(snapshot.run), deliveryPlans: [view.plan] };
      if (url === '/delivery-plans/plan') return structuredClone(view);
      if (url.endsWith('/final-confirmation')) {
        posts.push(structuredClone(body));
        if (first) {
          first = false;
          return Promise.reject(new Error('Simulated lost reply'));
        }
        view.validConfirmation = true;
        return { id: 'receipt' };
      }
    },
    { file: 'DeliveryPlans.vue', snapshot },
  );
  await f.state.select('plan');
  await f.state.confirm();
  assert.equal(posts[0].watched, false);
  assert.equal(posts[0].listened, false);
  assert.equal(posts.length, 1);
  await f.state.confirm();
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0], posts[1]);
  assert.deepEqual(posts[0].planRef, { id: 'plan', revision: 1 });
  assert.deepEqual(posts[0].exportAsset, { id: 'actual-film', revision: 1 });
  await f.state.confirm();
  assert.equal(posts.length, 2);
  view = {
    ...view,
    basisDigest: 'changed',
    validConfirmation: false,
    assets: [{ id: 'changed-film', revision: 1 }],
  };
  await f.state.load();
  assert.equal(f.state.played.value, false);
  assert.equal(f.state.watched.value, false);
  assert.equal(f.state.listened.value, false);
  assert.equal(f.state.conclusion.value, '');
  f.state.played.value = true;
  f.state.watched.value = true;
  f.state.listened.value = true;
  f.state.conclusion.value = 'New review';
  f.state.draft.value.edlDraft.clips[0].out = 0.5;
  await f.state.confirm();
  assert.equal(posts.length, 2);
  assert.match(f.state.error.value, /保存修改/);
});

test('delivery save freezes the submitted draft and preserves edits during its version lookup', async (t) => {
  let resolveCurrent!: (value: any) => void,
    defer = false,
    submitted: any;
  const snapshot = {
    project: { id: 'project' },
    run: { id: 'run', revision: 1, data: {} },
    episodes: [],
    assets: [],
    jobs: [],
  };
  let view: any = {
    plan: {
      id: 'plan',
      revision: 1,
      data: { target: { mode: 'work' }, duration: { mode: 'derive' }, pendingChecks: [] },
    },
    edl: {
      id: 'edl',
      revision: 1,
      data: {
        clips: [{ assetId: 'video', revision: 1, in: 0, out: 1, volume: 1 }],
        audio: [],
        overlays: [],
      },
    },
    assets: [],
    basisDigest: 'first',
    exports: [],
    blockers: [],
  };
  const f = await mountWorkspaceComponent(
    t,
    (url, method, body) => {
      if (url === '/creation-runs/run') {
        if (defer) {
          defer = false;
          return new Promise((resolve) => {
            resolveCurrent = resolve;
          });
        }
        return { run: snapshot.run, deliveryPlans: [view.plan] };
      }
      if (url === '/delivery-plans/plan') {
        if (method === 'PUT') {
          submitted = structuredClone(body);
          view = {
            ...view,
            plan: { ...view.plan, revision: 2 },
            edl: { ...view.edl, revision: 2, data: body.edlDraft },
            basisDigest: 'second',
          };
          return view.plan;
        }
        return structuredClone(view);
      }
    },
    { file: 'DeliveryPlans.vue', snapshot },
  );
  await f.state.select('plan');
  f.state.draft.value.edlDraft.clips[0].volume = 0.5;
  defer = true;
  const saving = f.state.save();
  f.state.draft.value.edlDraft.clips[0].volume = 0.2;
  resolveCurrent({ run: snapshot.run });
  await saving;
  assert.equal(submitted.edlDraft.clips[0].volume, 0.5);
  assert.equal(f.state.draft.value.edlDraft.clips[0].volume, 0.2);
  assert.equal(f.state.dirty.value, true);
  assert.equal(f.state.error.value, '');
});

test('reference confirmations invalidate only changed requirements, subjects or exact media versions', async (t) => {
  const snapshot = Vue.reactive({
    project: { id: 'project' },
    run: { id: 'run', revision: 1, data: {} },
    subjects: [{ key: 'actor', description: 'original' }],
    requirements: [
      {
        id: 'face',
        subjectKey: 'actor',
        description: 'front',
        inScope: true,
        binding: null as any,
      },
    ],
    assets: [{ id: 'image', revision: 1, data: { sha256: 'original' } }],
    jobs: [],
  });
  const f = await mountWorkspaceComponent(t, undefined, {
    file: 'ReferenceConfirmation.vue',
    snapshot,
  });
  const choice = f.state.choices.value.face;
  choice.assetId = 'image';
  choice.inspected = true;
  choice.conclusion = 'Actually inspected';
  snapshot.run.revision++;
  snapshot.requirements[0].binding = { updated: true };
  await Vue.nextTick();
  assert.equal(choice.inspected, true);
  snapshot.assets[0].revision++;
  assert.equal(choice.inspected, false);
  assert.equal(choice.conclusion, '');
  choice.inspected = true;
  choice.conclusion = 'New media inspected';
  snapshot.requirements[0].description = 'side view';
  assert.equal(choice.inspected, false);
  choice.inspected = true;
  snapshot.subjects[0].description = 'changed identity';
  assert.equal(choice.inspected, false);
  choice.inspected = true;
  choice.conclusion = 'Previously reviewed as reference only';
  choice.asGroupStart = true;
  assert.equal(choice.inspected, false);
  assert.equal(choice.conclusion, '');
});

test('a first-frame reference must explicitly cover one group opening', () => {
  const groups = [
    { id: 'g1', shotIds: ['s1', 's2'], transition: 'independent' as const, reason: 'test' },
    { id: 'g2', shotIds: ['s3'], transition: 'independent' as const, reason: 'test' },
  ];
  const item = { mediaType: 'image', purpose: 'composition', shotIds: ['s1'] };
  assert.equal(referenceStartGroup(item, groups)?.id, 'g1');
  assert.equal(referenceStartGroup({ ...item, shotIds: ['s1', 's2'] }, groups)?.id, 'g1');
  assert.equal(referenceStartGroup({ ...item, shotIds: ['s2'] }, groups), null);
  assert.equal(referenceStartGroup({ ...item, shotIds: ['s1', 's3'] }, groups), null);
  assert.equal(referenceStartGroup({ ...item, shotIds: [] }, groups), null);
  assert.equal(referenceStartGroup({ ...item, purpose: 'identity' }, groups), null);
  assert.equal(referenceStartGroup({ ...item, mediaType: 'audio' }, groups), null);
});

test('new unreferenced library assets can be reviewed and batch-bound without expanding workspace assets', async (t) => {
  const snapshot = Vue.reactive({
    project: { id: 'project' },
    run: { id: 'run', revision: 7, data: { stage: 'production' } },
    subjects: [],
    requirements: [
      {
        id: 'opening',
        mediaType: 'image',
        purpose: 'composition',
        shotIds: ['s1'],
        inScope: true,
        description: 'opening image',
      },
    ],
    results: {
      director: {
        data: {
          result: {
            groups: [{ id: 'g1', shotIds: ['s1'], transition: 'independent', reason: 'opening' }],
          },
        },
      },
    },
    assets: [],
    jobs: [],
  });
  const posts: any[] = [];
  let finish!: () => void;
  const f = await mountWorkspaceComponent(
    t,
    (_url, method, body) => {
      if (method === 'POST') {
        posts.push(structuredClone(body));
        return new Promise((resolve) => {
          finish = () => resolve({});
        });
      }
    },
    { file: 'ReferenceConfirmation.vue', snapshot },
  );
  const image = {
    id: 'new-image',
    projectId: 'project',
    revision: 3,
    data: { mediaType: 'image', sha256: 'actual-import', stale: false },
  };
  f.state.libraryRequirement.value = 'opening';
  f.state.pickAsset({ ...image, projectId: 'other-project' });
  assert.equal(f.state.choices.value.opening.assetId, '');
  f.state.pickAsset(image);
  assert.equal(snapshot.assets.length, 0);
  assert.equal(f.state.assetFor('opening').revision, 3);
  await f.state.confirm();
  assert.equal(posts.length, 0, 'selection alone is not a visual review');
  const choice = f.state.choices.value.opening;
  choice.asGroupStart = true;
  choice.inspected = true;
  choice.conclusion = 'Actual image inspected; use at the group opening';
  const pending = f.state.confirm();
  await f.state.confirm();
  assert.equal(posts.length, 1);
  assert.deepEqual(posts[0].items[0].asset, { id: image.id, revision: 3 });
  assert.equal(posts[0].items[0].asGroupStart, true);
  assert.equal(posts[0].runRevision, 7);
  finish();
  await pending;
  assert.equal(f.state.choices.value.opening.inspected, false);
});

test('scope wording requires an explicit review and reuses only exact-source translations', async (t) => {
  const prior = { path: '/direction/visual', source: '自然光', text: 'Natural light.' };
  const snapshot: any = {
    project: { id: 'project' },
    run: { id: 'run', revision: 2, data: {} },
    jobs: [],
    layout: { data: { view: 'storyboard', assistantCollapsed: true } },
    results: { direction: { data: { result: { stage: 'direction', visual: '自然光' } } } },
    scope: {
      data: {
        executionText: { reviewed: true, entries: [prior] },
        output: { width: 1280, height: 736, steps: 20, seed: 0 },
      },
    },
  };
  const posts: any[] = [];
  const f = await mountWorkspaceComponent(
    t,
    (url, method, body) => {
      if (method === 'GET' && url.includes('/workspace')) return snapshot;
      if (method === 'POST') {
        posts.push(body);
        return {};
      }
    },
    { file: 'WorkStudio.vue', props: { project: snapshot.project, version: 1 } },
  );
  f.state.chooseScope(['s1']);
  assert.equal(f.state.scopeWording.value[0].text, prior.text);
  assert.equal(f.state.wordingReviewed.value, false);
  await f.state.saveScope();
  assert.equal(posts.length, 0);
  f.state.wordingReviewed.value = true;
  await f.state.saveScope();
  assert.deepEqual(posts[0].executionText, { reviewed: true, entries: [prior] });
  assert.deepEqual(posts[0].shotIds, ['s1']);
  snapshot.results.direction.data.result.visual = '晨光';
  f.state.chooseScope(['s1']);
  assert.equal(f.state.scopeWording.value[0].text, '');
  assert.equal(f.state.wordingReviewed.value, false);
});
