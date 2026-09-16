import { Store, HttpError } from './db.js';
import { DomainService } from './domain-service.js';
import type { RecordDoc, Job } from '../shared/contracts.js';
export function candidateMedia(
  store: Store,
  job: Job,
  media: RecordDoc[],
  jobs: Job[],
  reviews: RecordDoc[],
  label: string,
  details = true,
) {
  const assets = media.filter((a) => a.data.jobId === job.id);
  let video =
    assets.find((a) => a.data.mediaType === 'video' && a.data.category === 'generated') || null;
  const review =
    reviews
      .filter((r) => r.data.jobId === job.id || (video && r.data.video?.id === video.id))
      .at(-1) || null;
  if (review?.data.video) video = store.get(review.data.video.id, review.data.video.revision);
  const audio = assets.find((a) => a.data.category === 'original_audio') || null;
  const exports = video
    ? media.filter((a) => {
        if (a.data.category !== 'export') return false;
        const source = jobs.find((j) => j.id === a.data.jobId);
        return (
          source &&
          new DomainService(store)
            .refs(source.input)
            .some((r) => r.id === video!.id && r.revision === video!.revision)
        );
      })
    : [];
  const storage = new Map(
    details
      ? store.db
          .prepare(
            "SELECT f.path,f.status FROM media_file_state f JOIN documents d ON json_extract(d.data,'$.path')=f.path WHERE d.kind='asset' AND d.project_id=? AND json_extract(d.data,'$.jobId')=?",
          )
          .all(job.projectId, job.id)
          .map((r) => [r.path, r.status])
      : [],
  );
  const evidence = (details ? assets : [])
    .filter((a) => ['review_frame', 'keyframe'].includes(a.data.category))
    .map((a) => ({
      ...a,
      cleared: storage.get(a.data.path) === 'cleared',
      issues: (review?.data.issues || []).filter((i: any) => i.evidence?.id === a.id),
      pinned: !!review && JSON.stringify(review.data).includes(a.id),
    }))
    .sort(
      (a, b) =>
        Number(b.pinned) - Number(a.pinned) || (a.data.frameIndex ?? 0) - (b.data.frameIndex ?? 0),
    );
  return {
    detailPending: !details,
    id: job.id,
    label,
    segmentId: job.input.segment?.id || '',
    shotIds: job.input.segment?.shotIds || [],
    video,
    audio,
    review,
    exports,
    evidence,
    state: job.state,
    epoch: job.input.creationEpoch ?? null,
    scope: job.input.creationScope || null,
  };
}

export function candidateDetail(store: Store, projectId: string, jobId: string) {
  const job = store.job(jobId);
  if (job.projectId !== projectId || job.kind !== 'generation')
    throw new HttpError(400, '候选不属于该项目');
  const assets = store.db
    .prepare(
      "SELECT * FROM documents WHERE project_id=? AND kind='asset' AND json_extract(data,'$.jobId')=?",
    )
    .all(projectId, jobId)
    .map((r) => store.decode(r));
  const videoIds = assets.filter((a) => a.data.category === 'generated').map((a) => a.id);
  const exportJobs = videoIds.length
    ? store.db
        .prepare(
          `SELECT DISTINCT j.id FROM jobs j,json_tree(j.input) t WHERE j.project_id=? AND j.kind='export' AND t.type='text' AND t.value IN (${videoIds.map(() => '?').join(',')})`,
        )
        .all(projectId, ...videoIds)
        .map((r) => store.job(String(r.id)))
    : [];
  if (exportJobs.length)
    assets.push(
      ...store.db
        .prepare(
          `SELECT * FROM documents WHERE project_id=? AND kind='asset' AND json_extract(data,'$.category')='export' AND json_extract(data,'$.jobId') IN (${exportJobs.map(() => '?').join(',')})`,
        )
        .all(projectId, ...exportJobs.map((j) => j.id))
        .map((r) => store.decode(r)),
    );
  const reviews = store.db
    .prepare(
      `SELECT * FROM documents WHERE project_id=? AND kind='generation_review' AND (json_extract(data,'$.jobId')=? ${videoIds.length ? `OR json_extract(data,'$.video.id') IN (${videoIds.map(() => '?').join(',')})` : ''}) ORDER BY created_at,id`,
    )
    .all(projectId, jobId, ...videoIds)
    .map((r) => store.decode(r));
  return candidateMedia(
    store,
    job,
    assets,
    [job, ...exportJobs],
    reviews,
    `${job.input.segment?.id || '候选'} · ${job.id.slice(0, 8)}`,
  );
}
