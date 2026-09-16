import type { ShotExecutionSpec, DirectionIssue } from './directing.js';

export function worldPoint(
  p: { x: number; y: number; height?: number },
  space?: { width: number; depth: number },
) {
  return { x: p.x * (space?.width || 10), y: p.height || 0, z: p.y * (space?.depth || 10) };
}
export function sampleKeys<
  T extends { frame: number; position: { x: number; y: number }; heading: number },
>(keys: T[], frame: number): T | null {
  if (!keys.length) return null;
  if (frame <= keys[0].frame) return keys[0];
  const n = keys.findIndex((k) => k.frame > frame);
  if (n < 0) return keys.at(-1)!;
  const a = keys[n - 1],
    b = keys[n],
    t = (frame - a.frame) / (b.frame - a.frame);
  const result: any = {
    ...a,
    frame,
    position: {
      x: a.position.x + (b.position.x - a.position.x) * t,
      y: a.position.y + (b.position.y - a.position.y) * t,
    },
    heading: (a.heading + (((b.heading - a.heading + 540) % 360) - 180) * t + 360) % 360,
  };
  for (const key of ['height', 'pitch', 'fov'])
    if (typeof (a as any)[key] === 'number')
      result[key] = (a as any)[key] + ((b as any)[key] - (a as any)[key]) * t;
  return result;
}
export function sampleShot(spec: ShotExecutionSpec, frame: number) {
  const f = Math.max(0, Math.min(spec.frames - 1, Math.round(frame)));
  const layout = spec.layout?.data;
  const instances = (spec.state?.instances || []).map((i: any) => {
    const path = spec.directing?.paths.find((p) => p.instanceId === i.instanceId);
    const start = spec.state.start.find((p: any) => p.instanceId === i.instanceId);
    const end = spec.state.end.find((p: any) => p.instanceId === i.instanceId);
    const pose = sampleKeys(
      path?.keys ||
        (start
          ? [
              { ...start, frame: 0 },
              { ...(end || start), frame: Math.max(1, spec.frames - 1) },
            ]
          : []),
      f,
    );
    const proxy = spec.directing?.proxies.find((p) => p.instanceId === i.instanceId) || {
      shape: 'box',
      width: 1,
      depth: 1,
      height: 1,
      color: '#83b7ca',
    };
    return { ...i, pose, proxy, position: pose ? worldPoint(pose.position, layout?.space) : null };
  });
  const key = sampleKeys(spec.directing?.camera.keys || [], f);
  const camera =
    key ||
    (spec.camera
      ? {
          ...spec.camera,
          height: spec.camera.optics?.height || 1.6,
          pitch: spec.camera.optics?.pitch || 0,
          fov: spec.camera.optics?.fov || 50,
        }
      : null);
  const barriers = (layout?.barriers || []).map((b: any) => {
    const changes = (spec.directing?.doors || [])
      .filter((d) => d.barrierId === b.id && d.frame <= f)
      .sort((a, b) => a.frame - b.frame);
    return { ...b, open: changes.at(-1)?.open ?? b.open };
  });
  return {
    frame: f,
    instances,
    camera,
    barriers,
    measured: !!layout?.space && layout?.scale !== 'schematic',
  };
}

/** Transform a declared local surface point; never substitute a default proxy or pose. */
export function spatialAnchor(
  spec: ShotExecutionSpec,
  sample: ReturnType<typeof sampleShot>,
  anchorId: string,
) {
  const d = spec.directing && spec.directing.version !== 1 ? spec.directing : null;
  const anchor = d?.staging?.anchors.find((a) => a.id === anchorId);
  const target = sample.instances.find((i: any) => i.instanceId === anchor?.instanceId);
  const proxy = d?.proxies.find((p) => p.instanceId === anchor?.instanceId);
  if (!anchor?.position || !target?.position || !target.pose || !proxy) return null;
  const yaw = (target.pose.heading * Math.PI) / 180;
  const x = (anchor.position.x - 0.5) * proxy.width,
    z = (anchor.position.y - 0.5) * proxy.depth;
  return {
    position: {
      x: target.position.x + x * Math.cos(yaw) - z * Math.sin(yaw),
      y: anchor.position.height,
      z: target.position.z + x * Math.sin(yaw) + z * Math.cos(yaw),
    },
    normalHeading:
      anchor.normalHeading === null ? null : (target.pose.heading + anchor.normalHeading) % 360,
    reach: anchor.reach,
  };
}
/** Project a world point using the same vertical-FOV convention as PerspectiveCamera. */
export function screenPoint(
  point: { x: number; y: number; z: number },
  camera: any,
  space: any,
  aspect: number,
) {
  const c = worldPoint({ ...camera.position, height: camera.height }, space);
  const yaw = (camera.heading * Math.PI) / 180,
    pitch = (camera.pitch * Math.PI) / 180;
  const v = { x: point.x - c.x, y: point.y - c.y, z: point.z - c.z };
  const right = v.x * Math.cos(yaw) + v.z * Math.sin(yaw);
  const forward = v.x * Math.sin(yaw) - v.z * Math.cos(yaw);
  const depth = forward * Math.cos(pitch) + v.y * Math.sin(pitch);
  const up = v.y * Math.cos(pitch) - forward * Math.sin(pitch);
  const scale = Math.tan((camera.fov * Math.PI) / 360);
  return { x: right / (depth * scale * aspect), y: up / (depth * scale), depth };
}
function crosses(a: any, b: any, c: any, d: any) {
  if (Math.hypot(a.x - b.x, a.y - b.y) < 1e-9) return false;
  const cross = (p: any, q: any, r: any) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const on = (p: any, q: any, r: any) =>
    Math.abs(cross(p, q, r)) < 1e-9 &&
    r.x >= Math.min(p.x, q.x) - 1e-9 &&
    r.x <= Math.max(p.x, q.x) + 1e-9 &&
    r.y >= Math.min(p.y, q.y) - 1e-9 &&
    r.y <= Math.max(p.y, q.y) + 1e-9;
  return (
    (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) ||
    on(a, b, c) ||
    on(a, b, d) ||
    on(c, d, a) ||
    on(c, d, b)
  );
}
/** Finite camera ray against a yaw-oriented proxy box; curved proxies use conservative bounds. */
function rayBox(from: any, to: any, center: any, half: any, heading = 0) {
  const yaw = (heading * Math.PI) / 180,
    cos = Math.cos(yaw),
    sin = Math.sin(yaw);
  const local = (p: any) => ({
    x: (p.x - center.x) * cos + (p.z - center.z) * sin,
    y: p.y - center.y,
    z: -(p.x - center.x) * sin + (p.z - center.z) * cos,
  });
  const a = local(from),
    b = local(to);
  let near = 0,
    far = 1;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = b[axis] - a[axis];
    if (Math.abs(delta) < 1e-9) {
      if (Math.abs(a[axis]) > half[axis]) return false;
    } else {
      const t1 = (-half[axis] - a[axis]) / delta,
        t2 = (half[axis] - a[axis]) / delta;
      near = Math.max(near, Math.min(t1, t2));
      far = Math.min(far, Math.max(t1, t2));
      if (near > far) return false;
    }
  }
  return near < 1 - 1e-6 && far > 1e-6;
}
export function spatialIssues(spec: ShotExecutionSpec, aspect = 9 / 16): DirectionIssue[] {
  const directing = spec.directing && spec.directing.version !== 1 ? spec.directing : null;
  const issues: DirectionIssue[] = [];
  const seen = new Set<string>();
  const add = (code: string, message: string, frame: number, evidence?: unknown) => {
    if (seen.has(code)) return;
    seen.add(code);
    issues.push({
      code: `${code}:${spec.shotId}`,
      severity: 'review',
      shotId: spec.shotId,
      field: 'directing',
      message,
      evidence: { frame, detail: evidence },
    });
  };
  if (!spec.layout) return issues;
  if (spec.layout.data.scale === 'schematic') return issues;
  if (directing?.contractRevision === 2 && !spec.layout.data.space) return issues;
  let prior = sampleShot(spec, 0);
  for (let frame = 0; frame < spec.frames; frame++) {
    const sample = sampleShot(spec, frame);
    for (const interaction of directing?.interactions || []) {
      if (interaction.kind === 'observe') continue;
      const event = spec.directing?.events.find((e) => e.id === interaction.eventId);
      if (event && (frame < event.startFrame || frame >= event.endFrame)) continue;
      const anchor = directing?.staging?.anchors.find(
        (a) => a.id === interaction.anchorId && a.instanceId === interaction.targetId,
      );
      const actor = sample.instances.find((i: any) => i.instanceId === interaction.actorId);
      const surface = anchor && spatialAnchor(spec, sample, anchor.id);
      if (!anchor || !surface || !actor?.position) continue;
      const dx = actor.position.x - surface.position.x,
        dz = actor.position.z - surface.position.z;
      if (anchor.reach !== null && Math.hypot(dx, dz) > anchor.reach)
        add(
          `interaction-reach:${interaction.id}`,
          `交互 ${interaction.id} 的代理位置超出已声明的平面操作范围`,
          frame,
          { interactionId: interaction.id, distance: Math.hypot(dx, dz), reach: anchor.reach },
        );
      if (surface.normalHeading !== null) {
        const normal = (surface.normalHeading * Math.PI) / 180;
        if (dx * Math.sin(normal) - dz * Math.cos(normal) < -0.01)
          add(
            `interaction-side:${interaction.id}`,
            `交互 ${interaction.id} 的操作者位于目标表面的背侧`,
            frame,
            { interactionId: interaction.id, anchorId: anchor.id },
          );
      }
    }
    for (const i of sample.instances) {
      if (!i.pose) continue;
      if (
        directing?.contractRevision === 2 &&
        !directing.proxies.some((p) => p.instanceId === i.instanceId)
      )
        continue;
      const last = prior.instances.find((p: any) => p.instanceId === i.instanceId);
      const origin = sample.camera
        ? worldPoint(
            { ...sample.camera.position, height: sample.camera.height },
            spec.layout.data.space,
          )
        : null;
      const target = i.position ? { ...i.position, y: i.proxy.height / 2 } : null;
      for (const b of sample.barriers) {
        if (b.open) continue;
        if (last?.pose && crosses(last.pose.position, i.pose.position, b.start, b.end))
          add(`barrier:${i.instanceId}:${b.id}`, `路径穿过关闭的 ${b.name}`, frame);
        const a = worldPoint(b.start, spec.layout.data.space),
          end = worldPoint(b.end, spec.layout.data.space);
        if (
          origin &&
          target &&
          rayBox(
            origin,
            target,
            { x: (a.x + end.x) / 2, y: b.height / 2, z: (a.z + end.z) / 2 },
            { x: Math.hypot(end.x - a.x, end.z - a.z) / 2, y: b.height / 2, z: b.thickness / 2 },
            (Math.atan2(end.z - a.z, end.x - a.x) * 180) / Math.PI,
          )
        )
          add(
            `occluded:${i.instanceId}:${b.id}`,
            `${i.instanceId} 的中心被代理墙体或门遮挡`,
            frame,
          );
      }
      if (origin && target) {
        const blockers = sample.instances
          .filter((b: any) => b.instanceId !== i.instanceId && b.position)
          .map((b: any) => ({
            id: b.instanceId,
            position: b.position,
            proxy: b.proxy,
            heading: b.pose.heading,
          }));
        for (const m of spec.layout.data.markers || [])
          if (m.kind === 'fixed_object')
            blockers.push({
              id: m.id,
              position: worldPoint(m.position, spec.layout.data.space),
              proxy: { width: 0.6, depth: 0.6, height: 0.8 },
              heading: 0,
            });
        for (const b of blockers) {
          const p = b.proxy,
            radius = Math.min(p.width, p.depth) / 2;
          if (
            rayBox(
              origin,
              target,
              { ...b.position, y: p.height / 2 },
              {
                x: p.shape && p.shape !== 'box' ? radius : p.width / 2,
                y: p.height / 2,
                z: p.shape && p.shape !== 'box' ? radius : p.depth / 2,
              },
              b.heading,
            )
          )
            add(
              `proxy-occluded:${i.instanceId}:${b.id}`,
              `${i.instanceId} 的中心被 ${b.id} 的代理边界遮挡`,
              frame,
            );
        }
      }
      if (sample.camera && i.position) {
        const p = screenPoint(
          { ...i.position, y: i.proxy.height / 2 },
          sample.camera,
          spec.layout.data.space,
          aspect,
        );
        if (p.depth <= 0 || Math.abs(p.x) > 1 || Math.abs(p.y) > 1)
          add(`offscreen:${i.instanceId}`, `${i.instanceId} 的代理中心离开画面`, frame, p);
      }
    }
    prior = sample;
  }
  return issues;
}

/** Reports what was checked, without equating a schematic or an empty report with success. */
export function spatialAssessment(spec: ShotExecutionSpec, aspect = 16 / 9) {
  const directing = spec.directing && spec.directing.version !== 1 ? spec.directing : null;
  const staging = directing?.staging;
  if (staging?.applicability === 'not_applicable')
    return {
      status: 'not_applicable',
      reason: staging.reason,
      issues: [] as DirectionIssue[],
      missing: [] as string[],
    };
  if (!spec.layout)
    return {
      status: 'not_run',
      reason: '尚无空间依据',
      issues: [] as DirectionIssue[],
      missing: ['layout'],
    };
  if (spec.layout.data.scale === 'schematic' || !spec.layout.data.space)
    return {
      status: 'schematic',
      reason: '示意空间只用于构图，不计算精确距离或遮挡结论',
      issues: [] as DirectionIssue[],
      missing: ['measured space'],
    };
  const missing: string[] = [];
  const sample = sampleShot(spec, 0);
  for (const p of directing?.performance || []) {
    for (const id of [p.instanceId, p.attention?.instanceId].filter(Boolean))
      if (!sample.instances.find((i: any) => i.instanceId === id)?.pose)
        missing.push(`${id}: attention position/heading`);
    if (!directing?.proxies.some((v) => v.instanceId === p.instanceId))
      missing.push(`${p.instanceId}: attention proxy`);
    if (p.attention?.anchorId && !spatialAnchor(spec, sample, p.attention.anchorId))
      missing.push(`${p.instanceId}: attention anchor geometry`);
  }
  for (const i of directing?.interactions || []) {
    if (i.kind === 'observe') continue;
    const anchor = staging?.anchors.find((a) => a.id === i.anchorId);
    for (const id of [i.actorId, i.targetId])
      if (!sample.instances.find((p: any) => p.instanceId === id)?.pose)
        missing.push(`${i.id}: ${id} position/heading`);
    if (!anchor?.position || anchor.normalHeading === null || anchor.reach === null)
      missing.push(`${i.id}: anchor geometry`);
    if (!spec.directing?.proxies.some((p) => p.instanceId === i.targetId))
      missing.push(`${i.id}: target proxy`);
  }
  if (!sample.camera) missing.push('camera');
  return {
    status: missing.length ? 'incomplete' : 'checked',
    reason: '代理几何检查只表示设计风险，实际操作与可见性须审看片段',
    missing,
    issues: spatialIssues(spec, aspect),
  };
}
