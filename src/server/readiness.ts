import { generationDigest } from './h3-guided.js';
import { resolveSeries } from './series-production.js';
import { Store, HttpError } from './db.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { creationPresets, type ReadinessIssue } from '../shared/workbench.js';
import { referencePlanSchema } from '../shared/domain.js';
import type { RecordDoc, ComfyProfile } from '../shared/contracts.js';
import { resolveCreativeBrief } from './creative-brief.js';
import type { CreationRef } from '../shared/creation.js';
import { ModelRegistry } from './model-registry.js';

export class ReadinessService {
  constructor(public store: Store) {}
  profile(projectId: string) {
    return (
      this.store
        .list('creation_profile', projectId)
        .filter((d) => !d.data.archived)
        .at(-1)?.data || creationPresets[3]
    );
  }
  generation(raw: any, profile: ComfyProfile, scope?: CreationRef) {
    const ep = this.store.get(raw.episodeId);
    if (
      (!profile?.baseUrl || !profile.instanceId) &&
      !new ModelRegistry(this.store).resolve(ep.projectId, ep.id, 'video', raw.segmentId)
    )
      throw new HttpError(400, '请先配置模型连接');
    const prepared = new StudioService(this.store).prepareGeneration(raw, profile, scope);
    return prepared;
  }
  project(projectId: string) {
    const project = new StudioService(this.store).project(projectId);
    const defaults = this.profile(projectId);
    const records = this.store.list(undefined, projectId),
      issues: ReadinessIssue[] = [];
    const add = (
      doc: RecordDoc,
      code: string,
      message: string,
      step: ReadinessIssue['step'],
      severity: ReadinessIssue['severity'] = 'review',
      extra: Partial<ReadinessIssue> = {},
    ) =>
      issues.push({
        code,
        message,
        step,
        severity,
        target: { id: doc.id, revision: doc.revision },
        field: '',
        action: '打开并处理',
        ...extra,
      });
    for (const doc of records) {
      if (doc.data.archived) continue;
      if (doc.kind === 'creation_run') {
        for (const problem of doc.data.issues || [])
          add(
            doc,
            problem.code,
            problem.message,
            ['production', 'assets'].includes(problem.stage)
              ? 'assets'
              : problem.stage === 'delivery'
                ? 'film'
                : problem.category === 'evidence'
                  ? 'review'
                  : 'planning',
            problem.severity,
            {
              category: problem.category,
              stage: problem.stage,
              field: problem.field,
              episodeId: doc.data.episodeId,
              action: '打开创作会话',
            },
          );
      }
      if (doc.data.stale)
        add(doc, 'stale', doc.data.staleReason || '依据已经变化，需要复核', 'planning', 'review');
      if (doc.kind === 'proposal' && !doc.data.approved)
        add(doc, 'proposal_review', doc.data.proposal?.summary || '导演提案待确认', 'planning');
      if (
        doc.kind === 'creation_profile' &&
        ['director-v5', 'director-v6', 'director-v7'].includes(doc.data.rulesVersion)
      ) {
        try {
          for (const check of resolveCreativeBrief(this.store, projectId, doc).checks)
            add(
              doc,
              check.code,
              check.message,
              'planning',
              check.severity === 'blocking' ? 'blocking' : 'review',
              { field: 'composition' },
            );
        } catch (e: any) {
          add(doc, 'creative-composition-invalid', e.message, 'planning', 'blocking', {
            field: 'composition',
          });
        }
      }
      if (doc.kind === 'reference_pack' && !doc.data.published)
        add(doc, 'pack_review', `${doc.data.name} 尚未发布`, 'assets');
      if (
        doc.kind === 'asset' &&
        doc.data.mediaType === 'image' &&
        !doc.data.derivedSource &&
        !doc.data.jobId &&
        !doc.data.adopted
      )
        add(doc, 'asset_review', `${doc.data.name} 待采用`, 'assets');
      if (doc.kind === 'episode') {
        const extra = { episodeId: doc.id };
        if (!doc.data.approved)
          add(doc, 'episode_review', `${doc.data.title} 分镜待审核`, 'shots', 'review', extra);
        if (!doc.data.shots?.length)
          add(doc, 'shots_missing', '尚未建立分镜', 'shots', 'blocking', extra);
        for (const segment of doc.data.segments || []) {
          try {
            this.generation(
              {
                episodeId: doc.id,
                episodeRevision: doc.revision,
                segmentId: segment.id,
                width: doc.data.seriesProduction
                  ? resolveSeries(this.store, doc).profile.data.width
                  : defaults.width,
                height: doc.data.seriesProduction
                  ? resolveSeries(this.store, doc).profile.data.height
                  : defaults.height,
                steps: doc.data.seriesProduction
                  ? resolveSeries(this.store, doc).profile.data.steps
                  : defaults.steps,
                seed: 1,
              },
              this.store.setting('comfy', null as any),
            );
          } catch (e: any) {
            add(doc, `segment:${segment.id}`, e.message, 'shots', 'blocking', {
              ...extra,
              segmentId: segment.id,
              field: `segments.${segment.id}`,
            });
          }
        }
        if (
          !records.some(
            (c) =>
              c.kind === 'continuity' && c.parentId === doc.id && c.data.confirmed && !c.data.stale,
          ) &&
          project.data.mode === 'series'
        )
          add(doc, 'canon_review', '本集剧情状态待确认', 'review', 'review', extra);
      }
    }
    for (const job of this.store.jobs(projectId)) {
      if (
        job.kind === 'generation' &&
        job.state === 'succeeded' &&
        !records.some(
          (r) => r.kind === 'segment_selection' && r.data.jobId === job.id && !r.data.stale,
        )
      ) {
        const ep = records.find((r) => r.id === job.episodeId);
        if (ep)
          add(ep, `candidate:${job.id}`, '视频候选待审核与选择', 'review', 'review', {
            episodeId: ep.id,
          });
      }
    }
    return {
      projectId,
      issues,
      steps: ['planning', 'assets', 'shots', 'review', 'film'].map((step) => ({
        step,
        blocking: issues.filter((i) => i.step === step && i.severity === 'blocking').length,
        review: issues.filter((i) => i.step === step && i.severity === 'review').length,
      })),
    };
  }
  suggest(episodeId: string, segmentId: string) {
    const ep = this.store.get(episodeId),
      domain = new DomainService(this.store);
    if (ep.kind !== 'episode') throw new HttpError(400, '需要分集');
    const segment = ep.data.segments.find((s: any) => s.id === segmentId);
    if (!segment) throw new HttpError(404, '片段不存在');
    const old = segment.referencePlan
      ? domain.owned(ep.projectId, segment.referencePlan, 'reference_plan').data
      : null;
    const guides = old?.guides || [],
      pinned = new Set(guides.map((g: any) => g.bindingId));
    const bindings: any[] = (old?.bindings || [])
      .filter((b: any) => b.priority === 0 || pinned.has(b.id))
      .map((b: any) => structuredClone(b));
    const missing: any[] = [];
    const shots = ep.data.shots.filter((s: any) => segment.shotIds.includes(s.id));
    for (const shot of shots)
      for (const entry of shot.state?.instances || []) {
        if (
          shot.directing?.version >= 2 &&
          !shot.directing.presence.visible.includes(entry.instanceId)
        )
          continue;
        if (!entry.pack) {
          missing.push({ instanceId: entry.instanceId, reason: '请选择正式参考包' });
          continue;
        }
        const pack = domain.owned(ep.projectId, entry.pack, 'reference_pack');
        const entity = domain.owned(ep.projectId, entry.entity, 'entity');
        if (!pack.data.published || pack.data.stale) {
          missing.push({ instanceId: entry.instanceId, reason: '参考包需要发布审核' });
          continue;
        }
        const available = pack.data.views.filter((v: any) => !v.overviewOnly);
        const required = (shot.state.requiredViews || []).filter(
          (v: any) => v.instanceId === entry.instanceId,
        );
        const baseline = available.find((v: any) => v.view === 'front') || available[0];
        const desired = [
          ...(baseline ? [{ view: baseline.view, reason: '基准身份' }] : []),
          ...required,
        ];
        for (const need of desired) {
          const view = available.find((v: any) => v.view === need.view);
          if (!view) {
            missing.push({
              instanceId: entry.instanceId,
              view: need.view,
              entity: entry.entity,
              appearance: entry.appearance,
              reason: need.reason,
            });
            continue;
          }
          let binding = bindings.find(
            (b) =>
              b.pack?.id === pack.id &&
              b.pack?.revision === pack.revision &&
              b.view === view.view &&
              b.asset.id === view.asset.id &&
              b.asset.revision === view.asset.revision,
          );
          if (binding) {
            if (!binding.instanceIds.includes(entry.instanceId))
              binding.instanceIds.push(entry.instanceId);
            continue;
          }
          const prior = (old?.bindings || []).find(
            (b: any) =>
              b.pack?.id === pack.id &&
              b.view === view.view &&
              b.asset.id === view.asset.id &&
              b.asset.revision === view.asset.revision,
          );
          bindings.push({
            id: prior?.id || `ref-${pack.id}-${view.id}`,
            asset: view.asset,
            pack: entry.pack,
            view: view.view,
            instanceIds: [entry.instanceId],
            role: ['scene', 'prop', 'style'].includes(view.scope)
              ? view.scope
              : entity.data.type === 'environment'
                ? 'scene'
                : entity.data.type === 'style'
                  ? 'style'
                  : 'identity',
            priority: ['environment', 'style'].includes(entity.data.type)
              ? 3
              : need === desired[0]
                ? 1
                : 2,
            required: true,
            reason: need.reason,
            retain: view.features || [],
            allow: ['动作和姿态'],
            inheritBackground: view.inheritBackground || false,
          });
        }
      }
    for (const b of old?.bindings || []) if (!bindings.some((v) => v.id === b.id)) bindings.push(b);
    const data = referencePlanSchema.parse({
      name: '参考方案初稿',
      episodeId,
      segmentId,
      bindings,
      guides,
      acknowledgedRisks: [],
    });
    const requiredCount = new Set(
      data.bindings
        .filter((b) => b.required || b.priority === 0)
        .map((b) => `${b.asset.id}:${b.asset.revision}`),
    ).size;
    return {
      data,
      missing,
      requiredCount,
      limit: 9,
      blocked: requiredCount > 9,
      uploaded: false,
      submitted: false,
    };
  }
}
