import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest } from './h3-guided.js';
import { imagePreparationSchema, compileImagePreparation } from './image-preparation.js';
import { assertEpisodePlanCurrent } from './episode-plan.js';

export function prepareImageTask(store: Store, taskId: string, raw: unknown) {
  const body = imagePreparationSchema.parse(raw);
  const task = store.get(taskId);
  if (task.kind !== 'asset_task' || task.revision !== body.taskRevision || task.data.stale)
    throw new HttpError(409, '素材任务版本已变化或待复核');
  if (!task.data.views.some((v: any) => v.id === body.viewId))
    throw new HttpError(400, '视图不属于此素材任务');
  const run = task.data.creationRunId ? store.get(task.data.creationRunId) : null;
  const episodeId = run?.data.episodeId || null;
  const execution = new ModelRegistry(store).resolve(task.projectId, episodeId, 'image');
  if (!execution || execution.protocol !== 'openai-images')
    throw new HttpError(409, '请先选择图片生成／编辑模型');
  if (body.operation === 'generate' && body.references.length)
    throw new HttpError(400, '参考图片请使用编辑操作，不会忽略图片');
  if (body.operation === 'edit' && !body.references.length)
    throw new HttpError(400, '图片编辑需要固定参考图');
  const assets = body.references.map((r) => {
    const asset = store.get(r.id, r.revision);
    if (
      asset.kind !== 'asset' ||
      asset.projectId !== task.projectId ||
      asset.data.mediaType !== 'image'
    )
      throw new HttpError(400, '图片编辑参考必须是本项目固定版本图片');
    if (asset.data.bytes > 30 * 1024 * 1024) throw new HttpError(400, '编辑图片超过 30 MB');
    return { asset, reference: { assetId: r.id, revision: r.revision } };
  });
  const compiled = compileImagePreparation(store, task, body);
  if (run) assertEpisodePlanCurrent(store, run);
  const parameters = execution.selection.parameters;
  const input = {
    authoringVersion: 9,
    creationRunId: run?.id || null,
    ...(run?.data.effectivePlan ? { effectivePlan: run.data.effectivePlan } : {}),
    modelExecution: execution,
    imageTask: { id: task.id, revision: task.revision },
    viewId: body.viewId,
    imageOperation: body.operation,
    prepared: {
      ...compiled,
      request: {
        model: execution.modelId,
        prompt: compiled.finalPrompt,
        n: parameters.n || 1,
        size: parameters.size || '1024x1024',
        quality: parameters.quality || 'auto',
      },
    },
    assets,
    dependencies: [
      { id: task.id, revision: task.revision },
      ...body.references,
      ...compiled.dependencies,
      ...execution.dependencies,
    ],
  };
  return { input, digest: generationDigest(input), projectId: task.projectId, episodeId };
}

export function submitImageTask(store: Store, taskId: string, raw: any) {
  const body = z
    .object({
      preparation: imagePreparationSchema,
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      idempotencyKey: z.string().min(8),
      approved: z.literal(true),
    })
    .strict()
    .parse(raw);
  const prior = store.db
    .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
    .get(body.idempotencyKey);
  if (prior) {
    const job = store.job(String(prior.id));
    if (
      job.kind !== 'image' ||
      job.input.imageTask.id !== taskId ||
      job.input.previewDigest !== body.digest
    )
      throw new HttpError(409, '图片任务幂等键冲突');
    return job;
  }
  return store.transaction(() => {
    const prepared = prepareImageTask(store, taskId, body.preparation);
    if (prepared.digest !== body.digest) throw new HttpError(409, '图片准备结果已变化，请重新预览');
    const task = store.get(taskId);
    const attempts = Number(
      store.db
        .prepare(
          "SELECT count(*) n FROM jobs WHERE kind='image' AND json_extract(input,'$.imageTask.id')=? AND json_extract(input,'$.viewId')=?",
        )
        .get(taskId, body.preparation.viewId)!.n,
    );
    if (task.data.maxRevisions !== undefined && attempts >= task.data.maxRevisions + 1)
      throw new HttpError(409, '素材任务已达到初次制作与修订次数，请明确建立新任务范围');
    return store.createJob(
      'image',
      prepared.projectId,
      prepared.episodeId,
      { ...prepared.input, previewDigest: body.digest },
      body.idempotencyKey,
    );
  });
}
