import { z } from 'zod';
import { profileCompositionSchema, profileCompositionV3Schema } from './creative-modules.js';
import { versionRef } from './domain.js';

export const creationProfileV2Schema = z.object({
  name: z.string().trim().min(1),
  goal: z.string().default(''),
  audience: z.string().default(''),
  targetSeconds: z.number().positive().optional(),
  width: z.number().int().min(128).max(1344).multipleOf(32).default(864),
  height: z.number().int().min(128).max(1344).multipleOf(32).default(480),
  steps: z.number().int().min(1).max(50).default(20),
  visual: z.string().default(''),
  camera: z.string().default(''),
  pacing: z.string().default(''),
  sound: z.string().default('保留环境声音'),
  referenceStrategy: z.string().default('使用正式参考包，按镜头可见角度选图'),
  reviewReminders: z.array(z.string()).default([]),
  rulesVersion: z.literal('director-v5'),
  composition: profileCompositionSchema,
});
export const creationProfileV3Schema = creationProfileV2Schema.extend({
  rulesVersion: z.literal('director-v6'),
  composition: profileCompositionV3Schema,
});
export const creationProfileV4Schema = creationProfileV3Schema.extend({
  rulesVersion: z.literal('director-v7'),
});
export const creationProfileSchema = z.discriminatedUnion('rulesVersion', [
  creationProfileV2Schema,
  creationProfileV3Schema,
  creationProfileV4Schema,
]);
export type CreationProfile = z.infer<typeof creationProfileSchema>;
export const creationPresets = [
  {
    name: '剧情短片',
    goal: '围绕明确行动与变化讲述故事',
    pacing: '每个镜头有可见行动，保持前后承接',
  },
  {
    name: '产品展示',
    goal: '展示产品结构、材质与使用过程',
    camera: '机位服务于需要展示的结构',
    reviewReminders: ['检查数量、结构和接口位置'],
  },
  {
    name: '知识演示',
    goal: '以可见过程解释知识',
    reviewReminders: ['事实依据需要人工核对，生成画面不构成科学证据'],
  },
  { name: '空白自定义' },
].map((v) => creationProfileSchema.parse({ ...v, rulesVersion: 'director-v6', composition: {} }));
export const creativeStages = [
  'source_events',
  'series_plan',
  'episode_script',
  'shot_plan',
  'asset_requirements',
  'repair',
] as const;
export interface ReadinessIssue {
  category?: 'data' | 'consistency' | 'execution' | 'quality' | 'evidence';
  stage?: string;
  code: string;
  severity: 'blocking' | 'review' | 'info';
  message: string;
  target: { id: string; revision: number };
  episodeId?: string;
  segmentId?: string;
  field: string;
  step: 'planning' | 'assets' | 'shots' | 'review' | 'film';
  action: string;
}
export const batchEntrySchema = z.object({
  id: z.string().min(1),
  episodeId: z.string().min(1),
  episodeRevision: z.number().int().positive(),
  segmentId: z.string().min(1),
  width: z.number().int(),
  height: z.number().int(),
  steps: z.number().int().default(20),
  seed: z.number().int().nonnegative(),
  enabled: z.boolean().default(true),
  waitingFor: z.string().default(''),
  retryOf: z.string().optional(),
});
export const batchDraftSchema = z.object({
  name: z.string().trim().min(1),
  items: z.array(batchEntrySchema).min(1).max(100),
});
export type BatchEntry = z.infer<typeof batchEntrySchema>;

export const workspaceKinds: Record<string, string[]> = {
  creation: [],
  series: [
    'series',
    'creation_profile',
    'voice_profile',
    'dialogue_take',
    'continuity',
    'episode_release',
    'entity',
  ],
  home: [],
  settings: [],
  batches: [],
  jobs: [],
  production: [],
  planning: ['series', 'creative_module', 'creation_profile', 'proposal', 'chapter'],
  subjects: ['entity', 'appearance', 'reference_pack', 'asset_task'],
  layouts: ['entity', 'layout'],
  continuity: ['series', 'continuity', 'entity'],
  episode: ['entity', 'appearance', 'reference_pack', 'reference_plan', 'layout', 'chapter'],
  review: ['generation_review', 'segment_selection'],
  timeline: ['edl', 'segment_selection'],
  source: ['chapter'],
  director: ['series', 'chapter', 'proposal'],
  overview: ['series'],
  assets: [],
};
