import type { Store } from './db.js';
import type { RecordDoc } from '../shared/contracts.js';
import { selectionMedia } from './selection-splice.js';

// Read existing facts and adopted media; never infer observations from authored text.
export function storyCoverage(
  store: Store,
  run: RecordDoc | null,
  results: Record<string, RecordDoc | undefined>,
) {
  const script = results.script,
    director = results.director;
  if (!run || !script) return [];
  const facts = results.brief?.data.result.lockedFacts || [];
  const selections = store
    .list('segment_selection', run.projectId, run.data.episodeId)
    .filter((s) => !s.data.stale && s.data.creationRunId === run.id);
  const same = (a: any, b: any) => a?.id === b?.id && a?.revision === b?.revision;
  return script.data.result.scenes.flatMap((scene: any) =>
    scene.events.map((event: any) => {
      const shots = (director?.data.result.shots || []).filter(
        (s: any) => s.sceneId === scene.id && s.events.some((e: any) => e.eventId === event.id),
      );
      const evidence: any[] = [];
      for (const selection of selections)
        for (const part of selectionMedia(selection.data)) {
          if (!part.review || !part.video) continue;
          if (!part.review) continue;
          const review = store.get(part.review.id, part.review.revision),
            head = store.get(review.id);
          if (
            head.revision !== review.revision ||
            head.data.stale ||
            !review.data.eventEvidence?.length ||
            !same(review.data.video, part.video)
          )
            continue;
          const job = store.job(review.data.jobId);
          if (
            job.input.creationRunId !== run.id ||
            !same(job.input.authoring?.script, script) ||
            !same(job.input.authoring?.director, director)
          )
            continue;
          for (const shot of shots) {
            const phase = shot.events.find((e: any) => e.eventId === event.id)?.phase;
            const id = `${shot.id}:${event.id}:${phase}`;
            for (const e of review.data.eventEvidence || []) {
              if (
                e.shotId !== shot.id ||
                e.eventId !== id ||
                e.status !== 'pass' ||
                e.observed !== 'occurred' ||
                e.endFrame <= e.startFrame ||
                e.startFrame < Math.round(part.in * 24) ||
                e.endFrame > Math.round(part.out * 24)
              )
                continue;
              evidence.push({
                shotId: shot.id,
                phase,
                selection: { id: selection.id, revision: selection.revision },
                review: part.review,
                video: part.video,
                startFrame: e.startFrame,
                endFrame: e.endFrame,
                inspection: e.inspection,
              });
            }
          }
        }
      return {
        sceneId: scene.id,
        sceneTitle: scene.title,
        eventId: event.id,
        description: event.description,
        sources: (event.sourceFactIds || [])
          .map((id: string) => facts.find((f: any) => f.id === id))
          .filter(Boolean),
        shots: shots.map((s: any) => ({
          id: s.id,
          phase: s.events.find((e: any) => e.eventId === event.id).phase,
          purpose: s.purpose,
        })),
        evidence,
        status:
          shots.length && shots.every((s: any) => evidence.some((e) => e.shotId === s.id))
            ? 'observed'
            : shots.length
              ? 'planned'
              : 'unplanned',
      };
    }),
  );
}
