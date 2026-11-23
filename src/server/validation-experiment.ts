import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';
import { ModelRegistry } from './model-registry.js';
import {
  validationCases,
  validationControls,
  textValidationCases,
} from '../shared/validation-experiment.js';
import { creationRefSchema } from '../shared/creation.js';
import { fixedSeriesRecord } from './series-production.js';
import { AssemblyService } from './assembly.js';
import { promptProfiles } from '../shared/models.js';

const assetBinding = z
  .object({
    role: z.string().min(1),
    asset: creationRefSchema,
    inspected: z.literal(true),
    notes: z.string().trim().min(1),
  })
  .strict();
const experimentInput = z
  .object({
    seriesId: z.string().min(1),
    episodeId: z.string().optional(),
    seeds: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .refine((s) => s[0] !== s[1], '两个重复种子需要不同'),
    assets: z.array(assetBinding),
    recipe: z
      .object({
        baseline: z.string().min(1),
        experimental: z.string().min(1),
        experimentalRevision: z.string().min(1),
        change: z.string().min(1),
      })
      .strict(),
    environment: z
      .object({ nodeVersion: z.string(), workflowDigest: z.string(), inspected: z.boolean() })
      .strict(),
    quote: z
      .object({
        source: z.string(),
        checkedAt: z.string(),
        currency: z.string(),
        videoPerRequest: z.number().nonnegative().nullable(),
        textPerRequest: z.number().nonnegative().nullable(),
      })
      .strict(),
  })
  .strict();

// This ledger cannot submit tasks. It binds fixed preparations and existing jobs;
// original workers, adoption, and evidence services remain the only execution chain.
export class ValidationExperiments {
  constructor(public store: Store) {}
  prepare(projectId: string, raw: unknown) {
    const input = experimentInput.parse(raw),
      series = this.store.get(input.seriesId);
    if (series.projectId !== projectId || series.kind !== 'series')
      throw new HttpError(400, '实验系列归属不符');
    if (input.episodeId) {
      const ep = this.store.get(input.episodeId);
      if (ep.kind !== 'episode' || ep.projectId !== projectId || ep.data.seriesId !== series.id)
        throw new HttpError(400, '实验分集不属于本系列');
    }
    if (new Set(input.assets.map((a) => a.role)).size !== input.assets.length)
      throw new HttpError(400, '实验素材角色重复');
    const assets = input.assets.map((a) => {
      const doc = fixedSeriesRecord(this.store, projectId, a.asset, 'asset');
      if (doc.data.mediaType !== 'image' || !doc.data.adopted || !doc.data.sha256)
        throw new HttpError(409, '实验需要已审看采用且有哈希的图片');
      return { ...a, sha256: doc.data.sha256 };
    });
    const selectedModel = new ModelRegistry(this.store).resolve(
      projectId,
      input.episodeId || null,
      'video',
    );
    // Match the actual compiler's resolved scheme while preserving the pinned
    // selection (including "automatic") and its connection/config revisions.
    const model = selectedModel
      ? (() => {
          const { digest: _digest, ...fixed } = {
            ...selectedModel,
            promptProfile: input.recipe.baseline,
          };
          return { ...fixed, digest: generationDigest(fixed) };
        })()
      : null;
    const blockers: string[] = [];
    if (!model || model.protocol !== 'comfy-h3' || model.selection.mode !== 'ref2va')
      blockers.push('尚未固定可用的 ComfyUI/H3 Ref2VA 执行配置');
    if (
      !promptProfiles.some(
        (p) =>
          p.id === input.recipe.baseline && p.family === 'h3-comfy' && p.modes.includes('ref2va'),
      ) ||
      (model && !['automatic', input.recipe.baseline].includes(model.selection.promptProfile))
    )
      blockers.push('实验基准 Prompt 方案与固定连接选择不符或尚未实现');
    if (
      !input.environment.inspected ||
      !input.environment.nodeVersion ||
      !/^[a-f0-9]{64}$/.test(input.environment.workflowDigest)
    )
      blockers.push('节点版本及实际工作流摘要尚未核对');
    if (input.quote.videoPerRequest === null || !input.quote.source || !input.quote.checkedAt)
      blockers.push('真实报价尚未核对；请求秒数不是费用');
    const cases = validationCases(input.seeds).map((c) => ({
      ...c,
      missing: c.requiredAssets.filter((r) => !assets.some((a) => a.role === r)),
      boundaryRequired: c.dependsOn.length > 0,
    }));
    const content = {
      version: 1,
      projectId,
      series: { id: series.id, revision: series.revision },
      input,
      controls: validationControls,
      model,
      assets,
      cases,
      textCases: textValidationCases,
      blockers,
      quote: {
        ...input.quote,
        maximumVideo:
          input.quote.videoPerRequest === null ? null : 38 * input.quote.videoPerRequest,
        maximumText: input.quote.textPerRequest === null ? null : 8 * input.quote.textPerRequest,
      },
      dependencies: [
        { id: series.id, revision: series.revision },
        ...assets.map((a) => a.asset),
        ...(model?.dependencies || []),
      ],
      readyToSubmit: false,
      executionAuthorization: 'none',
    };
    return { ...content, digest: generationDigest(content) };
  }
  save(projectId: string, raw: unknown) {
    const body = z
      .object({
        input: experimentInput,
        digest: z.string().length(64),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const prior = this.store
        .list('validation_experiment', projectId)
        .find((d) => d.data.key === body.idempotencyKey);
      if (prior) {
        if (prior.data.preparation.digest !== body.digest)
          throw new HttpError(409, '实验保存回执不符');
        return prior;
      }
      const preparation = this.prepare(projectId, body.input);
      if (preparation.digest !== body.digest) throw new HttpError(409, '实验素材或执行依据已变化');
      return this.store.create(
        'validation_experiment',
        projectId,
        { preparation, key: body.idempotencyKey, attempts: [], textAttempts: [], observations: [] },
        body.input.seriesId,
      );
    });
  }
  record(id: string, raw: unknown) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        caseId: z.string(),
        jobId: z.string().optional(),
        outcome: z.enum([
          'preparation_blocked',
          'technical_failure',
          'unknown',
          'quality_fail',
          'pass',
        ]),
        notes: z.string().min(1),
        review: creationRefSchema.optional(),
        selection: creationRefSchema.optional(),
        assemblyReview: creationRefSchema.optional(),
        observations: z
          .array(
            z
              .object({
                check: z.string().min(1),
                status: z.enum(['pass', 'issues', 'unknown', 'not_applicable']),
                startFrame: z.number().int().nonnegative(),
                endFrame: z.number().int().positive(),
                inspection: z.enum(['frame', 'motion', 'audio', 'narrative']),
                notes: z.string().min(1),
              })
              .strict(),
          )
          .default([]),
        reviewSeconds: z.number().nonnegative().default(0),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const doc = this.store.get(id),
        preparation = doc.data.preparation;
      if (doc.kind !== 'validation_experiment' || doc.revision !== body.revision)
        throw new HttpError(409, '实验记录版本已变化');
      const definition = preparation.cases.find((c: any) => c.id === body.caseId);
      if (!definition) throw new HttpError(400, '不属于预登记案例');
      const job = body.jobId ? this.store.job(body.jobId) : null;
      if (job) {
        if (
          job.projectId !== doc.projectId ||
          job.kind !== 'generation' ||
          job.input.experiment?.id !== id ||
          job.input.experiment?.digest !== preparation.digest ||
          job.input.experiment?.caseId !== body.caseId
        )
          throw new HttpError(400, '任务未冻结此实验及案例依据；不能事后将其他任务冒充对照');
        if (
          job.input.modelExecution?.digest !== preparation.model?.digest ||
          job.input.segment.duration !== 10 ||
          job.input.seed !== definition.seed
        )
          throw new HttpError(409, '实验控制变量不一致');
      } else if (body.outcome !== 'preparation_blocked')
        throw new HttpError(400, '未执行案例只能记录准备阻断');
      if (doc.data.attempts.some((a: any) => a.caseId === body.caseId))
        throw new HttpError(409, '案例已记录；不得用重试覆盖原始结果');
      if (
        new Set(body.observations.map((o) => o.check)).size !== body.observations.length ||
        body.observations.some((o) => !definition.checks.includes(o.check))
      )
        throw new HttpError(400, '观察必须对应预登记指标，不得重复');
      if (body.observations.length && !body.review)
        throw new HttpError(400, '实际观察需要媒体审核依据');
      if (body.review) {
        const review = fixedSeriesRecord(
          this.store,
          doc.projectId,
          body.review,
          'generation_review',
        );
        if (!job || review.data.jobId !== job.id || !review.data.inspected)
          throw new HttpError(400, '观察审核与任务不符');
        for (const o of body.observations) {
          if (
            o.startFrame < Math.round(review.data.in * 24) ||
            o.endFrame > Math.round(review.data.out * 24) ||
            o.endFrame <= o.startFrame ||
            (o.inspection !== 'frame' && o.endFrame - o.startFrame < 2)
          )
            throw new HttpError(400, '观察区间必须由实际播放审核覆盖');
          if (['unexpected_voice', 'sound_join'].includes(o.check) && o.inspection !== 'audio')
            throw new HttpError(400, '声音指标需要听审，不以截图或字幕替代');
        }
      }
      if (
        body.outcome === 'pass' &&
        definition.checks.some(
          (check: string) =>
            !body.observations.some(
              (o) => o.check === check && ['pass', 'not_applicable'].includes(o.status),
            ),
        )
      )
        throw new HttpError(409, '全部适用指标需要明确观察，未知不能计作通过');
      if (['quality_fail', 'pass'].includes(body.outcome)) {
        if (!body.review || !job) throw new HttpError(400, '质量结论需要原任务媒体审核');
        const review = fixedSeriesRecord(
          this.store,
          doc.projectId,
          body.review,
          'generation_review',
        );
        if (review.data.jobId !== job.id || !review.data.inspected)
          throw new HttpError(400, '审核不属于此任务或未实际审看');
        if (
          body.outcome === 'pass' &&
          (review.data.dimensions.audio !== 'pass' ||
            Object.values(review.data.dimensions).some(
              (v) => v === 'unreviewed' || v === 'issues',
            ) ||
            review.data.stale ||
            this.store.get(review.id).revision !== review.revision)
        )
          throw new HttpError(409, '实验通过需要有效的完整视听审核；无画内对白也不能跳过听审');
      }
      let adoptedFrames = 0;
      if (body.selection) {
        const selection = fixedSeriesRecord(
          this.store,
          doc.projectId,
          body.selection,
          'segment_selection',
        );
        if (
          !body.review ||
          selection.data.review?.id !== body.review.id ||
          selection.data.review.revision !== body.review.revision
        )
          throw new HttpError(400, '采用与审核版本不符');
        adoptedFrames = Math.round((selection.data.out - selection.data.in) * 24);
      }
      if (body.outcome === 'pass' && definition.dependsOn.length) {
        if (!body.assemblyReview || !body.selection)
          throw new HttpError(409, '接续实验通过需要本段采用及相邻片段联合审核');
        const review = fixedSeriesRecord(
          this.store,
          doc.projectId,
          body.assemblyReview,
          'assembly_review',
        );
        const scope = new AssemblyService(this.store)
          .inspect(review.data.edl.id)
          .scopes.find(
            (s) =>
              s.review?.id === review.id &&
              s.review?.revision === review.revision &&
              s.scope === 'join',
          );
        const required = [
          body.selection,
          ...definition.dependsOn.map(
            (caseId: string) => doc.data.attempts.find((a: any) => a.caseId === caseId)?.selection,
          ),
        ];
        if (
          !scope?.passed ||
          required.some(
            (ref) =>
              !ref ||
              !scope.content.clips.some(
                (c: any) => c.selection?.id === ref.id && c.selection.revision === ref.revision,
              ),
          )
        )
          throw new HttpError(409, '联合审核未覆盖本案例的实际两侧采用版本');
      }
      return this.store.update(id, doc.revision, {
        ...doc.data,
        attempts: [...doc.data.attempts, { ...body, adoptedFrames, at: Date.now() }],
      });
    });
  }
  report(id: string, blind = false) {
    const doc = this.store.get(id);
    if (doc.kind !== 'validation_experiment') throw new HttpError(400, '请选择实验记录');
    const attempts = doc.data.attempts;
    return {
      id,
      revision: doc.revision,
      counts: {
        planned: doc.data.preparation.cases.length,
        attempted: attempts.filter((a: any) => a.jobId).length,
        pending: doc.data.preparation.cases.length - attempts.length,
        ...Object.fromEntries(
          ['preparation_blocked', 'technical_failure', 'unknown', 'quality_fail', 'pass'].map(
            (s) => [s, attempts.filter((a: any) => a.outcome === s).length],
          ),
        ),
      },
      adoptedSeconds: attempts.reduce((n: number, a: any) => n + a.adoptedFrames, 0) / 24,
      reviewSeconds: attempts.reduce((n: number, a: any) => n + a.reviewSeconds, 0),
      cases: doc.data.preparation.cases
        .map((c: any) => {
          const code = generationDigest({ id, caseId: c.id }).slice(0, 12);
          const attempt = attempts.find((a: any) => a.caseId === c.id);
          return blind
            ? {
                code,
                checks: c.checks,
                media: attempt?.jobId ? this.store.job(attempt.jobId).output.assetIds || [] : [],
              }
            : { ...c, code, attempt: attempt || null };
        })
        .sort((a: any, b: any) => a.code.localeCompare(b.code)),
      conclusion: '小样筛查；未执行与未知分列，不推算长系列成功率',
    };
  }
}
