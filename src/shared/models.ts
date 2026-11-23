import { z } from 'zod';
import { isSpeechProtocol, speechCapabilities, speechProtocols } from './speech.js';

export const modelProtocols = [
  'codex',
  'responses',
  'chat-completions',
  'openai-images',
  'comfy-h3',
  'minimax-video',
  'ark-video',
  ...speechProtocols,
  'sync-lipsync',
  'tencent-asr',
] as const;
export type ModelProtocol = (typeof modelProtocols)[number];
export const modelRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict();
export const credentialRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('env'), key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/) }).strict(),
  z.object({ kind: z.literal('dpapi'), key: z.string().uuid() }).strict(),
]);
export const connectionDataSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    protocol: z.enum(modelProtocols),
    baseUrl: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          ['http:', 'https:'].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, '连接地址不能包含凭据、查询或片段'),
    credential: credentialRefSchema.nullable().default(null),
    credentials: z
      .object({ secretId: credentialRefSchema, secretKey: credentialRefSchema })
      .strict()
      .optional(),
    region: z.string().optional(),
    account: z.string().optional(),
    appId: z.string().regex(/^\d+$/).optional(),
    speechResourceId: z.string().optional(),
    ttsBaseUrl: z
      .string()
      .url()
      .refine((v) => {
        const u = new URL(v);
        return (
          ['http:', 'https:'].includes(u.protocol) &&
          !u.username &&
          !u.password &&
          !u.search &&
          !u.hash
        );
      }, 'TTS 地址不能含凭据或查询')
      .optional(),
    enabled: z.boolean().default(false),
    compatible: z.boolean().default(false),
    capacityGroup: z.string().min(1).max(160),
    concurrency: z.number().int().min(1).max(8).default(1),
    instanceId: z.string().optional(),
    models: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(200),
            name: z.string().trim().min(1).max(160),
            preset: z.enum([
              'text',
              'image',
              'h3-comfy',
              'h3-api',
              'seedance-2',
              ...speechProtocols,
              'sync-lipsync',
              'tencent-asr',
            ]),
            // Missing retains the meaning of previously published connection snapshots.
            enabled: z.boolean().optional(),
            imageInput: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.models.map((m) => m.id)).size !== v.models.length)
      c.addIssue({ code: 'custom', message: '模型标识重复', path: ['models'] });
    const expected =
      isSpeechProtocol(v.protocol) || v.protocol === 'sync-lipsync' || v.protocol === 'tencent-asr'
        ? v.protocol
        : ['codex', 'responses', 'chat-completions'].includes(v.protocol)
          ? 'text'
          : v.protocol === 'openai-images'
            ? 'image'
            : v.protocol === 'comfy-h3'
              ? 'h3-comfy'
              : v.protocol === 'minimax-video'
                ? 'h3-api'
                : 'seedance-2';
    if (v.models.some((m) => m.preset !== expected))
      c.addIssue({ code: 'custom', message: '模型能力方案与协议不匹配', path: ['models'] });
    if (v.protocol === 'comfy-h3' && !v.instanceId)
      c.addIssue({ code: 'custom', message: 'ComfyUI 需要固定实例身份', path: ['instanceId'] });
    if (v.protocol === 'comfy-h3' && v.credential)
      c.addIssue({
        code: 'custom',
        message: '当前 ComfyUI 适配器使用无需密钥的连接，不支持网关鉴权；不能静默忽略凭据',
        path: ['credential'],
      });
    if (['tencent-speech', 'tencent-asr'].includes(v.protocol) && !v.credentials)
      c.addIssue({
        code: 'custom',
        message: '腾讯签名需要 SecretId 和 SecretKey 的服务端引用',
        path: ['credentials'],
      });
    if (v.protocol === 'tencent-asr' && !v.appId)
      c.addIssue({ code: 'custom', message: '腾讯录音识别需要 AppID', path: ['appId'] });
    if (v.models.some((m) => m.imageInput) && v.protocol !== 'chat-completions')
      c.addIssue({
        code: 'custom',
        message: '当前仅 Chat Completions 适配器实现图像理解输入',
        path: ['models'],
      });
    if (
      !['codex', 'comfy-h3', 'tencent-speech', 'tencent-asr'].includes(v.protocol) &&
      !v.credential
    )
      c.addIssue({ code: 'custom', message: '需要服务端凭据引用', path: ['credential'] });
    if (
      v.protocol === 'codex' &&
      !v.credential &&
      v.baseUrl.replace(/\/+$/, '') !== 'https://api.openai.com/v1'
    )
      c.addIssue({
        code: 'custom',
        message: 'Codex 登录认证只用于官方服务；自定义地址需要明确凭据',
        path: ['baseUrl'],
      });
    if (
      ['minimax-video', 'comfy-h3'].includes(v.protocol) &&
      v.models.some((m) => m.id !== 'MiniMax-H3')
    )
      c.addIssue({
        code: 'custom',
        message: '当前能力方案仅核对了 MiniMax-H3；其他型号需独立能力方案',
        path: ['models'],
      });
  });
export type ConnectionData = z.infer<typeof connectionDataSchema>;
export interface ModelConnection {
  id: string;
  revision: number;
  data: ConnectionData;
  createdAt: number;
}
// Current lifecycle permission is separate from the immutable execution snapshot.
export function modelAvailable(data: ConnectionData, modelId: string): boolean {
  return data.enabled && data.models.some((m) => m.id === modelId && m.enabled !== false);
}
export const executionSelectionSchema = z
  .object({
    connection: modelRefSchema,
    modelId: z.string().min(1),
    mode: z.enum(['authored', 't2v', 'i2v', 'ref2va']).default('authored'),
    promptProfile: z.string().default('automatic'),
    parameters: z
      .object({
        resolution: z.string().optional(),
        ratio: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        steps: z.number().int().positive().optional(),
        seed: z.number().int().nonnegative().optional(),
        maxOutputTokens: z.number().int().positive().max(100000).optional(),
        temperature: z.number().min(0).max(2).optional(),
        size: z.string().optional(),
        quality: z.string().optional(),
        n: z.number().int().min(1).max(4).optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type ExecutionSelection = z.infer<typeof executionSelectionSchema>;
export const modelAllowanceSchema = z
  .object({
    enabled: z.boolean().default(false),
    connections: z.array(modelRefSchema).default([]),
    maxTextRequests: z.number().int().nonnegative().default(0),
    maxImageRequests: z.number().int().nonnegative().default(0),
    maxImages: z.number().int().nonnegative().default(0),
    maxVideoRequests: z.number().int().nonnegative().default(0),
    maxVideoSeconds: z.number().nonnegative().default(0),
  })
  .strict();
export const executionConfigSchema = z
  .object({
    version: z.literal(1).default(1),
    slots: z.record(
      z.string().regex(/^(text(?::[a-z]+)?|image|speech|lipsync|video(?::[^\s]+)?)$/),
      executionSelectionSchema,
    ),
    allowance: modelAllowanceSchema.optional(),
  })
  .strict();
export interface ModelCapabilities {
  version: 1;
  kind: 'text' | 'image' | 'video' | 'speech';
  speech?: (typeof speechCapabilities)[keyof typeof speechCapabilities];
  operations?: string[];
  imageInput?: boolean;
  maxReferenceVideos?: number;
  maxReferenceAudio?: number;
  modes: string[];
  minSeconds?: number;
  maxSeconds?: number;
  integerSeconds?: boolean;
  maxReferenceImages?: number;
  supportsLastFrame?: boolean;
  supportsGuides?: boolean;
  resolutions?: string[];
  ratios?: string[];
  sizes?: string[];
  qualities?: string[];
  verification: 'catalog_declared';
}
export interface ModelExecution {
  version: 1;
  connection: ModelConnection;
  modelId: string;
  protocol: ModelProtocol;
  adapterVersion: string;
  selection: ExecutionSelection;
  capabilities: ModelCapabilities;
  dependencies: Array<{ id: string; revision: number }>;
  promptProfile: string;
  digest: string;
}
export interface InputBinding {
  id: string;
  asset: { id: string; revision: number };
  sha256: string;
  purpose: string;
  role:
    | 'first_frame'
    | 'last_frame'
    | 'reference_image'
    | 'reference_video'
    | 'reference_audio'
    | 'time_guide';
  frame?: number;
  label: string;
  instanceIds: string[];
  shotIds: string[];
}
export interface PromptProfile {
  id: string;
  family: string;
  modes: string[];
  sections: string[];
  language: string;
}
export const promptProfiles: PromptProfile[] = [
  {
    id: 'native-h3-base-v4',
    family: 'h3-comfy',
    modes: ['t2v', 'i2v'],
    sections: ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'],
    language: '英文执行描述；对白保留原文',
  },
  {
    id: 'native-h3-directed-v4',
    family: 'h3-comfy',
    modes: ['ref2va'],
    sections: [
      'subject_definitions',
      'summary',
      'retention_analysis',
      'detailed_description',
      'overall_soundscape',
      'non_diegetic_music',
    ],
    language: '英文执行描述；对白保留原文',
  },
  {
    id: 'minimax-h3-api-base-v1',
    family: 'h3-api',
    modes: ['t2v', 'i2v'],
    sections: ['integrated_multimodal_description', 'overall_soundscape', 'non_diegetic_music'],
    language: '保持已审核执行正文',
  },
  {
    id: 'minimax-h3-api-ref-v1',
    family: 'h3-api',
    modes: ['ref2va'],
    sections: [
      'subject_definitions',
      'summary',
      'retention_analysis',
      'detailed_description',
      'overall_soundscape',
      'non_diegetic_music',
    ],
    language: '保持已审核执行正文',
  },
  {
    id: 'ark-directed-v1',
    family: 'seedance-2',
    modes: ['t2v', 'i2v', 'ref2va'],
    sections: ['references', 'shots', 'sound'],
    language: '保持已审核执行正文',
  },
  ...(['h3-comfy', 'h3-api', 'seedance-2', 'image'] as const).map((family) => ({
    id:
      family === 'image'
        ? 'canvas-image-v2'
        : family === 'seedance-2'
          ? 'canvas-seedance-v2'
          : 'canvas-h3-v2',
    family,
    modes: family === 'image' ? ['generate', 'edit'] : ['t2v', 'i2v', 'ref2va'],
    sections:
      family === 'image'
        ? ['fixed_references', 'projected_content', 'edit_plan']
        : ['fixed_references', 'projected_shot', 'sound'],
    language: '制作节点 v2：固定业务资料投影与明确参考职责；保持原文，不隐式翻译',
  })),
];
export const protocolLabels: Record<ModelProtocol, string> = {
  codex: 'Codex CLI',
  responses: 'Responses',
  'chat-completions': 'Chat Completions',
  'openai-images': 'Images 生成／编辑',
  'comfy-h3': 'MiniMax H3 · ComfyUI',
  'minimax-video': 'MiniMax H3 · API',
  'ark-video': 'Seedance · 方舟 API',
  'minimax-speech': 'MiniMax Speech',
  cosyvoice: '阿里云 CosyVoice',
  'doubao-speech': '豆包语音 V3',
  'baidu-speech': '百度大模型声音复刻',
  'tencent-speech': '腾讯 VRS / TTS',
  'sync-lipsync': 'Sync · 口型处理',
  'tencent-asr': '腾讯录音识别 · 极速版',
};
export function modelCapabilities(
  preset: ConnectionData['models'][number]['preset'],
  imageInput?: boolean,
): ModelCapabilities {
  const base = { version: 1 as const, verification: 'catalog_declared' as const };
  if (preset === 'tencent-asr')
    return { ...base, kind: 'speech', modes: ['transcribe'], operations: ['transcribe'] };
  if (isSpeechProtocol(preset))
    return {
      ...base,
      kind: 'speech',
      modes: ['clone', 'synthesize'],
      operations: ['clone', 'query_voice', 'synthesize'],
      speech: speechCapabilities[preset],
    };
  if (preset === 'sync-lipsync')
    return {
      ...base,
      kind: 'video',
      modes: ['lipsync'],
      operations: ['lipsync', 'query'],
      supportsGuides: false,
    };
  if (preset === 'text')
    return {
      ...base,
      kind: 'text',
      modes: ['structured_text'],
      ...(imageInput ? { imageInput: true } : {}),
    };
  if (preset === 'image')
    return {
      ...base,
      kind: 'image',
      modes: ['generate', 'edit'],
      maxReferenceImages: 16,
      sizes: ['1024x1024', '1536x1024', '1024x1536'],
      qualities: ['auto', 'low', 'medium', 'high'],
    };
  if (preset === 'h3-comfy')
    return {
      ...base,
      kind: 'video',
      modes: ['t2v', 'i2v', 'ref2va'],
      minSeconds: 5,
      maxSeconds: 15,
      supportsLastFrame: true,
      supportsGuides: true,
      maxReferenceImages: 9,
    };
  return {
    ...base,
    kind: 'video',
    modes: ['t2v', 'i2v', 'ref2va'],
    minSeconds: 4,
    maxSeconds: 15,
    integerSeconds: true,
    supportsLastFrame: true,
    supportsGuides: false,
    maxReferenceImages: 9,
    ...(preset === 'h3-api' ? { maxReferenceVideos: 3, maxReferenceAudio: 3 } : {}),
    resolutions: preset === 'h3-api' ? ['768P', '2K'] : ['480p', '720p', '1080p'],
    ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
  };
}
