import { z } from 'zod';

export const moduleCategories = ['visual', 'world', 'narrative', 'direction'] as const;
export const moduleStageRules = z.object({
  source_events: z.array(z.string()).default([]),
  series_plan: z.array(z.string()).default([]),
  episode_script: z.array(z.string()).default([]),
  shot_plan: z.array(z.string()).default([]),
  asset_requirements: z.array(z.string()).default([]),
  repair: z.array(z.string()).default([]),
});
const sourceSchema = z.object({
  title: z.string(),
  location: z.string(),
  license: z.string(),
  note: z.string(),
});
const moduleCommon = {
  formatVersion: z.literal(1).default(1),
  name: z.string().trim().min(1),
  responsibility: z.string().min(1),
  scope: z.string().min(1),
  stageRules: moduleStageRules,
  references: z.array(z.string()).min(1),
  examples: z.array(z.object({ good: z.string(), bad: z.string(), reason: z.string() })).min(1),
  checks: z.array(z.string()).min(1),
  limitations: z.array(z.string()).min(1),
  sources: z.array(sourceSchema).min(1),
};
export const creativeModuleSchema = z.discriminatedUnion('category', [
  z.object({
    ...moduleCommon,
    category: z.literal('visual'),
    spec: z.object({
      representation: z.enum([
        'anime_2d',
        'hand_drawn',
        'stylized_3d',
        'realistic_cg',
        'live_action',
        'mixed',
        'custom',
      ]),
      line: z.string(),
      proportions: z.string(),
      materials: z.string(),
      shading: z.string(),
      palette: z.string(),
      backgrounds: z.string(),
      effects: z.string(),
      motion: z.string(),
    }),
  }),
  z.object({
    ...moduleCommon,
    category: z.literal('world'),
    spec: z.object({
      society: z.string(),
      mechanisms: z.array(z.string()),
      costs: z.array(z.string()),
      spatialRules: z.array(z.string()),
      forbiddenAssumptions: z.array(z.string()),
    }),
  }),
  z.object({
    ...moduleCommon,
    category: z.literal('narrative'),
    spec: z.object({
      centralQuestion: z.string(),
      choice: z.string(),
      causality: z.string(),
      information: z.string(),
      payoff: z.string(),
    }),
  }),
  z.object({
    ...moduleCommon,
    category: z.literal('direction'),
    spec: z.object({
      scale: z.string(),
      framing: z.string(),
      performance: z.string(),
      rhythm: z.string(),
      sound: z.string(),
    }),
  }),
]);
export type CreativeModule = z.infer<typeof creativeModuleSchema>;
export const moduleRefSchema = z.object({
  id: z.string().min(1),
  revision: z.number().int().positive(),
});
export const creativeScopeSchema = z.object({
  seriesId: z.string().optional(),
  episodeId: z.string().optional(),
  sceneId: z.string().optional(),
});
export const briefOverridesSchema = z.object({
  visual: z.string().default(''),
  world: z.string().default(''),
  narrative: z.string().default(''),
  direction: z.string().default(''),
  mixedMedia: z.string().default(''),
});
export const profileCompositionSchema = z.object({
  moduleRefs: z.array(moduleRefSchema).min(1),
  overrides: briefOverridesSchema.default({
    visual: '',
    world: '',
    narrative: '',
    direction: '',
    mixedMedia: '',
  }),
  exceptions: z
    .array(
      z.object({
        scope: creativeScopeSchema,
        reason: z.string().min(1),
        overrides: briefOverridesSchema,
      }),
    )
    .default([]),
  artBible: z.object({
    characters: z.string(),
    environments: z.string(),
    props: z.string(),
    effects: z.string(),
  }),
});
export const artEntrySchema = z.object({
  id: z.string().min(1),
  target: z.object({
    kind: z.enum(['global', 'instance', 'entity', 'effect']),
    id: z.string().default(''),
  }),
  aspect: z.enum(['style', 'identity', 'appearance', 'environment', 'material', 'effect']),
  text: z.string().min(1),
  stable: z.literal(true),
  scope: creativeScopeSchema
    .extend({ shotIds: z.array(z.string()).default([]) })
    .default({ shotIds: [] }),
  when: z
    .array(
      z.object({
        instanceId: z.string(),
        key: z.string(),
        value: z.union([z.boolean(), z.number().finite(), z.string()]),
      }),
    )
    .default([]),
});
export const profileCompositionV3Schema = profileCompositionSchema.extend({
  moduleRefs: z.array(moduleRefSchema).default([]),
  artBible: profileCompositionSchema.shape.artBible.default({
    characters: '',
    environments: '',
    props: '',
    effects: '',
  }),
  artEntries: z.array(artEntrySchema).default([]),
  visualReference: z
    .object({
      asset: moduleRefSchema,
      description: z.string().min(1),
      reviewed: z.boolean().default(false),
    })
    .optional(),
});
export const storyBlueprintSchema = z.object({
  centralQuestion: z.string().min(1),
  endingDirection: z.string().min(1),
  characterChanges: z.array(
    z.object({
      instanceId: z.string(),
      desire: z.string(),
      choice: z.string(),
      cost: z.string(),
      outcome: z.string(),
    }),
  ),
  relationships: z.array(z.string()),
  setups: z.array(
    z.object({
      id: z.string(),
      plant: z.string(),
      payoff: z.string(),
      resolved: z.boolean().default(false),
    }),
  ),
});
