import { directingSchema } from './directing.js';
import { mouthObservationFields } from './mouth-review.js';
import { z } from 'zod';
import {
  shotStateSchema,
  versionRef,
  productionSchema,
  layoutSchema,
  referencePlanSchema,
} from './domain.js';
import { dramaturgySchema, shotProductionSchema } from './longform.js';
import { incomingSchema, repairSchema } from './shot-semantics.js';
import { episodeProductionSchema } from './series.js';
import { creationOverlaySchema } from './creation.js';

export const kinds = [
  'project',
  'series',
  'arc',
  'episode',
  'chapter',
  'asset',
  'proposal',
  'continuity',
  'edl',
  'entity',
  'appearance',
  'reference_pack',
  'asset_task',
  'layout',
  'reference_plan',
  'generation_review',
  'segment_selection',
  'creation_profile',
  'creative_module',
  'voice_profile',
  'dialogue_take',
  'assembly_review',
  'episode_release',
  'creation_settings',
  'creation_run',
  'authoring_result',
  'creation_delivery',
  'creation_delivery_plan',
  'creation_scope',
  'workspace_layout',
  'creation_message',
  'creation_review_edit',
  'creation_media_issue',
] as const;
export type Kind = (typeof kinds)[number];
export interface RecordDoc<T = any> {
  id: string;
  kind: Kind;
  projectId: string;
  parentId: string | null;
  revision: number;
  data: T;
  createdAt: number;
  updatedAt: number;
}
export const referenceSchema = z.object({
  assetId: z.string(),
  revision: z.number().int().positive(),
  role: z.enum([
    'identity',
    'style',
    'scene',
    'prop',
    'first_frame',
    'last_frame',
    'video',
    'audio',
  ]),
  instruction: z.string().default(''),
  subjectId: z.string().trim().default(''),
  usage: referencePlanSchema.shape.bindings.unwrap().element.shape.usage,
});
export const guideSchema = z.object({
  assetId: z.string(),
  revision: z.number().int().positive(),
  frameIndex: z.number().int().min(-1),
  instruction: z.string().default(''),
});
export const guidedPromptSchema = z.object({
  summary: z.string().trim().min(1),
  detailedDescription: z.string().trim().min(1),
  overallSoundscape: z.string().trim().min(1),
  nonDiegeticMusic: z.string().trim().min(1),
});
export const shotSchema = z.object({
  id: z.string().min(1),
  scene: z.string(),
  description: z.string(),
  dialogue: z.string(),
  continuity: z.string(),
  duration: z.number().positive().max(900),
  production: shotProductionSchema.optional(),
  state: shotStateSchema.optional(),
  directing: directingSchema.optional(),
});
export const segmentSchema = z.object({
  id: z.string().min(1),
  shotIds: z.array(z.string()).min(1),
  prompt: z.string().min(1),
  mode: z.enum(['t2v', 'i2v', 'ref2va']),
  duration: z.number().min(5).max(15),
  references: z.array(referenceSchema).default([]),
  guides: z.array(guideSchema).default([]),
  guidedPrompt: guidedPromptSchema.nullable().default(null),
  referencePlan: versionRef.optional(),
  generationMode: z.enum(['exploration', 'formal']).optional(),
  executionVersion: z
    .enum([
      'native-h3-directed-v1',
      'native-h3-directed-v2',
      'native-h3-base-v2',
      'native-h3-directed-v3',
      'native-h3-base-v3',
      'native-h3-directed-v4',
      'native-h3-base-v4',
    ])
    .optional(),
  incoming: incomingSchema.optional(),
  repair: repairSchema.optional(),
});
export const episodePlanSchema = z.object({
  title: z.string().min(1),
  summary: z.string(),
  script: z.string(),
  sourceChapterIds: z.array(z.string()),
  shots: z.array(shotSchema),
  segments: z.array(segmentSchema),
  incoming: z.record(z.string(), z.unknown()),
  outgoing: z.record(z.string(), z.unknown()),
  openLoops: z.array(z.string()),
  creationProfile: versionRef.optional(),
  dramaturgy: dramaturgySchema.optional(),
  seriesProduction: episodeProductionSchema.optional(),
  preproductionPackage: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .optional(),
});
export type EpisodePlan = z.infer<typeof episodePlanSchema>;
export type GenerationSegment = z.infer<typeof segmentSchema>;

export const edlSchema = z
  .object({
    overlays: z.array(creationOverlaySchema).max(2000).optional(),
    schemaVersion: z.literal(2).optional(),
    episodeId: z.string(),
    width: z
      .number()
      .int()
      .min(128)
      .max(3840)
      .refine((v) => v % 2 === 0),
    height: z
      .number()
      .int()
      .min(128)
      .max(3840)
      .refine((v) => v % 2 === 0),
    fps: z.literal(24),
    clips: z
      .array(
        z.object({
          assetId: z.string(),
          revision: z.number().int().positive(),
          in: z.number().nonnegative(),
          out: z.number().positive(),
          volume: z.number().min(0).max(1),
          fadeInFrames: z.number().int().nonnegative().optional(),
          fadeOutFrames: z.number().int().nonnegative().optional(),
          selection: versionRef.optional(),
          role: z.enum(['story', 'intro', 'outro', 'recap']).optional(),
        }),
      )
      .min(1),
    audio: z.array(
      z.object({
        assetId: z.string(),
        revision: z.number().int().positive(),
        in: z.number().nonnegative(),
        out: z.number().positive(),
        start: z.number().nonnegative(),
        dialogueTake: versionRef.optional(),
        originalAudio: z.literal('muted').optional(),
        lipSyncReviewed: z.boolean().optional(),
        ...mouthObservationFields,
        volume: z.number().min(0).max(1),
        fadeInFrames: z.number().int().nonnegative().optional(),
        fadeOutFrames: z.number().int().nonnegative().optional(),
      }),
    ),
  })
  .superRefine((edl, ctx) => {
    const frames = Math.round(edl.clips.reduce((n, c) => n + c.out - c.in, 0) * 24);
    if (edl.overlays?.length && edl.schemaVersion !== 2)
      ctx.addIssue({ code: 'custom', path: ['overlays'], message: '精确图文需要新版时间线' });
    if (new Set(edl.overlays?.map((o) => o.id)).size !== (edl.overlays?.length || 0))
      ctx.addIssue({ code: 'custom', path: ['overlays'], message: '图文标识重复' });
    edl.overlays?.forEach((o, i) => {
      if (o.endFrame <= o.startFrame || o.endFrame > frames)
        ctx.addIssue({
          code: 'custom',
          path: ['overlays', i],
          message: '图文区间必须位于实际成片内',
        });
    });
    for (const [track, clips] of [
      ['clips', edl.clips],
      ['audio', edl.audio],
    ] as const) {
      clips.forEach((clip, i) => {
        if (clip.out <= clip.in)
          ctx.addIssue({ code: 'custom', path: [track, i, 'out'], message: '出点必须大于入点' });
        if (edl.schemaVersion === 2) {
          for (const [key, v] of Object.entries(clip))
            if (
              ['in', 'out', 'start'].includes(key) &&
              typeof v === 'number' &&
              Math.abs(v * 24 - Math.round(v * 24)) > 1e-6
            )
              ctx.addIssue({
                code: 'custom',
                path: [track, i, key],
                message: '新版时间线必须使用 24 fps 整帧边界',
              });
          if (
            (clip.fadeInFrames || 0) + (clip.fadeOutFrames || 0) >
            Math.round((clip.out - clip.in) * 24)
          )
            ctx.addIssue({ code: 'custom', path: [track, i], message: '淡入淡出不能超过片段时长' });
        } else if (clip.fadeInFrames || clip.fadeOutFrames)
          ctx.addIssue({ code: 'custom', path: [track, i], message: '声音包络需要新版时间线' });
      });
    }
  });
export type EditDecisionList = z.infer<typeof edlSchema>;
export interface ContinuitySnapshot {
  facts: Record<string, unknown>;
  openLoops: string[];
  references: { id: string; revision: number }[];
  confirmed: boolean;
  stale: boolean;
}
export interface AssetVersion {
  name: string;
  category: string;
  entityId: string;
  variant: string;
  mediaType: 'image' | 'video' | 'audio';
  path: string;
  sha256: string;
  adopted: boolean;
  sourceAssetIds: string[];
  prompt: string;
  duration?: number;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  jobId?: string;
}
export const jobStates = [
  'queued',
  'preparing',
  'submitting',
  'unknown',
  'submitted',
  'running',
  'archiving',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type JobState = (typeof jobStates)[number];
export interface Job {
  id: string;
  projectId: string;
  episodeId: string | null;
  kind: 'generation' | 'creative' | 'export';
  state: JobState;
  input: any;
  output: any;
  promptId: string | null;
  error: string | null;
  cancelRequested: boolean;
  createdAt: number;
  updatedAt: number;
  batchId?: string | null;
  batchItemId?: string | null;
  holdReason?: string | null;
}
export interface ComfyProfile {
  baseUrl: string;
  instanceId: string;
}
export const generationRequestSchema = z.object({
  episodeId: z.string(),
  episodeRevision: z.number().int(),
  segmentId: z.string(),
  width: z
    .number()
    .int()
    .min(128)
    .max(1344)
    .refine((v) => v % 32 === 0),
  height: z
    .number()
    .int()
    .min(128)
    .max(1344)
    .refine((v) => v % 32 === 0),
  steps: z.number().int().min(1).max(50).default(20),
  seed: z.number().int().min(0).max(2147483647),
  approved: z.literal(true),
  idempotencyKey: z.string().min(8),
  previewDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export const generationPreviewSchema = generationRequestSchema.omit({
  approved: true,
  idempotencyKey: true,
  previewDigest: true,
});
export function clipDuration(clip: { in: number; out: number }) {
  return clip.out - clip.in;
}
export function timelineDuration(edl: EditDecisionList) {
  return edl.clips.reduce((n, c) => n + clipDuration(c), 0);
}
export function frameCount(seconds: number) {
  const f = Math.max(5, Math.round(seconds * 24));
  return f + ((5 - (f % 17) + 17) % 17);
}
