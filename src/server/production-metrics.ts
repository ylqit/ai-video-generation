import { Store, HttpError } from './db.js';
import { selectionMedia } from './selection-splice.js';

// Read-only accounting from actual jobs and current valid adopted media. Unknown
// acceptance, elapsed wall time and model execution time are not interchangeable.
export function productionMetrics(store: Store, runId: string) {
  const run = store.get(runId);
  if (run.kind !== 'creation_run') throw new HttpError(400, '指标需要创作运行');
  const jobs = store
    .jobs(run.projectId, run.data.episodeId)
    .filter((j) => j.kind === 'generation' && j.input.creationRunId === runId);
  const ids = new Set(jobs.map((j) => j.id));
  const videos = store.db
    .prepare(
      "SELECT * FROM documents WHERE project_id=? AND kind='asset' AND json_extract(data,'$.category')='generated' AND json_extract(data,'$.mediaType')='video'",
    )
    .all(run.projectId)
    .map((r) => store.decode(r))
    .filter((a) => ids.has(a.data.jobId));
  const media = new Map(videos.map((v) => [v.id, v]));
  const intervals = new Map<string, [number, number][]>();
  const selections = store
    .list('segment_selection', run.projectId, run.data.episodeId)
    .filter((s) => s.data.creationRunId === runId && !s.data.stale && !s.data.archived);
  let selectedTimelineFrames = 0;
  for (const selection of selections)
    for (const p of selectionMedia(selection.data)) {
      const video = media.get(p.video?.id);
      if (!video || video.data.archived) continue;
      const start = Math.round(p.in * 24),
        end = Math.round(p.out * 24);
      if (end <= start) continue;
      selectedTimelineFrames += end - start;
      const key = `${p.video.id}:${p.video.revision}`;
      intervals.set(key, [...(intervals.get(key) || []), [start, end]]);
    }
  let uniqueAdoptedFrames = 0;
  for (const ranges of intervals.values()) {
    let end = -1;
    for (const [start, stop] of ranges.sort((a, b) => a[0] - b[0])) {
      uniqueAdoptedFrames += Math.max(0, stop - Math.max(start, end));
      end = Math.max(end, stop);
    }
  }
  const durations = store.db
    .prepare(
      "SELECT e.job_id, MIN(CASE WHEN e.kind IN ('submitted','running') THEN e.created_at END) AS start, MIN(CASE WHEN e.kind='succeeded' THEN e.created_at END) AS finish FROM events e JOIN jobs j ON j.id=e.job_id WHERE j.project_id=? AND j.episode_id=? GROUP BY e.job_id",
    )
    .all(run.projectId, run.data.episodeId)
    .filter(
      (e) =>
        ids.has(String(e.job_id)) &&
        e.start != null &&
        e.finish != null &&
        Number(e.finish) >= Number(e.start),
    )
    .map((e) => Number(e.finish) - Number(e.start));
  return {
    run: { id: run.id, revision: run.revision },
    requested: jobs.length,
    requestedSeconds: jobs.reduce((n, j) => n + Number(j.input.segment?.duration || 0), 0),
    remoteTaskIds: new Set(jobs.map((j) => j.promptId).filter(Boolean)).size,
    acceptanceUnknown: jobs.filter((j) => j.state === 'unknown').length,
    archived: jobs.filter((j) => j.state === 'succeeded').length,
    actualFrames: videos.reduce(
      (n, v) => n + (Number.isInteger(v.data.frameCount) ? v.data.frameCount : 0),
      0,
    ),
    frameCountMissing: videos.filter((v) => !Number.isInteger(v.data.frameCount)).length,
    selectedTimelineFrames,
    uniqueAdoptedFrames,
    adoptedSecondsPerRequest: jobs.length ? uniqueAdoptedFrames / 24 / jobs.length : null,
    observedWallTime: {
      samples: durations.length,
      totalMs: durations.reduce((n, d) => n + d, 0),
      includesArchiving: true,
    },
    reviewTimeMs: null,
    states: Object.fromEntries(
      [...new Set(jobs.map((j) => j.state))].map((state) => [
        state,
        jobs.filter((j) => j.state === state).length,
      ]),
    ),
    scope:
      '当前运行所有尝试；采用仅统计未失效的当前选择。源媒体重叠区间去重，历史导出不计入新增采用。',
  };
}
