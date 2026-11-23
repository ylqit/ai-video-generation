import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fixture } from './fixtures/workspace.js';
import { configureModel } from './fixtures/models.js';
import { Worker } from '../src/server/worker.js';
import { executeProviderMedia, providerMediaRequest } from '../src/server/provider-media.js';
import { prepareImageTask, submitImageTask } from '../src/server/image-production.js';
import { CreationMediaService } from '../src/server/creation-media.js';
import { modelUsage } from '../src/server/model-usage.js';
import { runProcess, ingestAsset } from '../src/server/media.js';
import { config, prepareData } from '../src/server/config.js';
import type { ModelProtocol } from '../src/shared/models.js';

async function setup(t: any, protocol: ModelProtocol, image = false) {
  const f = fixture(t, image, false, undefined, { canvasTreatment: 'letterbox' }),
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-execution-'));
  prepareData(root);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const j of f.store.jobs()) f.store.patchJob(j.id, { state: 'cancelled' });
  process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline-dummy';
  t.after(() => {
    delete process.env.STUDIO_PROTOCOL_TEST_KEY;
  });
  const selected = configureModel(f.store, f.project.id, protocol);
  return { ...f, ...selected, root };
}

function videoJob(f: Awaited<ReturnType<typeof setup>>) {
  const scope = f.select(),
    p = f.workspace.preview(
      scope.scope.id,
      scope.scope.revision,
      f.creation.get(f.run.id).revision,
    );
  assert.deepEqual(p.issues, []);
  f.workspace.submit(
    scope.scope.id,
    scope.scope.revision,
    f.creation.get(f.run.id).revision,
    p.preview.digest,
    crypto.randomUUID(),
  );
  return f.store.jobs(f.project.id).find((j) => j.kind === 'generation')!;
}

for (const protocol of ['minimax-video', 'ark-video'] as const)
  test(
    protocol +
      ' archives original and 24fps working media, including recovery after download failure',
    async (t) => {
      const f = await setup(t, protocol),
        job = videoJob(f);
      const file = path.join(f.root, 'fixture-30fps.mp4');
      await runProcess(config.ffmpeg, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=blue:s=320x240:r=30:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=1',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-shortest',
        file,
      ]);
      const bytes = await fs.readFile(file);
      let posts = 0,
        polls = 0,
        downloads = 0;
      const request = (async (url: any, init?: RequestInit) => {
        if (String(url).includes('/media.mp4')) {
          downloads++;
          if (downloads === 1) throw new Error('offline download interruption');
          return new Response(bytes);
        }
        if (init?.method === 'POST') {
          posts++;
          const body = JSON.parse(String(init.body));
          assert.equal(body.duration, 12);
          assert.ok(
            String(url).endsWith(
              protocol === 'minimax-video' ? '/v2/video_generation' : '/contents/generations/tasks',
            ),
          );
          return Response.json(
            protocol === 'minimax-video' ? { task_id: 'remote-one' } : { id: 'remote-one' },
            { headers: { 'x-request-id': 'receipt' } },
          );
        }
        polls++;
        assert.ok(String(url).endsWith('/remote-one'));
        const task = {
          id: 'remote-one',
          model: 'actual-offline-model',
          status: 'succeeded',
          content:
            protocol === 'minimax-video'
              ? { url: 'https://media.invalid/media.mp4' }
              : { video_url: 'https://media.invalid/media.mp4' },
          usage: { generated_tokens: 12 },
        };
        return Response.json(protocol === 'minimax-video' ? { task } : task);
      }) as typeof fetch;
      const worker = new Worker(f.store, f.root, undefined, undefined, undefined, request);
      t.after(() => worker.stop());
      await worker.execute(job, 'model', new AbortController().signal);
      assert.equal(f.store.job(job.id).output.remote.taskId, 'remote-one');
      f.registry.saveConnection(
        { revision: 1, data: { ...f.connection.data, enabled: false } },
        f.connection.id,
      );
      await worker.execute(f.store.job(job.id), 'model', new AbortController().signal);
      await worker.execute(f.store.job(job.id), 'media', new AbortController().signal);
      assert.equal(f.store.job(job.id).state, 'failed');
      assert.equal(f.store.job(job.id).output.remote.taskId, 'remote-one');
      f.store.patchJob(job.id, { state: 'archiving' });
      await worker.execute(f.store.job(job.id), 'media', new AbortController().signal);
      const done = f.store.job(job.id);
      assert.equal(done.state, 'succeeded', done.error || undefined);
      assert.equal(posts, 1);
      assert.ok(polls >= 3);
      const work = f.store.get(done.output.videoAssetId);
      assert.equal(work.data.frameCount, 24);
      assert.equal(work.data.timeBase.sourceTimestamps.length, 30);
      assert.equal(work.data.timeBase.playbackRate, 1);
      assert.equal(f.store.get(work.data.timeBase.source.id).data.frameCount, 30);
      assert.equal(work.data.adopted, false);
      assert.equal(done.output.mediaCheck.visualReview, 'pending');
      assert.ok(
        f.store.list('asset', f.project.id).some((a) => a.data.category === 'original_audio'),
      );
      const before = f.store.list('asset', f.project.id).length;
      await worker.execute({ ...done, state: 'archiving' }, 'media', new AbortController().signal);
      assert.equal(f.store.list('asset', f.project.id).length, before);
      assert.equal(posts, 1);
    },
  );

test('timeout after submission remains unknown through restart and never repeats POST', async (t) => {
  const f = await setup(t, 'minimax-video'),
    job = videoJob(f);
  let posts = 0;
  const request = (async () => {
    posts++;
    throw new Error('reply lost');
  }) as typeof fetch;
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, request);
  t.after(() => worker.stop());
  await worker.execute(job, 'model', new AbortController().signal);
  assert.equal(f.store.job(job.id).state, 'unknown');
  f.store.recover();
  for (let i = 0; i < 3; i++)
    await worker.execute(f.store.job(job.id), 'model', new AbortController().signal);
  assert.equal(posts, 1);
  assert.equal(f.store.job(job.id).state, 'unknown');
  assert.equal(modelUsage(f.store, f.project.id).videoRequests, 1);
});

test('persisted response recovers exact remote identity without a new request', async (t) => {
  const f = await setup(t, 'minimax-video'),
    job = videoJob(f);
  const dir = path.join(f.root, 'saved-response');
  await fs.mkdir(dir);
  await fs.writeFile(
    path.join(dir, 'response.json'),
    JSON.stringify({ data: { task_id: 'original-id' }, requestId: 'saved' }),
  );
  f.store.patchJob(job.id, { state: 'submitting', output: { executionDir: dir } });
  f.store.recover();
  await executeProviderMedia(
    f.store,
    f.root,
    f.store.job(job.id),
    'restarted',
    undefined,
    (async () => {
      throw new Error('network must not run');
    }) as typeof fetch,
  );
  assert.equal(f.store.job(job.id).state, 'submitted');
  assert.equal(f.store.job(job.id).output.remote.taskId, 'original-id');
});

test('disabled queued connection is held while a different connection can submit', async (t) => {
  const f = await setup(t, 'minimax-video'),
    first = videoJob(f);
  const other = configureModel(f.store, f.project.id, 'ark-video');
  const e = other.registry.resolve(f.project.id, f.run.data.episodeId, 'video')!;
  const second = f.store.createJob(
    'generation',
    f.project.id,
    f.run.data.episodeId,
    {
      ...first.input,
      modelExecution: e,
      prepared: {
        ...first.input.prepared,
        request: { ...first.input.prepared.request, model: e.modelId },
      },
    },
    'other-connection',
  );
  f.registry.saveConnection(
    { revision: 1, data: { ...f.connection.data, enabled: false } },
    f.connection.id,
  );
  let posts = 0;
  const worker = new Worker(
    f.store,
    f.root,
    undefined,
    async () => {
      throw new Error('unexpected authoring');
    },
    undefined,
    (async () => {
      posts++;
      return Response.json({ id: 'ark-task' });
    }) as typeof fetch,
  );
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.job(first.id).holdReason, 'model_connection_disabled');
  assert.equal(f.store.job(second.id).state, 'submitted');
  assert.equal(posts, 1);
});

for (const protocol of ['responses', 'chat-completions'] as const)
  test(
    protocol + ' uses fixed structured output and recovers saved response without resubmission',
    async (t) => {
      const f = await setup(t, protocol),
        media = new CreationMediaService(f.store, f.root);
      const accepted = media.message(f.run.id, {
        revision: f.creation.get(f.run.id).revision,
        mode: 'discuss',
        request: 'Explain the selected work.',
        references: [],
        idempotencyKey: crypto.randomUUID(),
      });
      let posts = 0;
      const request = (async (url: any, init?: RequestInit) => {
        posts++;
        const body = JSON.parse(String(init?.body));
        assert.equal(body.model, 'offline-model');
        assert.ok(
          String(url).endsWith(protocol === 'responses' ? '/responses' : '/chat/completions'),
        );
        assert.equal(
          protocol === 'responses'
            ? body.text.format.strict
            : body.response_format.json_schema.strict,
          true,
        );
        const output = JSON.stringify({
          answer: 'Offline protocol response; media not reviewed.',
          resultLinks: [],
        });
        return Response.json({
          model: 'actual-offline-text',
          usage: { total_tokens: 20 },
          ...(protocol === 'responses'
            ? { output: [{ content: [{ type: 'output_text', text: output }] }] }
            : { choices: [{ message: { content: output } }] }),
        });
      }) as typeof fetch;
      const worker = new Worker(f.store, f.root, undefined, undefined, undefined, request);
      t.after(() => worker.stop());
      await worker.execute(accepted.job!, 'model', new AbortController().signal);
      const done = f.store.job(accepted.job!.id);
      assert.equal(done.state, 'succeeded', done.error || undefined);
      assert.equal(done.output.providerReceipt.usage.total_tokens, 20);
      f.store.patchJob(done.id, { state: 'unknown' });
      await worker.execute(f.store.job(done.id), 'model', new AbortController().signal);
      assert.equal(posts, 1);
      assert.equal(modelUsage(f.store, f.project.id).textRequests, 1);
    },
  );

test('Images generation and edit return candidates through the existing task, without auto-adoption', async (t) => {
  const f = await setup(t, 'openai-images', true),
    media = new CreationMediaService(f.store, f.root);
  const { task } = media.createAssetTask(f.run.id, {
    revision: f.creation.get(f.run.id).revision,
    requirementId: 'outside',
    maxRevisions: 2,
    idempotencyKey: crypto.randomUUID(),
  });
  const png = path.join(f.root, 'fixture.png');
  await runProcess(config.ffmpeg, [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=green:s=320x320',
    '-frames:v',
    '1',
    png,
  ]);
  const bytes = await fs.readFile(png);
  const preparation = {
    taskRevision: task.revision,
    viewId: 'outside',
    operation: 'generate',
    prompt: 'A generic silver product, isolated.',
    references: [],
  };
  const preview = prepareImageTask(f.store, task.id, preparation);
  const body = {
    preparation,
    digest: preview.digest,
    approved: true,
    idempotencyKey: 'image-once',
  };
  const job = submitImageTask(f.store, task.id, body);
  assert.equal(submitImageTask(f.store, task.id, body).id, job.id);
  let posts = 0;
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async (url: any) => {
    posts++;
    assert.ok(String(url).endsWith('/images/generations'));
    return Response.json({
      data: [{ b64_json: bytes.toString('base64') }],
      usage: { total_tokens: 12 },
    });
  }) as typeof fetch);
  t.after(() => worker.stop());
  await worker.execute(job, 'model', new AbortController().signal);
  await worker.execute(f.store.job(job.id), 'media', new AbortController().signal);
  const done = f.store.job(job.id);
  assert.equal(done.state, 'succeeded', done.error || undefined);
  const candidate = f.store.get(done.output.assetIds[0]);
  assert.equal(candidate.data.adopted, false);
  assert.equal(candidate.data.prompt, preparation.prompt);
  assert.equal(
    f.store.get(task.id).data.deliveries[0].executionReceipt.evidence,
    'provider_receipt',
  );
  await worker.execute({ ...done, state: 'archiving' }, 'media', new AbortController().signal);
  assert.equal(f.store.get(task.id).data.deliveries.length, 1);
  assert.equal(posts, 1);
  const adopted = f.store.update(candidate.id, candidate.revision, {
    ...candidate.data,
    adopted: true,
  });
  const edit = prepareImageTask(f.store, task.id, {
    ...preparation,
    taskRevision: f.store.get(task.id).revision,
    operation: 'edit',
    references: [{ id: adopted.id, revision: adopted.revision }],
  });
  const wire = await providerMediaRequest(f.root, { kind: 'image', input: edit.input } as any);
  assert.equal(wire.resource, '/images/edits');
  assert.match(wire.contentType, /^multipart\/form-data;/);
  const form = await new Response(wire.body, {
    headers: { 'Content-Type': wire.contentType },
  }).formData();
  assert.equal(form.getAll('image[]').length, 1);
  assert.equal(form.get('prompt'), preparation.prompt);
  assert.equal(modelUsage(f.store, f.project.id).images, 1);
});

test('definite API rejection fails without automatic retry; malformed saved text remains recoverable evidence', async (t) => {
  const f = await setup(t, 'responses'),
    media = new CreationMediaService(f.store, f.root);
  const accepted = media.message(f.run.id, {
    revision: f.creation.get(f.run.id).revision,
    mode: 'discuss',
    request: 'Offline request.',
    references: [],
    idempotencyKey: crypto.randomUUID(),
  });
  const worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async () =>
    Response.json({ error: { message: 'invalid request' } }, { status: 400 })) as typeof fetch);
  t.after(() => worker.stop());
  await worker.execute(accepted.job!, 'model', new AbortController().signal);
  assert.equal(f.store.job(accepted.job!.id).state, 'failed');
  const second = media.message(f.run.id, {
    revision: f.creation.get(f.run.id).revision,
    mode: 'discuss',
    request: 'Another request.',
    references: [],
    idempotencyKey: crypto.randomUUID(),
  });
  worker.requestModel = (async () => Response.json({ output_text: '{bad json' })) as typeof fetch;
  await worker.execute(second.job!, 'model', new AbortController().signal);
  const failed = f.store.job(second.job!.id);
  assert.equal(failed.state, 'failed');
  assert.ok(failed.output.descriptor.textResponseFile);
  f.store.patchJob(failed.id, { state: 'unknown' });
  worker.requestModel = (async () => {
    throw new Error('must not resend');
  }) as typeof fetch;
  await worker.execute(f.store.job(failed.id), 'model', new AbortController().signal);
  assert.equal(f.store.job(failed.id).state, 'failed');
});

test('missing credentials fail before transport rather than becoming an unknown accepted request', async (t) => {
  for (const protocol of ['responses', 'minimax-video'] as const) {
    const f = await setup(t, protocol);
    const job =
      protocol === 'responses'
        ? new CreationMediaService(f.store, f.root).message(f.run.id, {
            revision: f.creation.get(f.run.id).revision,
            mode: 'discuss',
            request: 'No credentials.',
            references: [],
            idempotencyKey: crypto.randomUUID(),
          }).job!
        : videoJob(f);
    delete process.env.STUDIO_PROTOCOL_TEST_KEY;
    let posts = 0;
    const worker = new Worker(f.store, f.root, undefined, undefined, undefined, (async () => {
      posts++;
      throw new Error('must not send');
    }) as typeof fetch);
    t.after(() => worker.stop());
    await worker.execute(job, 'model', new AbortController().signal);
    assert.equal(f.store.job(job.id).state, 'failed');
    assert.equal(posts, 0);
  }
});
