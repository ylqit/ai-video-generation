import { z } from 'zod';
import { HttpError, type Store } from './db.js';
import { ModelRegistry } from './model-registry.js';
import { SeriesProductionService, fixedSeriesRecord } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import {
  seriesProposalInputSchema,
  seriesProposalResultSchema,
  seriesProposalRules,
} from '../shared/series-proposal.js';
import { creationRefSchema } from '../shared/creation.js';
import type { Job } from '../shared/contracts.js';
import { validateAdaptationIntent, indexedSource } from './source-adaptation.js';

// Owns the proposal lifecycle. Execution remains an ordinary creative job;
// applying a proposal delegates the actual plan mutation to the existing service.
export class SeriesProposals {
  constructor(public store: Store) {}
  prepare(seriesId: string, raw: unknown) {
    const body = seriesProposalInputSchema.parse(raw),
      series = this.store.get(seriesId);
    if (series.kind !== 'series') throw new HttpError(400, '请选择系列');
    const sources = body.sources.map((r) =>
      indexedSource(this.store, fixedSeriesRecord(this.store, series.projectId, r)),
    );
    validateAdaptationIntent(this.store, series.projectId, body.adaptation, body.sources);
    if (body.adaptation.mode === 'faithful_adaptation' && !sources.length)
      throw new HttpError(400, '忠实改编需要固定来源');
    if (
      body.approach === 'specification_first' &&
      (!body.requestedEpisodes || !body.requestedRuntime)
    )
      throw new HttpError(400, '先给规格需要明确集数与单集时长');
    const context = {
      schemaVersion: 9,
      mode: 'series_proposal',
      projectId: series.projectId,
      series: { id: series.id, revision: series.revision },
      input: body,
      currentPlan: series.data.production || null,
      records: sources,
      dependencies: [
        { id: series.id, revision: series.revision },
        ...body.sources,
        ...sources
          .filter((d) => d.kind === 'source_index')
          .flatMap((d) => d.data.entries.map((e: any) => e.source)),
      ],
      rules: { version: 'series-proposal-v1', text: seriesProposalRules },
      modelExecution: new ModelRegistry(this.store).resolve(
        series.projectId,
        series.id,
        'text',
        'series_proposal',
      ),
    };
    if (JSON.stringify(context).length > 300000)
      throw new HttpError(400, '整季资料超过预算，请按来源索引选择必要章节，未自动截断');
    return {
      context,
      digest: generationDigest(context),
      usage: { textRequests: 1, automaticRepairs: 0, images: 0, videos: 0 },
    };
  }
  generate(seriesId: string, raw: any) {
    const body = z
      .object({
        input: seriesProposalInputSchema,
        digest: z.string().length(64),
        approved: z.literal(true),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const row = this.store.db
        .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
        .get(`series-proposal:${seriesId}:${body.idempotencyKey}`);
      const prior = row ? this.store.job(String(row.id)) : null;
      if (prior) {
        if (prior.input.previewDigest !== body.digest) throw new HttpError(409, '提案请求回执不符');
        return prior;
      }
      const prepared = this.prepare(seriesId, body.input);
      if (prepared.digest !== body.digest) throw new HttpError(409, '整季准备依据已变化');
      if (!prepared.context.modelExecution) throw new HttpError(409, '请先固定系列或项目文字模型');
      return this.store.createJob(
        'creative',
        prepared.context.projectId,
        null,
        {
          context: prepared.context,
          modelExecution: prepared.context.modelExecution,
          previewDigest: prepared.digest,
        },
        `series-proposal:${seriesId}:${body.idempotencyKey}`,
      );
    });
  }
  complete(job: Job, result: unknown) {
    if (!job.projectId) throw new HttpError(400, '整季提案需要项目归属');
    const old = this.store
      .list('series_proposal', job.projectId)
      .find((d) => d.data.jobId === job.id);
    if (old) return old;
    const parsed = seriesProposalResultSchema.safeParse(result);
    const issues = parsed.success
      ? this.resultIssues(job.input.context, parsed.data)
      : parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return this.store.create(
      'series_proposal',
      job.projectId,
      {
        version: 1,
        context: job.input.context,
        result: parsed.success ? parsed.data : result,
        valid: !issues.length,
        issues,
        jobId: job.id,
        adopted: false,
        stale:
          this.store.get(job.input.context.series.id).revision !==
          job.input.context.series.revision,
      },
      job.input.context.series.id,
    );
  }
  resultIssues(context: any, result: z.infer<typeof seriesProposalResultSchema>) {
    const ids = new Set(
      context.records
        .filter((r: any) => r.kind === 'source_index')
        .flatMap((r: any) => r.data.entries.map((e: any) => e.id)),
    );
    const issues: string[] = [];
    if (result.episodes.some((e) => e.sourceEntryIds.some((id) => !ids.has(id))))
      issues.push('提案引用了不存在的来源索引');
    if (
      result.story.information.some(
        (i) =>
          i.plantEpisode > result.episodes.length ||
          i.revealEpisode > result.episodes.length ||
          i.revealEpisode < i.plantEpisode,
      )
    )
      issues.push('信息铺垫或揭示分集越界／逆序');
    for (const list of [
      result.story.characters.map((c) => c.key),
      result.story.information.map((i) => i.id),
    ])
      if (new Set(list).size !== list.length) issues.push('人物或信息标识重复');
    return issues;
  }
  save(seriesId: string, raw: unknown) {
    const body = z
      .object({
        input: seriesProposalInputSchema,
        digest: z.string().length(64),
        result: seriesProposalResultSchema,
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const prior = this.store
        .list('series_proposal', this.store.get(seriesId).projectId, seriesId)
        .find((d) => d.data.key === body.idempotencyKey);
      if (prior) {
        if (prior.data.saveDigest !== generationDigest(body))
          throw new HttpError(409, '提案保存回执不符');
        return prior;
      }
      const preparation = this.prepare(seriesId, body.input);
      if (preparation.digest !== body.digest) throw new HttpError(409, '请重新准备整季提案');
      const issues = this.resultIssues(preparation.context, body.result);
      if (issues.length) throw new HttpError(400, issues.join('；'));
      return this.store.create(
        'series_proposal',
        preparation.context.projectId,
        {
          version: 1,
          context: preparation.context,
          result: body.result,
          valid: true,
          adopted: false,
          key: body.idempotencyKey,
          saveDigest: generationDigest(body),
        },
        seriesId,
      );
    });
  }
  preview(id: string, raw: unknown) {
    const body = z
      .object({ revision: z.number().int().positive(), profile: creationRefSchema.optional() })
      .strict()
      .parse(raw);
    const proposal = this.store.get(id),
      series = this.store.get(proposal.parentId!);
    if (
      proposal.kind !== 'series_proposal' ||
      proposal.revision !== body.revision ||
      !proposal.data.valid ||
      proposal.data.stale
    )
      throw new HttpError(409, '提案尚未有效或版本已变化');
    for (const ref of proposal.data.context.dependencies) {
      fixedSeriesRecord(this.store, proposal.projectId, ref);
      if (this.store.get(ref.id).revision !== ref.revision)
        throw new HttpError(409, '提案固定来源已变化；请重新准备，不覆盖新计划');
    }
    const result = seriesProposalResultSchema.parse(proposal.data.result);
    const old = series.data.production;
    const active = (old?.slots || []).filter((s: any) => s.active);
    const slots = result.episodes.map((e, n) => ({
      ...active[n],
      ...e,
      id: active[n]?.id || `proposal-${proposal.id}-${n + 1}`,
      active: true,
    }));
    const data = {
      ...old,
      version: 1,
      profile: body.profile || old?.profile,
      targetEpisodes: result.episodes.length,
      runtime: proposal.data.context.input.requestedRuntime || result.episodes[0].runtime,
      story: result.story,
      proposal: { id, revision: proposal.revision },
      slots,
    };
    const plan = new SeriesProductionService(this.store).preview(series.id, data);
    return {
      proposal: { id, revision: proposal.revision },
      plan,
      differences: {
        before: old || null,
        after: plan.data,
        specificationChanged:
          proposal.data.context.input.requestedEpisodes !== result.episodes.length ||
          result.episodes.some(
            (e) =>
              generationDigest(e.runtime) !==
              generationDigest(proposal.data.context.input.requestedRuntime),
          ),
        note: '只采用规划；人物为剧情提案，实例映射在单集核对；不创建分集、剧本或媒体任务',
      },
      digest: generationDigest({
        proposal: { id, revision: proposal.revision },
        plan: plan.digest,
      }),
    };
  }
  apply(id: string, raw: any) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        profile: creationRefSchema.optional(),
        digest: z.string().length(64),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const proposal = this.store.get(id),
        receipt = proposal.data.application;
      if (receipt?.key === body.idempotencyKey) {
        if (receipt.digest !== body.digest) throw new HttpError(409, '提案采用回执不符');
        return this.store.get(receipt.series.id, receipt.series.revision);
      }
      const preview = this.preview(id, {
        revision: body.revision,
        ...(body.profile ? { profile: body.profile } : {}),
      });
      if (preview.digest !== body.digest) throw new HttpError(409, '提案影响预览已变化');
      const series = new SeriesProductionService(this.store).apply(proposal.parentId!, {
        ...preview.plan,
        revision: preview.plan.series.revision,
        idempotencyKey: body.idempotencyKey,
      });
      this.store.update(id, proposal.revision, {
        ...proposal.data,
        adopted: true,
        application: {
          key: body.idempotencyKey,
          digest: body.digest,
          series: { id: series.id, revision: series.revision },
        },
      });
      return series;
    });
  }
}
