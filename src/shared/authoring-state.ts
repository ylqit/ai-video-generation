import type { DirectorResult } from './creation.js';

type Shot = DirectorResult['shots'][number];

// V9 arrays declare known facts. An omitted object remains unspecified until first
// established, then carries forward; an explicit object's relation list replaces its old list.
export function resolveAuthoringStates(director: DirectorResult) {
  const resolved = new Map<
    string,
    {
      entryState: Shot['entryState'];
      exitState: Shot['exitState'];
      entryRelations: Shot['entryRelations'];
      exitRelations: Shot['exitRelations'];
      transitionChanges: { subjectKey: string; property: string; reason: string }[];
    }
  >();
  let facts: Shot['entryState'] = [],
    relations: Shot['entryRelations'] = [];
  const mergeFacts = (base: Shot['entryState'], updates: Shot['entryState']) => [
    ...new Map([...base, ...updates].map((f) => [`${f.subjectKey}:${f.key}`, f])).values(),
  ];
  const mergeRelations = (base: Shot['entryRelations'], updates: Shot['entryRelations']) => {
    const objects = new Set(updates.map((r) => r.objectKey));
    return [...base.filter((r) => !objects.has(r.objectKey)), ...updates];
  };
  for (const shot of director.shots) {
    const entryState = mergeFacts(facts, shot.entryState);
    const entryRelations = mergeRelations(relations, shot.entryRelations);
    const exitState = mergeFacts(entryState, shot.exitState);
    const exitRelations = mergeRelations(entryRelations, shot.exitRelations);
    const transitionChanges: { subjectKey: string; property: string; reason: string }[] = [];
    const group = director.groups.find((g) => g.shotIds[0] === shot.id);
    if (group && ['ellipsis', 'location_change', 'flashback'].includes(group.transition)) {
      for (const f of entryState) {
        const before = facts.find((p) => p.subjectKey === f.subjectKey && p.key === f.key);
        if (before && before.value !== f.value)
          transitionChanges.push({
            subjectKey: f.subjectKey,
            property: `attribute:${f.key}`,
            reason: group.reason,
          });
      }
      for (const objectKey of new Set(entryRelations.map((r) => r.objectKey))) {
        const before = relations.filter((r) => r.objectKey === objectKey);
        const after = entryRelations.filter((r) => r.objectKey === objectKey);
        if (!before.length || JSON.stringify(before) === JSON.stringify(after)) continue;
        transitionChanges.push({
          subjectKey: objectKey,
          property: 'relationship',
          reason: group.reason,
        });
        const oldLocation = before.find((r) => r.type === 'locatedIn');
        const newLocation = after.find((r) => r.type === 'locatedIn');
        if (oldLocation && newLocation && oldLocation.targetKey !== newLocation.targetKey)
          transitionChanges.push({
            subjectKey: objectKey,
            property: 'attribute:creation_location',
            reason: group.reason,
          });
      }
    }
    resolved.set(shot.id, {
      entryState,
      exitState,
      entryRelations,
      exitRelations,
      transitionChanges,
    });
    facts = exitState;
    relations = exitRelations;
  }
  return resolved;
}
