import { generationDigest } from './h3-guided.js';

// One fixed-input inventory, including a compatibility reader for already frozen jobs.
// Head revisions are preview freshness metadata, never the versions a model consumed.
export function generationDependencies(input: any): { id: string; revision: number }[] {
  if (input.dependencies) return input.dependencies;
  const refs = [
    input.episode,
    input.seriesInputs?.series,
    ...(input.seriesInputs?.shared || []),
    ...(input.seriesInputs?.voices || []).map((v: any) => v.record),
    ...(input.planning?.dependencies || []),
    ...(input.planning?.records || []),
    input.creativeBrief?.profile,
    ...(input.creativeBrief?.modules || []).map((m: any) => m.ref),
    input.creativeBrief?.visualReference?.asset,
    ...(input.assets || []).map((a: any) => a.asset),
    ...(input.continuation?.dependencies || []),
  ].filter((r: any) => r?.id && Number.isInteger(r.revision));
  return [
    ...new Map(
      refs.map((r: any) => [`${r.id}:${r.revision}`, { id: r.id, revision: r.revision }]),
    ).values(),
  ].sort((a, b) => a.id.localeCompare(b.id) || a.revision - b.revision);
}

export function correctionAffectsInput(input: any, correction: any, jobId?: string): boolean {
  if (jobId && correction.supersedingJobId === jobId) return false;
  // Segment-only plan events are new semantics; legacy jobs retain the old impact graph.
  if (correction.segmentIds && !input.dependencies && !correction.affected?.length) return false;
  if (
    input.dependencies &&
    correction.source === input.episode?.id &&
    correction.segmentIds &&
    !correction.segmentIds.includes(input.segment?.id)
  )
    return false;
  return generationDependencies(input).some((ref) => {
    if (correction.source === ref.id && correction.selectionChange) {
      if (input.segment?.repair?.sourceSelection?.id === ref.id) return true;
      const incoming = input.segment?.incoming;
      if (incoming?.version === 2) {
        const sources = incoming.sources.filter((s: any) => s.selection?.id === ref.id);
        if (sources.length)
          return sources.some((source: any) => {
            const change = correction.selectionChange[source.boundary || 'end'];
            return (
              incoming.decisions.some(
                (d: any) =>
                  d.sourceId === source.id && change.keys.includes(d.instanceId + ':' + d.key),
              ) ||
              incoming.relationDecisions.some(
                (d: any) => d.sourceId === source.id && change.objects.includes(d.objectId),
              ) ||
              incoming.actionDecisions.some(
                (d: any) =>
                  d.sourceId === source.id &&
                  (change.actions || []).includes(d.instanceId + ':' + d.actionId),
              )
            );
          });
      }
      if (incoming?.selection?.id === ref.id) {
        const change = correction.selectionChange;
        const side = incoming.boundary || 'end';
        return (
          incoming.decisions.some((d: any) =>
            change[side].keys.includes(`${d.instanceId}:${d.key}`),
          ) ||
          incoming.relationDecisions.some((d: any) => change[side].objects.includes(d.objectId))
        );
      }
    }
    return (
      correction.source === ref.id ||
      (correction.affected || []).some((a: any) => a.id === ref.id && ref.revision <= a.revision)
    );
  });
}

export function boundaryChanges(before: any, after: any) {
  return Object.fromEntries(
    ['start', 'end'].map((side) => {
      const left = before?.[side],
        right = after?.[side];
      const facts = [...(left?.facts || []), ...(right?.facts || [])];
      const keys = [...new Set<string>(facts.map((f) => `${f.instanceId}:${f.key}`))].filter(
        (key) =>
          generationDigest(
            (left?.facts || [])
              .filter((f: any) => `${f.instanceId}:${f.key}` === key)
              .map((f: any) => [f.status, f.value]),
          ) !==
          generationDigest(
            (right?.facts || [])
              .filter((f: any) => `${f.instanceId}:${f.key}` === key)
              .map((f: any) => [f.status, f.value]),
          ),
      );
      const objects = [
        ...new Set<string>([
          ...(left?.relationObjectIds || []),
          ...(right?.relationObjectIds || []),
          ...[...(left?.relations || []), ...(right?.relations || [])].map((r) => r.objectId),
        ]),
      ].filter(
        (id) =>
          !!left?.relationObjectIds?.includes(id) !== !!right?.relationObjectIds?.includes(id) ||
          generationDigest((left?.relations || []).filter((r: any) => r.objectId === id)) !==
            generationDigest((right?.relations || []).filter((r: any) => r.objectId === id)),
      );
      const actions = [
        ...new Set<string>(
          [...(left?.actions || []), ...(right?.actions || [])].map(
            (a) => a.instanceId + ':' + a.id,
          ),
        ),
      ].filter(
        (k) =>
          generationDigest(
            (left?.actions || []).filter((a: any) => a.instanceId + ':' + a.id === k),
          ) !==
          generationDigest(
            (right?.actions || []).filter((a: any) => a.instanceId + ':' + a.id === k),
          ),
      );
      return [side, { keys, objects, ...(left?.actions || right?.actions ? { actions } : {}) }];
    }),
  );
}
