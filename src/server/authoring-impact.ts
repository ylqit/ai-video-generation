import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { authoringSchemas, authoringStages, creationRefSchema } from '../shared/creation.js';
import { scopeAuthoringProjection } from '../shared/scope-projection.js';
import { scopedRevisionSchema } from '../shared/workspace.js';
import { validateScopedRevision } from './workspace.js';
import { generationDigest } from './h3-guided.js';

// Read-only impact uses exactly the projection that protects existing execution
// scopes. It predicts input changes, never invents a new observed boundary/Canon.
export function authoringImpact(store: Store, runId: string, raw: unknown) {
  const body = z
    .object({
      revision: z.number().int().positive(),
      baseline: creationRefSchema,
      stage: z.enum(authoringStages),
      result: z.unknown(),
      scope: z
        .object({
          shotIds: scopedRevisionSchema.shape.shotIds,
          sceneIds: scopedRevisionSchema.shape.sceneIds,
          subjectKeys: scopedRevisionSchema.shape.subjectKeys,
        })
        .strict()
        .optional(),
    })
    .strict()
    .parse(raw);
  const run = store.get(runId),
    baseline = store.get(body.baseline.id, body.baseline.revision);
  if (
    run.kind !== 'creation_run' ||
    run.revision !== body.revision ||
    baseline.parentId !== runId ||
    baseline.data.stage !== body.stage ||
    generationDigest(run.data.results?.[body.stage] || null) !== generationDigest(body.baseline)
  )
    throw new HttpError(409, '修订影响需要当前运行与已采用基线');
  const next = authoringSchemas[body.stage].parse(body.result);
  if (body.scope)
    validateScopedRevision(
      store,
      {
        ...run,
        data: {
          ...run.data,
          writable: {
            ...scopedRevisionSchema.parse({ ...body.scope, baseline: body.baseline }),
            stage: body.stage,
          },
        },
      },
      body.stage,
      next,
    );
  const before: any = baseline.data.result;
  const changedFields = Object.keys(next).filter(
    (key) => generationDigest(before[key] ?? null) !== generationDigest((next as any)[key] ?? null),
  );
  const changedObjects = ['subjects', 'scenes', 'shots', 'sceneDesigns', 'items'].flatMap(
    (field) => {
      const old = before[field],
        after = (next as any)[field];
      if (!Array.isArray(old) || !Array.isArray(after)) return [];
      const key = field === 'subjects' ? 'key' : 'id';
      return [...new Set<string>([...old, ...after].map((item) => item[key]))]
        .filter(
          (id) =>
            generationDigest(old.find((v) => v[key] === id) ?? null) !==
            generationDigest(after.find((v) => v[key] === id) ?? null),
        )
        .map((id) => ({ field, id }));
    },
  );
  const scopes = store
    .list('creation_scope', run.projectId)
    .filter((s) => s.parentId === runId)
    .map((scope) => {
      let affected = false,
        problem = '';
      try {
        const d = scope.data.authoring.director,
          s = scope.data.authoring.script;
        if (!d) throw new Error('导演基线尚未采用');
        const director = store.get(d.id, d.revision).data.result;
        const script = s ? store.get(s.id, s.revision).data.result : undefined;
        affected =
          generationDigest(
            scopeAuthoringProjection(body.stage, before, scope.data, director, script),
          ) !==
          generationDigest(
            scopeAuthoringProjection(body.stage, next, scope.data, director, script),
          );
      } catch (e: any) {
        problem = e.message;
      }
      return {
        id: scope.id,
        revision: scope.revision,
        name: scope.data.name,
        shotIds: scope.data.shotIds,
        groupIds: scope.data.groupIds,
        affected,
        problem,
      };
    });
  const jobs = store
    .jobs(run.projectId)
    .filter(
      (j) =>
        j.kind === 'generation' &&
        j.input.creationRunId === run.id &&
        scopes.some(
          (s) =>
            s.affected &&
            (s.id === j.input.creationScope?.id || s.groupIds.includes(j.input.segment?.id)),
        ),
    )
    .map((j) => ({
      id: j.id,
      state: j.state,
      groupId: j.input.segment?.id,
      action: ['queued', 'created', 'held'].includes(j.state)
        ? '重新核对冻结依据；确认纠正后按原机制暂停'
        : '原任务与媒体保留，采用前核对变化',
    }));
  return {
    digest: generationDigest(body),
    changedFields,
    changedObjects,
    scopes,
    jobs,
    facts: '计划修订不会确认新的故事事实；只有实际采用的边界或证据改变，才沿对应消费传播事实复核。',
  };
}
