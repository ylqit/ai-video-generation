import { presentationEvidence, validateCanonPresentation } from './presentation-evidence.js';
import { timelineMap, roleFrames } from '../shared/edit-timeline.js';
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
    if (edl.kind !== 'edl' || ![2, 3].includes(edl.data.schemaVersion))
      throw new HttpError(400, '装配审核需要整帧 EDL');
    const ep = this.store.get(edl.parentId!);
    if (ep.data.seriesProduction) resolveSeries(this.store, ep);
    new StudioService(this.store).validateEdl(ep.projectId, edl.data);
    const map = timelineMap(edl.data),
      cursor = map.frames;
    const blockers: string[] = [],
      refs: any[] = [];
    const clips = edl.data.clips.map((clip: any, index: number) => {
      const { startFrame, endFrame } = map.clips[index];
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
          if (part.review)
            fixedSeriesRecord(this.store, ep.projectId, part.review, 'generation_review');
      }
      const segment =
        selection && ep.data.segments.find((s: any) => s.id === selection.data.segmentId);
      const shots = segment ? ep.data.shots.filter((s: any) => segment.shotIds.includes(s.id)) : [];
      const sceneIds = [...new Set<string>(shots.map((s: any) => s.scene))];
      return {
        ...clip,
        index,
        startFrame,
        endFrame,
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
    const warnings = [...audioCheck.warnings];
    const audio = edl.data.audio;
    const scopes: any[] = [];
    const presentation =
      edl.data.schemaVersion === 3 ? presentationEvidence(this.store, edl.data) : [];
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
        ...(edl.data.schemaVersion === 3
          ? {
              recheckEvidence: presentation
                .filter((r) => r.affected && r.startFrame < endFrame && r.endFrame > startFrame)
                .map((r) => ({
                  ...r,
                  startFrame: r.startFrame - startFrame,
                  endFrame: r.endFrame - startFrame,
                })),
            }
          : {}),
        ...(edl.data.overlays?.length
          ? {
              overlays: edl.data.overlays
                .filter((o: any) => o.startFrame < endFrame && o.endFrame > startFrame)
                .map((o: any) => ({
                  ...o,
                  startFrame: o.startFrame - startFrame,
                  endFrame: o.endFrame - startFrame,
                })),
            }
          : {}),
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
        endFrame: Math.min(right.endFrame, Math.max(left.endFrame, right.startFrame) + 24),
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
    warnings.push(...missing.map((s: any) => `片段 ${s.id} 尚未进入实际时间线`));
    const runtime = ep.data.seriesProduction
      ? episodeRuntime(this.store, ep)
      : { targetFrames: cursor, toleranceFrames: 0, policy: 'exact' };
    return {
      edl: { id: edl.id, revision: edl.revision },
      episode: { id: ep.id, revision: ep.revision },
      clips,
      audio,
      scopes,
      blockers,
      warnings,
      dependencies: refs,
      frames: cursor,
      storyFrames: roleFrames(edl.data, 'story'),
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
    const frames = timelineMap(edl.data).frames;
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
    if (
      (data.scope === 'episode' ||
        scope.content.clips.some(
          (c: any) => c.transition || c.visualFadeInFrames || c.visualFadeOutFrames,
        )) &&
      !data.exportAsset
    )
      throw new HttpError(409, '整集或画面转场审核必须绑定当前实际导出');
    if (data.presentedEvidence?.length && !data.exportAsset)
      throw new HttpError(409, '呈现证据复核必须绑定实际导出');
    for (const item of data.presentedEvidence || []) {
      if (
        !scope.content.recheckEvidence?.some(
          (e: any) =>
            e.contained &&
            e.evidenceId === item.evidenceId &&
            e.selection.id === item.selection.id &&
            e.selection.revision === item.selection.revision &&
            e.startFrame + scope.startFrame >= data.startFrame &&
            e.endFrame + scope.startFrame <= data.endFrame,
        )
      )
        throw new HttpError(409, '呈现证据不在本次实际观看范围');
    }
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
    const edl = this.store.get(edlId);
    const owner = edl.data.owner?.deliveryPlanId;
    if (owner && this.store.get(owner).data.target.mode !== 'work')
      throw new HttpError(409, '范围导出不能标记为整集定稿');
    const snapshot = this.inspect(edlId),
      ep = this.store.get(edl.parentId!);
    const asset = this.validateExport(ep, edl, raw.exportAsset);
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
      quality: 'not_certified',
      reviews: snapshot.scopes.flatMap((s) => (s.review ? [s.review] : [])),
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
      const doc = this.store.create(
        'episode_release',
        edl.projectId,
        {
          ...preview,
          canon: null,
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
        ...preview.reviews,
      ]);
      this.store.event(null, 'episode_released', { releaseId: doc.id });
      return doc;
    });
  }
}
