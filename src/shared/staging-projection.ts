import type { AuthoringShot, DirectorResult } from './creation.js';
import type { SceneDesign, ShotStaging } from './staging-contracts.js';
import { directingSchema, prepareShot } from './directing.js';

export function sceneDesignDependencies(design: SceneDesign, shots: AuthoringShot[]) {
  const used = shots.filter((s) => s.staging?.sceneDesignId === design.id);
  const cameras = new Set(used.map((s) => s.staging!.cameraId));
  const anchors = new Set(
    used.flatMap((s) => [
      ...(s.interactions || []).map((i) => i.anchorId),
      ...s.performances.map((p) => p.attention?.anchorId),
      ...[...s.entryRelations, ...s.exitRelations].map((r) => r.anchorId),
    ]),
  );
  return {
    ...design,
    cameras: design.cameras.filter((c) => cameras.has(c.id)),
    anchors: design.anchors.filter((a) => anchors.has(a.id)),
  };
}

/** Resolve whole-sequence poses by scene, including explicit unknowns. No inferred motion. */
export function resolveStaging(director: DirectorResult) {
  const states = new Map<string, ShotStaging['entry']>();
  const doorStates = new Map<string, Map<string, boolean>>();
  const result = new Map<
    string,
    { entry: ShotStaging['entry']; exit: ShotStaging['exit']; doors: ShotStaging['doors'] }
  >();
  const merge = (base: ShotStaging['entry'], updates: ShotStaging['entry']) => [
    ...new Map([...base, ...updates].map((p) => [p.subjectKey, p])).values(),
  ];
  for (const shot of director.shots) {
    if (!shot.staging) continue;
    const entry = merge(states.get(shot.staging.sceneDesignId) || [], shot.staging.entry);
    const pathEnds = shot.staging.paths.flatMap((p) => {
      const key = p.keys.at(-1);
      return key
        ? [{ subjectKey: p.subjectKey, position: key.position, heading: key.heading }]
        : [];
    });
    const exit = merge(merge(entry, pathEnds), shot.staging.exit);
    const inheritedDoors = doorStates.get(shot.staging.sceneDesignId) || new Map<string, boolean>();
    const doors = [...inheritedDoors].map(([barrierId, open]) => ({ barrierId, open, frame: 0 }));
    for (const change of [...shot.staging.doors].sort((a, b) => a.frame - b.frame)) {
      const duplicate = doors.findIndex(
        (d) => d.barrierId === change.barrierId && d.frame === change.frame,
      );
      if (duplicate >= 0) doors.splice(duplicate, 1);
      doors.push(change);
      inheritedDoors.set(change.barrierId, change.open);
    }
    doorStates.set(shot.staging.sceneDesignId, inheritedDoors);
    states.set(shot.staging.sceneDesignId, exit);
    result.set(shot.id, { entry, exit, doors });
  }
  return result;
}

/** Shared geometry projection for authoring preview and persisted execution layouts. */
export function projectSceneDesign(
  design: SceneDesign,
  environment: { id: string; revision: number },
) {
  return {
    name: design.id,
    environment,
    space: design.space || undefined,
    scale: design.scale,
    barriers: design.barriers,
    regions: design.regions,
    markers: [],
    image: null,
    cameras: design.cameras.map(({ height, pitch, fov, ...camera }) => ({
      ...camera,
      framing: '',
      optics: { height, pitch, fov },
    })),
  };
}

/** This is the only conversion between authoring subject keys and execution instances. */
export function projectShotStaging(
  director: DirectorResult,
  shot: AuthoringShot,
  instance: (key: string) => string,
) {
  const design = director.sceneDesigns?.find((d) => d.id === shot.staging?.sceneDesignId);
  const resolved = resolveStaging(director).get(shot.id);
  const used = new Set([
    ...shot.visibleSubjectKeys,
    ...(resolved?.entry || []).map((p) => p.subjectKey),
    ...(shot.staging?.paths || []).map((p) => p.subjectKey),
    ...shot.performances.map((p) => p.subjectKey),
    ...shot.performances.flatMap((p) => (p.attention?.subjectKey ? [p.attention.subjectKey] : [])),
    ...(shot.interactions || []).flatMap((i) => [i.actorKey, i.targetKey]),
  ]);
  const poses = (values: ShotStaging['entry']) =>
    values
      .filter((p) => p.position !== null && p.heading !== null)
      .map((p) => ({
        instanceId: instance(p.subjectKey),
        position: p.position!,
        heading: p.heading!,
        phase: '',
        regionId: '',
      }));
  const applicable = design?.applicability === 'spatial';
  return {
    state: {
      cameraId: shot.staging?.cameraId || '',
      start: poses(resolved?.entry || []),
      end: poses(resolved?.exit || []),
    },
    directing: {
      contractRevision: director.contractRevision,
      events: shot.events.map((e) => {
        const cue = shot.cues.find(
          (c) => c.target.kind === 'event' && c.target.eventId === e.eventId,
        );
        return {
          id: `${shot.id}:${e.eventId}:${e.phase}`,
          description: e.eventId,
          startFrame: cue?.window?.startFrame ?? 0,
          endFrame: cue?.window?.endFrame ?? shot.frames,
          strictWindow: !!cue?.window,
          afterIds: (cue?.afterIds || []).flatMap((id) => {
            const target = shot.cues.find((c) => c.id === id)?.target;
            return target?.kind === 'event'
              ? [
                  `${shot.id}:${target.eventId}:${shot.events.find((e) => e.eventId === target.eventId)?.phase}`,
                ]
              : [];
          }),
          changes: [],
        };
      }),
      cues: shot.cues.map((cue) => ({
        ...cue,
        target:
          cue.target.kind === 'event'
            ? {
                kind: 'event' as const,
                eventId: `${shot.id}:${cue.target.eventId}:${shot.events.find((e) => e.eventId === (cue.target as { eventId: string }).eventId)?.phase}`,
              }
            : cue.target,
      })),
      paths: (shot.staging?.paths || []).map((p) => ({
        instanceId: instance(p.subjectKey),
        keys: p.keys,
      })),
      proxies: (design?.proxies || [])
        .filter((p) => used.has(p.subjectKey))
        .map(({ subjectKey, ...p }) => ({ ...p, instanceId: instance(subjectKey) })),
      doors: resolved?.doors || [],
      axis: shot.staging?.axis || undefined,
      staging: {
        applicability: applicable ? 'spatial' : 'not_applicable',
        scale: design?.scale || 'schematic',
        reason: design?.reason || '',
        entry: (resolved?.entry || []).map(({ subjectKey, ...p }) => ({
          ...p,
          instanceId: instance(subjectKey),
        })),
        exit: (resolved?.exit || []).map(({ subjectKey, ...p }) => ({
          ...p,
          instanceId: instance(subjectKey),
        })),
        anchors: (design?.anchors || [])
          .filter((a) => used.has(a.subjectKey))
          .map(({ subjectKey, ...a }) => ({ ...a, instanceId: instance(subjectKey) })),
      },
      interactions: (shot.interactions || []).map(({ actorKey, targetKey, ...i }) => ({
        ...i,
        eventId: `${shot.id}:${i.eventId}:${shot.events.find((e) => e.eventId === i.eventId)?.phase}`,
        actorId: instance(actorKey),
        targetId: instance(targetKey),
      })),
      audienceInformation: shot.informationChange || '',
      audienceFocus: shot.audienceFocus || '',
      cutReason: shot.cutReason || '',
      execution: {
        action: shot.action,
        visibleSpace: shot.visibleSpace,
        visualTreatment: shot.visualTreatment,
      },
      camera: {
        ...shot.camera,
        description: `${shot.camera.position}; ${shot.camera.reason}`,
        keys: shot.staging?.cameraKeys || [],
      },
      performance: shot.performances.map((p) => ({
        id: p.id,
        instanceId: instance(p.subjectKey),
        stimulus: p.trigger,
        intention: `${p.goal}; obstacle: ${p.obstacle}`,
        reaction: p.visible,
        ...(p.attention && (p.attention.subjectKey || p.attention.point)
          ? {
              attention: {
                ...(p.attention.subjectKey
                  ? { instanceId: instance(p.attention.subjectKey) }
                  : { point: p.attention.point! }),
                anchor: p.attention.description,
                anchorId: p.attention.anchorId,
              },
            }
          : {}),
        ...(p.headHeading !== null && p.headHeading !== undefined
          ? { headHeading: p.headHeading }
          : {}),
      })),
    },
  };
}

/** A read-only plan preview, never a stored execution object or approved asset. */
export function authoringPrevis(
  director: DirectorResult,
  shotId: string,
  basis: { id: string; revision: number },
) {
  const shot = director.shots.find((s) => s.id === shotId);
  if (!shot) throw new Error('导演镜头不存在');
  const design = director.sceneDesigns?.find((d) => d.id === shot.staging?.sceneDesignId);
  const projection = projectShotStaging(director, shot, (key) => key);
  const source = { id: basis.id, revision: basis.revision };
  const layout = design
    ? { ...source, data: projectSceneDesign(design, source), projectionOnly: true }
    : null;
  const ids = new Set([
    ...shot.visibleSubjectKeys,
    ...projection.directing.staging.entry.map((p) => p.instanceId),
    ...projection.directing.proxies.map((p) => p.instanceId),
    ...projection.directing.paths.map((p) => p.instanceId),
    ...shot.performances.flatMap((p) => (p.attention?.subjectKey ? [p.attention.subjectKey] : [])),
  ]);
  return prepareShot(
    {
      id: shot.id,
      duration: shot.frames / 24,
      state: {
        ...projection.state,
        layout: layout ? source : null,
        instances: [...ids].map((instanceId) => ({ instanceId })),
        startRelations: [],
        endRelations: [],
      },
      directing: directingSchema.parse({
        ...projection.directing,
        version: 2,
        presence: { visible: shot.visibleSubjectKeys },
        purpose: shot.purpose,
      }),
    },
    layout ? [layout] : [],
  );
}
