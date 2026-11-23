import type { DirectorResult, ScriptResult } from './creation.js';
import { scopeSubjectKeys, requirementInScope, type CreationScope } from './workspace.js';
import { resolveAuthoringStates } from './authoring-state.js';
import { resolveStaging, sceneDesignDependencies } from './staging-projection.js';

// Shared by frozen-scope validation and read-only edit impact. Metadata titles and
// summaries do not change execution; inherited state and timing still do.
export function scopeAuthoringProjection(
  stage: string,
  value: any,
  scope: CreationScope,
  director: DirectorResult,
  script?: ScriptResult,
) {
  const selectedShots = director.shots.filter((s) => scope.shotIds.includes(s.id));
  const knownStates = resolveAuthoringStates(director);
  const sceneIds = new Set(selectedShots.map((s) => s.sceneId));
  const subjectKeys = scopeSubjectKeys(
    script,
    selectedShots.map((shot) => ({ ...shot, ...knownStates.get(shot.id)! })),
  );

  const { summary: _summary, title: _title, ...data } = value;
  if (stage === 'script')
    return {
      ...data,
      scenes: data.scenes.filter((s: any) => sceneIds.has(s.id)),
      subjects: data.subjects.filter((s: any) => subjectKeys.has(s.key)),
    };
  if (stage === 'assets')
    return {
      ...data,
      items: data.items.filter((i: any) => requirementInScope(i, script, selectedShots)),
    };
  if (stage === 'director') {
    const projectedStates = resolveAuthoringStates(value);
    const projectedStaging = resolveStaging(value);
    let frame = 0;
    const windows: CreationScope['windows'] = [];
    for (const shot of data.shots) {
      if (scope.shotIds.includes(shot.id))
        windows.push({ shotId: shot.id, startFrame: frame, endFrame: frame + shot.frames });
      frame += shot.frames;
    }
    return {
      ...data,
      ...(data.sceneDesigns
        ? {
            sceneDesigns: data.sceneDesigns
              .filter((d: any) => sceneIds.has(d.sceneId))
              .map((d: any) =>
                sceneDesignDependencies(
                  d,
                  data.shots.filter((s: any) => scope.shotIds.includes(s.id)),
                ),
              ),
          }
        : {}),
      shots: data.shots.filter((s: any) => scope.shotIds.includes(s.id)),
      groups: data.groups
        .filter((g: any) => scope.groupIds.includes(g.id))
        .map((g: any) => ({
          ...g,
          shotIds: g.shotIds.filter((id: string) => scope.shotIds.includes(id)),
        })),
      windows,
      knownStates: data.shots
        .filter((s: any) => scope.shotIds.includes(s.id))
        .map((s: any) => [s.id, projectedStates.get(s.id)]),
      knownStaging: data.shots
        .filter((s: any) => scope.shotIds.includes(s.id))
        .map((s: any) => [s.id, projectedStaging.get(s.id)]),
    };
  }
  return data;
}
