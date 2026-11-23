import { z } from 'zod';
import { authoringSchemas, type AuthoringContext } from './creation.js';

export const localReplacementSchemas = {
  script: z
    .object({
      protocol: z.literal('local-authoring-v1'),
      stage: z.literal('script'),
      subjects: authoringSchemas.script.shape.subjects,
      scenes: authoringSchemas.script.shape.scenes,
    })
    .strict(),
  director: z
    .object({
      protocol: z.literal('local-authoring-v1'),
      stage: z.literal('director'),
      shots: authoringSchemas.director.shape.shots,
      sceneDesigns: authoringSchemas.director.shape.sceneDesigns.unwrap().default([]),
    })
    .strict(),
};

// The complete baseline stays in the frozen server context. Only these objects
// may be returned on the local wire; the existing full-result validator is final.
export function localAuthoringObjects(context: AuthoringContext): Record<string, any[]> {
  const edit = context.writable;
  if (!edit || !['script', 'director'].includes(context.stage))
    throw new Error('局部作者需要固定剧本或导演基线');
  const baseline = edit.baselineResult as any;
  const subjects = new Set(edit.subjectKeys),
    scenes = new Set(edit.sceneIds),
    shots = new Set(edit.shotIds);
  if (context.stage === 'script')
    return {
      subjects: baseline.subjects.filter((s: any) => subjects.has(s.key)),
      scenes: baseline.scenes.filter((s: any) => scenes.has(s.id)),
    };
  return {
    shots: baseline.shots.filter(
      (s: any) =>
        shots.has(s.id) ||
        scenes.has(s.sceneId) ||
        [
          ...(s.performances || []),
          ...(s.entryState || []),
          ...(s.exitState || []),
          ...(s.staging?.entry || []),
          ...(s.staging?.exit || []),
          ...(s.staging?.paths || []),
        ].some((p: any) => subjects.has(p.subjectKey)) ||
        [...(s.entryRelations || []), ...(s.exitRelations || [])].some((r: any) =>
          subjects.has(r.objectKey),
        ) ||
        (s.interactions || []).some((i: any) => subjects.has(i.actorKey)),
    ),
    sceneDesigns: (baseline.sceneDesigns || []).filter(
      (d: any) =>
        scenes.has(d.sceneId) ||
        [...(d.anchors || []), ...(d.proxies || [])].some((a: any) => subjects.has(a.subjectKey)),
    ),
  };
}

export function mergeLocalAuthoring(context: AuthoringContext, raw: unknown) {
  const stage = context.stage as keyof typeof localReplacementSchemas;
  if (!(stage in localReplacementSchemas)) throw new Error('不支持此局部作者阶段');
  const replacement = localReplacementSchemas[stage].parse(raw) as any;
  const selected = localAuthoringObjects(context) as Record<string, any[]>;
  const result: any = structuredClone(context.writable!.baselineResult);
  let count = 0;
  for (const [field, objects] of Object.entries(selected)) {
    const identity = field === 'subjects' ? 'key' : 'id';
    const incoming: any[] = replacement[field];
    const ids = incoming.map((o) => o[identity]);
    if (
      new Set(ids).size !== ids.length ||
      ids.some((id) => !objects.some((o) => o[identity] === id))
    )
      throw new Error('局部替换包含重复或未授权对象');
    count += incoming.length;
    result[field] = (result[field] || []).map(
      (original: any) => incoming.find((o) => o[identity] === original[identity]) || original,
    );
  }
  if (!count) throw new Error('局部替换至少包含一个已授权对象');
  return result;
}

export function localAuthoringInput(context: AuthoringContext) {
  const selected = localAuthoringObjects(context) as any;
  const baseline: any = context.writable!.baselineResult;
  const sceneIds = new Set<string>([
    ...context.writable!.sceneIds,
    ...(selected.shots || []).map((s: any) => s.sceneId),
  ]);
  const subjectKeys = new Set<string>(context.writable!.subjectKeys);
  const script: any = context.stage === 'script' ? baseline : context.priorResults.script;
  for (const s of selected.shots || [])
    for (const key of s.visibleSubjectKeys) subjectKeys.add(key);
  for (const s of script?.scenes || [])
    if (sceneIds.has(s.id)) for (const line of s.dialogue) subjectKeys.add(line.speakerKey);
  const neighbors =
    context.stage === 'director'
      ? baseline.shots.filter(
          (s: any, i: number, all: any[]) =>
            !(selected.shots || []).some((t: any) => t.id === s.id) &&
            [all[i - 1], all[i + 1]].some((n) => selected.shots.some((t: any) => t.id === n?.id)),
        )
      : [];
  const { writable, priorResults, records, ...rest } = context;
  const { rules: _rules, capabilities: _capabilities, digest: _digest, ...identity } = rest;
  return {
    ...identity,
    writable: { ...writable, baselineResult: undefined, objects: selected },
    readOnlyNeighbors: neighbors,
    readOnlyGlobals: Object.fromEntries(
      Object.entries(baseline).filter(
        ([key]) => !['subjects', 'scenes', 'shots', 'sceneDesigns', 'screenplayText'].includes(key),
      ),
    ),
    priorResults: {
      ...priorResults,
      ...(script
        ? {
            script: {
              ...script,
              screenplayText: undefined,
              scenes: script.scenes.filter((s: any) => sceneIds.has(s.id)),
              subjects: script.subjects.filter((s: any) => subjectKeys.has(s.key)),
            },
          }
        : {}),
    },
    // Fixed source documents remain available in full: we do not silently trim a
    // source or Canon fact without an explicit range/consumer map.
    records,
    reading: {
      selectedScenes: [...sceneIds],
      selectedSubjects: [...subjectKeys],
      baselineRetainedOnServer: true,
    },
  };
}
