import { z } from 'zod';
import { voiceApplicationSchema } from './speech.js';
import { stateFactSchema } from './shot-semantics.js';
import { deliveryCanvasSchema } from './production-plan.js';

export const factDependencySchema = z
  .object({
    mode: z.enum(['previous', 'independent']),
    reason: z.string().trim().min(1),
  })
  .strict();
export const seasonStorySchema = z
  .object({
    goal: z.string().min(1),
    conflict: z.string().min(1),
    ending: z.string().min(1),
    characters: z.array(
      z
        .object({
          key: z.string().min(1),
          name: z.string().min(1),
          start: z.string(),
          change: z.string(),
          end: z.string(),
        })
        .strict(),
    ),
    information: z.array(
      z
        .object({
          id: z.string().min(1),
          statement: z.string().min(1),
          plantEpisode: z.number().int().positive(),
          revealEpisode: z.number().int().positive(),
        })
        .strict(),
    ),
  })
  .strict();

export const seriesRefSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
});
export const runtimeSchema = z.object({
  targetFrames: z.number().int().positive().default(28800),
  toleranceFrames: z.number().int().nonnegative().default(0),
});
export const episodeSlotSchema = z.object({
  id: z.string().min(1),
  title: z.string().default(''),
  episodeId: z.string().optional(),
  runtime: runtimeSchema.optional(),
  active: z.boolean().default(true),
  question: z.string().default(''),
  conflict: z.string().default(''),
  choice: z.string().default(''),
  outcome: z.string().default(''),
  openQuestions: z.array(z.string()).default([]),
});
export const seriesInformationSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['world_fact', 'character_knowledge', 'character_belief', 'audience_knowledge']),
  statement: z.string().min(1),
  instanceIds: z.array(z.string()).default([]),
  afterIds: z.array(z.string()).default([]),
  conflictsWith: z.array(z.string()).default([]),
  milestones: z
    .array(
      z.object({
        slotId: z.string(),
        purpose: z.enum(['plant', 'mislead', 'reveal', 'payoff']),
        description: z.string(),
      }),
    )
    .default([]),
});
export const seriesProductionSchema = z.object({
  version: z.literal(1),
  story: seasonStorySchema.optional(),
  proposal: seriesRefSchema.optional(),
  profile: seriesRefSchema,
  sharedReferences: z.array(seriesRefSchema).default([]),
  voices: z.array(z.object({ instanceId: z.string(), profile: seriesRefSchema })).default([]),
  targetEpisodes: z.number().int().positive().default(20),
  runtime: runtimeSchema.default({ targetFrames: 28800, toleranceFrames: 0 }),
  canvas: deliveryCanvasSchema.optional(),
  factDependency: factDependencySchema.optional(),
  slots: z.array(episodeSlotSchema).default([]),
  chronology: z
    .object({
      mode: z.enum(['standalone', 'continuation', 'branch']),
      fromCanon: seriesRefSchema.optional(),
    })
    .refine(
      (v) => (v.mode === 'standalone' ? !v.fromCanon : !!v.fromCanon),
      '续作和分支必须固定前作 Canon',
    )
    .default({ mode: 'standalone' }),
  information: z.array(seriesInformationSchema).default([]),
  actionDefinitions: z
    .array(
      z
        .object({ id: z.string().min(1), phases: z.array(z.string().min(1)).min(1) })
        .refine((a) => new Set(a.phases).size === a.phases.length, '动作阶段重复'),
    )
    .default([]),
  characterBeats: z
    .array(
      z.object({
        id: z.string(),
        instanceId: z.string(),
        slotId: z.string(),
        prerequisite: z.string(),
        change: z.string(),
        consequence: z.string(),
      }),
    )
    .default([]),
  authoredEvents: z
    .array(
      z.object({
        id: z.string(),
        slotId: z.string(),
        statement: z.string(),
        offscreen: z.boolean(),
        approved: z.boolean().default(false),
      }),
    )
    .default([]),
});
export const episodeProductionSchema = z.object({
  version: z.literal(1),
  slotId: z.string().min(1),
  runtime: runtimeSchema.optional(),
  canvas: deliveryCanvasSchema.optional(),
  factDependency: factDependencySchema.optional(),
  overrides: z
    .record(z.enum(['visual', 'world', 'narrative', 'direction', 'mixedMedia']), z.string())
    .optional(),
  overrideReason: z.string().default(''),
  voices: z
    .array(
      z.object({ instanceId: z.string(), profile: seriesRefSchema, reason: z.string().min(1) }),
    )
    .default([]),
  information: z
    .array(z.object({ informationId: z.string(), shotIds: z.array(z.string()).min(1) }))
    .default([]),
});
const legacyVoiceProfileSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  entity: seriesRefSchema,
  language: z.string().min(1),
  pronunciation: z.string().default(''),
  timbre: z.string().min(1),
  performance: z.string().default(''),
  samples: z
    .array(
      z
        .object({
          asset: seriesRefSchema,
          in: z.number().nonnegative(),
          out: z.number().positive(),
          inspected: z.literal(true),
          notes: z.string().min(1),
        })
        .refine((v) => v.out > v.in, '声音参考区间无效'),
    )
    .min(1),
});
export const voiceProfileSchema = z.union([legacyVoiceProfileSchema, voiceApplicationSchema]);
export const dialogueTakeSchema = z
  .object({
    version: z.literal(1),
    episode: seriesRefSchema,
    shotId: z.string(),
    lineId: z.string(),
    instanceId: z.string(),
    voice: seriesRefSchema,
    asset: seriesRefSchema,
    in: z.number().nonnegative(),
    out: z.number().positive(),
    actualText: z.string(),
    source: z.enum(['imported', 'h3_extracted', 'tts']),
    synthesisJobId: z.string().optional(),
    sampleRange: z
      .object({
        sampleRate: z.number().int().positive(),
        inSample: z.number().int().nonnegative(),
        outSample: z.number().int().positive(),
      })
      .optional(),
    sourceVideo: seriesRefSchema.optional(),
    listened: z.boolean().default(false),
    voiceMatch: z.boolean().nullable().default(null),
    conclusion: z.string().default(''),
  })
  .refine((v) => v.out > v.in, '对白采用范围无效');
export const factSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('media'),
    selection: seriesRefSchema,
    evidenceIds: z.array(z.string()).min(1),
  }),
  z.object({
    kind: z.literal('offscreen'),
    series: seriesRefSchema,
    eventId: z.string(),
    reason: z.string().min(1),
  }),
  z.object({ kind: z.literal('baseline'), reference: seriesRefSchema, reason: z.string().min(1) }),
]);
export const canonFactV3Schema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  instanceIds: z.array(z.string()).default([]),
  kind: z.enum(['world_fact', 'character_knowledge', 'character_belief', 'audience_knowledge']),
  operation: z.enum(['add', 'change', 'retract', 'retain']),
  replaces: z.string().optional(),
  informationId: z.string().optional(),
  informationStage: z.enum(['plant', 'mislead', 'reveal', 'payoff']).optional(),
  attribute: stateFactSchema.optional(),
  effective: z.object({ slotId: z.string(), sceneId: z.string().optional() }),
  source: factSourceSchema,
});
export const actionBoundarySchema = z.object({
  id: z.string().min(1),
  instanceId: z.string().min(1),
  phase: z.string().min(1),
  unfinished: z.boolean().default(false),
  direction: z.string().default(''),
  attention: z.string().default(''),
  next: z.string().default(''),
});
// Shared authoring/observation validation: a phase is a finite authored value,
// or one of the three lifecycle phases of an explicitly referenced event.
export function actionPhaseIssues(
  actions: any[],
  definitions: { id: string; phases: string[] }[],
  events: { id: string }[],
) {
  return actions.flatMap((a) => {
    const phases =
      definitions.find((d) => d.id === a.id)?.phases ||
      (events.some((e) => e.id === a.id) ? ['not_started', 'in_progress', 'completed'] : []);
    return phases.includes(a.phase)
      ? []
      : [`动作 ${a.id} 的阶段 ${a.phase} 未在系列有限阶段或当前事件中声明`];
  });
}
export const boundaryWindowSchema = z
  .object({
    side: z.enum(['start', 'end']),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
    inspection: z.enum(['motion', 'audio']),
    status: z.enum(['pass', 'issues', 'unknown']),
    actions: z.array(actionBoundarySchema).default([]),
    appearance: z.string().default(''),
    sound: z.string().default(''),
    notes: z.string().min(1),
  })
  .refine((v) => v.endFrame - v.startFrame >= 2, '边界运动／听审需要至少两帧的实际区间');

export const assemblyDimensions = [
  'identity',
  'state',
  'action',
  'space',
  'dialogue',
  'sound',
  'narrative',
] as const;
export const assemblyReviewSchema = z
  .object({
    version: z.literal(1),
    edl: seriesRefSchema,
    scope: z.enum(['join', 'scene', 'episode']),
    key: z.string(),
    digest: z.string().min(1),
    exportAsset: seriesRefSchema.optional(),
    presentedEvidence: z
      .array(z.object({ selection: seriesRefSchema, evidenceId: z.string().min(1) }).strict())
      .optional(),
    dimensions: z.record(
      z.enum(assemblyDimensions),
      z.enum(['pass', 'issues', 'not_applicable', 'unreviewed']),
    ),
    reasons: z.record(z.string(), z.string()).default({}),
    watched: z.literal(true),
    listened: z.literal(true),
    conclusion: z.string().min(1),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
  })
  .refine((v) => v.endFrame > v.startFrame, '装配审核区间无效');

export type SeriesProduction = z.infer<typeof seriesProductionSchema>;
