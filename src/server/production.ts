import type { Store } from './db.js';
import { HttpError } from './db.js';
import { ReadinessService } from './readiness.js';
import { dramaturgyIssues } from '../shared/longform.js';
import type { EpisodePlan, RecordDoc } from '../shared/contracts.js';

export function productionProgress(store: Store, episodeId: string) {
  const episode = store.get(episodeId);
  if (episode.kind !== 'episode') throw new HttpError(400, '不是分集');
  const plan = episode.data as EpisodePlan;
  const jobs = store.db
    .prepare("SELECT * FROM jobs WHERE episode_id=? AND kind='generation' ORDER BY created_at,id")
    .all(episodeId)
    .map((r) => store.decodeJob(r));
  const selections = store
    .list('segment_selection', episode.projectId)
    .filter((s) => s.parentId === episodeId);
  const reviews = store.list('generation_review', episode.projectId);
  const readiness = new ReadinessService(store),
    defaults = readiness.profile(episode.projectId);
  const attemptsBySegment = new Map<string, typeof jobs>();
  for (const job of jobs) {
    if (job.input.offlineFixture || !job.input.segment?.id) continue;
    const id = job.input.segment.id;
    const group = attemptsBySegment.get(id) || [];
    group.push(job);
    attemptsBySegment.set(id, group);
  }
  const selectionBySegment = new Map(
    selections.filter((s) => !s.data.stale).map((s) => [s.data.segmentId, s]),
  );
  const rejectedJobs = new Set(
    reviews
      .filter((r) => r.data.issues?.some((i: any) => i.severity === 'blocking'))
      .map((r) => r.data.jobId),
  );
  const segments = plan.segments.map((segment) => {
    const attempts = attemptsBySegment.get(segment.id) || [];
    const selection = selectionBySegment.get(segment.id);
    const actualJob =
      selection && attempts.find((j) => j.id === selection.data.jobId && j.state === 'succeeded');
    const validSelection = selection && actualJob ? selection : undefined;
    let waitingReason = '';
    if (!validSelection)
      try {
        readiness.generation(
          {
            episodeId,
            episodeRevision: episode.revision,
            segmentId: segment.id,
            width: defaults.width,
            height: defaults.height,
            steps: defaults.steps,
            seed: 1,
          },
          store.setting('comfy', null as any),
        );
      } catch (e: any) {
        waitingReason = e.message;
      }
    const latest = attempts.at(-1);
    const rejected = latest && rejectedJobs.has(latest.id);
    const status = validSelection
      ? 'selected'
      : latest?.state === 'succeeded'
        ? rejected
          ? 'redo'
          : 'review'
        : latest && !['failed', 'cancelled'].includes(latest.state)
          ? 'running'
          : latest?.state === 'failed'
            ? 'failed'
            : waitingReason
              ? 'blocked'
              : 'ready';
    return {
      id: segment.id,
      shotIds: segment.shotIds,
      status,
      waitingReason,
      selectionId: validSelection?.id || null,
      adoptedSeconds: validSelection
        ? validSelection.data.composition
          ? validSelection.data.composition.totalFrames / 24
          : validSelection.data.out - validSelection.data.in
        : 0,
      coverage: validSelection?.data.coverage || [],
      attempts: attempts.length,
      requestedSeconds: attempts.reduce((n, j) => n + (j.input.segment?.duration || 0), 0),
      latestJobId: latest?.id || null,
      latestError: latest?.error || null,
      previewRequired: !validSelection,
    };
  });
  const scenes = (
    plan.dramaturgy?.scenes || [
      {
        id: 'episode',
        title: plan.title,
        targetFrames: Math.round(plan.shots.reduce((n, s) => n + s.duration, 0) * 24),
        shotIds: plan.shots.map((s) => s.id),
      },
    ]
  ).map((scene) => {
    const relevant = segments.filter((s) => s.shotIds.some((id) => scene.shotIds.includes(id)));
    const covered = new Map<string, number>();
    for (const s of relevant)
      for (const c of s.coverage)
        if (scene.shotIds.includes(c.shotId))
          covered.set(c.shotId, Math.max(covered.get(c.shotId) || 0, c.out - c.in));
    const adoptedSeconds = [...covered.values()].reduce((n, v) => n + v, 0);
    return {
      ...scene,
      adoptedSeconds,
      missingSeconds: Math.max(0, scene.targetFrames / 24 - adoptedSeconds),
      segments: relevant,
    };
  });
  const realJobs = jobs.filter((j) => !j.input.offlineFixture),
    succeeded = realJobs.filter((j) => j.state === 'succeeded');
  const timings = realJobs.flatMap((j) =>
    typeof j.output.remoteDurationMs === 'number' ? [j.output.remoteDurationMs] : [],
  );
  const adoptedSeconds = scenes.reduce((n, s) => n + s.adoptedSeconds, 0),
    targetSeconds = scenes.reduce((n, s) => n + s.targetFrames / 24, 0);
  return {
    episode: {
      id: episode.id,
      revision: episode.revision,
      title: plan.title,
      approved: !!episode.data.approved,
    },
    targetSeconds,
    adoptedSeconds,
    missingSeconds: Math.max(0, targetSeconds - adoptedSeconds),
    scenes,
    issues: dramaturgyIssues(plan),
    attempts: realJobs.length,
    requestedSeconds: realJobs.reduce((n, j) => n + (j.input.segment?.duration || 0), 0),
    selectedCandidates: new Set(
      segments
        .filter((s) => s.selectionId)
        .map((s) => selections.find((d) => d.id === s.selectionId)?.data.jobId),
    ).size,
    succeededCandidates: succeeded.length,
    meanRemoteDurationMs: timings.length
      ? timings.reduce((n, v) => n + v, 0) / timings.length
      : null,
    timingSamples: timings.length,
    allCanonPending: !store
      .list('continuity', episode.projectId)
      .some((c) => c.parentId === episodeId && c.data.confirmed && !c.data.stale),
  };
}
