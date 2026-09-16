import { validateDeliveryAudio } from './delivery-audio.js';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import { Store, HttpError } from './db.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { AssemblyService } from './assembly.js';
import { CreationService } from './creation.js';
import { creationMediaStatus } from './creation-production.js';
import { resolveScope } from './workspace.js';
import { assertProductionHead } from './creation-heads.js';
import { generationDigest } from './h3-guided.js';
import { inside } from './config.js';
import { fileCleared } from './media-retention.js';
import { durationBounds, type CreationRef } from '../shared/creation.js';
import {
  deliveryCreateSchema,
  deliveryUpdateSchema,
  deliveryConfirmSchema,
  type DeliveryTarget,
} from '../shared/delivery.js';
import type { RecordDoc } from '../shared/contracts.js';

const ref = (doc: RecordDoc) => ({ id: doc.id, revision: doc.revision });

export class DeliveryService {
  constructor(
    public store: Store,
    public root?: string,
  ) {}

  groups(run: RecordDoc, target: DeliveryTarget) {
    const scope = target.mode === 'scope' ? resolveScope(this.store, run, target.scope) : null;
    const directorRef = scope?.data.authoring.director || run.data.results.director;
    if (!directorRef) throw new HttpError(409, '导演结果尚未采用');
    const director = this.store.get(directorRef.id, directorRef.revision).data.result;
    const ids = scope ? scope.data.groupIds : director.groups.map((g: any) => g.id);
    const media = creationMediaStatus(this.store, run);
    return director.groups
      .filter((g: any) => ids.includes(g.id))
      .map((g: any) => {
        const actual = media.groups.find((m: any) => m.id === g.id);
        const shotIds = scope
          ? g.shotIds.filter((id: string) => scope.data.shotIds.includes(id))
          : g.shotIds;
        if (actual && generationDigest(actual.shotIds) === generationDigest(shotIds)) return actual;
        return { id: g.id, shotIds, selection: null, parts: [], frames: 0 };
      });
  }

  draft(runId: string, target: DeliveryTarget) {
    const run = new CreationService(this.store).get(runId);
    const groups = this.groups(run, target);
    const results = new CreationService(this.store).adopted(run);
    const editorial = results.editorial?.stage === 'editorial' ? results.editorial : null;
    const output =
      run.data.materialized?.output ||
      new CreationService(this.store).settings(run.projectId).data.policy.output;
    const edlDraft: any = {
      schemaVersion: 2,
      episodeId: run.data.episodeId,
      width: output.width,
      height: output.height,
      fps: 24,
      clips: groups.flatMap((g: any) =>
        g.parts.map((p: any) => ({
          assetId: p.video.id,
          revision: p.video.revision,
          in: p.in,
          out: p.out,
          volume: p.volume ?? 1,
          selection: g.selection,
          role: 'story',
        })),
      ),
      audio: [],
      overlays: [],
    };
    const pendingChecks: string[] = [];
    const scope = target.mode === 'scope' ? resolveScope(this.store, run, target.scope) : null;
    const duration = scope
      ? { mode: 'exact' as const, seconds: scope.data.requestedFrames / 24 }
      : run.data.duration;
    const windows: { sourceStart: number; sourceEnd: number; outputStart: number }[] = [];
    const directorRef = scope?.data.authoring.director || run.data.results.director;
    const shots = this.store.get(directorRef.id, directorRef.revision).data.result.shots;
    let plannedCursor = 0;
    const plannedWindows = shots
      .map((shot: any) => {
        const startFrame = plannedCursor;
        plannedCursor += shot.frames;
        return { shotId: shot.id, startFrame, endFrame: plannedCursor };
      })
      .filter((w: any) => !scope || scope.data.shotIds.includes(w.shotId));
    let outputCursor = 0;
    for (const group of groups) {
      const selection = group.selection
        ? this.store.get(group.selection.id, group.selection.revision).data
        : null;
      const planned = plannedWindows.filter((w: any) => group.shotIds.includes(w.shotId));
      if (!selection || selection.composition) {
        pendingChecks.push(
          `片段 ${group.id} 缺少直接逐镜采用对应，或经过局部拼接，请校对声音及字幕`,
        );
      } else {
        for (const w of planned) {
          const coverage = selection.coverage.find((c: any) => c.shotId === w.shotId);
          if (
            !coverage ||
            Math.round((coverage.out - coverage.in) * 24) !== w.endFrame - w.startFrame
          ) {
            pendingChecks.push(
              `镜头 ${w.shotId} 实际采用长度与计划不同或缺少对应，请校对声音及字幕`,
            );
            continue;
          }
          windows.push({
            sourceStart: w.startFrame,
            sourceEnd: w.endFrame,
            outputStart: outputCursor + Math.round((coverage.in - selection.in) * 24),
          });
        }
      }
      outputCursor += group.frames;
    }
    if (editorial) {
      for (const a of editorial.audio) {
        const audioEnd = a.startFrame + a.outFrame - a.inFrame;
        const relevantFrames = plannedWindows.reduce(
          (n: number, w: any) =>
            n + Math.max(0, Math.min(audioEnd, w.endFrame) - Math.max(a.startFrame, w.startFrame)),
          0,
        );
        const mappedFrames = windows.reduce(
          (n, w) =>
            n +
            Math.max(0, Math.min(audioEnd, w.sourceEnd) - Math.max(a.startFrame, w.sourceStart)),
          0,
        );
        if (mappedFrames !== relevantFrames)
          pendingChecks.push(
            `音轨 ${a.asset.id} v${a.asset.revision}（源 ${a.inFrame}–${a.outFrame} 帧，计划起点 ${a.startFrame} 帧）存在未映射区间，请按实际采用重新定位`,
          );
        for (const w of windows) {
          const start = Math.max(a.startFrame, w.sourceStart),
            end = Math.min(a.startFrame + a.outFrame - a.inFrame, w.sourceEnd);
          if (start < end)
            edlDraft.audio.push({
              assetId: a.asset.id,
              revision: a.asset.revision,
              in: (a.inFrame + start - a.startFrame) / 24,
              out: (a.inFrame + end - a.startFrame) / 24,
              start: (w.outputStart + start - w.sourceStart) / 24,
              volume: a.volume,
            });
        }
      }
      for (const o of editorial.overlays) {
        const intersections = windows.filter(
          (w) => o.startFrame < w.sourceEnd && o.endFrame > w.sourceStart,
        );
        if (
          intersections.length === 1 &&
          o.startFrame >= intersections[0].sourceStart &&
          o.endFrame <= intersections[0].sourceEnd
        ) {
          const w = intersections[0];
          edlDraft.overlays.push({
            ...o,
            startFrame: w.outputStart + o.startFrame - w.sourceStart,
            endFrame: w.outputStart + o.endFrame - w.sourceStart,
          });
        } else if (
          plannedWindows.some((w: any) => o.startFrame < w.endFrame && o.endFrame > w.startFrame)
        )
          pendingChecks.push(
            `字幕 ${o.id} 跨范围边界或实际镜头时长不符，请重新定位并保留原文：${o.text}`,
          );
      }
    }
    return {
      runRevision: run.revision,
      target,
      duration,
      edlDraft,
      pendingChecks,
      windows,
      missingGroups: groups.filter((g: any) => !g.selection).map((g: any) => g.id),
    };
  }

  create(runId: string, raw: unknown) {
    const input = deliveryCreateSchema.parse(raw);
    return this.store.transaction(() => {
      const run = new CreationService(this.store).get(runId);
      const prior = this.store
        .list('creation_delivery_plan', run.projectId)
        .find((p) => p.data.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (prior.parentId !== run.id || prior.data.requestDigest !== generationDigest(input))
          throw new HttpError(409, '交付幂等键用于不同内容');
        return prior;
      }
      assertProductionHead(this.store, run);
      if (run.revision !== input.runRevision || run.data.paused)
        throw new HttpError(409, '创作运行已变化或暂停');
      if (
        input.edlDraft.episodeId !== run.data.episodeId ||
        input.edlDraft.clips.some((c) => !c.selection)
      )
        throw new HttpError(400, '交付草稿必须引用本分集的真实采用');
      const groups = this.groups(run, input.target);
      const allowed = new Set(groups.flatMap((g: any) => (g.selection ? [g.selection.id] : [])));
      if (input.edlDraft.clips.some((c) => !allowed.has(c.selection!.id)))
        throw new HttpError(409, '采用不属于交付目标');
      const id = randomUUID();
      const owner = {
        deliveryPlanId: id,
        runId,
        episodeId: run.data.episodeId,
        mode: input.target.mode,
      };
      const edl = new StudioService(this.store).saveEdl(run.projectId, input.edlDraft, undefined, {
        createId: randomUUID(),
        owner,
      });
      const scope =
        input.target.mode === 'scope' ? resolveScope(this.store, run, input.target.scope) : null;
      const data: any = {
        ...input,
        requestDigest: generationDigest(input),
        run: ref(run),
        episode: ref(this.store.get(run.data.episodeId)),
        authoring: scope ? scope.data.authoring : run.data.results,
        duration:
          input.duration ||
          (scope ? { mode: 'exact', seconds: scope.data.requestedFrames / 24 } : run.data.duration),
        edl: ref(edl),
        selections: [
          ...new Map(input.edlDraft.clips.map((c) => [c.selection!.id, c.selection!])).values(),
        ],
        output: { width: edl.data.width, height: edl.data.height, fps: 24 },
      };
      delete data.edlDraft;
      delete data.runRevision;
      data.basisDigest = this.basis(data, edl);
      const plan = this.store.create('creation_delivery_plan', run.projectId, data, runId, id);
      new DomainService(this.store).dependencies(plan, new DomainService(this.store).refs(data));
      return plan;
    });
  }

  basis(data: any, edl: RecordDoc) {
    return generationDigest({
      target: data.target,
      duration: data.duration,
      authoring: data.authoring,
      selections: data.selections,
      edl: { ...ref(edl), data: edl.data },
      output: data.output,
      pendingChecks: data.pendingChecks,
    });
  }

  update(id: string, raw: unknown) {
    const input = deliveryUpdateSchema.parse(raw);
    return this.store.transaction(() => {
      const plan = new StudioService(this.store).owned(
        id,
        this.store.get(id).projectId,
        'creation_delivery_plan',
      );
      const run = new CreationService(this.store).get(plan.parentId!);
      assertProductionHead(this.store, run);
      if (plan.revision !== input.revision || run.revision !== input.runRevision || run.data.paused)
        throw new HttpError(409, '交付或创作版本已变化');
      if (
        input.edlDraft.episodeId !== run.data.episodeId ||
        input.edlDraft.clips.some((c) => !c.selection)
      )
        throw new HttpError(400, '需要本分集的真实采用');
      const allowed = new Set(
        this.groups(run, plan.data.target).flatMap((g: any) =>
          g.selection ? [g.selection.id] : [],
        ),
      );
      if (input.edlDraft.clips.some((c) => !allowed.has(c.selection!.id)))
        throw new HttpError(409, '采用不属于交付目标');
      const previous = this.store.get(plan.data.edl.id, plan.data.edl.revision);
      const edl = new StudioService(this.store).saveEdl(
        plan.projectId,
        input.edlDraft,
        previous.revision,
        { id: previous.id, owner: previous.data.owner },
      );
      const data = {
        ...plan.data,
        duration: input.duration,
        pendingChecks: input.pendingChecks,
        edl: ref(edl),
        selections: [
          ...new Map(input.edlDraft.clips.map((c) => [c.selection!.id, c.selection!])).values(),
        ],
        output: { width: edl.data.width, height: edl.data.height, fps: 24 },
      };
      data.basisDigest = this.basis(data, edl);
      const next = this.store.update(id, input.revision, data);
      new DomainService(this.store).dependencies(next, new DomainService(this.store).refs(data));
      return next;
    });
  }

  inspect(id: string, revision?: number) {
    const plan = this.store.get(id, revision);
    if (plan.kind !== 'creation_delivery_plan') throw new HttpError(400, '不是交付计划');
    const edl = this.store.get(plan.data.edl.id, plan.data.edl.revision);
    const run = new CreationService(this.store).get(plan.parentId!);
    const blockers: string[] = [...plan.data.pendingChecks];
    try {
      assertProductionHead(this.store, run);
      if (
        run.data.paused ||
        this.store.get(plan.id).revision !== plan.revision ||
        this.store.get(edl.id).revision !== edl.revision ||
        plan.data.stale ||
        edl.data.stale
      )
        throw new HttpError(409, '交付依据已变化或运行暂停');
      if (plan.data.target.mode === 'scope') resolveScope(this.store, run, plan.data.target.scope);
      else {
        const current = new CreationService(this.store).adopted(run);
        for (const [stage, source] of Object.entries(plan.data.authoring) as [
          string,
          CreationRef,
        ][]) {
          const saved = this.store.get(source.id, source.revision);
          if (
            generationDigest(saved.data.result) !==
            generationDigest(current[stage as keyof typeof current])
          )
            throw new HttpError(409, '完整作品作者依据已变化');
        }
      }
      const groups = this.groups(run, plan.data.target);
      const expected = groups.flatMap((g: any) =>
        g.parts.map((p: any) => ({
          assetId: p.video.id,
          revision: p.video.revision,
          in: p.in,
          out: p.out,
          selection: g.selection,
        })),
      );
      const actual = edl.data.clips.map((c: any) => ({
        assetId: c.assetId,
        revision: c.revision,
        in: c.in,
        out: c.out,
        selection: c.selection,
      }));
      if (
        !groups.length ||
        groups.some((g: any) => !g.selection) ||
        generationDigest(expected) !== generationDigest(actual)
      )
        throw new HttpError(409, '交付范围存在未采用片段、过期采用或区间变化');
      new StudioService(this.store).validateEdl(plan.projectId, edl.data);
      const frames = edl.data.clips.reduce(
        (n: number, c: any) => n + Math.round((c.out - c.in) * 24),
        0,
      );
      let cursor = 0;
      const audioClips = edl.data.clips.map((c: any) => {
        const startFrame = cursor;
        cursor += Math.round((c.out - c.in) * 24);
        return { ...c, startFrame, endFrame: cursor };
      });
      blockers.push(
        ...validateDeliveryAudio(
          this.store,
          this.store.get(plan.data.episode.id),
          edl.data,
          audioClips,
          frames,
        ).blockers,
      );
      const bounds = durationBounds(plan.data.duration);
      if (bounds && (frames < bounds.minFrames || frames > bounds.maxFrames))
        throw new HttpError(
          409,
          `实际采用 ${frames} 帧不在交付允许范围 ${bounds.minFrames}–${bounds.maxFrames} 帧内`,
        );
      if (edl.data.audio.some((a: any) => Math.round((a.start + a.out - a.in) * 24) > frames))
        throw new HttpError(409, '音轨超出实际交付，请校对');
      for (const c of [...edl.data.clips, ...edl.data.audio]) {
        const asset = this.store.get(c.assetId, c.revision);
        if (this.store.get(asset.id).data.stale || fileCleared(this.store, asset.data.path))
          throw new HttpError(409, '交付素材已失效或已清理');
        if (this.root && !fs.existsSync(inside(this.root, asset.data.path)))
          throw new HttpError(409, '交付素材文件缺失');
      }
    } catch (error) {
      if (!(error instanceof HttpError || error instanceof z.ZodError)) throw error;
      blockers.push(error.message);
    }
    const exports = this.store
      .jobs(plan.projectId)
      .filter(
        (j) =>
          j.kind === 'export' &&
          j.input.deliveryPlan?.id === plan.id &&
          j.input.deliveryPlan.revision === plan.revision,
      );
    const confirmations = this.store
      .list('creation_delivery', plan.projectId)
      .filter((d) => d.data.planRef?.id === plan.id && d.data.planRef.revision === plan.revision);
    const assets = exports
      .filter((j) => j.state === 'succeeded')
      .flatMap((j) => (j.output.assetIds || []).map((assetId: string) => this.store.get(assetId)));
    return {
      plan,
      edl,
      blockers,
      basisDigest: plan.data.basisDigest,
      exports,
      assets,
      confirmations,
      validConfirmation:
        !blockers.length &&
        confirmations.some(
          (d) =>
            !d.data.stale &&
            assets.some(
              (a) =>
                a.id === d.data.exportAsset.id &&
                a.revision === d.data.exportAsset.revision &&
                a.data.sha256 === d.data.sha256,
            ),
        ),
    };
  }

  export(id: string, raw: unknown) {
    const input = z
      .object({
        revision: z.number().int().positive(),
        basisDigest: z.string().length(64),
        idempotencyKey: z.string().min(8),
      })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT * FROM jobs WHERE idempotency_key=?')
        .get(input.idempotencyKey);
      if (prior) {
        const job = this.store.decodeJob(prior);
        if (
          job.kind !== 'export' ||
          job.input.deliveryPlan?.id !== id ||
          job.input.deliveryPlan.revision !== input.revision ||
          job.input.basisDigest !== input.basisDigest
        )
          throw new HttpError(409, '导出幂等键用于不同计划');
        return job;
      }
      const view = this.inspect(id, input.revision);
      if (view.blockers.length || view.basisDigest !== input.basisDigest)
        throw new HttpError(409, view.blockers.join('；') || '交付依据摘要已变化');
      const { plan, edl } = view;
      const assets = [
        ...new Map(
          [...edl.data.clips, ...edl.data.audio].map((c: any) => [
            `${c.assetId}:${c.revision}`,
            this.store.get(c.assetId, c.revision),
          ]),
        ).values(),
      ];
      return this.store.createJob(
        'export',
        plan.projectId,
        plan.data.episode.id,
        {
          edl: edl.data,
          edlRevision: edl.revision,
          assets,
          name: plan.data.target.mode === 'scope' ? '范围样片 [待确认]' : '完整作品 [待确认]',
          partial: false,
          creationRunId: plan.parentId,
          deliveryPlan: ref(plan),
          basisDigest: plan.data.basisDigest,
        },
        input.idempotencyKey,
      );
    });
  }

  advance(run: RecordDoc) {
    if (run.data.exportJobId) {
      const job = this.store.job(run.data.exportJobId);
      const state =
        job.state === 'succeeded'
          ? 'awaiting_final_confirmation'
          : job.state === 'failed'
            ? 'export_failed'
            : 'exporting';
      return run.data.state === state
        ? run
        : this.store.update(run.id, run.revision, { ...run.data, state });
    }
    const draft = this.draft(run.id, { mode: 'work' });
    if (!run.data.results.editorial) throw new HttpError(409, '后期方案尚未采用');
    return this.store.transaction(() => {
      const { missingGroups: _missing, windows: _windows, ...input } = draft;
      const plan = this.create(run.id, {
        ...input,
        idempotencyKey: `creation:${run.id}:${run.data.epoch}:plan`,
      });
      const job = this.export(plan.id, {
        revision: plan.revision,
        basisDigest: plan.data.basisDigest,
        idempotencyKey: `creation:${run.id}:${run.data.epoch}:export`,
      });
      return this.store.update(run.id, run.revision, {
        ...run.data,
        deliveryPlan: ref(plan),
        edl: plan.data.edl,
        exportJobId: job.id,
        state: 'exporting',
        issues: [],
      });
    });
  }

  confirm(runId: string, raw: unknown) {
    const input = deliveryConfirmSchema.parse(raw);
    return this.store.transaction(() => {
      const run = new CreationService(this.store).get(runId);
      const prior = this.store
        .list('creation_delivery', run.projectId)
        .find((d) => d.data.idempotencyKey === input.idempotencyKey);
      if (prior) {
        if (prior.parentId !== runId || prior.data.requestDigest !== generationDigest(input))
          throw new HttpError(409, '确认幂等键用于不同成片');
        return prior;
      }
      if (run.revision !== input.revision) throw new HttpError(409, '创作状态已变化');
      const planRef = input.planRef || run.data.deliveryPlan;
      if (!planRef) throw new HttpError(409, '历史导出保留为证据，请创建明确交付计划');
      const view = this.inspect(planRef.id, planRef.revision);
      if (view.plan.parentId !== runId || view.blockers.length)
        throw new HttpError(409, view.blockers.join('；') || '计划不属于运行');
      const ep = this.store.get(run.data.episodeId);
      const asset = new AssemblyService(this.store).validateExport(ep, view.edl, input.exportAsset);
      const job = this.store.job(asset.data.jobId);
      if (
        generationDigest(job.input.deliveryPlan) !== generationDigest(planRef) ||
        job.input.basisDigest !== view.basisDigest ||
        this.store.get(asset.id).data.stale
      )
        throw new HttpError(409, '必须确认本次实际导出版本');
      if (this.root) {
        const hash = createHash('sha256');
        const fd = fs.openSync(inside(this.root, asset.data.path), 'r');
        try {
          const buffer = Buffer.alloc(1024 * 1024);
          let size;
          while ((size = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0)
            hash.update(buffer.subarray(0, size));
        } finally {
          fs.closeSync(fd);
        }
        if (hash.digest('hex') !== asset.data.sha256)
          throw new HttpError(409, '实际导出文件哈希不一致');
      }
      let release: RecordDoc | null = null;
      if (view.plan.data.target.mode === 'work' && ep.data.seriesProduction) {
        const assembly = new AssemblyService(this.store);
        const preview = assembly.previewRelease(view.edl.id, {
          exportAsset: input.exportAsset,
          canon: input.canon,
        });
        release = assembly.release(view.edl.id, {
          ...preview,
          exportAsset: input.exportAsset,
          canon: input.canon,
          idempotencyKey: input.idempotencyKey,
        });
      }
      const delivery = this.store.create(
        'creation_delivery',
        run.projectId,
        {
          ...input,
          planRef,
          target: view.plan.data.target,
          requestDigest: generationDigest(input),
          actor: 'user',
          at: Date.now(),
          episode: ref(ep),
          edl: ref(view.edl),
          selections: view.plan.data.selections,
          actualFrames: asset.data.frameCount,
          sha256: asset.data.sha256,
          release: release ? ref(release) : null,
          stale: false,
        },
        runId,
      );
      new DomainService(this.store).dependencies(
        delivery,
        new DomainService(this.store).refs(delivery.data),
      );
      if (view.plan.data.target.mode === 'work')
        this.store.update(run.id, run.revision, {
          ...run.data,
          stage: 'complete',
          state: 'complete',
          delivery: ref(delivery),
          deliveryPlan: planRef,
          edl: ref(view.edl),
          exportJobId: job.id,
          issues: [],
        });
      return delivery;
    });
  }
}
