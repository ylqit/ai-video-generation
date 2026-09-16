import { validateDeliveryAudio } from './delivery-audio.js';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { assemblyReviewSchema, assemblyDimensions } from '../shared/series.js';
import { generationDigest } from './h3-guided.js';
import { fixedSeriesRecord, resolveSeries, episodeRuntime } from './series-production.js';
import { prepareCanonV3 } from './series-canon.js';
import { selectionMedia } from './selection-splice.js';

// Actual EDL scopes own their review fingerprints. Plan titles or unrelated cuts do not
// expire a join; its two media boundaries, contracts and effective audio do.
export class AssemblyService {
  constructor(public store: Store) {}

  inspect(edlId: string) {
    const edl = this.store.get(edlId);
    if (edl.kind !== 'edl' || edl.data.schemaVersion !== 2)
      throw new HttpError(400, '装配审核需要 EDL v2');
    const ep = this.store.get(edl.parentId!);
    resolveSeries(this.store, ep);
    new StudioService(this.store).validateEdl(ep.projectId, edl.data);
    let cursor = 0;
    const blockers: string[] = [],
      refs: any[] = [];
    const clips = edl.data.clips.map((clip: any, index: number) => {
      const startFrame = cursor,
        frames = Math.round((clip.out - clip.in) * 24);
      cursor += frames;
      const asset = fixedSeriesRecord(
        this.store,
        ep.projectId,
        { id: clip.assetId, revision: clip.revision },
        'asset',
      );
      refs.push({ id: asset.id, revision: asset.revision });
      const selection = clip.selection
        ? fixedSeriesRecord(this.store, ep.projectId, clip.selection, 'segment_selection')
        : null;
      if (selection && selection.parentId !== ep.id)
        throw new HttpError(400, '采用片段不属于当前分集');
      if (selection) {
        refs.push(clip.selection);
        if (this.store.get(selection.id).revision !== selection.revision)
          blockers.push(`片段 ${index + 1} 使用旧采用版本，请明确重新采用`);
        for (const part of selectionMedia(selection.data))
          fixedSeriesRecord(this.store, ep.projectId, part.review, 'generation_review');
      } else if (!clip.role || clip.role === 'story')
        blockers.push(`正片片段 ${index + 1} 缺少已采用依据`);
      const segment =
        selection && ep.data.segments.find((s: any) => s.id === selection.data.segmentId);
      const shots = segment ? ep.data.shots.filter((s: any) => segment.shotIds.includes(s.id)) : [];
      const sceneIds = [...new Set<string>(shots.map((s: any) => s.scene))];
      return {
        ...clip,
        index,
        startFrame,
        endFrame: cursor,
        sceneIds,
        role: clip.role || 'story',
        contract: shots.map((s: any) => ({
          id: s.id,
          scene: s.scene,
          state: s.state,
          directing: s.directing,
        })),
        incoming: segment?.incoming || null,
      };
    });
    const audioCheck = validateDeliveryAudio(this.store, ep, edl.data, clips, cursor);
    refs.push(...audioCheck.refs);
    blockers.push(...audioCheck.blockers);
    const audio = edl.data.audio;
    const scopes: any[] = [];
    const savedReviews = this.store.list('assembly_review', ep.projectId);
    const addScope = (
      scope: string,
      key: string,
      startFrame: number,
      endFrame: number,
      members: any[],
    ) => {
      const effectiveAudio = audio
        .filter(
          (a: any) =>
            a.volume > 0 && a.start * 24 < endFrame && (a.start + a.out - a.in) * 24 > startFrame,
        )
        .map((a: any) => ({ ...a, start: a.start - startFrame / 24 }));
      const localClips = members.map(({ index, startFrame: start, endFrame: end, ...c }: any) => ({
        ...c,
        startFrame: start - startFrame,
        endFrame: end - startFrame,
      }));
      const content = {
        scope,
        clips: localClips,
        audio: effectiveAudio,
        frames: endFrame - startFrame,
        width: edl.data.width,
        height: edl.data.height,
      };
      const digest = generationDigest(content);
      const review = savedReviews
        .filter(
          (r) =>
            r.parentId === ep.id &&
            r.data.scope === scope &&
            r.data.key === key &&
            r.data.digest === digest &&
            !r.data.stale,
        )
        .at(-1);
      const passed =
        !!review &&
        assemblyDimensions.every((d) =>
          ['pass', 'not_applicable'].includes(review.data.dimensions[d]),
        );
      scopes.push({
        scope,
        key,
        startFrame,
        endFrame,
        digest,
        content,
        review: review ? { id: review.id, revision: review.revision } : null,
        passed,
      });
    };
    for (let i = 1; i < clips.length; i++) {
      const left = clips[i - 1],
        right = clips[i];
      // Entire clips enter the digest; playback defaults to one second on each side.
      addScope('join', `join:${i}`, left.startFrame, right.endFrame, [left, right]);
      scopes.at(-1).window = {
        startFrame: Math.max(left.startFrame, right.startFrame - 24),
        endFrame: Math.min(right.endFrame, right.startFrame + 24),
        cutFrame: right.startFrame,
      };
    }
    for (const scene of [...new Set<string>(clips.flatMap((c: any) => c.sceneIds))]) {
      const members = clips.filter((c: any) => c.sceneIds.includes(scene));
      const start = members[0].startFrame,
        end = members.at(-1).endFrame;
      addScope(
        'scene',
        scene,
        start,
        end,
        clips.filter((c: any) => c.startFrame < end && c.endFrame > start),
      );
    }
    addScope('episode', ep.id, 0, cursor, clips);
    const missing = ep.data.segments.filter(
      (s: any) =>
        !clips.some(
          (c: any) =>
            c.selection &&
            this.store.get(c.selection.id, c.selection.revision).data.segmentId === s.id,
        ),
    );
    blockers.push(...missing.map((s: any) => `片段 ${s.id} 尚未进入实际时间线`));
    const runtime = episodeRuntime(this.store, ep);
    return {
      edl: { id: edl.id, revision: edl.revision },
      episode: { id: ep.id, revision: ep.revision },
      clips,
      audio,
      scopes,
      blockers,
      dependencies: refs,
      frames: cursor,
      storyFrames: clips
        .filter((c: any) => c.role === 'story')
        .reduce((n: number, c: any) => n + c.endFrame - c.startFrame, 0),
      runtime,
      differenceFrames: cursor - runtime.targetFrames,
    };
  }

  validateExport(ep: any, edl: any, ref: any) {
    const asset = fixedSeriesRecord(this.store, ep.projectId, ref, 'asset');
    const job = asset.data.jobId && this.store.job(asset.data.jobId);
    if (
      !job ||
      job.kind !== 'export' ||
      job.state !== 'succeeded' ||
      job.episodeId !== ep.id ||
      !job.output.assetIds?.includes(asset.id) ||
      job.input.edlRevision !== edl.revision ||
      generationDigest(job.input.edl) !== generationDigest(edl.data)
    )
      throw new HttpError(409, '需要当前固定 EDL 的实际成功导出媒体');
    const frames = edl.data.clips.reduce(
      (n: number, c: any) => n + Math.round((c.out - c.in) * 24),
      0,
    );
    if (asset.data.mediaType !== 'video' || asset.data.frameCount !== frames || !asset.data.sha256)
      throw new HttpError(409, '导出实际帧数或归档校验不符');
    return asset;
  }

  review(raw: unknown) {
    const data = assemblyReviewSchema.parse(raw),
      snapshot = this.inspect(data.edl.id);
    const edl = this.store.get(data.edl.id),
      ep = this.store.get(edl.parentId!);
    const scope = snapshot.scopes.find((s) => s.scope === data.scope && s.key === data.key);
    if (edl.revision !== data.edl.revision || !scope || scope.digest !== data.digest)
      throw new HttpError(409, '实际接点或音轨已变化，请重新审核');
    const window = data.scope === 'join' ? scope.window : scope;
    if (
      data.startFrame > window.startFrame ||
      data.endFrame < window.endFrame ||
      data.startFrame < scope.startFrame ||
      data.endFrame > scope.endFrame
    )
      throw new HttpError(409, '审核播放范围没有覆盖实际接点窗口或完整场景／分集');
    for (const d of assemblyDimensions)
      if (data.dimensions[d] === 'not_applicable' && !data.reasons[d]?.trim())
        throw new HttpError(400, '不适用的审核维度必须说明理由');
    if (data.scope === 'episode' && !data.exportAsset)
      throw new HttpError(409, '整集观看审核必须绑定实际导出');
    if (data.exportAsset) this.validateExport(ep, edl, data.exportAsset);
    return this.store.transaction(() => {
      const doc = this.store.create(
        'assembly_review',
        ep.projectId,
        { ...data, effectiveInputs: scope.content },
        ep.id,
      );
      const domain = new DomainService(this.store);
      // EDL revision is frozen above. Index only actual members of this review scope.
      domain.dependencies(
        doc,
        domain.refs(scope.content).concat(data.exportAsset ? [data.exportAsset] : []),
      );
      return doc;
    });
  }

  previewRelease(edlId: string, raw: any) {
    const owned = this.store.get(edlId).data.owner?.deliveryPlanId;
    if (owned && this.store.get(owned).data.target.mode !== 'work')
      throw new HttpError(409, '范围交付不能发布整集 Canon');
    const snapshot = this.inspect(edlId),
      edl = this.store.get(edlId),
      ep = this.store.get(edl.parentId!);
    if (!ep.data.approved || ep.data.stale) throw new HttpError(409, '分集剧情需要重新审核');
    const blockers = [
      ...snapshot.blockers,
      ...snapshot.scopes
        .filter((s) => !s.passed)
        .map((s) => `${s.scope} ${s.key} 尚未通过联合审核`),
    ];
    if (Math.abs(snapshot.differenceFrames) > snapshot.runtime.toleranceFrames)
      blockers.push('实际交付帧数超出本集目标和允许偏差');
    if (blockers.length) throw new HttpError(409, blockers.join('；'));
    const asset = this.validateExport(ep, edl, raw.exportAsset);
    const watched = snapshot.scopes.find((s) => s.scope === 'episode')!;
    if (
      generationDigest(
        this.store.get(watched.review.id, watched.review.revision).data.exportAsset,
      ) !== generationDigest(raw.exportAsset)
    )
      throw new HttpError(409, '交付媒体与整集观看审核媒体不一致');
    const canon = prepareCanonV3(this.store, ep, raw.canon);
    const consumed = new Set(
      snapshot.clips.flatMap((c: any) =>
        c.selection ? [`${c.selection.id}:${c.selection.revision}`] : [],
      ),
    );
    if (
      canon.dependencies.some(
        (r: any) =>
          this.store.get(r.id, r.revision).kind === 'segment_selection' &&
          !consumed.has(`${r.id}:${r.revision}`),
      )
    )
      throw new HttpError(409, '本集 Canon 的采用证据未进入交付时间线');
    const oldCanon = this.store.list('continuity', ep.projectId).find((c) => c.parentId === ep.id);
    if (oldCanon && !canon.data.correctionReason.trim())
      throw new HttpError(409, '重新交付需说明已确认事实的纠正依据');
    const series = resolveSeries(this.store, ep).series;
    const input = {
      episode: snapshot.episode,
      series: { id: series.id, revision: series.revision },
      edl: snapshot.edl,
      exportAsset: { id: asset.id, revision: asset.revision },
      sha256: asset.data.sha256,
      frames: snapshot.frames,
      storyFrames: snapshot.storyFrames,
      runtime: snapshot.runtime,
      reviews: snapshot.scopes.map((s) => s.review),
      canon,
      previousCanonRevision: oldCanon?.revision || null,
    };
    return { ...input, digest: generationDigest(input) };
  }

  release(edlId: string, raw: any) {
    const key = z.string().min(8).parse(raw.idempotencyKey);
    const edl = this.store.get(edlId);
    const prior = this.store
      .list('episode_release', edl.projectId)
      .find((r) => r.data.idempotencyKey === key);
    if (prior) {
      if (prior.data.digest !== raw.digest || prior.data.edl.id !== edlId)
        throw new HttpError(409, '重复交付请求内容不同');
      return prior;
    }
    return this.store.transaction(() => {
      const preview = this.previewRelease(edlId, raw);
      if (preview.digest !== raw.digest) throw new HttpError(409, '交付输入已变化，请重新预览');
      const domain = new DomainService(this.store);
      const old = this.store
        .list('continuity', edl.projectId)
        .find((c) => c.parentId === edl.parentId);
      const canon = old
        ? this.store.update(old.id, preview.previousCanonRevision!, preview.canon.data)
        : this.store.create('continuity', edl.projectId, preview.canon.data, edl.parentId);
      domain.dependencies(canon, preview.canon.dependencies);
      if (old) domain.impact(old.id, true, preview.canon.data.correctionReason);
      const doc = this.store.create(
        'episode_release',
        edl.projectId,
        {
          ...preview,
          canon: { id: canon.id, revision: canon.revision },
          idempotencyKey: key,
          stale: false,
        },
        edl.parentId,
      );
      domain.dependencies(doc, [
        preview.episode,
        preview.series,
        preview.edl,
        preview.exportAsset,
        { id: canon.id, revision: canon.revision },
        ...preview.reviews,
      ]);
      this.store.event(null, 'episode_released', { releaseId: doc.id, canonId: canon.id });
      return doc;
    });
  }
}
