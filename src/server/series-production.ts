import { DomainService } from './domain-service.js';
import { AssemblyService } from './assembly.js';
import { selectionMedia } from './selection-splice.js';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';
import {
  seriesProductionSchema,
  runtimeSchema,
  episodeProductionSchema,
  actionPhaseIssues,
} from '../shared/series.js';

// Series ownership and fixed configuration resolution. No jobs or media side effects.
export function fixedSeriesRecord(
  store: Store,
  projectId: string,
  ref: { id: string; revision: number },
  kind?: string,
) {
  const doc = store.get(ref.id, ref.revision),
    head = store.get(ref.id);
  if (doc.projectId !== projectId || (kind && doc.kind !== kind))
    throw new HttpError(400, '系列依据归属或类型错误');
  if (doc.data.stale || head.data.stale || doc.data.archived || head.data.archived)
    throw new HttpError(409, `固定依据待复核：${doc.id}`);
  return doc;
}
// A confirmed fact can outlive an edit only while its actual evidence remains valid.
// Resolve current selection heads here so a stale nearer Canon cannot be silently skipped.
export function canonSourceProblems(
  store: Store,
  canon: any,
  visited = new Set<string>(),
): string[] {
  const problems: string[] = [];
  if (visited.has(canon.id)) return ['剧情确认链存在循环'];
  visited.add(canon.id);
  if (canon.data.previous) {
    try {
      const prior = store.get(canon.data.previous.id);
      if (
        prior.revision !== canon.data.previous.revision ||
        prior.data.stale ||
        canonSourceProblems(store, prior, visited).length
      )
        problems.push('直接前置事实版本或其证据已变化');
    } catch {
      problems.push('直接前置事实缺失');
    }
  }
  for (const f of canon.data.facts || [])
    if (f.source?.kind === 'media') {
      try {
        const original = store.get(f.source.selection.id, f.source.selection.revision),
          current = store.get(original.id);
        if (current.data.stale || current.data.archived) throw new Error('采用待复核');
        for (const part of selectionMedia(original.data)) {
          const review = store.get(part.review.id, part.review.revision);
          if (store.get(review.id).data.stale) throw new Error('观察审核待复核');
          const entries = [
            ...(review.data.observations || []),
            ...(review.data.eventEvidence || []),
            ...(review.data.audioEvidence || []),
          ].filter((e) => f.source.evidenceIds.includes(e.id || e.eventId || e.requirementId));
          for (const e of entries)
            if (
              !selectionMedia(current.data).some(
                (p) =>
                  p.video.id === part.video.id &&
                  p.video.revision === part.video.revision &&
                  p.in * 24 <= e.startFrame &&
                  p.out * 24 >= e.endFrame,
              )
            )
              throw new Error('事实证据已被替换或裁掉');
        }
        if (f.attribute && current.revision !== original.revision) {
          const attr = current.data.boundary?.end?.facts?.find(
            (a: any) => a.instanceId === f.attribute.instanceId && a.key === f.attribute.key,
          );
          if (attr?.status !== 'known' || attr.value !== f.attribute.value)
            throw new Error('关键属性已改变');
        }
      } catch (e: any) {
        problems.push(`${f.id}: ${e.message}`);
      }
    }
  for (const s of canon.data.relationSources || []) {
    try {
      const selected = store.get(s.selection.id);
      if (
        selected.data.stale ||
        selected.data.archived ||
        !selected.data.boundary?.end?.relationObjectIds.includes(s.objectId) ||
        generationDigest(
          (selected.data.boundary.end.relations || []).filter(
            (r: any) => r.objectId === s.objectId,
          ),
        ) !==
          generationDigest(
            (canon.data.relations || []).filter((r: any) => r.objectId === s.objectId),
          )
      )
        throw new Error('关系的实际采用边界已变化');
    } catch (e: any) {
      problems.push(`${s.objectId}: ${e.message}`);
    }
  }
  for (const s of canon.data.actionSources || []) {
    try {
      const selected = store.get(s.selection.id),
        expected = canon.data.unfinishedActions.find(
          (a: any) => a.instanceId === s.instanceId && a.id === s.actionId,
        ),
        actual = selected.data.boundary?.end?.actions?.find(
          (a: any) => a.instanceId === s.instanceId && a.id === s.actionId,
        );
      if (
        selected.data.stale ||
        selected.data.archived ||
        generationDigest(expected || null) !== generationDigest(actual || null)
      )
        throw new Error('未完成动作的实际边界已变化');
    } catch (e: any) {
      problems.push(`${s.instanceId}:${s.actionId}: ${e.message}`);
    }
  }
  return problems;
}
export function resolveSeries(store: Store, target: any) {
  const series =
    target.kind === 'series'
      ? target
      : target.data.seriesId
        ? store.get(target.data.seriesId)
        : null;
  if (!series || series.kind !== 'series' || series.projectId !== target.projectId)
    throw new HttpError(400, 'V7 必须明确所属系列');
  const production = seriesProductionSchema.parse(series.data.production);
  if (!series.data.approved || series.data.stale) throw new HttpError(409, '系列制作计划待确认');
  const profile = fixedSeriesRecord(
    store,
    series.projectId,
    production.profile,
    'creation_profile',
  );
  if (profile.data.rulesVersion !== 'director-v7' || !profile.data.published)
    throw new HttpError(409, '系列需要固定已发布的 V7 配置');
  const shared = production.sharedReferences.map((r) =>
    fixedSeriesRecord(store, series.projectId, r),
  );
  if (
    shared.some(
      (d) =>
        !['series', 'entity', 'appearance', 'reference_pack', 'creative_module'].includes(d.kind),
    )
  )
    throw new HttpError(400, '共享依据应为明确设定、主体、外观、参考包或模块');
  if (new Set(production.voices.map((v) => v.instanceId)).size !== production.voices.length)
    throw new HttpError(400, '系列声音实例绑定重复');
  const bindings = new Map(production.voices.map((v) => [v.instanceId, v.profile]));
  for (const v of target.kind === 'episode' ? target.data.seriesProduction?.voices || [] : [])
    bindings.set(v.instanceId, v.profile);
  const voices = [...bindings].map(([instanceId, ref]) => {
    const record = fixedSeriesRecord(store, series.projectId, ref, 'voice_profile');
    if (!record.data.published) throw new HttpError(409, '系列声音版本需要先听审发布');
    const entity = fixedSeriesRecord(store, series.projectId, record.data.entity, 'entity');
    if (!entity.data.instances.some((i: any) => i.id === instanceId))
      throw new HttpError(400, '声音角色实例与主体不符');
    return { instanceId, record };
  });
  if (target.kind === 'episode') {
    const settings = episodeProductionSchema.parse(target.data.seriesProduction);
    const slot = production.slots.find((s) => s.id === settings.slotId && s.active);
    if (!slot || slot.episodeId !== target.id)
      throw new HttpError(409, '分集必须关联当前系列的有效规划条目');
    const actionIssues = (target.data.shots || []).flatMap((s: any) =>
      actionPhaseIssues(
        [...(s.directing?.carry?.startActions || []), ...(s.directing?.carry?.endActions || [])],
        production.actionDefinitions,
        s.directing?.events || [],
      ),
    );
    if (actionIssues.length) throw new HttpError(400, actionIssues.join('；'));
    if (
      settings.overrides &&
      Object.values(settings.overrides).some(Boolean) &&
      !settings.overrideReason.trim()
    )
      throw new HttpError(400, '分集覆盖必须说明理由');
  }
  return { series, production, profile, shared, voices };
}
export function episodeRuntime(store: Store, ep: any) {
  const { production } = resolveSeries(store, ep);
  const slot = production.slots.find((s) => s.id === ep.data.seriesProduction.slotId)!;
  return runtimeSchema.parse(
    ep.data.seriesProduction.runtime || slot.runtime || production.runtime,
  );
}
export function predecessorCanon(store: Store, ep: any, allowMissing = false) {
  const { series, production } = resolveSeries(store, ep);
  const slots = production.slots.filter((s) => s.active),
    index = slots.findIndex((s) => s.id === ep.data.seriesProduction.slotId);
  let canon: any = null;
  if (index === 0 && production.chronology.fromCanon) {
    try {
      canon = fixedSeriesRecord(store, ep.projectId, production.chronology.fromCanon, 'continuity');
      if (canonSourceProblems(store, canon).length)
        throw new HttpError(409, '前作事实的实际证据需要复核');
    } catch (e) {
      if (allowMissing) return { canon: null, waiting: '固定前作事实未就绪或证据需要复核' };
      throw e;
    }
  }
  if (index > 0) {
    const prior = slots[index - 1];
    canon =
      prior.episodeId &&
      store
        .list('continuity', ep.projectId)
        .find((c) => c.parentId === prior.episodeId && c.data.seriesId === series.id);
    if (
      !canon ||
      !canon.data.confirmed ||
      canon.data.stale ||
      canonSourceProblems(store, canon).length
    ) {
      if (allowMissing)
        return { canon: null, waiting: `前置分集 ${prior.title || prior.id} 剧情未确认或待复核` };
      throw new HttpError(
        409,
        `前置分集 ${prior.title || prior.id} 剧情未确认或待复核；不能回退读取更旧事实`,
      );
    }
  }
  if (canon && (!canon.data.confirmed || canon.data.stale || canon.data.schemaVersion !== 3)) {
    if (allowMissing) return { canon: null, waiting: '前置事实需显式转换并审核为 Canon v3' };
    throw new HttpError(409, '前置事实需显式转换并审核为 Canon v3');
  }
  return { canon, waiting: null };
}
export function seriesInformationForEpisode(store: Store, ep: any, requireConfirmed = false) {
  const { production } = resolveSeries(store, ep);
  const links = episodeProductionSchema.parse(ep.data.seriesProduction).information;
  return links.map((link) => {
    const entry = production.information.find((i) => i.id === link.informationId);
    if (!entry || link.shotIds.some((id) => !ep.data.shots.some((s: any) => s.id === id)))
      throw new HttpError(400, '系列信息引用或镜头归属错误');
    const reveals = ep.data.shots.flatMap((s: any) =>
      (s.directing?.information || []).filter(
        (i: any) => i.informationId === entry.id && i.purpose === 'reveal',
      ),
    );
    const outside = entry.afterIds.filter((id) => !links.some((l) => l.informationId === id));
    if (requireConfirmed && reveals.length && outside.length) {
      const prior = predecessorCanon(store, ep).canon;
      if (
        outside.some(
          (id) =>
            !prior?.data.facts.some(
              (f: any) =>
                f.informationId === id &&
                f.source?.kind === 'media' &&
                ['reveal', 'payoff'].includes(f.informationStage),
            ),
        )
      )
        throw new HttpError(409, '跨集揭示的前置成片信息尚未确认');
    }
    return {
      ...entry,
      shotIds: link.shotIds,
      afterIds: entry.afterIds.filter((id) => links.some((l) => l.informationId === id)),
      conflictsWith: entry.conflictsWith.filter((id) => links.some((l) => l.informationId === id)),
    };
  });
}

export class SeriesProductionService {
  constructor(public store: Store) {}
  preview(seriesId: string, raw: unknown) {
    const series = this.store.get(seriesId);
    if (series.kind !== 'series') throw new HttpError(400, '请选择系列');
    const data = seriesProductionSchema.parse(raw),
      old = series.data.production;
    const seen = new Set(data.slots.map((s) => s.id));
    if (seen.size !== data.slots.length) throw new HttpError(400, '分集规划 ID 重复');
    // Keep removed linked slots as inactive history, never delete episodes.
    for (const slot of old?.slots || [])
      if (!seen.has(slot.id)) {
        data.slots.push({ ...slot, active: false });
        seen.add(slot.id);
      }
    let active = data.slots.filter((s) => s.active);
    if (active.length > data.targetEpisodes)
      active.slice(data.targetEpisodes).forEach((s) => (s.active = false));
    for (let n = active.length; n < data.targetEpisodes; n++) {
      const id = `slot-${series.id}-${series.revision + 1}-${n + 1}`;
      if (seen.has(id)) throw new HttpError(400, '新规划 ID 冲突');
      data.slots.push({
        id,
        title: `第 ${n + 1} 集`,
        active: true,
        question: '',
        conflict: '',
        choice: '',
        outcome: '',
        openQuestions: [],
      });
    }
    active = data.slots.filter((s) => s.active);
    const linked = data.slots.map((s) => s.episodeId).filter(Boolean);
    if (new Set(linked).size !== linked.length)
      throw new HttpError(400, '同一分集不能绑定多个规划条目');
    for (const slot of data.slots)
      if (slot.episodeId) {
        const ep = this.store.get(slot.episodeId);
        if (
          ep.kind !== 'episode' ||
          ep.projectId !== series.projectId ||
          ep.data.seriesId !== series.id
        )
          throw new HttpError(400, '规划分集不属于本系列');
      }
    const ids = new Set(data.information.map((i) => i.id));
    if (new Set(data.actionDefinitions.map((a) => a.id)).size !== data.actionDefinitions.length)
      throw new HttpError(400, '动作定义 ID 重复');
    if (ids.size !== data.information.length) throw new HttpError(400, '系列信息 ID 重复');
    for (const info of data.information) {
      if ([...info.afterIds, ...info.conflictsWith].some((id) => !ids.has(id) || id === info.id))
        throw new HttpError(400, '系列信息依赖不存在或引用自身');
      if (info.milestones.some((m) => !data.slots.some((s) => s.id === m.slotId)))
        throw new HttpError(400, '信息节点引用不存在分集');
      for (const before of info.afterIds) {
        const prior = data.information.find((i) => i.id === before)!;
        const first = (i: typeof info) =>
          Math.min(
            ...i.milestones
              .filter((m) => ['reveal', 'payoff'].includes(m.purpose))
              .map((m) => active.findIndex((s) => s.id === m.slotId))
              .filter((n) => n >= 0),
          );
        if (first(prior) > first(info)) throw new HttpError(400, '系列信息揭示顺序冲突');
      }
    }
    const visit = (id: string, stack: Set<string>) => {
      if (stack.has(id)) throw new HttpError(400, '系列信息依赖循环');
      for (const p of data.information.find((i) => i.id === id)!.afterIds)
        visit(p, new Set([...stack, id]));
    };
    data.information.forEach((i) => visit(i.id, new Set()));
    if (
      [...data.characterBeats, ...data.authoredEvents].some(
        (b) => !data.slots.some((s) => s.id === b.slotId),
      )
    )
      throw new HttpError(400, '人物变化或画外事件分集不存在');
    const resolved = resolveSeries(this.store, {
      ...series,
      data: { ...series.data, production: data, approved: true, stale: false },
    });
    if (data.chronology.fromCanon) {
      const source = fixedSeriesRecord(
        this.store,
        series.projectId,
        data.chronology.fromCanon,
        'continuity',
      );
      if (canonSourceProblems(this.store, source).length)
        throw new HttpError(409, '前作事实依据需要复核');
      if (
        source.data.seriesId === series.id ||
        !source.data.confirmed ||
        source.data.schemaVersion !== 3
      )
        throw new HttpError(400, '前作起点必须是其他系列的已确认 Canon v3');
      const visited = new Set([series.id]);
      let next: any = source;
      while (next) {
        if (visited.has(next.data.seriesId)) throw new HttpError(400, '系列继承不得循环');
        visited.add(next.data.seriesId);
        const parent = this.store.get(next.data.seriesId).data.production?.chronology?.fromCanon;
        next = parent ? this.store.get(parent.id, parent.revision) : null;
      }
    }
    const impacts = data.slots.map((slot) => ({
      slotId: slot.id,
      episodeId: slot.episodeId || null,
      active: slot.active,
      runtime:
        (slot.episodeId && this.store.get(slot.episodeId).data.seriesProduction?.runtime) ||
        slot.runtime ||
        data.runtime,
      delivered:
        !!slot.episodeId &&
        this.store
          .list('episode_release', series.projectId)
          .some((r) => r.parentId === slot.episodeId),
      changed:
        generationDigest(slot) !==
          generationDigest(old?.slots?.find((s: any) => s.id === slot.id) || null) ||
        generationDigest(old?.runtime || null) !== generationDigest(data.runtime),
    }));
    const episodeBindings = data.slots
      .filter((s) => s.episodeId && !this.store.get(s.episodeId).data.seriesProduction)
      .map((s) => ({
        episode: { id: s.episodeId!, revision: this.store.get(s.episodeId!).revision },
        slotId: s.id,
        requiresContractReview: true,
      }));
    const input = {
      series: { id: series.id, revision: series.revision },
      data,
      episodeBindings,
      dependencies: [
        resolved.profile,
        ...resolved.shared,
        ...resolved.voices.map((v) => v.record),
      ].map((d) => ({ id: d.id, revision: d.revision })),
    };
    return { ...input, impacts, digest: generationDigest(input) };
  }
  apply(seriesId: string, raw: any) {
    const key = z.string().min(8).parse(raw.idempotencyKey);
    const prior = this.store.db
      .prepare(
        "SELECT data FROM events WHERE kind='series_plan_applied' AND json_extract(data,'$.seriesId')=? AND json_extract(data,'$.key')=?",
      )
      .get(seriesId, key);
    if (prior) {
      const result = JSON.parse(String(prior.data));
      if (result.digest !== raw.digest) throw new HttpError(409, '重复请求的计划摘要不同');
      return this.store.get(seriesId, result.revision);
    }
    const preview = this.preview(seriesId, raw.data);
    if (preview.digest !== raw.digest || preview.series.revision !== raw.revision)
      throw new HttpError(409, '系列计划已变化，请重新预览');
    return this.store.transaction(() => {
      const old = this.store.get(seriesId),
        doc = this.store.update(seriesId, old.revision, {
          ...old.data,
          production: preview.data,
          approved: true,
          stale: false,
        });
      new DomainService(this.store).dependencies(doc, preview.dependencies);
      for (const binding of preview.episodeBindings) {
        const ep = this.store.get(binding.episode.id);
        const converted = this.store.update(ep.id, binding.episode.revision, {
          ...ep.data,
          seriesProduction: { version: 1, slotId: binding.slotId },
          approved: false,
        });
        const domain = new DomainService(this.store);
        domain.dependencies(converted, domain.refs(ep.data));
      }
      this.store.event(null, 'series_plan_applied', {
        seriesId,
        key,
        digest: raw.digest,
        revision: doc.revision,
      });
      return doc;
    });
  }
  progress(seriesId: string) {
    const series = this.store.get(seriesId),
      { production } = resolveSeries(this.store, series);
    const releases = this.store.list('episode_release', series.projectId);
    const jobs = this.store.jobs(series.projectId),
      edls = this.store.list('edl', series.projectId),
      takes = this.store.list('dialogue_take', series.projectId);
    const slots = production.slots.map((slot) => {
      const ep = slot.episodeId ? this.store.get(slot.episodeId) : null;
      const edl = ep && edls.find((e) => e.parentId === ep.id);
      let assembly: any = null,
        assemblyProblem: string | null = null;
      if (edl && slot.active) {
        try {
          assembly = new AssemblyService(this.store).inspect(edl.id);
        } catch (e: any) {
          assemblyProblem = e.message;
        }
      }
      const runtime = ep?.data.seriesProduction?.runtime || slot.runtime || production.runtime;
      const release = releases.filter((r) => r.parentId === slot.episodeId && !r.data.stale).at(-1);
      const fits =
        release &&
        Math.abs(release.data.frames - runtime.targetFrames) <= runtime.toleranceFrames &&
        (() => {
          try {
            const c = this.store.get(release.data.canon.id);
            return (
              c.revision === release.data.canon.revision &&
              !c.data.stale &&
              !canonSourceProblems(this.store, c).length
            );
          } catch {
            return false;
          }
        })();
      return {
        ...slot,
        runtime,
        release: release ? { id: release.id, revision: release.revision } : null,
        delivered: !!fits,
        generated: ep
          ? jobs.filter(
              (j) => j.episodeId === ep.id && j.kind === 'generation' && j.state === 'succeeded',
            ).length
          : 0,
        joins: {
          total: assembly?.scopes.filter((s: any) => s.scope === 'join').length || 0,
          passed: assembly?.scopes.filter((s: any) => s.scope === 'join' && s.passed).length || 0,
        },
        scenes: {
          total: assembly?.scopes.filter((s: any) => s.scope === 'scene').length || 0,
          passed: assembly?.scopes.filter((s: any) => s.scope === 'scene' && s.passed).length || 0,
        },
        dialogueTakes: ep ? takes.filter((t) => t.parentId === ep.id && !t.data.stale).length : 0,
        soundReviewed:
          !!assembly && assembly.scopes.length > 0 && assembly.scopes.every((s: any) => s.passed),
        assemblyProblem,
        adoptedFrames: ep
          ? this.store
              .list('segment_selection', series.projectId)
              .filter((s) => s.parentId === ep.id && !s.data.stale)
              .reduce(
                (n, s) =>
                  n +
                  (s.data.composition?.totalFrames || Math.round((s.data.out - s.data.in) * 24)),
                0,
              )
          : 0,
      };
    });
    const confirmed = this.store
      .list('continuity', series.projectId)
      .filter(
        (c) =>
          c.data.seriesId === series.id &&
          !c.data.stale &&
          !canonSourceProblems(this.store, c).length,
      );
    const information = production.information.map((i) => ({
      ...i,
      actual: [
        ...new Map(
          confirmed
            .flatMap((c) =>
              (c.data.facts || [])
                .filter(
                  (f: any) =>
                    f.informationId === i.id && f.informationStage && f.source.kind === 'media',
                )
                .map((f: any) => [
                  f.id,
                  {
                    factId: f.id,
                    stage: f.informationStage,
                    slotId: f.effective.slotId,
                    source: f.source,
                    canon: { id: c.id, revision: c.revision },
                  },
                ]),
            )
            .map(([id, value]) => [id, value] as const),
        ).values(),
      ],
    }));
    return {
      information,
      series: { id: series.id, revision: series.revision },
      targetEpisodes: production.targetEpisodes,
      slots,
      delivered: slots.filter((s) => s.active && s.delivered).length,
      complete: slots.filter((s) => s.active && s.delivered).length === production.targetEpisodes,
      facts: this.store
        .list('continuity', series.projectId)
        .filter((c) => c.data.seriesId === series.id)
        .map((c) => ({
          id: c.id,
          revision: c.revision,
          problems: [
            ...(c.data.stale ? ['已标记待复核'] : []),
            ...canonSourceProblems(this.store, c),
          ],
        })),
    };
  }
}
