import { z } from 'zod';
import {
  sceneDesignSchema,
  floorPointSchema,
  mouthVisibilitySchema,
  interactionSchema,
} from './staging-contracts.js';
import { shotCueSchema } from './creation.js';
import { causalEventSchema } from './shot-semantics.js';
import { actionBoundarySchema, seriesRefSchema } from './series.js';

export const pointSchema = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
const vector = pointSchema.extend({ height: z.number().nonnegative().default(0) });
const frame = z.number().int().nonnegative();
export const cameraSchema = z.object({
  height: z.number().positive().default(1.6),
  pitch: z.number().min(-89).max(89).default(0),
  fov: z.number().min(5).max(150).default(50),
});
export const spaceSchema = z.object({
  width: z.number().positive(),
  depth: z.number().positive(),
  height: z.number().positive(),
});
export const barrierSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(['wall', 'door']),
  start: pointSchema,
  end: pointSchema,
  height: z.number().positive(),
  thickness: z.number().positive().default(0.15),
  open: z.boolean().default(false),
  regions: z.array(z.string()).default([]),
});
export const legacyDirectingSchema = z.object({
  version: z.literal(1),
  purpose: z.string().default(''),
  audienceInformation: z.string().default(''),
  performance: z
    .array(
      z.object({
        id: z.string().optional(),
        instanceId: z.string().min(1),
        stimulus: z.string(),
        intention: z.string(),
        reaction: z.string(),
        attention: z
          .object({
            instanceId: z.string().optional(),
            point: vector.optional(),
            anchor: z.string().default(''),
            anchorId: z.string().nullable().optional(),
          })
          .optional(),
        headHeading: z.number().min(0).lt(360).optional(),
      }),
    )
    .default([]),
  camera: z
    .object({
      description: z.string().default(''),
      shotSize: z.string().default(''),
      composition: z.string().default(''),
      motion: z
        .enum(['static', 'pan', 'tilt', 'dolly', 'truck', 'pedestal', 'arc', 'tracking', 'zoom'])
        .default('static'),
      amplitude: z.string().default(''),
      keys: z
        .array(
          z.object({
            frame,
            position: pointSchema,
            heading: z.number().min(0).lt(360),
            ...cameraSchema.shape,
          }),
        )
        .default([]),
    })
    .default({
      description: '',
      shotSize: '',
      composition: '',
      motion: 'static',
      amplitude: '',
      keys: [],
    }),
  paths: z
    .array(
      z.object({
        instanceId: z.string().min(1),
        keys: z
          .array(z.object({ frame, position: pointSchema, heading: z.number().min(0).lt(360) }))
          .min(2),
      }),
    )
    .default([]),
  proxies: z
    .array(
      z.object({
        instanceId: z.string().min(1),
        shape: z.enum(['box', 'capsule', 'cylinder']).default('box'),
        width: z.number().positive(),
        depth: z.number().positive(),
        height: z.number().positive(),
        color: z
          .string()
          .regex(/^#[0-9a-fA-F]{6}$/)
          .default('#83b7ca'),
      }),
    )
    .default([]),
  doors: z.array(z.object({ barrierId: z.string(), frame, open: z.boolean() })).default([]),
  transition: z
    .object({
      kind: z
        .enum(['continuous', 'ellipsis', 'location_change', 'flashback'])
        .default('continuous'),
      reason: z.string().default(''),
      changes: z
        .array(
          z.object({
            objectId: z.string(),
            property: z.enum(['position', 'heading', 'relationship', 'door']),
            reason: z.string().min(1),
          }),
        )
        .default([]),
    })
    .default({ kind: 'continuous', reason: '', changes: [] }),
  axis: z
    .object({ from: pointSchema, to: pointSchema, crossingReason: z.string().default('') })
    .optional(),
  sound: z
    .object({
      dialogue: z
        .array(
          z.object({
            id: z.string().optional(),
            instanceId: z.string(),
            language: z.string(),
            text: z.string(),
            voice: z.string().default(''),
            delivery: z.enum(['onscreen', 'offscreen', 'voiceover']).optional(),
            mouth: mouthVisibilitySchema.optional(),
          }),
        )
        .default([]),
      continuation: z.string().optional(),
      environment: z.string().default(''),
      actions: z.string().default(''),
      music: z.string().default('N/A'),
    })
    .default({ dialogue: [], environment: '', actions: '', music: 'N/A' }),
  effects: z
    .array(
      z.object({
        source: z.string(),
        carrier: z.string(),
        change: z.string(),
        target: z.string(),
        visibleResult: z.string(),
      }),
    )
    .default([]),
  events: z
    .array(
      z.object({
        id: z.string().min(1),
        description: z.string().min(1),
        startFrame: frame,
        endFrame: frame,
        required: z.boolean().default(true),
        inspection: z.enum(['frame', 'motion', 'audio']).default('motion'),
      }),
    )
    .default([]),
  // Authored and reviewed executable wording; preview never asks an LLM to fill it.
  execution: z
    .object({
      action: z.string().default(''),
      visualTreatment: z.string().optional(),
      retention: z.array(z.string()).default([]),
      visibleSpace: z.string().optional(),
      retentionBindings: z
        .array(
          z.object({
            target: z.string().min(1),
            preserve: z.array(z.string()),
            allow: z.array(z.string()),
            background: z.enum(['inherit', 'exclude', 'specified']),
          }),
        )
        .optional(),
    })
    .default({ action: '', retention: [] }),
});
export const directingV2Schema = legacyDirectingSchema.extend({
  version: z.literal(2),
  contractRevision: z.literal(2).optional(),
  authoringSource: z.object({ id: z.string(), revision: z.number().int().positive() }).optional(),
  audienceFocus: z.string().optional(),
  cutReason: z.string().optional(),
  staging: z
    .object({
      applicability: z.enum(['spatial', 'not_applicable']),
      scale: z.enum(['schematic', 'measured']),
      reason: z.string(),
      entry: z.array(
        z.object({
          instanceId: z.string(),
          position: floorPointSchema.nullable(),
          heading: z.number().min(0).lt(360).nullable(),
        }),
      ),
      exit: z.array(
        z.object({
          instanceId: z.string(),
          position: floorPointSchema.nullable(),
          heading: z.number().min(0).lt(360).nullable(),
        }),
      ),
      anchors: z.array(
        sceneDesignSchema.shape.anchors.element
          .omit({ subjectKey: true })
          .extend({ instanceId: z.string() }),
      ),
    })
    .optional(),
  interactions: z
    .array(
      interactionSchema
        .omit({ actorKey: true, targetKey: true })
        .extend({ actorId: z.string(), targetId: z.string() }),
    )
    .optional(),
  // Preserve authored location anchors independently from the old region-only relation field.
  locations: z
    .object({
      start: z.array(
        z.object({
          objectId: z.string(),
          targetId: z.string(),
          anchor: z.string(),
          anchorId: z.string().nullable(),
        }),
      ),
      end: z.array(
        z.object({
          objectId: z.string(),
          targetId: z.string(),
          anchor: z.string(),
          anchorId: z.string().nullable(),
        }),
      ),
    })
    .optional(),
  cues: z.array(shotCueSchema).optional(),
  transition: legacyDirectingSchema.shape.transition
    .unwrap()
    .extend({
      changes: z
        .array(
          z.object({
            objectId: z.string(),
            property: z.string().min(1),
            reason: z.string().min(1),
          }),
        )
        .default([]),
    })
    .default({ kind: 'continuous', reason: '', changes: [] }),
  sound: legacyDirectingSchema.shape.sound
    .unwrap()
    .extend({
      checks: z
        .array(
          z.object({
            id: z.string().min(1),
            kind: z.enum(['no_speech', 'action', 'environment', 'continuation']),
            description: z.string().min(1),
          }),
        )
        .default([]),
    })
    .default({ dialogue: [], environment: '', actions: '', music: 'N/A', checks: [] }),
  presence: z.object({ visible: z.array(z.string()), audible: z.array(z.string()).default([]) }),
  events: z.array(causalEventSchema).default([]),
  information: z
    .array(
      z.object({
        informationId: z.string().min(1),
        eventId: z.string().min(1),
        purpose: z.enum(['reveal', 'withhold', 'verify']),
      }),
    )
    .default([]),
});
export const directingV3Schema = directingV2Schema.extend({
  version: z.literal(3),
  carry: z
    .object({
      attributes: z
        .array(z.object({ instanceId: z.string(), key: z.string(), reason: z.string() }))
        .default([]),
      relationObjectIds: z.array(z.string()).default([]),
      startActions: z.array(actionBoundarySchema).default([]),
      endActions: z.array(actionBoundarySchema).default([]),
    })
    .default({ attributes: [], relationObjectIds: [], startActions: [], endActions: [] }),
  sound: directingV2Schema.shape.sound
    .unwrap()
    .extend({
      dialogue: z
        .array(
          legacyDirectingSchema.shape.sound
            .unwrap()
            .shape.dialogue.unwrap()
            .element.extend({
              id: z.string().min(1),
              voiceProfile: seriesRefSchema,
            }),
        )
        .default([]),
    })
    .default({ dialogue: [], environment: '', actions: '', music: 'N/A', checks: [] }),
});
export const directingSchema = z.discriminatedUnion('version', [
  legacyDirectingSchema,
  directingV2Schema,
  directingV3Schema,
]);
export type Directing = z.infer<typeof directingSchema>;
export interface DirectionIssue {
  code: string;
  severity: 'blocking' | 'review' | 'info';
  message: string;
  shotId: string;
  field: string;
  evidence?: unknown;
}
export interface ShotExecutionSpec {
  version: 1 | 2 | 3;
  shotId: string;
  frames: number;
  directing: Directing | null;
  state: any;
  layout: any;
  camera: any;
  cameraIntent: string;
  issues: DirectionIssue[];
  trace: { field: string; consumers: string[]; status: 'used' | 'unsupported' }[];
}

export function prepareShot(shot: any, layouts: any[] = []): ShotExecutionSpec {
  const parsed = shot.directing ? directingSchema.safeParse(shot.directing) : null;
  const d = parsed?.success ? parsed.data : null;
  const frames = Math.round(shot.duration * 24);
  const layout = layouts.find(
    (r) => r.id === shot.state?.layout?.id && r.revision === shot.state?.layout?.revision,
  );
  const camera = layout?.data.cameras.find((c: any) => c.id === shot.state?.cameraId);
  const issues: DirectionIssue[] = [];
  const issue = (
    code: string,
    message: string,
    field: string,
    severity: DirectionIssue['severity'] = 'blocking',
  ) => issues.push({ code: `${code}:${shot.id}`, message, field, severity, shotId: shot.id });
  if (parsed && !parsed.success)
    for (const problem of parsed.error.issues)
      issue(
        'contract-' + problem.path.join('.'),
        problem.message,
        'directing.' + problem.path.join('.'),
      );
  const ids = new Set<string>(shot.state?.instances.map((i: any) => i.instanceId) || []);
  if (d) {
    for (const [field, values] of [
      ['paths', d.paths],
      ['performance', d.performance],
      ['proxies', d.proxies],
    ] as const) {
      if (
        new Set(values.map((v: any) => (field === 'performance' && v.id ? v.id : v.instanceId)))
          .size !== values.length
      )
        issue(`duplicate-${field}`, '同一实例不能重复配置', `directing.${field}`);
      for (const v of values)
        if (!ids.has(v.instanceId))
          issue(`instance-${field}`, `未出场实例 ${v.instanceId}`, `directing.${field}`);
    }
    for (const [field, keys] of [
      ...d.paths.map((p) => [`paths.${p.instanceId}`, p.keys] as const),
      ['camera.keys', d.camera.keys] as const,
    ]) {
      if (keys.some((k, n) => k.frame >= frames || (n > 0 && k.frame <= keys[n - 1].frame)))
        issue(`keys-${field}`, '时间关键点必须递增且处于镜头帧范围内', `directing.${field}`);
    }
    for (const path of d.paths) {
      if (!layout) issue('path-layout', '实例路径需要固定布局', 'directing.paths');
      for (const [pose, key, edge] of [
        [
          shot.state?.start.find((v: any) => v.instanceId === path.instanceId),
          path.keys[0],
          'start',
        ],
        [
          shot.state?.end.find((v: any) => v.instanceId === path.instanceId),
          path.keys.at(-1),
          'end',
        ],
      ] as const) {
        if (
          pose &&
          key &&
          (Math.hypot(pose.position.x - key.position.x, pose.position.y - key.position.y) > 1e-6 ||
            Math.abs(((pose.heading - key.heading + 540) % 360) - 180) > 1e-6)
        )
          issue(`path-${edge}-${path.instanceId}`, '路径端点与镜头预期状态冲突', 'directing.paths');
      }
    }
    if (d.axis && Math.hypot(d.axis.to.x - d.axis.from.x, d.axis.to.y - d.axis.from.y) < 1e-6)
      issue('axis-degenerate', '轴线两个端点不能相同', 'directing.axis');
    if (new Set(d.doors.map((v) => `${v.barrierId}:${v.frame}`)).size !== d.doors.length)
      issue('door-conflict', '同一门在同帧有重复状态', 'directing.doors');
    for (const p of d.performance) {
      if (p.attention && Number(!!p.attention.instanceId) + Number(!!p.attention.point) !== 1)
        issue('attention', '关注目标必须唯一选择实例或空间点', 'directing.performance');
      if (p.attention?.instanceId && !ids.has(p.attention.instanceId))
        issue('attention-target', '关注实例不在本镜头', 'directing.performance');
    }
    for (const event of d.events)
      if (event.endFrame <= event.startFrame || event.endFrame > frames)
        issue('event-range', '事件使用镜头内左闭右开帧区间', 'directing.events');
    if (new Set(d.events.map((e) => e.id)).size !== d.events.length)
      issue('event-id', '事件 ID 重复', 'directing.events');
    for (const door of d.doors)
      if (
        door.frame >= frames ||
        !layout?.data.barriers?.some((b: any) => b.id === door.barrierId && b.kind === 'door')
      )
        issue('door', '门状态引用或时间无效', 'directing.doors');
    if (d.camera.keys.length && !layout)
      issue('camera-layout', '相机路径需要固定布局', 'directing.camera.keys');
    if (d.transition.kind !== 'continuous' && !d.transition.reason.trim())
      issue('transition', '非连续剪辑需要明确原因', 'directing.transition');
    if (!d.execution.action.trim())
      issue('wording', '缺少审核后的执行动作正文', 'directing.execution.action', 'review');
    for (const line of d.sound.dialogue)
      if (!ids.has(line.instanceId))
        issue('speaker', '说话实例不在本镜头', 'directing.sound.dialogue');
  }
  const trace: ShotExecutionSpec['trace'] = d
    ? Object.keys(d)
        .filter((k) => k !== 'version')
        .map((field) => ({
          field: `directing.${field}`,
          consumers: ['paths', 'camera', 'doors', 'performance'].includes(field)
            ? ['previs', 'prompt', 'review']
            : field === 'proxies'
              ? ['previs', 'review']
              : ['purpose', 'audienceInformation', 'events'].includes(field)
                ? ['review']
                : ['prompt', 'review'],
          status: 'used',
        }))
    : [];
  for (const key of Object.keys(shot.state?.photography || {})) {
    trace.push({ field: `state.photography.${key}`, consumers: [], status: 'unsupported' });
    issue(
      `legacy-photography-${key}`,
      `旧摄影字段 ${key} 未参与执行，请转换为导演设计`,
      `state.photography.${key}`,
      'review',
    );
  }
  if (shot.state?.relationKnowledge)
    trace.push({
      field: 'state.relationKnowledge',
      consumers: ['continuity', 'review'],
      status: 'used',
    });
  return {
    version: d?.version || 1,
    shotId: shot.id,
    frames,
    directing: d,
    state: shot.state || null,
    layout: layout || null,
    camera: camera || null,
    cameraIntent: shot.state?.cameraIntent || '',
    issues,
    trace,
  };
}

/** Deterministic cross-shot checks, independent of explanatory camera prose. */
export function continuityIssues(shots: any[], layouts: any[] = []): DirectionIssue[] {
  const issues: DirectionIssue[] = [];
  const side = (p: any, a: any) =>
    (a.to.x - a.from.x) * (p.y - a.from.y) - (a.to.y - a.from.y) * (p.x - a.from.x);
  for (let n = 1; n < shots.length; n++) {
    const current = shots[n],
      before = shots[n - 1],
      s = current.state,
      p = before.state;
    if (!s || !p) continue;
    const t = current.directing?.transition;
    const report = (code: string, message: string, field: string, evidence?: unknown) =>
      issues.push({
        code: `${code}:${current.id}`,
        message,
        field,
        evidence,
        severity: 'review',
        shotId: current.id,
      });
    const explains = (objectId: string, property: string) =>
      t?.changes?.some(
        (c: any) => c.objectId === objectId && c.property === property && c.reason.trim(),
      );
    const continuous = !t || t.kind === 'continuous';
    if (!continuous && !(current.directing?.version >= 2)) continue;
    if (current.directing?.version >= 2) {
      for (const value of s.attributes?.start || []) {
        const previous = p.attributes?.end?.find(
          (f: any) => f.instanceId === value.instanceId && f.key === value.key,
        );
        if (
          previous &&
          (previous.status !== value.status || previous.value !== value.value) &&
          !explains(value.instanceId, `attribute:${value.key}`)
        )
          report(
            `attribute:${value.instanceId}:${value.key}`,
            '关键属性变化需要逐项说明',
            'state.attributes.start',
            { previous, current: value },
          );
      }
    }
    if (
      continuous &&
      s.layout &&
      p.layout &&
      (s.layout.id !== p.layout.id || s.layout.revision !== p.layout.revision)
    )
      report('layout-boundary', '连续镜头引用不同布局版本，需要确认空间对应关系', 'state.layout', {
        previous: p.layout,
        current: s.layout,
      });
    if (
      continuous &&
      s.layout &&
      p.layout &&
      s.layout.id === p.layout.id &&
      s.layout.revision === p.layout.revision
    ) {
      for (const pose of s.start) {
        const last = p.end.find((v: any) => v.instanceId === pose.instanceId);
        if (
          last &&
          Math.hypot(last.position.x - pose.position.x, last.position.y - pose.position.y) > 1e-6 &&
          !explains(pose.instanceId, 'position')
        )
          report(`position:${pose.instanceId}`, '连续镜头位置变化未说明', 'state.start', {
            previous: last,
            current: pose,
          });
        if (
          last &&
          Math.abs(((pose.heading - last.heading + 540) % 360) - 180) > 1e-6 &&
          !explains(pose.instanceId, 'heading')
        )
          report(`heading:${pose.instanceId}`, '连续镜头身体朝向变化未说明', 'state.start');
      }
      const a = current.directing?.axis || before.directing?.axis;
      const left = prepareShot(before, layouts).camera,
        right = prepareShot(current, layouts).camera;
      if (
        a &&
        left &&
        right &&
        side(left.position, a) * side(right.position, a) < 0 &&
        !current.directing?.axis?.crossingReason?.trim()
      )
        report('axis', '相机跨越已声明轴线，需要明确摄影意图', 'directing.axis');
    }
    const rel = (values: any[]) => values.filter((r) => r.type !== 'locatedIn');
    for (const objectId of new Set(
      [...rel(p.endRelations), ...rel(s.startRelations)].map((r) => r.objectId),
    )) {
      if (
        (p.relationKnowledge && !p.relationKnowledge.end.includes(objectId)) ||
        (s.relationKnowledge && !s.relationKnowledge.start.includes(objectId))
      )
        continue;
      const normalize = (values: any[]) =>
        JSON.stringify(
          rel(values)
            .filter((r) => r.objectId === objectId)
            .map((r) => [r.type, r.targetId, r.anchor, r.quantity])
            .sort(),
        );
      if (
        normalize(p.endRelations) !== normalize(s.startRelations) &&
        !explains(objectId, 'relationship')
      )
        report(
          `handoff:${objectId}`,
          '连续镜头持物归属、位置或数量变化未说明',
          'state.startRelations',
        );
    }
    const lastDoors = new Map<string, boolean>();
    for (const d of before.directing?.doors || []) lastDoors.set(d.barrierId, d.open);
    for (const d of current.directing?.doors || [])
      if (
        d.frame === 0 &&
        lastDoors.has(d.barrierId) &&
        lastDoors.get(d.barrierId) !== d.open &&
        !explains(d.barrierId, 'door')
      )
        report(`door:${d.barrierId}`, '连续镜头门状态变化未说明', 'directing.doors');
  }
  return issues;
}

export function eventCoverageIssues(
  events: { id: string; required: boolean; inspection: string }[],
  evidence: any[],
  start: number,
  end: number,
) {
  return events
    .filter((e) => e.required)
    .flatMap((e) => {
      const item = evidence.find((v) => v.eventId === e.id && v.status === 'pass');
      if (
        !item ||
        item.startFrame < start ||
        item.endFrame > end ||
        item.endFrame <= item.startFrame ||
        item.inspection !== e.inspection
      )
        return [`事件 ${e.id} 没有在采用区间内通过对应类型的审核`];
      return [];
    });
}
