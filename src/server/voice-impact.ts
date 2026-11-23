import { Store } from './db.js';
import { generationDigest } from './h3-guided.js';

// Compare actual consumed lines, not episode revision numbers or display names.
export function updateVoiceDependents(store: Store, episodeId: string) {
  const ep = store.get(episodeId);
  const changed = (basis: any, text: string) => {
    const line = ep.data.shots
      ?.find((s: any) => s.id === basis.shotId)
      ?.directing?.sound?.dialogue?.find((l: any) => l.id === basis.lineId);
    return (
      !line ||
      line.text !== text ||
      line.instanceId !== basis.instanceId ||
      generationDigest(line.voiceProfile) !== generationDigest(basis.voiceProfile || basis.voice)
    );
  };
  for (const take of store
    .list('dialogue_take', ep.projectId)
    .filter((d) => d.parentId === episodeId)) {
    if (!take.data.stale && changed(take.data, take.data.actualText))
      store.update(take.id, take.revision, {
        ...take.data,
        stale: true,
        staleReason: '实际消费的台词或说话者声音版本已改变',
      });
  }
  for (const job of store
    .jobs(ep.projectId, episodeId)
    .filter((j) => ['speech', 'lipsync'].includes(j.kind))) {
    const basis = job.input.line || job.input.take?.data;
    if (!basis || !changed(basis, job.input.text || basis.actualText)) continue;
    if (job.state === 'queued' && !job.holdReason)
      store.patchJob(job.id, { holdReason: 'dependencies_need_review' });
    else if (!job.output.basisCorrected)
      store.patchJob(job.id, {
        output: {
          ...job.output,
          basisCorrected: true,
          basisCorrectionMessage: '台词或声音依据已改变，原任务继续归档，采用前需重新审核',
        },
      });
  }
}
