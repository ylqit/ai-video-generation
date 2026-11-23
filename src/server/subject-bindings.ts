import { z } from 'zod';
import { HttpError, type Store } from './db.js';
import { generationDigest } from './h3-guided.js';
import { creationRefSchema } from '../shared/creation.js';
import { fixedSeriesRecord } from './series-production.js';

export const subjectBindingSchema = z
  .object({
    subjectKey: z.string().min(1),
    subjectDigest: z.string().length(64),
    decision: z.enum(['new', 'reuse']),
    entity: creationRefSchema.nullable(),
    instanceId: z.string().nullable(),
    reason: z.string().trim().min(1),
  })
  .strict()
  .refine(
    (b) => (b.decision === 'reuse' ? !!b.entity && !!b.instanceId : !b.entity && !b.instanceId),
    '新建与复用决定不能混用',
  );

export function subjectBindingIssues(store: Store, run: any, script: any): string[] {
  if (!run.data.productionRevision || !store.get(run.data.episodeId).data.seriesProduction)
    return [];
  return script.subjects.flatMap((subject: any) => {
    const binding = run.data.subjectBindings?.find((b: any) => b.subjectKey === subject.key);
    if (!binding || binding.subjectDigest !== generationDigest(subject))
      return [`请确认本集主体 ${subject.name} 的系列实例映射`];
    if (binding.decision === 'new') return [];
    try {
      const entity = fixedSeriesRecord(store, run.projectId, binding.entity, 'entity');
      if (!entity.data.instances.some((i: any) => i.id === binding.instanceId))
        throw new Error('实例不存在');
      const missing = subject.attributes.filter(
        (a: any) => !entity.data.attributes?.some((b: any) => b.key === a.key && b.type === a.type),
      );
      if (missing.length)
        return [
          `${subject.name} 的共享主体缺少属性定义：${missing.map((a: any) => a.key).join('、')}；请明确更新并固定主体版本`,
        ];
      return [];
    } catch (e: any) {
      return [`${subject.name}：${e.message}`];
    }
  });
}

export class SubjectBindings {
  constructor(public store: Store) {}
  inspect(runId: string, reference?: { id: string; revision: number }) {
    const run = this.store.get(runId);
    if (run.kind !== 'creation_run') throw new HttpError(400, '请选择创作运行');
    const fixed = reference || run.data.results.script;
    const script = fixed
      ? this.store.get(fixed.id, fixed.revision)
      : this.store
          .list('authoring_result', run.projectId, runId)
          .filter((d) => d.data.stage === 'script' && !d.data.stale)
          .at(-1);
    if (script && (script.parentId !== runId || script.data.stage !== 'script'))
      throw new HttpError(400, '剧本不属于本运行');
    const entities = this.store
      .list('entity', run.projectId)
      .filter((d) => !d.data.stale && !d.data.archived);
    const fixedEntities = (run.data.subjectBindings || [])
      .filter((b: any) => b.decision === 'reuse')
      .map((b: any) => this.store.get(b.entity.id, b.entity.revision));
    const choices = [
      ...new Map([...entities, ...fixedEntities].map((e) => [`${e.id}:${e.revision}`, e])).values(),
    ];
    return {
      run: { id: run.id, revision: run.revision },
      script: script ? { id: script.id, revision: script.revision } : null,
      editable: !!script && !script.data.adopted && !script.data.stale,
      available: choices.flatMap((e) =>
        e.data.instances.map((i: any) => ({
          entity: { id: e.id, revision: e.revision },
          instanceId: i.id,
          name: i.name,
          description: e.data.description,
        })),
      ),
      subjects: (script?.data.result?.subjects || []).map((s: any) => ({
        key: s.key,
        name: s.name,
        kind: s.kind,
        subjectDigest: generationDigest(s),
        binding: run.data.subjectBindings?.find((b: any) => b.subjectKey === s.key) || null,
        consumed: run.data.mappings?.[s.key] || null,
        suggestions: entities.flatMap((e) =>
          e.data.instances
            .filter((i: any) => i.name === s.name)
            .map((i: any) => ({ entity: { id: e.id, revision: e.revision }, instanceId: i.id })),
        ),
      })),
      issues: script ? subjectBindingIssues(this.store, run, script.data.result) : [],
    };
  }
  save(runId: string, raw: unknown) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        script: creationRefSchema,
        bindings: z.array(subjectBindingSchema),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const run = this.store.get(runId),
        digest = generationDigest(body);
      const receipt = run.data.subjectBindingReceipts?.find(
        (r: any) => r.key === body.idempotencyKey,
      );
      if (receipt) {
        if (receipt.digest !== digest) throw new HttpError(409, '映射回执用于不同内容');
        return run;
      }
      if (run.revision !== body.revision) throw new HttpError(409, '创作运行已变化');
      const view = this.inspect(runId, body.script),
        script = this.store.get(body.script.id, body.script.revision);
      if (script.data.stale || this.store.get(script.id).revision !== script.revision)
        throw new HttpError(409, '剧本版本已变化，请重新读取映射');
      if (
        new Set(body.bindings.map((b) => b.subjectKey)).size !== body.bindings.length ||
        body.bindings.length !== view.subjects.length
      )
        throw new HttpError(400, '请逐个确认本集主体，不能重复或遗漏');
      const problems = subjectBindingIssues(
        this.store,
        { ...run, data: { ...run.data, productionRevision: 2, subjectBindings: body.bindings } },
        script.data.result,
      );
      if (problems.length) throw new HttpError(400, problems.join('；'));
      const reused = body.bindings
        .filter((b) => b.decision === 'reuse')
        .map((b) => `${b.entity!.id}:${b.instanceId}`);
      if (new Set(reused).size !== reused.length)
        throw new HttpError(400, '两个本集主体不能静默合并为同一实例；请先修订剧本主体表');
      return this.store.update(run.id, run.revision, {
        ...run.data,
        subjectBindings: body.bindings,
        subjectBindingReceipts: [
          ...(run.data.subjectBindingReceipts || []),
          { key: body.idempotencyKey, digest },
        ],
        productionPreview: null,
        productionApproval: null,
      });
    });
  }
}
