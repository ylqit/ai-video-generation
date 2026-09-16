import { creationCapabilities } from './capabilities.js';
import { productionHead } from './creation-heads.js';
import {
  modularRefTemplate,
  modularBaseTemplate,
  universalRefTemplate,
  universalBaseTemplate,
  seriesRefTemplate,
  seriesBaseTemplate,
  prepareModularH3,
} from './modular-h3.js';
import { generationDependencies } from './generation-dependencies.js';
import { prepareContinuation } from './continuation.js';
import { selectionMedia } from './selection-splice.js';
import { validateShotSemantics } from '../shared/shot-semantics.js';
import { resolveCreativeBrief, selectedProfile } from './creative-brief.js';
import { prepareDirectedH3 } from './directed-h3.js';
import { prepareShot } from '../shared/directing.js';
import { randomUUID, createHash } from 'node:crypto';
import type { Store } from './db.js';
import { HttpError } from './db.js';
import { dramaturgyIssues } from '../shared/longform.js';
import {
  episodePlanSchema,
  edlSchema,
  generationRequestSchema,
  generationPreviewSchema,
  type RecordDoc,
  type ComfyProfile,
} from '../shared/contracts.js';
import parseNovel from '../shared/toonflow/parseNovel.js';
import parseScript from '../shared/toonflow/parseScript.js';
import { prepareGuidedH3, generationDigest, guidedTemplateVersion } from './h3-guided.js';
import { DomainService } from './domain-service.js';
import {
  resolveReferencePlan,
  preparePlannedH3,
  plannedTemplateVersion,
} from './reference-plan.js';

import {
  resolveSeries,
  seriesInformationForEpisode,
  predecessorCanon,
} from './series-production.js';
export class StudioService {
  constructor(public store: Store) {}
  project(id: string) {
    const d = this.store.get(id);
    if (d.kind !== 'project') throw new HttpError(400, '不是项目');
    return d;
  }
  owned(id: string, projectId: string, kind?: string, revision?: number) {
    const d = this.store.get(id, revision);
    if (d.projectId !== projectId || (kind && d.kind !== kind))
      throw new HttpError(400, '记录与项目或类型不匹配');
    return d;
  }
  createProject(data: { title: string; mode: 'series' | 'short'; brief: string }) {
    return this.store.transaction(() => {
      const p = this.store.create('project', '', data);
      this.store.create('series', p.id, { title: data.title, bible: {}, approved: false }, p.id);
      return p;
    });
  }
  createEpisode(projectId: string, data: any, createId?: string) {
    this.project(projectId);
    if (data.seriesId && !this.store.list('series', projectId).some((s) => s.id === data.seriesId))
      throw new HttpError(400, '指定系列不存在');
    if (!data.seriesId && this.store.list('series', projectId).some((s) => s.data.production))
      throw new HttpError(400, '请明确选择系列');
    const series =
      this.store.list('series', projectId).find((s) => s.id === data.seriesId) ||
      this.store.list('series', projectId)[0];
    if (!series) throw new HttpError(400, '系列不存在');
    if (data.arcId) this.owned(data.arcId, projectId, 'arc');
    if (series.data.production && data.arcId && this.store.get(data.arcId).parentId !== series.id)
      throw new HttpError(400, '篇章不属于指定系列');
    const number =
      Math.max(
        0,
        ...this.store
          .list('episode', projectId)
          .filter((e) => e.data.seriesId === series.id)
          .map((e) => e.data.number),
      ) + 1;
    if (series.data.production) {
      const slot = series.data.production.slots.find(
        (s: any) => s.id === data.slotId && s.active && !s.episodeId,
      );
      if (!slot) throw new HttpError(400, '请明确选择尚未关联分集的规划条目');
      return this.store.transaction(() => {
        const doc = this.store.create(
          'episode',
          projectId,
          {
            title: data.title || slot.title,
            number:
              series.data.production.slots
                .filter((s: any) => s.active)
                .findIndex((s: any) => s.id === slot.id) + 1,
            seriesId: series.id,
            arcId: data.arcId || null,
            summary: '',
            script: '',
            sourceChapterIds: [],
            shots: [],
            segments: [],
            incoming: {},
            outgoing: {},
            openLoops: [],
            approved: false,
            stale: false,
            seriesProduction: { version: 1, slotId: slot.id, voices: [], information: [] },
          },
          data.arcId || series.id,
          createId,
        );
        this.store.update(series.id, series.revision, {
          ...series.data,
          production: {
            ...series.data.production,
            slots: series.data.production.slots.map((s: any) =>
              s.id === slot.id ? { ...s, episodeId: doc.id } : s,
            ),
          },
        });
        return doc;
      });
    }
    return this.store.create(
      'episode',
      projectId,
      {
        title: data.title || `第 ${number} 集`,
        number,
        seriesId: series.id,
        arcId: data.arcId || null,
        summary: '',
        script: '',
        sourceChapterIds: [],
        shots: [],
        segments: [],
        incoming: {},
        outgoing: {},
        openLoops: [],
        approved: false,
        stale: false,
        dependencies: [],
      },
      data.arcId || series.id,
      createId,
    );
  }
  importNovel(projectId: string, text: string) {
    this.project(projectId);
    return this.store.transaction(() => {
      let order = this.store.list('chapter', projectId).length;
      return parseNovel(text).flatMap((reel) =>
        reel.chapters.map((ch) =>
          this.store.create(
            'chapter',
            projectId,
            {
              title: ch.chapter || `第 ${ch.index} 章`,
              reel: reel.reel,
              number: ++order,
              sourceIndex: ch.index,
              text: ch.text,
              event: '',
              sourceHash: createHash('sha256').update(text).digest('hex'),
            },
            projectId,
          ),
        ),
      );
    });
  }
  importScripts(projectId: string, text: string) {
    return this.store.transaction(() =>
      parseScript(text).map((e) => {
        const doc = this.createEpisode(projectId, { title: e.chapter || `第 ${e.index} 集` });
        return this.store.update(doc.id, doc.revision, { ...doc.data, script: e.text });
      }),
    );
  }
  invalidate(changedId: string, segmentIds?: string[]) {
    const changed = this.store.get(changedId);
    const affected = new Set([changedId]);
    let loop = true;
    while (loop) {
      loop = false;
      for (const d of this.store.list(undefined, changed.projectId)) {
        if (affected.has(d.id)) continue;
        if (segmentIds && d.kind === 'segment_selection') continue;
        const deps = d.data.dependencies || d.data.references || [];
        if (deps.some((r: any) => affected.has(r.id))) {
          affected.add(d.id);
          this.store.update(d.id, d.revision, {
            ...d.data,
            stale: true,
            staleReason: `引用 ${changedId} 已更新，需复核`,
          });
          loop = true;
        }
      }
    }
    const ids = [...affected].filter((id) => id !== changedId);
    if (ids.length || segmentIds?.length)
      this.store.event(null, 'domain_correction', {
        source: changedId,
        reason: '原创作依据已修改',
        affected: ids.map((id) => ({ id, revision: this.store.get(id).revision })),
        ...(segmentIds ? { segmentIds } : {}),
      });
    return ids;
  }
  saveEpisode(
    id: string,
    revision: number,
    raw: any,
    dependencies?: { id: string; revision: number }[],
  ) {
    const d = this.store.get(id);
    if (d.kind !== 'episode') throw new HttpError(400, '不是分集');
    const plan = episodePlanSchema.parse(raw);
    if (d.data.seriesProduction || plan.seriesProduction) {
      if (
        !plan.seriesProduction ||
        (d.data.seriesProduction && plan.seriesProduction.slotId !== d.data.seriesProduction.slotId)
      )
        throw new HttpError(400, '不能移除或偷换分集规划归属');
      const scoped = { ...d, data: { ...d.data, ...plan } };
      resolveSeries(this.store, scoped);
      seriesInformationForEpisode(this.store, scoped);
    }
    this.validatePlan(d.projectId, plan);
    return this.store.transaction(() => {
      const next = this.store.update(id, revision, {
        ...d.data,
        ...plan,
        approved: false,
        stale: false,
        dependencies: dependencies ?? d.data.dependencies ?? [],
      });
      const domain = new DomainService(this.store);
      domain.dependencies(next, [...domain.refs(plan), ...next.data.dependencies]);
      const segmentFingerprint = (episode: any, id: string) => {
        const segment = episode.segments.find((s: any) => s.id === id);
        return generationDigest({
          segment,
          shots: episode.shots.filter((s: any) => segment?.shotIds.includes(s.id)),
        });
      };
      const changedSegments = [
        ...new Set<string>([...d.data.segments, ...plan.segments].map((s: any) => s.id)),
      ].filter((id) => segmentFingerprint(d.data, id) !== segmentFingerprint(plan, id));
      for (const selection of this.store
        .list('segment_selection', d.projectId)
        .filter((s) => s.parentId === id)) {
        if (changedSegments.includes(selection.data.segmentId)) {
          const marked = this.store.update(selection.id, selection.revision, {
            ...selection.data,
            stale: true,
            staleReason: '本片段分镜或参考方案已变化，需要重新审核选择',
            staleCause: 'plan_changed',
          });
          domain.dependencies(marked, domain.refs(selection.data));
          if (selection.data.schemaVersion === 3)
            domain.propagateSelectionCorrection(d.projectId, {
              source: selection.id,
              affected: [],
              reason: '上游片段计划变化，采用需要复核',
            });
        }
      }
      this.invalidate(id, changedSegments);
      return next;
    });
  }
  validatePlan(projectId: string, plan: any) {
    const timingIssues = dramaturgyIssues(plan);
    if (timingIssues.length) throw new HttpError(400, timingIssues.join('；'));
    const domain = new DomainService(this.store);
    for (const shot of plan.shots) if (shot.state) domain.validateShot(projectId, shot.state);
    for (const id of plan.sourceChapterIds) this.owned(id, projectId, 'chapter');
    const layouts = plan.shots.flatMap((s: any) =>
      s.state?.layout ? [domain.owned(projectId, s.state.layout, 'layout')] : [],
    );
    const directingErrors = plan.shots
      .flatMap((s: any) => prepareShot(s, layouts).issues)
      .filter((i: any) => i.severity === 'blocking');
    if (directingErrors.length)
      throw new HttpError(400, directingErrors.map((i: any) => i.message).join('；'));
    const semanticErrors = plan.shots.flatMap((s: any) =>
      validateShotSemantics(
        s,
        domain.refs(s).map((r) => domain.owned(projectId, r)),
      ),
    );
    if (semanticErrors.length) throw new HttpError(400, semanticErrors.join('；'));
    const ids = plan.shots.map((s: any) => s.id);
    if (new Set(ids).size !== ids.length) throw new HttpError(400, '镜头 ID 重复');
    const segIds = plan.segments.map((s: any) => s.id);
    if (new Set(segIds).size !== segIds.length) throw new HttpError(400, '片段 ID 重复');
    if (plan.dramaturgy) {
      const covered = plan.segments.flatMap((s: any) => s.shotIds);
      if (new Set(covered).size !== covered.length)
        throw new HttpError(400, '长片镜头不能同时由两个片段覆盖；候选重做沿用片段 ID');
    }
    for (const seg of plan.segments) {
      if (seg.shotIds.some((id: string) => !ids.includes(id)))
        throw new HttpError(400, '片段引用不存在的镜头');
      for (const ref of [...seg.references, ...(seg.guides || [])])
        this.owned(ref.assetId, projectId, 'asset', ref.revision);
      if (seg.referencePlan) domain.owned(projectId, seg.referencePlan, 'reference_plan');
      if (seg.guides?.length && !seg.referencePlan) {
        const assets = [...seg.references, ...seg.guides].map((r: any) => ({
          reference: r,
          asset: this.owned(r.assetId, projectId, 'asset', r.revision),
        }));
        prepareGuidedH3({ segment: seg, assets, width: 864, height: 480 });
      }
    }
  }
  approveEpisode(id: string, revision: number) {
    const doc = this.store.get(id);
    if (doc.kind !== 'episode') throw new HttpError(400, '不是分集');
    this.validatePlan(doc.projectId, episodePlanSchema.parse(doc.data));
    const next = this.store.update(id, revision, {
      ...doc.data,
      approved: true,
      stale: false,
      dependencies: doc.data.shots.some((s: any) => s.state)
        ? doc.data.dependencies || []
        : (doc.data.dependencies || []).map((r: any) => ({
            id: r.id,
            revision: this.store.get(r.id).revision,
          })),
    });
    const domain = new DomainService(this.store);
    domain.dependencies(next, [
      ...domain.refs(doc.data.shots),
      ...domain.refs(doc.data.segments),
      ...(doc.data.dependencies || []),
    ]);
    return next;
  }
  confirmContinuity(episodeId: string, revision: number, data: any) {
    const ep = this.store.get(episodeId);
    if (ep.data.seriesProduction) throw new HttpError(409, 'V7 剧情事实通过整集交付确认');
    if (ep.kind !== 'episode' || ep.revision !== revision || !ep.data.approved)
      throw new HttpError(409, '请先确认当前分集版本');
    const refs = [{ id: ep.id, revision: ep.revision }, ...(data.references || [])];
    for (const ref of refs) this.owned(ref.id, ep.projectId, undefined, ref.revision);
    return this.store.transaction(() => {
      const old = this.store.list('continuity', ep.projectId).find((c) => c.parentId === ep.id);
      const next = {
        facts: data.facts || {},
        openLoops: data.openLoops || [],
        references: refs,
        confirmed: true,
        stale: false,
      };
      if (old) {
        const result = this.store.update(old.id, old.revision, next);
        this.invalidate(old.id);
        return result;
      }
      // Invalidate earlier dependent plans before adding a newly confirmed fact.
      this.invalidate(ep.id);
      return this.store.create('continuity', ep.projectId, next, ep.id);
    });
  }
  prepareGeneration(
    raw: any,
    profile: ComfyProfile,
    scopeReference?: { id: string; revision: number },
  ) {
    const req = generationPreviewSchema.parse(raw);
    const capabilities = creationCapabilities(this.store, profile);
    const ep = this.store.get(req.episodeId);
    if (
      ep.kind !== 'episode' ||
      ep.revision !== req.episodeRevision ||
      !ep.data.approved ||
      ep.data.stale
    )
      throw new HttpError(409, '分集需先审核，或已发生版本变化');
    let segment = ep.data.segments.find((s: any) => s.id === req.segmentId);
    if (!segment) throw new HttpError(400, '片段不存在');
    const head = productionHead(this.store, ep.id);
    if (head.conflict) throw new HttpError(409, '先明确激活当前制作版本');
    if (head.runId) {
      const director = this.store.get(head.runId).data.results?.director;
      if (
        !director ||
        this.store.get(director.id, director.revision).data.result.contractRevision !== 2 ||
        segment.shotIds.some(
          (id: string) =>
            ep.data.shots.find((s: any) => s.id === id)?.directing?.contractRevision !== 2,
        )
      )
        throw new HttpError(
          409,
          '原 V9 制作依据只支持审看与恢复；新生成须完成修订 2 导演设计并重新准备',
        );
    }
    if (scopeReference) {
      const scope = this.store.get(scopeReference.id, scopeReference.revision);
      const run = scope.parentId ? this.store.get(scope.parentId) : null;
      if (
        scope.kind !== 'creation_scope' ||
        scope.projectId !== ep.projectId ||
        this.store.get(scope.id).revision !== scope.revision ||
        run?.kind !== 'creation_run' ||
        run.projectId !== ep.projectId ||
        run.data.episodeId !== ep.id ||
        run.data.scope?.id !== scope.id ||
        run.data.scope?.revision !== scope.revision ||
        run.data.materialized?.scope?.id !== scope.id ||
        run.data.materialized?.scope?.revision !== scope.revision ||
        run.data.materialized?.episode?.id !== ep.id ||
        run.data.materialized?.episode?.revision !== ep.revision
      )
        throw new HttpError(409, '执行范围与当前物化版本不匹配');
      const projected = run.data.materialized.segments?.find((s: any) => s.id === req.segmentId);
      if (
        !projected ||
        !scope.data.groupIds.includes(projected.id) ||
        generationDigest(projected.shotIds) !==
          generationDigest(segment.shotIds.filter((id: string) => scope.data.shotIds.includes(id)))
      )
        throw new HttpError(409, '执行片段包含范围外镜头');
      segment = projected;
    }
    if (
      ep.data.dramaturgy &&
      segment.generationMode === 'formal' &&
      !segment.referencePlan &&
      ![modularBaseTemplate, universalBaseTemplate, seriesBaseTemplate].includes(
        segment.executionVersion,
      )
    )
      throw new HttpError(409, '长片正式生成需要发布本片段参考方案，固定主体、图片与关键帧版本');
    if (
      capabilities.guidedImages.available === false &&
      (segment.guides?.length ||
        [modularRefTemplate, universalRefTemplate, seriesRefTemplate].includes(
          segment.executionVersion,
        ))
    )
      throw new HttpError(
        409,
        '已保存的节点探测不支持所需图片参考：' + capabilities.guidedImages.reason,
      );
    if (req.width * req.height > 1344 * 768) throw new HttpError(400, '超过 H3 原生画布面积');
    const seriesMode = [seriesRefTemplate, seriesBaseTemplate].includes(segment.executionVersion);
    if (ep.data.seriesProduction && !seriesMode)
      throw new HttpError(409, 'V7 系列需要明确升级的 H3 v4 模板');
    const seriesContext = seriesMode ? resolveSeries(this.store, ep) : null;
    if (seriesMode && segment.incoming?.version !== 2)
      throw new HttpError(409, 'V7 需要明确独立或多来源接续契约');
    const universal = [
      universalRefTemplate,
      universalBaseTemplate,
      seriesRefTemplate,
      seriesBaseTemplate,
    ].includes(segment.executionVersion);
    const modular = [
      modularRefTemplate,
      modularBaseTemplate,
      universalRefTemplate,
      universalBaseTemplate,
      seriesRefTemplate,
      seriesBaseTemplate,
    ].includes(segment.executionVersion);
    if ((segment.incoming || segment.repair) && !universal)
      throw new HttpError(400, '接续与修订契约需要新版 V3 模板');
    const continuation = universal ? prepareContinuation(this.store, ep, segment) : null;
    const creativeProfile =
      seriesContext?.profile ||
      (modular
        ? ep.data.creationProfile
          ? new DomainService(this.store).owned(
              ep.projectId,
              ep.data.creationProfile,
              'creation_profile',
            )
          : selectedProfile(this.store, ep.projectId)
        : null);
    const shots = universal
      ? segment.shotIds.map((id: string) => ep.data.shots.find((s: any) => s.id === id))
      : ep.data.shots.filter((s: any) => segment.shotIds.includes(s.id));
    const scenes = [...new Set<string>(shots.map((s: any) => s.scene))];
    const briefs = creativeProfile
      ? scenes.map((sceneId) =>
          resolveCreativeBrief(
            this.store,
            ep.projectId,
            creativeProfile,
            { episodeId: ep.id, sceneId },
            true,
          ),
        )
      : [];
    if (
      briefs.length > 1 &&
      new Set(
        briefs.map((b) =>
          generationDigest({
            modules: b.modules,
            overrides: b.overrides,
            artBible: b.artBible,
            ...('artEntries' in b
              ? { artEntries: b.artEntries, visualReference: b.visualReference }
              : {}),
          }),
        ),
      ).size > 1
    )
      throw new HttpError(400, '一个生成片段跨越不同制作规范；请按场景拆分');
    const creativeBrief = briefs[0];
    const creativeDependencies = creativeBrief
      ? [
          creativeBrief.profile,
          ...creativeBrief.modules.map((m) => m.ref),
          ...('visualReference' in creativeBrief && creativeBrief.visualReference
            ? [creativeBrief.visualReference.asset]
            : []),
        ]
      : [];
    if (
      [modularBaseTemplate, universalBaseTemplate, seriesBaseTemplate].includes(
        segment.executionVersion,
      )
    ) {
      if (segment.referencePlan || segment.mode === 'ref2va')
        throw new HttpError(400, 'Base 模板不接受 Ref 参考方案');
      const domain = new DomainService(this.store);
      const records = domain.refs(shots).map((r) => domain.owned(ep.projectId, r));
      const assets = segment.references.map((r: any) => {
        const asset = this.owned(r.assetId, ep.projectId, 'asset', r.revision);
        if (!asset.data.adopted || asset.data.mediaType !== 'image')
          throw new HttpError(400, 'Base 首尾帧必须是已采用图片');
        return { reference: r, asset };
      });
      const input: any = {
        capabilities,
        compilerVersion: capabilities.compilerVersion,
        templateVersion: segment.executionVersion,
        profile,
        episode: { id: ep.id, revision: ep.revision },
        segment,
        creativeBrief,
        planning: { shots, records },
        assets,
        width: req.width,
        height: req.height,
        steps: req.steps,
        seed: req.seed,
        dependencyHeads: [...creativeDependencies, ...records].map((r) => ({
          id: r.id,
          revision: this.store.get(r.id).revision,
        })),
      };
      if (universal) {
        input.continuation = continuation;
        input.information = seriesMode
          ? [
              ...(ep.data.dramaturgy?.information || []),
              ...seriesInformationForEpisode(this.store, ep, true),
            ]
          : ep.data.dramaturgy?.information || [];
        if (seriesContext)
          input.seriesInputs = {
            actionDefinitions: seriesContext.production.actionDefinitions,
            series: { id: seriesContext.series.id, revision: seriesContext.series.revision },
            shared: seriesContext.production.sharedReferences,
            voices: seriesContext.voices
              .filter((v) =>
                shots.some((s: any) =>
                  s.directing.sound.dialogue.some((l: any) => l.instanceId === v.instanceId),
                ),
              )
              .map((v) => ({ instanceId: v.instanceId, record: v.record })),
          };
        input.dependencies = generationDependencies(input);
      }
      input.prepared = prepareModularH3(input);
      return { input, digest: generationDigest(input), projectId: ep.projectId };
    }
    if (segment.referencePlan) {
      const planning = resolveReferencePlan(this.store, ep, segment, req.width / req.height);
      const assets = [
        ...new Map(
          planning.selected.map((b: any) => [
            `${b.asset.id}:${b.asset.revision}`,
            {
              reference: { assetId: b.asset.id, revision: b.asset.revision },
              asset: this.owned(b.asset.id, ep.projectId, 'asset', b.asset.revision),
            },
          ]),
        ).values(),
      ];
      const input: any = {
        capabilities,
        compilerVersion: capabilities.compilerVersion,
        templateVersion: segment.executionVersion || plannedTemplateVersion,
        profile,
        episode: { id: ep.id, revision: ep.revision },
        segment,
        planning,
        assets,
        width: req.width,
        height: req.height,
        steps: req.steps,
        seed: req.seed,
        dependencyHeads: planning.dependencies.map((r) => ({
          id: r.id,
          revision: this.store.get(r.id).revision,
        })),
      };
      if (
        [modularRefTemplate, universalRefTemplate, seriesRefTemplate].includes(
          segment.executionVersion,
        )
      ) {
        input.creativeBrief = creativeBrief;
        input.dependencyHeads.push(
          ...creativeDependencies.map((r) => ({
            id: r.id,
            revision: this.store.get(r.id).revision,
          })),
        );
        if (universal) {
          input.continuation = continuation;
          input.information = seriesMode
            ? [
                ...(ep.data.dramaturgy?.information || []),
                ...seriesInformationForEpisode(this.store, ep, true),
              ]
            : ep.data.dramaturgy?.information || [];
          if (seriesContext)
            input.seriesInputs = {
              actionDefinitions: seriesContext.production.actionDefinitions,
              series: { id: seriesContext.series.id, revision: seriesContext.series.revision },
              shared: seriesContext.production.sharedReferences,
              voices: seriesContext.voices
                .filter((v) =>
                  shots.some((s: any) =>
                    s.directing.sound.dialogue.some((l: any) => l.instanceId === v.instanceId),
                  ),
                )
                .map((v) => ({ instanceId: v.instanceId, record: v.record })),
            };
          input.dependencies = generationDependencies(input);
        }
        input.prepared = prepareModularH3(input);
        return { input, digest: generationDigest(input), projectId: ep.projectId };
      }
      input.prepared = segment.executionVersion
        ? prepareDirectedH3(input)
        : preparePlannedH3(input);
      return { input, digest: generationDigest(input), projectId: ep.projectId };
    }
    if (segment.executionVersion)
      throw new HttpError(400, '新版导演模板需要已发布的 Ref2VA 参考方案');
    const guided = Boolean(segment.guides?.length);
    const selected = guided ? [...segment.references, ...segment.guides] : segment.references;
    const seen = new Set<string>();
    const assets = selected
      .filter((r: any) => {
        if (!guided) return true;
        const key = `${r.assetId}:${r.revision}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r: any) => {
        const a = this.owned(r.assetId, ep.projectId, 'asset', r.revision);
        if (!a.data.adopted) throw new HttpError(400, '请先采用参考素材');
        return { reference: r, asset: a };
      });
    const input: any = {
      capabilities,
      compilerVersion: capabilities.compilerVersion,
      templateVersion: guided ? guidedTemplateVersion : 'native-h3-v1',
      profile,
      episode: { id: ep.id, revision: ep.revision },
      segment,
      assets,
      width: req.width,
      height: req.height,
      steps: req.steps,
      seed: req.seed,
    };
    if (guided) {
      input.prepared = prepareGuidedH3(input);
      // Current review metadata participates in preview freshness; frozen files still
      // reference the explicitly selected historical version.
      input.assetHeads = assets.map((a: any) => ({
        id: a.asset.id,
        revision: this.store.get(a.asset.id).revision,
      }));
    }
    return { input, digest: generationDigest(input), projectId: ep.projectId };
  }
  generation(raw: any, profile: ComfyProfile) {
    const req = generationRequestSchema.parse(raw);
    const { input, digest, projectId } = this.prepareGeneration(req, profile);
    if (input.prepared && req.previewDigest !== digest)
      throw new HttpError(409, '请重新预览并确认：素材、分镜、参数或模板已变化');
    const frozen = input.prepared ? { ...input, previewDigest: digest } : input;
    return this.store.createJob('generation', projectId, req.episodeId, frozen, req.idempotencyKey);
  }
  saveEdl(
    projectId: string,
    raw: any,
    revision?: number,
    identity?: {
      id?: string;
      createId?: string;
      owner?: { deliveryPlanId: string; runId: string; episodeId: string; mode: 'work' | 'scope' };
    },
  ) {
    const edl = edlSchema.parse(raw);
    this.owned(edl.episodeId, projectId, 'episode');
    this.validateEdl(projectId, edl);
    if (revision !== undefined && !identity?.id)
      throw new HttpError(400, '更新时间线必须指定 ID 和版本');
    const old = identity?.id ? this.owned(identity.id, projectId, 'edl') : undefined;
    if (
      old &&
      (old.parentId !== edl.episodeId ||
        JSON.stringify(old.data.owner) !== JSON.stringify(identity?.owner))
    )
      throw new HttpError(409, '时间线归属不可改变，请通过所属交付计划保存');
    const dependencies = [...edl.clips, ...edl.audio].map((c) => ({
      id: c.assetId,
      revision: c.revision,
    }));
    dependencies.push(
      ...edl.clips.flatMap((c) => (c.selection ? [c.selection] : [])),
      ...edl.audio.flatMap((a) => (a.dialogueTake ? [a.dialogueTake] : [])),
    );
    return this.store.transaction(() => {
      const doc = old
        ? this.store.update(old.id, revision ?? -1, {
            ...edl,
            ...(identity?.owner ? { owner: identity.owner } : {}),
            dependencies,
          })
        : this.store.create(
            'edl',
            projectId,
            { ...edl, ...(identity?.owner ? { owner: identity.owner } : {}), dependencies },
            edl.episodeId,
            identity?.createId,
          );
      new DomainService(this.store).dependencies(doc, dependencies);
      return doc;
    });
  }
  validateEdl(projectId: string, edl: any) {
    for (const id of new Set<string>(
      edl.clips.flatMap((c: any) => (c.selection ? [c.selection.id] : [])),
    )) {
      const entries = edl.clips
        .map((c: any, index: number) => ({ ...c, index }))
        .filter((c: any) => c.selection?.id === id);
      const selection = this.owned(
        id,
        projectId,
        'segment_selection',
        entries[0].selection.revision,
      );
      if (!selection.data.composition) continue;
      const parts = selectionMedia(selection.data);
      if (
        entries.length !== parts.length ||
        entries.some(
          (e: any, n: number) =>
            e.selection.revision !== selection.revision ||
            e.index !== entries[0].index + n ||
            e.assetId !== parts[n].video.id ||
            e.revision !== parts[n].video.revision ||
            e.in !== parts[n].in ||
            e.out !== parts[n].out,
        )
      )
        throw new HttpError(409, '局部修订装配必须完整保留已审核的片段顺序；调整裁剪需要重新采用');
    }
    for (const [audioOnly, clips] of [
      [false, edl.clips],
      [true, edl.audio],
    ] as const) {
      for (const clip of clips) {
        if (clip.selection) {
          const selection = this.owned(
            clip.selection.id,
            projectId,
            'segment_selection',
            clip.selection.revision,
          );
          if (
            selection.data.composition
              ? !selectionMedia(selection.data).some(
                  (part) =>
                    part.video.id === clip.assetId &&
                    part.video.revision === clip.revision &&
                    part.in === clip.in &&
                    part.out === clip.out,
                )
              : selection.data.video.id !== clip.assetId ||
                selection.data.video.revision !== clip.revision ||
                clip.in < selection.data.in ||
                clip.out > selection.data.out ||
                (selection.data.schemaVersion === 3 &&
                  (clip.in !== selection.data.in || clip.out !== selection.data.out))
          )
            throw new HttpError(409, '候选或区间变化需要重新审核片段选择');
        }
        const a = this.owned(clip.assetId, projectId, 'asset', clip.revision);
        if (!a.data.adopted) throw new HttpError(400, '时间线只可使用已采用素材');
        if (audioOnly && a.data.mediaType !== 'audio' && !a.data.hasAudio)
          throw new HttpError(400, '此素材没有音轨');
        if (!audioOnly && a.data.mediaType === 'audio')
          throw new HttpError(400, '视频轨不能放纯音频');
        if (clip.out <= clip.in) throw new HttpError(400, '出点必须大于入点');
        if (a.data.mediaType === 'image') {
          if (clip.in !== 0) throw new HttpError(400, '静态图片入点应为 0');
        } else if (!a.data.duration || clip.out > a.data.duration + 0.04)
          throw new HttpError(400, '裁剪超过媒体实际时长');
      }
    }
  }
}
