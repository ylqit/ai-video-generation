import { Store, HttpError } from './db.js';
import { DomainService } from './domain-service.js';
import { prepareShot } from '../shared/directing.js';
import { sampleShot, spatialIssues } from '../shared/spatial.js';
import { generationDigest } from './h3-guided.js';
import { authoringPrevis } from '../shared/staging-projection.js';

export function previsManifest(
  store: Store,
  episodeId: string,
  revision: number,
  shotId: string,
  frame: number,
  width: number,
  height: number,
) {
  const episode = store.get(episodeId, revision);
  if (episode.kind !== 'episode') throw new HttpError(400, '需要分集');
  const shot = episode.data.shots.find((s: any) => s.id === shotId);
  if (!shot) throw new HttpError(404, '镜头不存在');
  const domain = new DomainService(store),
    layouts = shot.state?.layout
      ? [domain.owned(episode.projectId, shot.state.layout, 'layout')]
      : [];
  const spec = prepareShot(shot, layouts);
  if (
    ![revision, frame, width, height].every(Number.isInteger) ||
    revision < 1 ||
    frame < 0 ||
    width < 128 ||
    width > 2048 ||
    height < 128 ||
    height > 2048
  )
    throw new HttpError(400, '预演参数无效');
  if (spec.issues.some((i) => i.severity === 'blocking'))
    throw new HttpError(400, '先修复镜头设计校验问题');
  if (frame >= spec.frames) throw new HttpError(400, '预演帧超出镜头');
  const manifest = {
    version: 1,
    kind: 'scene_previs',
    episode: { id: episode.id, revision },
    shotId,
    layout: shot.state?.layout || null,
    frame,
    width,
    height,
    renderer: 'studio-previs-v1',
    spec,
    sampled: sampleShot(spec, frame),
  };
  return {
    projectId: episode.projectId,
    manifest,
    digest: generationDigest(manifest),
    issues: [...spec.issues, ...spatialIssues(spec, width / height)],
  };
}

export function authoringPrevisManifest(
  store: Store,
  resultId: string,
  revision: number,
  shotId: string,
  frame: number,
  width: number,
  height: number,
) {
  const record = store.get(resultId, revision);
  if (
    record.kind !== 'authoring_result' ||
    record.data.stage !== 'director' ||
    record.data.result.contractRevision !== 2
  )
    throw new HttpError(400, '需要 V9 修订 2 导演结果');
  const run = store.get(record.parentId!);
  const spec = authoringPrevis(record.data.result, shotId, { id: record.id, revision });
  if (
    ![frame, width, height].every(Number.isInteger) ||
    frame < 0 ||
    frame >= spec.frames ||
    width < 128 ||
    height < 128 ||
    width > 2048 ||
    height > 2048
  )
    throw new HttpError(400, '预演参数无效');
  if (spec.issues.some((i) => i.severity === 'blocking'))
    throw new HttpError(400, '先修复镜头设计校验问题');
  const manifest = {
    version: 1,
    kind: 'authoring_previs',
    authoring: { id: record.id, revision },
    episode: record.data.context.target,
    shotId,
    layout: null,
    frame,
    width,
    height,
    renderer: 'studio-previs-v2',
    spec,
    sampled: sampleShot(spec, frame),
  };
  if (run.projectId !== record.projectId) throw new HttpError(400, '导演归属错误');
  return {
    projectId: record.projectId,
    manifest,
    digest: generationDigest(manifest),
    issues: [...spec.issues, ...spatialIssues(spec, width / height)],
  };
}
