import { z } from 'zod';
import {
  sceneDesignSchema,
  shotStagingSchema,
  interactionSchema,
  attentionSchema,
  mouthVisibilitySchema,
  referenceCoverageSchema,
} from './staging-contracts.js';

// Authoring contracts deliberately do not contain H3 canvas or segment limits.
const text = z.string().max(100000);
const key = z
  .string()
  .min(1)
  .max(160)
  .refine(
    (value) => !['__proto__', 'prototype', 'constructor'].includes(value),
    '标识符使用保留名称',
  );
export const creationRefSchema = z
  .object({ id: key, revision: z.number().int().positive() })
  .strict();
export type CreationRef = z.infer<typeof creationRefSchema>;
export const durationIntentSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('exact'), seconds: z.number().positive() }).strict(),
  z
    .object({
      mode: z.literal('approximate'),
      seconds: z.number().positive(),
      tolerancePercent: z.number().min(0).max(50).default(5),
    })
    .strict(),
  z.object({ mode: z.literal('derive') }).strict(),
]);
export type DurationIntent = z.infer<typeof durationIntentSchema>;
export const creationSettingsSchema = z
  .object({
    progression: z.enum(['review', 'automatic']).default('review'),
    duration: durationIntentSchema.default({ mode: 'derive' }),
    interpretation: z.literal('faithful_with_performance').default('faithful_with_performance'),
    finalApproval: z.literal('user').default('user'),
    output: z
      .object({
        width: z.number().int().min(128).max(3840).multipleOf(2).default(864),
        height: z.number().int().min(128).max(3840).multipleOf(2).default(480),
        steps: z.number().int().min(1).max(50).default(20),
      })
      .strict()
      .default({ width: 864, height: 480, steps: 20 }),
    allowance: z
      .object({
        enabled: z.boolean().default(false),
        maxGenerations: z.number().int().min(0).max(10000).default(0),
        maxGeneratedSeconds: z.number().min(0).max(1000000).default(0),
      })
      .strict()
      .default({ enabled: false, maxGenerations: 0, maxGeneratedSeconds: 0 }),
    maxTextRepairs: z.number().int().min(0).max(2).default(2),
  })
  .strict();
export type CreationSettings = z.infer<typeof creationSettingsSchema>;

export function inferDurationIntent(request: string): DurationIntent {
  const match = request.match(
    /(大约|约|大概)?\s*(\d+(?:\.\d+)?|一|两|二|三|四|五|六|七|八|九|十|半)\s*(分钟|秒钟|秒)(左右|上下)?/,
  );
  if (!match) return { mode: 'derive' };
  const chinese: Record<string, number> = {
    一: 1,
    两: 2,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
    半: 0.5,
  };
  const seconds = (chinese[match[2]] ?? Number(match[2])) * (match[3] === '分钟' ? 60 : 1);
  if (!Number.isFinite(seconds) || seconds <= 0) return { mode: 'derive' };
  return match[1] || match[4]
    ? { mode: 'approximate', seconds, tolerancePercent: 5 }
    : { mode: 'exact', seconds };
}
export function durationBounds(intent: DurationIntent, fps = 24) {
  if (intent.mode === 'derive') return null;
  const tolerance =
    intent.mode === 'approximate' ? (intent.seconds * intent.tolerancePercent) / 100 : 0;
  return {
    minFrames: Math.ceil((intent.seconds - tolerance) * fps - 1e-7),
    maxFrames: Math.floor((intent.seconds + tolerance) * fps + 1e-7),
  };
}

export const authoringStages = [
  'brief',
  'script',
  'direction',
  'director',
  'assets',
  'editorial',
] as const;
export type AuthoringStage = (typeof authoringStages)[number];
export const creationStageLabels: Record<string, string> = {
  brief: '需求与来源',
  script: '故事与剧本',
  direction: '呈现方向',
  director: '导演计划',
  assets: '资产与声音身份',
  production: '生成与候选',
  review: '实际审看与采用',
  editorial: '声音与后期',
  delivery: '成片与最终确认',
  complete: '已交付',
};
export const creationIssueSchema = z
  .object({
    code: key,
    category: z.enum(['data', 'consistency', 'execution', 'quality', 'evidence']),
    severity: z.enum(['blocking', 'review', 'info']),
    stage: z.string(),
    field: z.string(),
    message: text,
    targetId: z.string(),
  })
  .strict();
export type CreationIssue = z.infer<typeof creationIssueSchema>;
const common = {
  schemaVersion: z.literal(9),
  // Missing means the original V9 contract, never an implicit spatial upgrade.
  contractRevision: z.literal(2).optional(),
  title: text,
  summary: text,
  assumptions: z.array(text),
  openQuestions: z.array(text),
  sources: z.array(creationRefSchema),
  contentChange: z.enum(['preserved', 'revision_requested']),
};
const subject = z
  .object({
    key,
    name: text,
    kind: z.enum(['human', 'animal', 'object', 'environment', 'graphic']),
    description: text,
    attributes: z.array(
      z
        .object({
          key: key
            .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
            .refine((v) => v !== 'creation_location', '此属性名由环境关系映射保留'),
          label: text,
          type: z.enum(['enum', 'boolean', 'number']).default('enum'),
          values: z.array(key),
        })
        .strict()
        .refine((a) => a.type !== 'enum' || a.values.length > 0, '枚举需要允许值'),
    ),
  })
  .strict();
const fact = z
  .object({
    id: key,
    kind: z.enum(['event', 'dialogue', 'identity', 'relationship', 'ending', 'claim']),
    statement: text,
    source: creationRefSchema.nullable(),
  })
  .strict();
const dialogue = z
  .object({
    id: key,
    speakerKey: key,
    text,
    translation: text.optional(),
    sourceFactId: key.nullable(),
    language: key,
  })
  .strict();
const sourceEvent = z.object({ id: key, description: text, sourceFactIds: z.array(key) }).strict();
export const creationOverlaySchema = z
  .object({
    id: key,
    text: z.string().max(10000),
    sourceDialogueId: key.nullable(),
    startFrame: z.number().int().nonnegative(),
    endFrame: z.number().int().positive(),
    position: z.enum(['top', 'center', 'bottom']),
    fontSize: z.number().int().min(12).max(160),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  })
  .strict();
const scene = z
  .object({
    id: key,
    title: text,
    setting: text,
    narrative: text,
    events: z.array(sourceEvent),
    dialogue: z.array(dialogue),
  })
  .strict();
const state = z
  .object({
    subjectKey: key,
    key,
    value: z.union([z.string().min(1), z.boolean(), z.number().finite()]).nullable(),
  })
  .strict();
const relation = z
  .object({
    objectKey: key,
    type: z.enum(['heldBy', 'attachedTo', 'containedIn', 'locatedIn']),
    targetKey: key,
    anchor: text,
    anchorId: key.nullable().optional(),
  })
  .strict();
export const shotCueSchema = z
  .object({
    id: key,
    target: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('event'), eventId: key }).strict(),
      z.object({ kind: z.literal('dialogue'), lineId: key }).strict(),
      z.object({ kind: z.literal('performance'), performanceId: key }).strict(),
    ]),
    window: z
      .object({ startFrame: z.number().int().nonnegative(), endFrame: z.number().int().positive() })
      .strict()
      .nullable(),
    afterIds: z.array(key),
  })
  .strict();
export const authoringShotSchema = z
  .object({
    id: key,
    sceneId: key,
    frames: z.number().int().positive(),
    purpose: text,
    visibleSubjectKeys: z.array(key),
    events: z.array(
      z
        .object({ eventId: key, phase: z.enum(['start', 'continue', 'complete', 'whole']) })
        .strict(),
    ),
    dialogue: z.array(
      z
        .object({
          lineId: key,
          delivery: z.enum(['onscreen', 'offscreen', 'voiceover']),
          mouth: mouthVisibilitySchema.optional(),
        })
        .strict(),
    ),
    cues: z.array(shotCueSchema).default([]),
    action: text,
    staging: shotStagingSchema.nullable().optional(),
    visibleSpace: text.optional(),
    audienceFocus: text.optional(),
    informationChange: text.optional(),
    cutReason: text.optional(),
    // Only scoped, provider-ready visual wording is compiled; never direction policy prose.
    visualTreatment: text.optional(),
    interactions: z.array(interactionSchema).optional(),
    performances: z.array(
      z
        .object({
          id: key,
          subjectKey: key,
          trigger: text,
          goal: text,
          obstacle: text,
          visible: text,
          attention: attentionSchema.nullable().optional(),
          headHeading: z.number().min(0).lt(360).nullable().optional(),
        })
        .strict(),
    ),
    camera: z
      .object({
        shotSize: text,
        position: text,
        composition: text,
        motion: z.enum([
          'static',
          'pan',
          'tilt',
          'dolly',
          'truck',
          'pedestal',
          'arc',
          'tracking',
          'zoom',
        ]),
        reason: text,
      })
      .strict(),
    entryState: z.array(state),
    exitState: z.array(state),
    entryRelations: z.array(relation),
    exitRelations: z.array(relation),
    environmentSound: text,
    actionSound: text,
    soundContinuation: text,
  })
  .strict();
export const authoringSchemas = {
  brief: z
    .object({
      ...common,
      stage: z.literal('brief'),
      intent: z.enum(['narrative', 'commercial', 'explainer', 'visual', 'custom']),
      goal: text,
      audience: text,
      lockedFacts: z.array(fact),
      requirements: z.array(text),
    })
    .strict(),
  script: z
    .object({
      ...common,
      stage: z.literal('script'),
      screenplayText: text,
      subjects: z.array(subject),
      scenes: z.array(scene),
    })
    .strict(),
  direction: z
    .object({
      ...common,
      stage: z.literal('direction'),
      visual: text,
      narrative: text,
      directing: text,
      editing: text,
      sound: text,
      assetPolicy: text,
    })
    .strict(),
  director: z
    .object({
      ...common,
      stage: z.literal('director'),
      sceneDesigns: z.array(sceneDesignSchema).optional(),
      shots: z.array(authoringShotSchema),
      groups: z.array(
        z
          .object({
            id: key,
            shotIds: z.array(key).min(1),
            transition: z.enum([
              'independent',
              'continuous',
              'ellipsis',
              'location_change',
              'flashback',
            ]),
            reason: text,
          })
          .strict(),
      ),
    })
    .strict(),
  assets: z
    .object({
      ...common,
      stage: z.literal('assets'),
      items: z.array(
        z
          .object({
            id: key,
            subjectKey: key,
            mediaType: z.enum(['image', 'audio']),
            purpose: z.enum([
              'identity',
              'appearance',
              'environment',
              'composition',
              'action_start',
              'action_end',
              'style',
              'voice',
            ]),
            description: text,
            prompt: text,
            layout: text,
            shotIds: z.array(key),
            coverage: z.array(referenceCoverageSchema).optional(),
            preserve: z.array(text).optional(),
            allow: z.array(text).optional(),
            view: z.enum([
              'front',
              'left',
              'right',
              'back',
              'three_quarter',
              'top',
              'detail',
              'custom',
            ]),
          })
          .strict(),
      ),
    })
    .strict(),
  editorial: z
    .object({
      ...common,
      stage: z.literal('editorial'),
      musicDecision: z.enum(['no_music', 'import']),
      musicReason: text,
      audio: z.array(
        z
          .object({
            asset: creationRefSchema,
            startFrame: z.number().int().nonnegative(),
            inFrame: z.number().int().nonnegative(),
            outFrame: z.number().int().positive(),
            volume: z.number().min(0).max(1),
          })
          .strict(),
      ),
      overlays: z.array(creationOverlaySchema).max(2000),
    })
    .strict(),
} as const;
export type AuthoringResult = {
  [S in AuthoringStage]: z.infer<(typeof authoringSchemas)[S]>;
}[AuthoringStage];
export type ScriptResult = z.infer<typeof authoringSchemas.script>;
export type DirectorResult = z.infer<typeof authoringSchemas.director>;
export type AuthoringShot = z.infer<typeof authoringShotSchema>;
export function parseAuthoringResult(stage: AuthoringStage, raw: unknown): AuthoringResult {
  return authoringSchemas[stage].parse(raw);
}

export interface AuthoringContext {
  schemaVersion: 9;
  contractRevision?: 2;
  runId: string;
  epoch: number;
  stage: AuthoringStage;
  request: string;
  target: CreationRef;
  projectId: string;
  settings: CreationSettings;
  dependencies: CreationRef[];
  records: Array<{ id: string; revision: number; kind: string; data: unknown }>;
  priorResults: Partial<Record<AuthoringStage, AuthoringResult>>;
  writable?: {
    baseline: CreationRef;
    baselineResult: AuthoringResult;
    shotIds: string[];
    sceneIds: string[];
    subjectKeys: string[];
  };
  repairIssues: CreationIssue[];
  rules: { version: string; text: string; digest: string; files: string[] };
  capabilities: {
    provider: 'h3';
    video: boolean;
    image: false;
    audio: false;
    mediaReview: false;
    framesPerSecond: 24;
    minSeconds: 5;
    maxSeconds: 15;
  };
  digest: string;
}

export const H3_CREATION_CAPABILITIES = Object.freeze({
  contractRevision: 2 as const,
  provider: 'h3' as const,
  video: true,
  image: false as const,
  audio: false as const,
  mediaReview: false as const,
  framesPerSecond: 24 as const,
  minSeconds: 5 as const,
  maxSeconds: 15 as const,
});
