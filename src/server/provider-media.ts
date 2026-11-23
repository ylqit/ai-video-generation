import { assertAssistantMaySubmit } from './assistant-usage.js';
import { imageEditGuide, compositeImageEdit } from './image-edit-media.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Store, HttpError } from './db.js';
import { inside } from './config.js';
import { hashFile, probeMedia, ingestAsset } from './media.js';
import { modelRequest, ModelHttpError } from './model-http.js';
import { archiveVideoCandidate } from './candidate-archive.js';
import { CreationMediaService } from './creation-media.js';
import type { Job } from '../shared/contracts.js';
import { modelAvailable, type ModelExecution } from '../shared/models.js';

async function mediaBytes(root: string, asset: any) {
  const file = inside(root, asset.data.path);
  if ((await hashFile(file)) !== asset.data.sha256) throw new Error('固定参考文件哈希已变化');
  const bytes = await fs.readFile(file);
  const kind = asset.data.mediaType;
  if (bytes.length > (kind === 'video' ? 50 : kind === 'audio' ? 15 : 30) * 1024 * 1024)
    throw new Error('参考媒体超过传输限制');
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === '.png'
      ? 'image/png'
      : ['.jpg', '.jpeg'].includes(ext)
        ? 'image/jpeg'
        : kind === 'video' && ['.mp4', '.mov'].includes(ext)
          ? ext === '.mov'
            ? 'video/quicktime'
            : 'video/mp4'
          : kind === 'audio' && ['.mp3', '.wav'].includes(ext)
            ? ext === '.wav'
              ? 'audio/wav'
              : 'audio/mpeg'
            : ext === '.webp'
              ? 'image/webp'
              : null;
  if (!mime) throw new Error('接口仅接收 PNG、JPEG、WebP 图片');
  return { bytes, mime, name: path.basename(file) };
}

export async function providerMediaRequest(root: string, job: Job) {
  const execution: ModelExecution = job.input.modelExecution;
  const logical = structuredClone(job.input.prepared.request);
  if (job.kind === 'image' && job.input.imageOperation === 'edit') {
    const form = new FormData();
    for (const [key, value] of Object.entries(logical)) form.set(key, String(value));
    for (const entry of job.input.assets) {
      const file = await mediaBytes(root, entry.asset);
      form.append(
        'image[]',
        new Blob([new Uint8Array(file.bytes)], { type: file.mime }),
        file.name,
      );
    }
    if (job.input.imageEdit?.action === 'inpaint') {
      const guide = await imageEditGuide(root, job);
      form.append(
        'image[]',
        new Blob([new Uint8Array(await fs.readFile(guide))], { type: 'image/png' }),
        'edit-guide.png',
      );
    }
    const encoded = new Request('https://studio.invalid', { method: 'POST', body: form });
    const body = new Uint8Array(await encoded.arrayBuffer());
    if (body.byteLength > 64 * 1024 * 1024) throw new Error('图片编辑请求超过传输预算');
    return {
      resource: '/images/edits',
      body,
      contentType: encoded.headers.get('content-type')!,
      logical,
    };
  }
  if (job.kind === 'generation')
    for (const item of logical.content) {
      if (!['image_url', 'video_url', 'audio_url'].includes(item.type)) continue;
      const binding = job.input.prepared.inputBindings.find(
        (b: any) => `studio-asset:${b.asset.id}:${b.asset.revision}` === item[item.type].url,
      );
      if (!binding) throw new Error('Prompt 媒体槽没有对应固定绑定');
      const asset = job.input.assets.find(
        (a: any) => a.asset.id === binding.asset.id && a.asset.revision === binding.asset.revision,
      )?.asset;
      if (!asset || asset.data.sha256 !== binding.sha256) throw new Error('参考绑定摘要不匹配');
      const file = await mediaBytes(root, asset);
      item[item.type].url = `data:${file.mime};base64,${file.bytes.toString('base64')}`;
    }
  const body = JSON.stringify(logical);
  if (Buffer.byteLength(body) > 64 * 1024 * 1024) throw new Error('媒体请求超过 64 MB');
  return {
    resource:
      job.kind === 'image'
        ? '/images/generations'
        : execution.protocol === 'minimax-video'
          ? '/v2/video_generation'
          : '/contents/generations/tasks',
    body,
    contentType: 'application/json',
    logical: job.input.prepared.request,
  };
}

export async function queryProviderVideo(
  store: Store,
  job: Job,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
) {
  const execution: ModelExecution = job.input.modelExecution;
  const id = job.output.remote?.taskId;
  if (!id || job.output.remote.connectionId !== execution.connection.id)
    throw new HttpError(409, '缺少匹配固定连接的远端任务身份');
  const route =
    execution.protocol === 'minimax-video'
      ? '/v2/query/video_generation/'
      : '/contents/generations/tasks/';
  const response = await modelRequest(
    store,
    execution.connection,
    route + encodeURIComponent(id),
    { signal },
    request,
  );
  const task = execution.protocol === 'minimax-video' ? response.data.task : response.data;
  if (!task || String(task.id) !== String(id)) throw new Error('远端查询回执与任务身份不匹配');
  return { ...response, task, url: task.content?.url || task.content?.video_url || null };
}

// Submission identity is persisted before polling; unknown acceptance never invokes POST again.
export async function executeProviderMedia(
  store: Store,
  root: string,
  job: Job,
  owner: string,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
) {
  const execution: ModelExecution = job.input.modelExecution;
  const dir = inside(root, `jobs/${job.id}/runs/${owner}`);
  if (job.state === 'queued') {
    store.patchJob(job.id, { state: 'preparing', error: null });
    await fs.mkdir(dir, { recursive: true });
    const wire = await providerMediaRequest(root, job);
    signal?.throwIfAborted();
    await fs.writeFile(path.join(dir, 'input.json'), JSON.stringify(job.input, null, 2));
    await fs.writeFile(path.join(dir, 'request.body'), wire.body);
    await fs.writeFile(
      path.join(dir, 'request.json'),
      JSON.stringify(
        { resource: wire.resource, contentType: wire.contentType, logical: wire.logical },
        null,
        2,
      ),
    );
    if (store.job(job.id).cancelRequested) {
      store.patchJob(job.id, { state: 'cancelled' });
      return;
    }
    const currentConnection = store.db
      .prepare('SELECT data FROM model_connections WHERE id=?')
      .get(execution.connection.id);
    if (
      !currentConnection ||
      !modelAvailable(JSON.parse(String(currentConnection.data)), job.input.modelExecution.modelId)
    ) {
      store.patchJob(job.id, { state: 'queued', holdReason: 'model_connection_disabled' });
      return;
    }
    store.patchJob(job.id, {
      state: 'preparing',
      output: {
        ...job.output,
        executionDir: dir,
        requestBodySha256: await hashFile(path.join(dir, 'request.body')),
      },
    });
    try {
      const response = await modelRequest(
        store,
        execution.connection,
        wire.resource,
        { method: 'POST', headers: { 'Content-Type': wire.contentType }, body: wire.body, signal },
        request,
        () => {
          signal?.throwIfAborted();
          assertAssistantMaySubmit(store, job);
          if (store.job(job.id).cancelRequested) throw new HttpError(409, '提交前已取消');
          const enabled = store.db
            .prepare('SELECT data FROM model_connections WHERE id=?')
            .get(execution.connection.id);
          if (
            !enabled ||
            !modelAvailable(JSON.parse(String(enabled.data)), job.input.modelExecution.modelId)
          ) {
            store.patchJob(job.id, { state: 'queued', holdReason: 'model_connection_disabled' });
            throw new HttpError(409, '提交前连接已停用');
          }
          store.patchJob(job.id, { state: 'submitting' });
        },
      );
      await fs.writeFile(path.join(dir, 'response.json.part'), JSON.stringify(response));
      await fs.rename(path.join(dir, 'response.json.part'), path.join(dir, 'response.json'));
      signal?.throwIfAborted();
      recordSubmission(store, job, response, dir);
    } catch (error: any) {
      const current = store.job(job.id);
      if (current.state === 'queued' && current.holdReason) return;
      const definite =
        current.state === 'preparing' ||
        (error instanceof ModelHttpError &&
          [400, 401, 402, 403, 404, 413, 422, 429].includes(error.status));
      store.patchJob(job.id, {
        state: definite ? (current.cancelRequested ? 'cancelled' : 'failed') : 'unknown',
        error: `${definite ? '提交被拒绝' : '受理情况未知，未自动重发'}：${error.message}`,
      });
    }
    return;
  }
  if (job.state === 'unknown') {
    if (job.output.remote?.taskId) {
      store.patchJob(job.id, { state: 'submitted' });
      return;
    }
    const responseFile = job.output.executionDir
      ? path.join(job.output.executionDir, 'response.json')
      : null;
    if (responseFile) {
      const saved = await fs.readFile(responseFile, 'utf8').catch((e) => {
        if (e.code === 'ENOENT') return null;
        throw e;
      });
      if (saved) {
        recordSubmission(store, job, JSON.parse(saved), job.output.executionDir);
        return;
      }
    }
    store.patchJob(job.id, {
      error:
        '受理情况未知：没有可核验的远端编号或完整响应。请在供应商查询后绑定回执；不会按 Prompt 猜测匹配或重发。',
    });
    return;
  }
  if (job.state === 'archiving') {
    if (job.kind === 'image') await archiveImages(store, root, job, signal, request);
    else
      await archiveVideoCandidate(
        store,
        root,
        job,
        owner,
        async () => {
          // Requery the original task to refresh expiring links; never regenerate.
          const result = await queryProviderVideo(store, job, signal, request);
          if (result.task.status !== 'succeeded' || !result.url)
            throw new Error('原任务尚未提供可下载结果');
          const url = new URL(result.url);
          if (!['https:', 'http:'].includes(url.protocol)) throw new Error('结果地址协议无效');
          const response = await request(url, {
            signal: signal
              ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
              : AbortSignal.timeout(120000),
          });
          if (!response.ok) throw new Error('原任务媒体下载失败：HTTP ' + response.status);
          return response;
        },
        signal,
      );
    return;
  }
  const result = await queryProviderVideo(store, job, signal, request);
  if (store.job(job.id).output.waitSuspended) return;
  const status = result.task.status;
  const output = {
    ...store.job(job.id).output,
    lastCheckedAt: Date.now(),
    providerReceipt: {
      requestId: result.requestId,
      model: result.task.model || null,
      usage: result.task.usage || null,
      status,
    },
  };
  if (status === 'succeeded') {
    if (!result.url) throw new Error('任务成功但缺少视频地址');
    store.patchJob(job.id, {
      state: 'archiving',
      output: { ...output, descriptor: { url: result.url } },
      error: null,
    });
  } else if (['failed', 'expired'].includes(status))
    store.patchJob(job.id, { state: 'failed', output, error: '供应商任务终止：' + status });
  else if (['cancelled', 'canceled'].includes(status))
    store.patchJob(job.id, { state: 'cancelled', output, error: null });
  else if (['queued', 'pending', 'running', 'processing'].includes(status))
    store.patchJob(job.id, {
      state: ['running', 'processing'].includes(status) ? 'running' : 'submitted',
      output,
      error: job.cancelRequested
        ? 'API 删除接口也可能删除已完成结果；保持跟踪并归档，可明确暂停本机跟踪。'
        : null,
    });
  else throw new Error('未知供应商状态，保留任务身份等待核对：' + String(status));
}

function recordSubmission(store: Store, job: Job, response: any, dir: string) {
  const execution: ModelExecution = job.input.modelExecution;
  const output = {
    ...store.job(job.id).output,
    executionDir: dir,
    providerReceipt: {
      requestId: response.requestId,
      model: response.data.model || null,
      usage: response.data.usage || null,
    },
  };
  if (job.kind === 'image') {
    if (
      !Array.isArray(response.data.data) ||
      !response.data.data.length ||
      response.data.data.some((v: any) => !v.b64_json && !v.url)
    )
      throw new Error('图片响应缺少可归档候选');
    store.patchJob(job.id, {
      state: 'archiving',
      output: { ...output, descriptor: { imageResponseFile: path.join(dir, 'response.json') } },
      error: null,
    });
  } else {
    const id = execution.protocol === 'minimax-video' ? response.data.task_id : response.data.id;
    if (!id || !['string', 'number'].includes(typeof id))
      throw new Error('创建响应缺少任务编号，需要核对受理情况');
    store.patchJob(job.id, {
      state: 'submitted',
      output: {
        ...output,
        remote: {
          taskId: String(id),
          protocol: execution.protocol,
          connectionId: execution.connection.id,
          connectionRevision: execution.connection.revision,
        },
      },
      error: null,
    });
  }
}

async function archiveImages(
  store: Store,
  root: string,
  job: Job,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
) {
  const response = JSON.parse(await fs.readFile(job.output.descriptor.imageResponseFile, 'utf8'));
  const ids: string[] = [];
  for (const [index, item] of response.data.data.entries()) {
    signal?.throwIfAborted();
    const deliveryId = `${job.id}:${index}`;
    const existing = job.input.imageTask
      ? store
          .get(job.input.imageTask.id)
          .data.deliveries?.find((d: any) => d.deliveryId === deliveryId)
      : null;
    const archived =
      !job.input.imageTask &&
      store
        .list('asset', job.projectId!)
        .find((a) => a.data.jobId === job.id && a.data.deliveryId === deliveryId);
    if (archived) {
      ids.push(archived.id);
      continue;
    }
    if (existing) {
      ids.push(...existing.candidates.map((c: any) => c.asset.id));
      continue;
    }
    let bytes: Uint8Array;
    if (item.b64_json) bytes = Buffer.from(item.b64_json, 'base64');
    else {
      const url = new URL(item.url);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('图片结果地址协议无效');
      const result = await request(url, {
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
          : AbortSignal.timeout(120000),
      });
      if (!result.ok) throw new Error('图片下载失败，保留响应供恢复：' + result.status);
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (result.body)
        for await (const chunk of result.body as any) {
          size += chunk.length;
          if (size > 64 * 1024 * 1024) throw new Error('图片响应超过 64 MB');
          chunks.push(chunk);
        }
      bytes = Buffer.concat(chunks);
    }
    if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('图片响应超过 64 MB');
    const buffer = Buffer.from(bytes);
    const extension = buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? '.png'
      : buffer[0] === 255 && buffer[1] === 216
        ? '.jpg'
        : buffer.subarray(8, 12).toString() === 'WEBP'
          ? '.webp'
          : null;
    if (!extension) throw new Error('图片候选格式无效');
    const file = path.join(job.output.executionDir, `candidate-${index}${extension}`);
    await fs.writeFile(file, bytes);
    await probeMedia(file);
    if (!job.input.imageTask) {
      const composite =
        job.input.imageEdit?.action === 'inpaint'
          ? await compositeImageEdit(store, root, job, file, index, signal)
          : null;
      const asset = await ingestAsset(store, root, job.projectId!, composite?.file || file, {
        name: '图片候选 ' + (index + 1),
        category: 'generated_image',
        jobId: job.id,
        deliveryId,
        prompt: job.input.prepared.finalPrompt,
        sourceAssetIds: [
          ...job.input.assets.map((a: any) => a.asset.id),
          ...(composite ? [composite.sourceId] : []),
        ],
        ...(job.input.imageEdit
          ? {
              processingSource: {
                version: 1 as const,
                jobId: job.id,
                action: job.input.imageEdit.action,
                sources: [job.input.imageEdit.source],
                parameters: job.input.imageEdit,
              },
            }
          : {}),
      });
      ids.push(asset.id);
      continue;
    }
    const delivered = await new CreationMediaService(store, root).deliver(
      job.input.imageTask.id,
      {
        taskId: job.input.imageTask.id,
        taskRevision: job.input.imageTask.revision,
        deliveryId,
        assets: [{ viewId: job.input.viewId, file: path.basename(file) }],
        executionReceipt: {
          reportedCalls: index ? 0 : 1,
          tool: job.input.modelExecution.protocol,
          notes: '固定供应商响应；候选未自动采用',
        },
      },
      [{ path: file, originalname: path.basename(file) }],
      job,
    );
    ids.push(...delivered.delivery.candidates.map((c: any) => c.asset.id));
  }
  store.patchJob(job.id, {
    state: store.job(job.id).cancelRequested ? 'cancelled' : 'succeeded',
    output: { ...store.job(job.id).output, assetIds: ids },
    error: null,
  });
}
