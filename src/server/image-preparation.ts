import { z } from 'zod';
import { HttpError, type Store } from './db.js';
import type { RecordDoc } from '../shared/contracts.js';
import { modelRefSchema } from '../shared/models.js';

export const imagePreparationSchema = z
  .object({
    taskRevision: z.number().int().positive(),
    viewId: z.string().min(1),
    operation: z.enum(['generate', 'edit']),
    promptSource: z.enum(['task', 'reviewed_override']).optional(),
    prompt: z.string().trim().max(32000).optional(),
    overrideReviewed: z.boolean().optional(),
    references: z.array(modelRefSchema).max(16).default([]),
    referenceUses: z
      .array(
        z
          .object({
            asset: modelRefSchema,
            purpose: z.enum([
              'identity',
              'appearance',
              'environment',
              'style',
              'composition',
              'action_start',
              'action_end',
            ]),
            preserve: z.array(z.string().min(1)).default([]),
            allow: z.array(z.string().min(1)).default([]),
          })
          .strict(),
      )
      .max(16)
      .optional(),
  })
  .strict();

export function imageTaskBasis(store: Store, task: RecordDoc, viewId: string) {
  const view = task.data.views.find((v: any) => v.id === viewId);
  if (!view) throw new HttpError(400, '视图不属于此素材任务');
  const dependencies: Array<{ id: string; revision: number }> = [];
  let requirement: any = null,
    direction: any = null;
  if (task.data.assetsResult) {
    const assets = store.get(task.data.assetsResult.id, task.data.assetsResult.revision);
    const run = store.get(task.data.creationRunId);
    if (
      !assets.data.adopted ||
      assets.projectId !== task.projectId ||
      assets.parentId !== run.id ||
      store.get(assets.id).data.stale ||
      run.data.results.assets?.id !== assets.id ||
      run.data.results.assets?.revision !== assets.revision
    )
      throw new HttpError(409, '素材需求已变化，请依据当前采用版本重新准备任务');
    requirement = assets.data.result.items.find((i: any) => i.id === task.data.requirementId);
    if (!requirement) throw new HttpError(409, '固定素材需求不存在');
    const script =
      task.data.scriptResult &&
      store.get(task.data.scriptResult.id, task.data.scriptResult.revision);
    if (
      !script ||
      script.projectId !== task.projectId ||
      !script.data.adopted ||
      store.get(script.id).data.stale ||
      run.data.results.script?.id !== script.id ||
      run.data.results.script?.revision !== script.revision
    )
      throw new HttpError(409, '剧本依据已变化，请重新准备素材需求');
    dependencies.push(task.data.assetsResult, task.data.scriptResult);
    const fixedRun = task.data.creationRun
      ? store.get(task.data.creationRun.id, task.data.creationRun.revision)
      : null;
    const ref = task.data.directionResult || fixedRun?.data.results.direction;
    if (ref) {
      const doc = store.get(ref.id, ref.revision);
      if (
        doc.projectId !== task.projectId ||
        !doc.data.adopted ||
        store.get(doc.id).data.stale ||
        run.data.results.direction?.id !== doc.id ||
        run.data.results.direction?.revision !== doc.revision
      )
        throw new HttpError(409, '呈现方向已变化，请修订素材需求后重新准备');
      direction = {
        reference: ref,
        visual: doc.data.result.visual,
        consumption: 'text_request',
      };
      dependencies.push(ref);
    }
  }
  const requirements = requirement?.prompt || task.data.requirements;
  const instructions = [...new Set([requirements, view.instruction].filter((s) => s?.trim()))];
  if (!instructions.length) throw new HttpError(400, '素材任务没有可执行图片要求，请先修订需求');
  return {
    requirement,
    direction,
    view,
    dependencies: dependencies.filter(Boolean),
    prompt: [
      ...instructions,
      `View: ${view.view}`,
      direction?.visual && `Visual language: ${direction.visual}`,
      requirement?.layout && `Layout: ${requirement.layout}`,
      requirement?.preserve?.length && `Preserve: ${requirement.preserve.join('; ')}`,
      requirement?.allow?.length && `May change: ${requirement.allow.join('; ')}`,
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

export function compileImagePreparation(
  store: Store,
  task: RecordDoc,
  body: z.infer<typeof imagePreparationSchema>,
) {
  // Original free-text requests keep their execution semantics.
  if (!body.promptSource) {
    if (!body.prompt?.trim()) throw new HttpError(400, '请填写图片要求');
    return {
      finalPrompt: body.prompt,
      dependencies: [],
      source: 'legacy_explicit',
      consumption: [],
      bindings: [],
    };
  }
  const basis = imageTaskBasis(store, task, body.viewId);
  if (body.promptSource === 'reviewed_override' && (!body.overrideReviewed || !body.prompt?.trim()))
    throw new HttpError(400, '覆盖文本需要明确核对，不能由预览隐式补写');
  const uses = body.referenceUses || [];
  if (
    uses.length !== body.references.length ||
    uses.some(
      (u, i) =>
        u.asset.id !== body.references[i].id || u.asset.revision !== body.references[i].revision,
    )
  )
    throw new HttpError(400, '每张图片必须按实际输入顺序明确参考用途');
  const bindings = uses.map((u, i) => ({
    ...u,
    label: `Image ${i + 1}`,
    role: 'edit_image',
    consumption: 'model_input',
  }));
  const prompt = body.promptSource === 'task' ? basis.prompt : body.prompt!;
  return {
    finalPrompt: [
      prompt,
      ...bindings.map(
        (b) =>
          `${b.label}: ${b.purpose}. Preserve: ${b.preserve.join('; ') || 'only the declared purpose'}. May change: ${b.allow.join('; ') || 'as specified by this image task'}.`,
      ),
    ].join('\n'),
    dependencies: basis.dependencies,
    source: body.promptSource,
    basis,
    bindings,
    compilerVersion: 'image-task-v1',
    consumption: [
      {
        field: body.promptSource === 'task' ? 'task.requirements/view' : 'reviewed_override',
        mode: 'text_request',
        source: body.promptSource,
      },
      ...(basis.direction
        ? [
            {
              field: 'direction.visual',
              mode: body.promptSource === 'task' ? 'text_request' : 'planning_check',
              source: basis.direction.reference,
            },
          ]
        : []),
      ...bindings.map((b) => ({
        field: b.label,
        mode: 'model_input',
        source: b.asset,
        purpose: b.purpose,
      })),
      {
        field: 'identity/style/state fidelity',
        mode: 'post_review',
        source: 'actual image inspection',
      },
    ],
  };
}
