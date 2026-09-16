import { creativeModuleSchema } from './creative-modules.js';
import { cameraSchema, spaceSchema, barrierSchema } from './directing.js';
import { z } from 'zod';
import { mouthObservationFields } from './mouth-review.js';
import { referenceCoverageSchema } from './staging-contracts.js';
import { attributeDefinitionSchema, stateFactSchema, observationSchema } from './shot-semantics.js';
import {
  voiceProfileSchema,
  boundaryWindowSchema,
  canonFactV3Schema,
  actionBoundarySchema,
} from './series.js';

export const versionRef = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
});
export type VersionRef = z.infer<typeof versionRef>;
export const viewTypes = [
  'front',
  'left',
  'right',
  'back',
  'three_quarter',
  'top',
  'detail',
  'custom',
] as const;
export const entitySchema = z.object({
  name: z.string().trim().min(1),
  type: z.enum(['character', 'object', 'environment', 'style']),
  subtype: z.string().default(''),
  description: z.string().default(''),
  fixedFeatures: z.array(z.string()).default([]),
  allowedChanges: z.array(z.string()).default([]),
  attributes: z.array(attributeDefinitionSchema).optional(),
  anchors: z.array(z.string().min(1)).default([]),
  instances: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) })).default([]),
});
export const appearanceSchema = z.object({
  name: z.string().min(1),
  entity: versionRef,
  description: z.string(),
  features: z.record(z.string(), z.string()).default({}),
});
export const relationSchema = z.object({
  objectId: z.string().min(1),
  type: z.enum(['heldBy', 'attachedTo', 'containedIn', 'locatedIn']),
  targetId: z.string().min(1),
  anchor: z.string().default(''),
  quantity: z.number().int().positive().default(1),
  maxQuantity: z.number().int().positive().default(1),
  confirmed: z.boolean().default(false),
});
export const packSchema = z.object({
  name: z.string().min(1),
  entity: versionRef,
  appearance: versionRef.nullable().default(null),
  views: z
    .array(
      z.object({
        id: z.string().min(1),
        asset: versionRef,
        view: z.enum(viewTypes),
        label: z.string().default(''),
        features: z.array(z.string()).default([]),
        scope: z.string().default('identity'),
        inheritBackground: z.boolean().default(false),
        overviewOnly: z.boolean().default(false),
      }),
    )
    .min(1),
  relations: z.array(relationSchema).default([]),
  notes: z.string().default(''),
});
export const productionSchema = z.object({
  name: z.string().min(1),
  entity: versionRef,
  appearance: versionRef.nullable().default(null),
  references: z.array(versionRef).default([]),
  requirements: z.string().min(1),
  views: z
    .array(z.object({ id: z.string().min(1), view: z.enum(viewTypes), instruction: z.string() }))
    .min(1),
  relations: z.array(relationSchema).default([]),
});
const point = z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) });
export const layoutSchema = z.object({
  name: z.string().min(1),
  environment: versionRef,
  space: spaceSchema.optional(),
  scale: z.enum(['schematic', 'measured']).optional(),
  creationSource: z.object({ result: versionRef, sceneDesignId: z.string().min(1) }).optional(),
  barriers: z.array(barrierSchema).optional(),
  image: versionRef.nullable().default(null),
  regions: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        x: z.number().min(0).max(1),
        y: z.number().min(0).max(1),
        width: z.number().positive().max(1),
        height: z.number().positive().max(1),
      }),
    )
    .default([]),
  markers: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        kind: z.enum(['entrance', 'window', 'fixed_object']),
        position: point,
      }),
    )
    .default([]),
  cameras: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string(),
        position: point,
        heading: z.number().min(0).lt(360),
        framing: z.string().default(''),
        optics: cameraSchema.optional(),
      }),
    )
    .default([]),
});
const poseSchema = z.object({
  instanceId: z.string().min(1),
  position: point,
  heading: z.number().min(0).lt(360),
  phase: z.string().default(''),
  regionId: z.string().default(''),
});
export const shotStateSchema = z.object({
  layout: versionRef.nullable().default(null),
  cameraId: z.string().default(''),
  instances: z
    .array(
      z.object({
        instanceId: z.string().min(1),
        entity: versionRef,
        appearance: versionRef.nullable().default(null),
        pack: versionRef.nullable().default(null),
      }),
    )
    .default([]),
  start: z.array(poseSchema).default([]),
  end: z.array(poseSchema).default([]),
  startRelations: z.array(relationSchema).default([]),
  endRelations: z.array(relationSchema).default([]),
  relationKnowledge: z.object({ start: z.array(z.string()), end: z.array(z.string()) }).optional(),
  action: z.string().default(''),
  requiredViews: z
    .array(z.object({ instanceId: z.string(), view: z.enum(viewTypes), reason: z.string() }))
    .default([]),
  cameraIntent: z.string().default(''),
  allowAxisCrossing: z.boolean().default(false),
  confirmed: z.boolean().default(false),
  photography: z.record(z.string(), z.string()).default({}),
  attributes: z
    .object({ start: z.array(stateFactSchema), end: z.array(stateFactSchema) })
    .optional(),
});
export const referencePlanSchema = z.object({
  episodeId: z.string(),
  segmentId: z.string(),
  name: z.string().min(1),
  textIdentityInstanceIds: z.array(z.string().min(1)).default([]),
  bindings: z
    .array(
      z.object({
        id: z.string().min(1),
        asset: versionRef,
        instanceIds: z.array(z.string()).default([]),
        pack: versionRef.nullable().default(null),
        view: z.enum(viewTypes).default('front'),
        role: z.enum(['identity', 'scene', 'prop', 'style']),
        priority: z.number().int().min(0).max(4),
        required: z.boolean().default(true),
        reason: z.string().min(1),
        retain: z.array(z.string()).default([]),
        allow: z.array(z.string()).default([]),
        inheritBackground: z.boolean().default(false),
        usage: z
          .object({
            purpose: z.enum([
              'identity',
              'appearance',
              'environment',
              'composition',
              'action_start',
              'action_end',
              'motion',
              'sound',
              'style',
            ]),
            shotIds: z.array(z.string()).default([]),
            preserve: z.array(z.string()).default([]),
            allow: z.array(z.string()).default([]),
            reviewed: z.boolean().default(false),
            coverage: z.array(referenceCoverageSchema).optional(),
            depictedState: z.array(stateFactSchema).default([]),
            stateException: z.string().default(''),
          })
          .optional(),
      }),
    )
    .default([]),
  guides: z
    .array(
      z.object({
        bindingId: z.string(),
        frameIndex: z.number().int().min(-1),
        instruction: z.string().default(''),
      }),
    )
    .default([]),
  acknowledgedRisks: z.array(z.string()).default([]),
});
export const reviewDimensions = ['identity', 'props', 'space', 'action', 'style', 'audio'] as const;
export const reviewSchema = z.object({
  jobId: z.string(),
  video: versionRef,
  in: z.number().nonnegative(),
  out: z.number().positive(),
  dimensions: z.record(
    z.enum(reviewDimensions),
    z.enum(['pass', 'issues', 'not_applicable', 'unreviewed']),
  ),
  issues: z
    .array(
      z.object({
        category: z.enum(reviewDimensions),
        severity: z.enum(['note', 'warning', 'blocking']),
        description: z.string().min(1),
        frameIndex: z.number().int().nonnegative(),
        evidence: versionRef.nullable().default(null),
        shotId: z.string().optional(),
        interactionId: z.string().optional(),
        eventId: z.string().optional(),
        lineId: z.string().optional(),
      }),
    )
    .default([]),
  eventEvidence: z
    .array(
      z.object({
        eventId: z.string(),
        shotId: z.string(),
        status: z.enum(['pass', 'issues', 'unreviewed']),
        inspection: z.enum(['frame', 'motion', 'audio']),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        notes: z.string().default(''),
        observed: z.enum(['occurred', 'absent', 'unknown']).optional(),
      }),
    )
    .optional(),
  notes: z.string().default(''),
  observations: z.array(observationSchema).optional(),
  relationObservations: z
    .array(
      z.object({
        id: z.string().min(1),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        objectIds: z.array(z.string()).min(1),
        relations: z.array(relationSchema),
        inspected: z.literal(true),
        notes: z.string().default(''),
      }),
    )
    .optional(),
  audioEvidence: z
    .array(
      z.object({
        shotId: z.string(),
        requirementId: z.string(),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        status: z.enum(['pass', 'issues', 'unreviewed']),
        inspection: z.literal('audio'),
        speakerId: z.string().default(''),
        text: z.string().default(''),
        voicePresent: z.boolean().optional(),
        lipSyncReviewed: z.boolean().optional(),
        ...mouthObservationFields,
        notes: z.string().default(''),
      }),
    )
    .optional(),
  cueEvidence: z
    .array(
      z.object({
        shotId: z.string(),
        cueId: z.string(),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        inspection: z.enum(['motion', 'audio']),
        status: z.enum(['pass', 'issues', 'unreviewed']),
        notes: z.string().default(''),
      }),
    )
    .optional(),
  interactionEvidence: z
    .array(
      z.object({
        shotId: z.string(),
        interactionId: z.string(),
        startFrame: z.number().int().nonnegative(),
        endFrame: z.number().int().positive(),
        inspection: z.literal('motion'),
        status: z.enum(['pass', 'issues', 'unreviewed']),
        notes: z.string().default(''),
      }),
    )
    .optional(),
  spliceEvidence: z
    .array(
      z.object({
        sourceSelection: versionRef,
        side: z.enum(['before', 'after']),
        inspection: z.enum(['motion', 'audio']),
        status: z.enum(['pass', 'issues', 'unreviewed']),
        notes: z.string().min(1),
      }),
    )
    .optional(),
  correctionConclusion: z.string().optional(),
  observationBasis: versionRef.optional(),
  boundaryWindows: z.array(boundaryWindowSchema).optional(),
  inspected: z.literal(true),
});
export const selectionSchema = z.object({
  episode: versionRef,
  segmentId: z.string(),
  jobId: z.string(),
  video: versionRef,
  review: versionRef,
  in: z.number().nonnegative(),
  out: z.number().positive(),
  volume: z.number().min(0).max(1).default(1),
  coverage: z
    .array(
      z.object({ shotId: z.string(), in: z.number().nonnegative(), out: z.number().positive() }),
    )
    .min(1),
});
export const canonSchema = z.object({
  episode: versionRef,
  previous: versionRef.nullable(),
  facts: z.array(
    z.object({
      id: z.string().min(1),
      text: z.string().min(1),
      instanceIds: z.array(z.string()).default([]),
    }),
  ),
  instances: shotStateSchema.shape.instances,
  states: z.array(poseSchema).default([]),
  relations: z.array(relationSchema).default([]),
  openLoops: z.array(z.string()).default([]),
  references: z.array(versionRef).default([]),
  correctionReason: z.string().default(''),
});
export const domainSchemas = {
  voice_profile: voiceProfileSchema,
  creative_module: creativeModuleSchema,
  entity: entitySchema,
  appearance: appearanceSchema,
  reference_pack: packSchema,
  asset_task: productionSchema,
  layout: layoutSchema,
  reference_plan: referencePlanSchema,
};
export const canonV3Schema = canonSchema.extend({
  schemaVersion: z.literal(3),
  facts: z.array(canonFactV3Schema),
  attributes: z.array(stateFactSchema).default([]),
  unfinishedActions: z.array(actionBoundarySchema).default([]),
  relationSources: z.array(z.object({ objectId: z.string(), selection: versionRef })).default([]),
  actionSources: z
    .array(z.object({ instanceId: z.string(), actionId: z.string(), selection: versionRef }))
    .default([]),
});
export type DomainKind = keyof typeof domainSchemas;
export const derivedSourceSchema = z.object({
  jobId: z.string().nullable(),
  media: versionRef,
  kind: z.enum(['review_frame', 'last_frame', 'audio', 'crop']),
  frameIndex: z.number().int().nonnegative().nullable(),
  interval: z.object({ in: z.number().nonnegative(), out: z.number().positive() }).nullable(),
  parameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
});
export type DerivedSource = z.infer<typeof derivedSourceSchema>;
