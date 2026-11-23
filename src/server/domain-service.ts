import { repairSourceUnchanged } from './selection-splice.js';
import { saveStoryBasis } from './story-basis.js';
import { prepareCanonV3 } from './series-canon.js';
import { validateIssueTarget } from './review-evidence.js';
import { productionHead } from './creation-heads.js';
import { resolveCreativeBrief } from './creative-brief.js';
import { continuityIssues, prepareShot, eventCoverageIssues } from '../shared/directing.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';
import {
  domainSchemas,
  versionRef,
  shotStateSchema,
  reviewSchema,
  selectionSchema,
  canonSchema,
  type DomainKind,
  type VersionRef,
} from '../shared/domain.js';
import type { RecordDoc, Kind } from '../shared/contracts.js';
import { creationProfileSchema } from '../shared/workbench.js';
import { auditShotSemantics } from '../shared/shot-semantics.js';
import {
  validateObservedReview,
  selectedBoundary,
  buildReviewEvaluation,
} from './review-evidence.js';
import { boundaryChanges, correctionAffectsInput } from './generation-dependencies.js';
import { repairWindow, selectionMedia, spliceSelection } from './selection-splice.js';
import { prepareContinuation } from './continuation.js';
import { canonSourceProblems } from './series-production.js';
import { VoiceLibrary } from './voice-library.js';

// Owns project-domain validation, review publication, dependency tracking and copying.
// It never executes a model; corrections only mark existing result review metadata.
export class DomainService {
  constructor(public store: Store) {}
  owned(projectId: string, ref: VersionRef, kind?: Kind) {
    const doc = this.store.get(ref.id, ref.revision);
    if (doc.projectId !== projectId || (kind && doc.kind !== kind))
      throw new HttpError(400, '引用的项目、类型或版本不匹配');
    return doc;
  }
  dependencies(doc: RecordDoc, refs: (VersionRef & { purpose?: string })[]) {
    for (const ref of refs) {
      this.owned(doc.projectId, ref);
      this.store.db
        .prepare('INSERT OR IGNORE INTO dependencies VALUES(?,?,?,?,?)')
        .run(ref.id, ref.revision, doc.id, doc.revision, ref.purpose || 'fixed_input');
    }
  }
  refs(data: any): VersionRef[] {
    const result: VersionRef[] = [];
    const visit = (value: any) => {
      if (!value || typeof value !== 'object') return;
      if (typeof value.id === 'string' && Number.isInteger(value.revision)) {
        result.push({ id: value.id, revision: value.revision });
        return;
      }
      // Global voice identity has its own immutable library history.
      for (const [key, child] of Object.entries(value)) if (key !== 'globalVoice') visit(child);
    };
    visit(data);
    return [...new Map(result.map((r) => [`${r.id}:${r.revision}`, r])).values()];
  }
  validateRelations(relations: any[], instances: Map<string, RecordDoc>, regionIds: string[] = []) {
    const occupied = new Set<string>();
    for (const relation of relations) {
      if (!instances.has(relation.objectId))
        throw new HttpError(400, `关系主体不存在：${relation.objectId}`);
      const target = instances.get(relation.targetId);
      if (relation.objectId === relation.targetId) throw new HttpError(400, '物体不能归属于自身');
      if (relation.type === 'locatedIn') {
        if (!regionIds.includes(relation.targetId)) throw new HttpError(400, '场景区域不存在');
      } else if (!target) throw new HttpError(400, `关系目标不存在：${relation.targetId}`);
      if (
        ['heldBy', 'attachedTo'].includes(relation.type) &&
        !target?.data.anchors.includes(relation.anchor)
      )
        throw new HttpError(400, `附着点不存在：${relation.anchor}`);
      if (relation.quantity > relation.maxQuantity) throw new HttpError(400, '道具数量超出约束');
      const key = relation.objectId + ':' + (relation.type === 'locatedIn' ? 'location' : 'owner');
      if (occupied.has(key)) throw new HttpError(400, '同一物体具有冲突的归属关系');
      occupied.add(key);
    }
    for (const relation of relations) {
      const seen = new Set([relation.objectId]);
      let next = relation.targetId;
      while (next) {
        if (seen.has(next)) throw new HttpError(400, '道具归属关系形成循环');
        seen.add(next);
        next = relations.find((r) => r.objectId === next && r.type !== 'locatedIn')?.targetId;
      }
    }
  }
  instanceMap(projectId: string, entries?: any[]) {
    const map = new Map<string, RecordDoc>();
    const entities = entries
      ? entries.map((e) => this.owned(projectId, e.entity, 'entity'))
      : this.store.list('entity', projectId);
    for (const entity of entities)
      for (const instance of entity.data.instances) {
        if (map.has(instance.id) && map.get(instance.id)!.id !== entity.id)
          throw new HttpError(400, '实例 ID 在项目内重复');
        map.set(instance.id, entity);
      }
    return map;
  }
  save(
    projectId: string,
    kind: DomainKind | 'creation_profile',
    raw: unknown,
    id?: string,
    revision?: number,
    createId?: string,
  ) {
    const project = this.store.get(projectId);
    if (project.kind !== 'project') throw new HttpError(400, '不是项目');
    if (!(kind in domainSchemas) && kind !== 'creation_profile')
      throw new HttpError(400, '不支持的领域对象');
    const data: any =
      kind === 'creation_profile'
        ? creationProfileSchema.parse(raw)
        : domainSchemas[kind].parse(raw);
    const old = id ? this.store.get(id) : null;
    if (kind === 'voice_profile' && data.version === 2)
      new VoiceLibrary(this.store).voice(data.globalVoice.id, data.globalVoice.revision);
    if (old && (old.kind !== kind || old.projectId !== projectId))
      throw new HttpError(400, '记录不属于本项目或类型不匹配');
    if (old?.kind === 'layout' && old.data.creationSource)
      throw new HttpError(409, '此布局由固定导演结果生成，请通过导演场景修订修改空间');
    if (kind === 'entity') {
      if (
        new Set((data.attributes || []).map((a: any) => a.key)).size !==
        (data.attributes || []).length
      )
        throw new HttpError(400, '主体属性键重复');
      if (!data.instances.length) data.instances = [{ id: randomUUID(), name: data.name }];
      if (
        new Set(data.instances.map((i: any) => i.id)).size !== data.instances.length ||
        new Set(data.anchors).size !== data.anchors.length
      )
        throw new HttpError(400, '实例或附着点重复');
      const other = this.store
        .list('entity', projectId)
        .filter((e) => e.id !== id)
        .flatMap((e) => e.data.instances.map((i: any) => i.id));
      if (data.instances.some((i: any) => other.includes(i.id)))
        throw new HttpError(400, '实例 ID 已属于其他主体');
    }
    const refs = this.refs(data);
    for (const ref of refs) this.owned(projectId, ref);
    if (data.entity) this.owned(projectId, data.entity, 'entity');
    if (data.appearance) {
      const appearance = this.owned(projectId, data.appearance, 'appearance');
      if (appearance.data.entity.id !== data.entity.id) throw new HttpError(400, '外观不属于主体');
    }
    if (data.views && new Set(data.views.map((v: any) => v.id)).size !== data.views.length)
      throw new HttpError(400, '视图 ID 重复');
    if (
      kind === 'creation_profile' &&
      ['director-v5', 'director-v6', 'director-v7'].includes(data.rulesVersion)
    ) {
      for (const ref of data.composition.moduleRefs) this.owned(projectId, ref, 'creative_module');
      for (const exception of data.composition.exceptions) {
        if (!exception.scope.episodeId) throw new HttpError(400, '例外必须明确分集');
        const ep = this.owned(projectId, this.store.get(exception.scope.episodeId), 'episode');
        if (
          exception.scope.sceneId &&
          !ep.data.shots.some((s: any) => s.scene === exception.scope.sceneId) &&
          !ep.data.dramaturgy?.scenes.some((s: any) => s.id === exception.scope.sceneId)
        )
          throw new HttpError(400, '例外场景不存在');
      }
      for (const entry of data.composition.artEntries || []) {
        if (entry.target.kind === 'entity')
          this.owned(projectId, this.store.get(entry.target.id), 'entity');
        if (entry.target.kind === 'instance' && !this.instanceMap(projectId).has(entry.target.id))
          throw new HttpError(400, '美术条目引用未声明的项目实例');
        if (entry.scope.episodeId) {
          const ep = this.owned(projectId, this.store.get(entry.scope.episodeId), 'episode');
          if (
            entry.scope.shotIds.some(
              (id: string) => !ep.data.shots.some((s: any) => s.id === id),
            ) ||
            (entry.scope.sceneId &&
              !ep.data.shots.some((s: any) => s.scene === entry.scope.sceneId))
          )
            throw new HttpError(400, '美术条目镜头或场景不属于指定分集');
        }
      }
    }
    if (kind === 'reference_pack')
      for (const view of data.views) {
        const asset = this.owned(projectId, view.asset, 'asset');
        if (asset.data.mediaType !== 'image') throw new HttpError(400, '参考包必须引用图片版本');
      }
    if (kind === 'asset_task')
      for (const ref of data.references) {
        const asset = this.owned(projectId, ref, 'asset');
        if (asset.data.mediaType !== 'image') throw new HttpError(400, '制作任务参考必须是图片');
      }
    if (kind === 'reference_pack' || kind === 'asset_task')
      this.validateRelations(data.relations, this.instanceMap(projectId));
    if (kind === 'layout') {
      if (this.owned(projectId, data.environment, 'entity').data.type !== 'environment')
        throw new HttpError(400, '布局必须属于环境主体');
      if (data.image && this.owned(projectId, data.image, 'asset').data.mediaType !== 'image')
        throw new HttpError(400, '布局底图必须是图片');
      for (const list of [data.regions, data.markers, data.cameras, data.barriers || []])
        if (new Set(list.map((x: any) => x.id)).size !== list.length)
          throw new HttpError(400, '布局标识重复');
      for (const b of data.barriers || [])
        if (
          (b.start.x === b.end.x && b.start.y === b.end.y) ||
          b.regions.some((id: string) => !data.regions.some((r: any) => r.id === id))
        )
          throw new HttpError(400, '墙体长度或连接区域无效');
      if (data.regions.some((r: any) => r.x + r.width > 1 || r.y + r.height > 1))
        throw new HttpError(400, '区域超出布局范围');
    }
    if (kind === 'reference_plan') {
      const ep = this.store.get(data.episodeId);
      if (
        ep.kind !== 'episode' ||
        ep.projectId !== projectId ||
        !ep.data.segments.some((s: any) => s.id === data.segmentId)
      )
        throw new HttpError(400, '参考方案的片段不存在');
      if (new Set(data.bindings.map((b: any) => b.id)).size !== data.bindings.length)
        throw new HttpError(400, '图片绑定 ID 重复');
      for (const b of data.bindings) {
        const asset = this.owned(projectId, b.asset, 'asset');
        if (asset.data.mediaType !== 'image') throw new HttpError(400, '参考方案必须引用图片');
        if (b.pack) {
          const pack = this.owned(projectId, b.pack, 'reference_pack');
          if (
            !pack.data.views.some(
              (v: any) =>
                v.asset.id === b.asset.id &&
                v.asset.revision === b.asset.revision &&
                v.view === b.view &&
                !v.overviewOnly,
            )
          )
            throw new HttpError(400, '图片不在已发布参考包的独立视图中');
        }
      }
      for (const g of data.guides)
        if (!data.bindings.some((b: any) => b.id === g.bindingId))
          throw new HttpError(400, '关键帧引用悬空');
    }
    return this.store.transaction(() => {
      const nextData = {
        ...data,
        ...(old?.data.origin ? { origin: old.data.origin } : {}),
        schemaVersion: 2,
        published: false,
        stale: false,
        review: null,
        ...(kind === 'asset_task'
          ? {
              deliveries: old?.data.deliveries || [],
              ...(old?.data.creationRunId
                ? {
                    creationRunId: old.data.creationRunId,
                    creationRun: old.data.creationRun,
                    requirementId: old.data.requirementId,
                    shotIds: old.data.shotIds,
                    assetsResult: old.data.assetsResult,
                    scriptResult: old.data.scriptResult,
                    maxRevisions: old.data.maxRevisions,
                    receipts: old.data.receipts,
                    state: 'waiting_codex',
                  }
                : {}),
            }
          : {}),
      };
      const doc = old
        ? this.store.update(old.id, revision ?? -1, nextData)
        : this.store.create(
            kind,
            projectId,
            nextData,
            data.entity?.id || data.environment?.id || data.episodeId || projectId,
            createId,
          );
      this.dependencies(doc, refs);
      return doc;
    });
  }
  publish(id: string, revision: number, raw: unknown) {
    const review = z
      .object({ inspected: z.boolean().default(false), conclusion: z.string().default('') })
      .parse(raw);
    const doc = this.store.get(id);
    if (
      ![
        'reference_pack',
        'reference_plan',
        'creative_module',
        'creation_profile',
        'voice_profile',
      ].includes(doc.kind)
    )
      throw new HttpError(400, '此记录类型不支持发布；可发布参考包、参考方案、创作模块或创作配置');
    for (const ref of this.refs(doc.data)) this.owned(doc.projectId, ref);
    if (
      doc.kind === 'creation_profile' &&
      ['director-v5', 'director-v6', 'director-v7'].includes(doc.data.rulesVersion)
    ) {
      const brief = resolveCreativeBrief(this.store, doc.projectId, doc);
      const blockers = brief.checks.filter(
        (c) => c.severity === 'blocking' && c.code !== 'profile-unpublished',
      );
      if (blockers.length) throw new HttpError(409, blockers.map((c) => c.message).join('；'));
    }
    if (doc.kind === 'voice_profile') {
      if (doc.data.version === 2) {
        const voice = new VoiceLibrary(this.store).voice(
          doc.data.globalVoice.id,
          doc.data.globalVoice.revision,
        );
      }
      for (const sample of doc.data.samples || []) {
        const audio = this.owned(doc.projectId, sample.asset, 'asset');
        if (audio.data.mediaType !== 'audio' || sample.out > audio.data.duration)
          throw new HttpError(400, '声音参考必须是音频，且区间不能超出媒体');
      }
    }
    return this.store.transaction(() => {
      const next = this.store.update(id, revision, {
        ...doc.data,
        published: true,
        review: { ...review, at: Date.now() },
      });
      this.dependencies(next, this.refs(doc.data));
      return next;
    });
  }
  validateShot(projectId: string, raw: unknown) {
    const state = shotStateSchema.parse(raw),
      instances = this.instanceMap(projectId, state.instances);
    if (new Set(state.instances.map((i) => i.instanceId)).size !== state.instances.length)
      throw new HttpError(400, '镜头实例重复');
    for (const entry of state.instances) {
      if (instances.get(entry.instanceId)?.id !== entry.entity.id)
        throw new HttpError(400, '出场实例不属于指定主体');
      if (
        entry.appearance &&
        this.owned(projectId, entry.appearance, 'appearance').data.entity.id !== entry.entity.id
      )
        throw new HttpError(400, '镜头外观不属于主体');
      if (entry.pack) {
        const pack = this.owned(projectId, entry.pack, 'reference_pack');
        if (
          pack.data.entity.id !== entry.entity.id ||
          !pack.data.published ||
          (entry.appearance &&
            (pack.data.appearance?.id !== entry.appearance.id ||
              pack.data.appearance?.revision !== entry.appearance.revision))
        )
          throw new HttpError(400, '镜头参考包与主体或外观不一致');
      }
    }
    const layout = state.layout ? this.owned(projectId, state.layout, 'layout') : null;
    if (state.cameraId && !layout?.data.cameras.some((c: any) => c.id === state.cameraId))
      throw new HttpError(400, '机位不属于指定布局版本');
    const ids = state.instances.map((i) => i.instanceId);
    if (state.relationKnowledge) {
      for (const phase of ['start', 'end'] as const) {
        const known = state.relationKnowledge[phase];
        if (
          new Set(known).size !== known.length ||
          known.some((id) => !ids.includes(id)) ||
          state[phase === 'start' ? 'startRelations' : 'endRelations'].some(
            (r) => !known.includes(r.objectId),
          )
        )
          throw new HttpError(400, '物体关系知识必须包含已声明关系且只能引用本镜实例');
      }
    }
    for (const poses of [state.start, state.end]) {
      if (new Set(poses.map((p) => p.instanceId)).size !== poses.length)
        throw new HttpError(400, '同一实例有多个位置');
      for (const p of poses)
        if (
          !ids.includes(p.instanceId) ||
          (p.regionId && !layout?.data.regions.some((r: any) => r.id === p.regionId))
        )
          throw new HttpError(400, '镜头状态引用无效实例或区域');
    }
    for (const r of state.requiredViews)
      if (!ids.includes(r.instanceId)) throw new HttpError(400, '视图需求引用未出场实例');
    for (const relations of [state.startRelations, state.endRelations])
      this.validateRelations(
        relations,
        new Map([...instances].filter(([id]) => ids.includes(id))),
        layout?.data.regions.map((r: any) => r.id) || [],
      );
    return state;
  }
  shotChecks(projectId: string, shots: any[]) {
    const warnings: {
      code: string;
      message: string;
      shotId?: string;
      field?: string;
      severity?: string;
    }[] = [];
    for (const shot of shots) {
      if (!shot.state) {
        warnings.push({
          shotId: shot.id,
          field: 'state',
          severity: 'review',
          code: `state:${shot.id}`,
          message: `${shot.id} 尚未设置镜头状态`,
        });
        continue;
      }
      const s = this.validateShot(projectId, shot.state);
      if (!s.confirmed)
        warnings.push({
          shotId: shot.id,
          field: 'state.confirmed',
          severity: 'review',
          code: `confirm:${shot.id}`,
          message: `${shot.id} 状态待确认`,
        });
      for (const entry of s.instances.filter(
        (entry) =>
          !(shot.directing?.version >= 2) ||
          (shot.directing.presence.visible.includes(entry.instanceId) &&
            (s.layout || shot.directing.paths.length)),
      ))
        for (const phase of ['start', 'end'] as const)
          if (!s[phase].some((p) => p.instanceId === entry.instanceId))
            warnings.push({
              shotId: shot.id,
              field: `state.${phase}`,
              severity: 'review',
              code: `pose:${shot.id}:${entry.instanceId}:${phase}`,
              message: `${shot.id} 的 ${entry.instanceId} 缺少${phase === 'start' ? '起始' : '结束'}位置与朝向`,
            });
      if ([...s.startRelations, ...s.endRelations].some((r) => !r.confirmed))
        warnings.push({
          shotId: shot.id,
          field: 'state.startRelations',
          severity: 'review',
          code: `relations:${shot.id}`,
          message: `${shot.id} 有未确认持物关系`,
        });
    }
    const layouts = shots.flatMap((s) =>
      s.state?.layout ? [this.owned(projectId, s.state.layout, 'layout')] : [],
    );
    return [
      ...warnings,
      ...continuityIssues(shots, layouts),
      ...shots.filter((s) => s.directing).flatMap((s) => prepareShot(s, layouts).issues),
    ];
  }
  impact(id: string, correction = false, reason = '') {
    const source = this.store.get(id),
      seen = new Set([id]);
    const affected: any[] = [];
    const queue = [id];
    while (queue.length) {
      const sourceId = queue.shift()!;
      for (const row of this.store.db
        .prepare('SELECT DISTINCT consumer_id,purpose FROM dependencies WHERE source_id=?')
        .all(sourceId)) {
        const doc = this.store.get(String(row.consumer_id));
        if (seen.has(doc.id) || doc.projectId !== source.projectId) continue;
        // Historical edges remain auditable; only current consumers are flagged.
        if (
          !this.store.db
            .prepare(
              'SELECT 1 FROM dependencies WHERE source_id=? AND consumer_id=? AND consumer_revision=?',
            )
            .get(sourceId, doc.id, doc.revision)
        )
          continue;
        seen.add(doc.id);
        queue.push(doc.id);
        affected.push({
          id: doc.id,
          revision: doc.revision,
          kind: doc.kind,
          purpose: row.purpose,
          action: correction ? 'needs_review' : 'optional_upgrade',
        });
      }
    }
    if (correction) {
      if (!reason.trim()) throw new HttpError(400, '纠正必须说明原因');
      this.store.transaction(() => {
        for (const item of affected) {
          const doc = this.store.get(item.id);
          const next = this.store.update(doc.id, doc.revision, {
            ...doc.data,
            stale: true,
            staleReason: reason,
            correctionSource: id,
          });
          const rows = this.store.db
            .prepare('SELECT * FROM dependencies WHERE consumer_id=? AND consumer_revision=?')
            .all(doc.id, doc.revision);
          this.dependencies(
            next,
            rows.map((r) => ({
              id: String(r.source_id),
              revision: Number(r.source_revision),
              purpose: String(r.purpose),
            })),
          );
        }
        this.store.event(null, 'domain_correction', { source: id, reason, affected });
        for (const job of this.store
          .jobs(source.projectId)
          .filter((j) => j.kind === 'generation' && j.state === 'succeeded')) {
          if (correctionAffectsInput(job.input, { source: id, affected }))
            this.store.patchJob(job.id, {
              output: { ...job.output, basisCorrected: true, basisCorrectionMessage: reason },
            });
        }
      });
    }
    return affected;
  }
  exportTask(id: string, revision: number) {
    const task = this.store.get(id, revision);
    if (task.kind !== 'asset_task') throw new HttpError(400, '不是图片制作任务');
    return {
      schemaVersion: 2,
      taskId: id,
      taskRevision: revision,
      task: task.data,
      records: this.refs(task.data).map((r) => this.owned(task.projectId, r)),
      files: task.data.references.map((r: VersionRef) => ({
        ...r,
        url: `/api/assets/${r.id}/file?revision=${r.revision}`,
      })),
      delivery: {
        taskId: id,
        taskRevision: revision,
        deliveryId: '填写唯一交付标识',
        assets: task.data.views.map((v: any) => ({ viewId: v.id, file: `${v.id}.png` })),
      },
      instructions:
        '先确认当前 Codex 会话实际具备图像生成工具；若不可用请明确报告并停止。读取任务包固定参考后制作图片，每个视图单独交付。不得修改 Studio 源码、数据库、任务输入或绕过 Studio 提交 H3。不得凭文件名覆盖；未实际查看不得声称通过视觉检查。最多按任务 maxRevisions 要求修订，但 Studio 不控制外部会话调用次数。交付可包含 executionReceipt:{reportedCalls,tool,notes}，这是实际调用的自报凭据，不是平台计费保证。保持 taskId/taskRevision，使用 multipart files 与 manifest 回填。',
    };
  }
  publishLibrary(
    projectId: string,
    refs: VersionRef[],
    name: string,
    itemId?: string,
    revision?: number,
  ) {
    if (!name.trim() || !refs.length) throw new HttpError(400, '模板需要名称和来源');
    const docs = new Map<string, RecordDoc>();
    const queue = [...refs];
    while (queue.length) {
      const ref = queue.shift()!,
        key = `${ref.id}:${ref.revision}`;
      if (docs.has(key)) continue;
      const doc = this.owned(projectId, ref);
      if ([...docs.values()].some((d) => d.id === doc.id && d.revision !== doc.revision))
        throw new HttpError(400, '同一模板内一个对象只能使用一个固定版本，请先统一引用');
      if (
        ![
          'entity',
          'appearance',
          'reference_pack',
          'layout',
          'asset',
          'creation_profile',
          'creative_module',
        ].includes(doc.kind)
      )
        throw new HttpError(400, '模板只能包含主体、外观、参考包、布局和图片');
      if (doc.kind === 'asset' && doc.data.mediaType !== 'image')
        throw new HttpError(400, '模板素材需要固定图片');
      docs.set(key, doc);
      queue.push(...this.refs(doc.data));
      // Relations may target another reusable entity: include it explicitly in the bundle.
      const targetIds = (doc.data.relations || []).flatMap((r: any) => [r.objectId, r.targetId]);
      for (const entity of this.store.list('entity', projectId))
        if (entity.data.instances.some((i: any) => targetIds.includes(i.id)))
          queue.push({ id: entity.id, revision: entity.revision });
    }
    return this.store.transaction(() => {
      const id = itemId || randomUUID();
      const old = this.store.db.prepare('SELECT * FROM library_items WHERE id=?').get(id);
      if (itemId && (!old || Number(old.revision) !== revision))
        throw new HttpError(409, '模板库版本冲突');
      const next = old ? Number(old.revision) + 1 : 1;
      const bundle = {
        name,
        roots: refs,
        documents: [...docs.values()],
        sourceProjectId: projectId,
      };
      this.store.db
        .prepare(
          'INSERT INTO library_items VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,name=excluded.name',
        )
        .run(id, next, name, Date.now());
      this.store.db
        .prepare('INSERT INTO library_versions VALUES(?,?,?)')
        .run(id, next, JSON.stringify(bundle));
      return { id, revision: next, name };
    });
  }
  library(id: string, revision: number) {
    const row = this.store.db
      .prepare('SELECT bundle FROM library_versions WHERE id=? AND revision=?')
      .get(id, revision);
    if (!row) throw new HttpError(404, '模板库版本不存在');
    return JSON.parse(String(row.bundle));
  }
  copyLibrary(projectId: string, id: string, revision: number) {
    if (this.store.get(projectId).kind !== 'project') throw new HttpError(400, '不是项目');
    const bundle = this.library(id, revision);
    if (bundle.kind === 'global_voice' || bundle.kind === 'voice_media')
      throw new HttpError(400, '全局声音请通过作品选用入口固定版本');
    const mapping = new Map<string, string>(),
      instances = new Map<string, string>();
    for (const doc of bundle.documents) {
      mapping.set(`${doc.id}:${doc.revision}`, randomUUID());
      for (const i of doc.data.instances || [])
        if (!instances.has(i.id)) instances.set(i.id, randomUUID());
    }
    const remap = (value: any): any => {
      if (typeof value === 'string') return instances.get(value) || value;
      if (!value || typeof value !== 'object') return value;
      if (value.id && value.revision) {
        const newId = mapping.get(`${value.id}:${value.revision}`);
        if (!newId) throw new HttpError(400, '模板关系不完整');
        return { id: newId, revision: 1 };
      }
      if (Array.isArray(value)) return value.map(remap);
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
    };
    return this.store.transaction(() => {
      const copied: RecordDoc[] = [];
      for (const doc of bundle.documents) {
        const data = remap(doc.data);
        delete data.dependencies;
        delete data.origin;
        delete data.derivedSource;
        delete data.derivationKey;
        if (doc.kind === 'asset') {
          data.sourceAssetIds = [];
          data.jobId = null;
          data.entityId = '';
          data.adopted = false;
        }
        if (['reference_pack', 'creative_module', 'creation_profile'].includes(doc.kind)) {
          data.published = false;
          data.review = null;
        }
        data.origin = {
          libraryItemId: id,
          libraryRevision: revision,
          sourceId: doc.id,
          sourceRevision: doc.revision,
        };
        copied.push(
          this.store.create(
            doc.kind,
            projectId,
            data,
            projectId,
            mapping.get(`${doc.id}:${doc.revision}`)!,
          ),
        );
      }
      for (const doc of copied)
        this.dependencies(
          doc,
          this.refs(doc.data).filter((r) => copied.some((c) => c.id === r.id)),
        );
      return {
        documents: copied,
        mapping: Object.fromEntries(mapping),
        instanceMapping: Object.fromEntries(instances),
        roots: bundle.roots.map((r: VersionRef) => ({
          id: mapping.get(`${r.id}:${r.revision}`),
          revision: 1,
        })),
      };
    });
  }
  review(projectId: string, raw: unknown, id?: string, revision?: number) {
    const data = reviewSchema.parse(raw),
      job = this.store.job(data.jobId);
    const video = this.owned(projectId, data.video, 'asset');
    if (
      job.projectId !== projectId ||
      job.state !== 'succeeded' ||
      video.data.jobId !== job.id ||
      video.data.mediaType !== 'video'
    )
      throw new HttpError(400, '候选必须来自本项目已完成任务');
    if (data.out <= data.in || data.out > video.data.duration + 0.04)
      throw new HttpError(400, '审核区间越界');
    const evaluation = buildReviewEvaluation(this.store, projectId, job, data.observationBasis);
    if (job.kind === 'lipsync' && !evaluation)
      throw new HttpError(409, '口型派生候选需要以当前镜头重新建立观察审核，不能继承原片结论');
    const reviewSpecs = evaluation?.shotSpecs || job.input.prepared?.shotSpecs || [];
    validateObservedReview(
      evaluation
        ? {
            ...job,
            input: {
              ...job.input,
              prepared: { shotSpecs: reviewSpecs },
              planning: { records: evaluation.records },
              seriesInputs: {
                ...job.input.seriesInputs,
                actionDefinitions: evaluation.actionDefinitions,
              },
            },
          }
        : job,
      video,
      data,
    );
    const schemaVersion = reviewSpecs.some((s: any) => s.version >= 2) ? 3 : 2;
    const correctionBasis =
      schemaVersion === 3
        ? this.store.db
            .prepare("SELECT seq,data FROM events WHERE kind='domain_correction' AND created_at>=?")
            .all(job.createdAt)
            .filter((e) => correctionAffectsInput(job.input, JSON.parse(String(e.data)), job.id))
            .map((e) => Number(e.seq))
        : [];
    if (correctionBasis.length && !data.correctionConclusion?.trim())
      throw new HttpError(409, '依据发生纠正，需要填写实际重新审核的结论');
    for (const e of data.eventEvidence || []) {
      const spec = reviewSpecs.find((s: any) => s.shotId === e.shotId),
        expected = spec?.directing?.events.find((v: any) => v.id === e.eventId);
      if (
        !expected ||
        expected.inspection !== e.inspection ||
        e.endFrame <= e.startFrame ||
        e.startFrame < Math.floor(data.in * 24) ||
        e.endFrame > Math.ceil(data.out * 24)
      )
        throw new HttpError(400, '事件类型、来源或证据区间错误');
      if (e.status === 'pass' && e.inspection === 'motion' && e.endFrame - e.startFrame < 2)
        throw new HttpError(400, '连续动作不能以单帧证明');
    }
    if (
      new Set((data.eventEvidence || []).map((e) => `${e.shotId}:${e.eventId}`)).size !==
      (data.eventEvidence || []).length
    )
      throw new HttpError(400, '事件审核重复');
    for (const issue of data.issues) {
      validateIssueTarget(reviewSpecs, issue);
      if (
        issue.frameIndex < Math.floor(data.in * 24) ||
        issue.frameIndex >= Math.ceil(data.out * 24) ||
        (video.data.frameCount && issue.frameIndex >= video.data.frameCount)
      )
        throw new HttpError(400, '问题证据帧不在审核区间');
      if (issue.evidence) {
        const a = this.owned(projectId, issue.evidence, 'asset'),
          source = a.data.derivedSource;
        if (source?.media.id !== video.id || source.frameIndex !== issue.frameIndex)
          throw new HttpError(400, '证据帧与视频来源或帧号不匹配');
      }
      if (data.dimensions[issue.category] !== 'issues')
        throw new HttpError(400, '有问题的维度必须标为有问题');
    }
    return this.store.transaction(() => {
      if (id) this.owned(projectId, { id, revision: revision! }, 'generation_review');
      const doc = id
        ? this.store.update(id, revision!, {
            ...data,
            schemaVersion,
            ...(schemaVersion === 3 ? { correctionBasis } : {}),
            ...(evaluation ? { evaluation } : {}),
          })
        : this.store.create(
            'generation_review',
            projectId,
            {
              ...data,
              schemaVersion,
              ...(schemaVersion === 3 ? { correctionBasis } : {}),
              ...(evaluation ? { evaluation } : {}),
            },
            job.episodeId,
          );
      this.dependencies(doc, [
        data.video,
        ...(evaluation
          ? [
              evaluation.episode,
              ...evaluation.records.map((r) => ({ id: r.id, revision: r.revision })),
            ]
          : []),
        ...data.issues.flatMap((i) => (i.evidence ? [i.evidence] : [])),
      ]);
      return doc;
    });
  }
  select(projectId: string, raw: unknown, expected?: number) {
    const data = selectionSchema.parse(raw);
    const ep = this.owned(projectId, data.episode, 'episode');
    if (this.store.get(ep.id).revision !== ep.revision)
      throw new HttpError(409, '分集版本已变化，请刷新后选用');
    const job = this.store.job(data.jobId);
    const video = this.owned(projectId, data.video, 'asset');
    if (
      job.projectId !== projectId ||
      job.state !== 'succeeded' ||
      video.data.jobId !== job.id ||
      video.data.mediaType !== 'video'
    )
      throw new HttpError(400, '需要本作品真实归档的视频候选');
    const segment = ep.data.segments.find((v: any) => v.id === data.segmentId);
    if (!segment) throw new HttpError(400, '目标片段不存在');
    if (job.episodeId && (job.episodeId !== ep.id || job.input.segment?.id !== segment.id))
      throw new HttpError(400, '候选不属于目标片段；独立试作请使用关联入口');
    const head = productionHead(this.store, ep.id);
    if (head.conflict) throw new HttpError(409, '当前制作归属有冲突');
    if (head.runId && job.input.creationRunId && job.input.creationRunId !== head.runId)
      throw new HttpError(409, '候选属于其他创作版本，请先关联到当前镜头');
    const frames = video.data.frameCount || Math.floor(video.data.duration * 24);
    if (
      data.out <= data.in ||
      Math.round(data.out * 24) > frames ||
      [data.in, data.out].some((v) => Math.abs(v * 24 - Math.round(v * 24)) > 1e-6)
    )
      throw new HttpError(400, '选用区间必须在实际媒体的整帧范围内');
    if (
      new Set(data.coverage.map((c) => c.shotId)).size !== data.coverage.length ||
      data.coverage.some(
        (c) =>
          !segment.shotIds.includes(c.shotId) ||
          c.in < data.in ||
          c.out > data.out ||
          c.out <= c.in,
      )
    )
      throw new HttpError(400, '镜头映射重复、引用无效或超出选用区间');
    const review = data.review ? this.owned(projectId, data.review, 'generation_review') : null;
    if (
      review &&
      (review.data.jobId !== job.id ||
        review.data.video.id !== video.id ||
        review.data.video.revision !== video.revision)
    )
      throw new HttpError(400, '观察记录必须属于本次媒体版本');
    // Selection is an editing decision, never an invented quality verdict. Only actual
    // observations from a still-valid optional review can populate boundary facts.
    const observed = review && !this.store.get(review.id).data.stale ? review.data : {};
    const specs = observed.evaluation?.shotSpecs || job.input.prepared?.shotSpecs || [];
    const boundary = selectedBoundary(specs.length ? specs : [{}], observed, data);
    let replacement: any = null;
    const repair = job.input.segment?.repair;
    if (repair) {
      const source = this.owned(projectId, repair.sourceSelection, 'segment_selection');
      const current = this.store
        .list('segment_selection', projectId)
        .find((d) => d.parentId === ep.id && d.data.segmentId === data.segmentId);
      if (
        current?.id !== source.id ||
        (current.revision !== source.revision && !repairSourceUnchanged(source, current))
      )
        throw new HttpError(409, '替换来源已变化，请重新选择固定区间');
      repairWindow(source.data, repair);
      if (
        boundary.startFrame !== repair.adoptRange.startFrame ||
        boundary.endFrame !== repair.adoptRange.endFrame
      )
        throw new HttpError(400, '替换区间与当前修订输入不一致');
      replacement = spliceSelection(source, repair, data, boundary);
    }
    return this.store.transaction(() => {
      if (generationDigest(productionHead(this.store, ep.id)) !== generationDigest(head))
        throw new HttpError(409, '当前制作归属已变化');
      const old = this.store
        .list('segment_selection', projectId)
        .find((d) => d.parentId === ep.id && d.data.segmentId === data.segmentId);
      const payload = {
        ...data,
        review: data.review || null,
        ...(head.runId ? { creationRunId: head.runId } : {}),
        schemaVersion: 4,
        stale: false,
        quality: review ? 'observations_available' : 'unobserved',
        boundary,
        dependencies: job.input.dependencies || [],
        ...(replacement || {}),
      };
      const doc = old
        ? this.store.update(old.id, expected ?? -1, payload)
        : this.store.create('segment_selection', projectId, payload, ep.id);
      this.dependencies(doc, [
        data.episode,
        data.video,
        ...(data.review ? [data.review] : []),
        ...(job.input.dependencies || []),
        ...selectionMedia(payload).flatMap((p) => [p.video, ...(p.review ? [p.review] : [])]),
      ]);
      if (old?.data.boundary)
        this.propagateSelectionCorrection(projectId, {
          source: old.id,
          affected: [],
          selectionChange: boundaryChanges(old.data.boundary, payload.boundary),
          reason: '选用范围或边界依据变化',
          supersedingJobId: job.id,
        });
      return doc;
    });
  }
  propagateSelectionCorrection(projectId: string, correction: any) {
    return this.store.transaction(() => {
      const pending: any[] = [correction],
        visited = new Set([correction.source]);
      const completed = this.store
        .jobs(projectId)
        .filter((j) => j.kind === 'generation' && j.state === 'succeeded');
      while (pending.length) {
        const change = pending.shift();
        this.store.event(null, 'domain_correction', change);
        for (const canon of this.store.list('continuity', projectId)) {
          if (canon.data.schemaVersion !== 3 || visited.has(canon.id) || canon.data.stale) continue;
          const problems = canonSourceProblems(this.store, canon);
          if (!problems.length) continue;
          visited.add(canon.id);
          const marked = this.store.update(canon.id, canon.revision, {
            ...canon.data,
            stale: true,
            staleReason: problems.join('；'),
          });
          this.dependencies(marked, this.refs(canon.data));
          pending.push({
            source: canon.id,
            affected: [],
            reason: '已确认剧情的实际证据或直接前置链已变化',
          });
          for (const release of this.store
            .list('episode_release', projectId)
            .filter((r) => r.data.canon?.id === canon.id && !r.data.stale))
            this.store.update(release.id, release.revision, {
              ...release.data,
              stale: true,
              staleReason: '本集确认事实需要复核',
            });
        }
        for (const job of completed)
          if (correctionAffectsInput(job.input, change, job.id)) {
            const current = this.store.job(job.id);
            this.store.patchJob(job.id, {
              output: {
                ...current.output,
                basisCorrected: true,
                basisCorrectionMessage: change.reason,
              },
            });
          }
        // Once a selected result needs review, none of its dependent facts are confirmed.
        // Follow only actual frozen consumers, without invalidating independent shots.
        for (const dependent of this.store.list('segment_selection', projectId)) {
          if (visited.has(dependent.id) || !dependent.data.jobId) continue;
          const priorJob = this.store.job(dependent.data.jobId);
          if (!correctionAffectsInput(priorJob.input, change, priorJob.id)) continue;
          visited.add(dependent.id);
          if (!dependent.data.stale) {
            const marked = this.store.update(dependent.id, dependent.revision, {
              ...dependent.data,
              stale: true,
              staleReason: '依赖的采用边界状态已变化',
            });
            this.dependencies(marked, this.refs(dependent.data));
          }
          pending.push({ source: dependent.id, affected: [], reason: '上游采用依据需要复核' });
        }
      }
    });
  }
  assemble(projectId: string, episodeId: string) {
    const ep = this.store.get(episodeId);
    if (ep.kind !== 'episode' || ep.projectId !== projectId) throw new HttpError(400, '分集不存在');
    const selections = ep.data.segments.map((s: any) => {
      const selection = this.store
        .list('segment_selection', projectId)
        .find((d) => d.parentId === ep.id && d.data.segmentId === s.id);
      if (!selection) throw new HttpError(409, `片段 ${s.id} 尚未选用`);
      return selection;
    });
    if (!selections.length) throw new HttpError(400, '没有可装配片段');
    if (
      ep.data.dramaturgy &&
      selections.some((s: any) =>
        [s.data.in, s.data.out].some((v) => Math.abs(v * 24 - Math.round(v * 24)) > 1e-6),
      )
    )
      throw new HttpError(409, '装配需要有效的整帧入出点');
    return {
      ...(ep.data.dramaturgy || ep.data.seriesProduction ? { schemaVersion: 2 } : {}),
      episodeId,
      width: ep.data.dramaturgy?.canvas?.width || 864,
      height: ep.data.dramaturgy?.canvas?.height || 480,
      fps: 24,
      clips: selections.flatMap((s: any) =>
        selectionMedia(s.data).map((part) => ({
          assetId: part.video.id,
          revision: part.video.revision,
          in: part.in,
          out: part.out,
          volume: part.volume,
          selection: { id: s.id, revision: s.revision },
        })),
      ),
      audio: [],
    };
  }
  confirmCanon(projectId: string, raw: unknown, expected?: number) {
    const input = raw as any;
    if (input.schemaVersion === 4)
      return { document: saveStoryBasis(this.store, projectId, raw, expected), affected: [] };
    if (input.schemaVersion === 3)
      return this.store.transaction(() => {
        const ep = this.owned(projectId, input.episode, 'episode');
        const prepared = prepareCanonV3(this.store, ep, raw);
        const old = this.store
          .list('continuity', projectId, ep.id)
          .find((c) => c.data.schemaVersion === 3);
        const document = old
          ? this.store.update(old.id, expected ?? -1, prepared.data)
          : this.store.create('continuity', projectId, prepared.data, ep.id);
        this.dependencies(document, prepared.dependencies);
        return { document, affected: old ? this.impact(old.id, true, '媒体观察依据更新') : [] };
      });
    const data = canonSchema.parse(raw),
      ep = this.owned(projectId, data.episode, 'episode');
    if (this.store.get(ep.id).revision !== ep.revision)
      throw new HttpError(409, '请先确认当前分集');
    const existing = this.store
      .list('continuity', projectId)
      .filter((c) => c.data.schemaVersion === 2 && c.data.seriesId === ep.data.seriesId);
    const old = existing.find((c) => c.parentId === ep.id);
    const latestPrior = existing
      .filter((c) => c.data.episodeNumber < ep.data.number)
      .sort((a, b) => b.data.episodeNumber - a.data.episodeNumber)[0];
    if (
      (latestPrior?.id || null) !== (data.previous?.id || null) ||
      (latestPrior && (latestPrior.revision !== data.previous?.revision || latestPrior.data.stale))
    )
      throw new HttpError(409, '需要最近有效的前集确认状态，不能分叉或跳过待复核状态');
    if (old && !data.correctionReason.trim())
      throw new HttpError(400, '修改已确认剧情必须说明纠正原因');
    if (data.previous) this.owned(projectId, data.previous, 'continuity');
    const instances = this.instanceMap(projectId, data.instances);
    for (const i of data.instances)
      if (instances.get(i.instanceId)?.id !== i.entity.id)
        throw new HttpError(400, '剧情实例不属于主体');
    const declared = new Set(data.instances.map((i) => i.instanceId));
    if (
      declared.size !== data.instances.length ||
      new Set(data.facts.map((f) => f.id)).size !== data.facts.length
    )
      throw new HttpError(400, '剧情实例或事实 ID 重复');
    if (
      data.states.some((s) => !declared.has(s.instanceId)) ||
      data.facts.some((f) => f.instanceIds.some((id) => !declared.has(id)))
    )
      throw new HttpError(400, '剧情状态或事实引用未声明实例');
    this.validateRelations(
      data.relations,
      new Map([...instances].filter(([id]) => declared.has(id))),
      this.store.list('layout', projectId).flatMap((l) => l.data.regions.map((r: any) => r.id)),
    );
    if (data.relations.some((r) => !r.confirmed)) throw new HttpError(400, '剧情关系必须明确确认');
    for (const ref of this.refs(data)) this.owned(projectId, ref);
    return this.store.transaction(() => {
      const nextData = {
        ...data,
        schemaVersion: 2,
        seriesId: ep.data.seriesId,
        episodeNumber: ep.data.number,
        confirmed: true,
        stale: false,
      };
      const doc = old
        ? this.store.update(old.id, expected ?? -1, nextData)
        : this.store.create('continuity', projectId, nextData, ep.id);
      this.dependencies(doc, this.refs(data));
      const affected = old ? this.impact(old.id, true, data.correctionReason) : [];
      if (!old)
        for (const later of existing.filter((c) => c.data.episodeNumber > ep.data.number)) {
          const current = this.store.get(later.id);
          if (current.data.stale) continue;
          const marked = this.store.update(current.id, current.revision, {
            ...current.data,
            stale: true,
            staleReason: '新增更早的确认状态，需要重新接续剧情链',
          });
          this.dependencies(marked, this.refs(current.data));
          affected.push(
            { id: marked.id, revision: marked.revision, kind: marked.kind, action: 'needs_review' },
            ...this.impact(marked.id, true, '更早的确认状态已补充，需复核后续内容'),
          );
        }
      return { document: doc, affected };
    });
  }
}
