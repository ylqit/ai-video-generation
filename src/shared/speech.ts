import { z } from 'zod';

export const speechProtocols = [
  'minimax-speech',
  'cosyvoice',
  'doubao-speech',
  'baidu-speech',
  'tencent-speech',
] as const;
export type SpeechProtocol = (typeof speechProtocols)[number];
export const voiceRefSchema = z
  .object({ id: z.string().min(1), revision: z.number().int().positive() })
  .strict();
export const voiceStates = [
  'draft',
  'awaiting_clone',
  'processing',
  'verification_required',
  'auditionable',
  'confirmed',
  'unavailable',
] as const;
export const voiceStateLabels: Record<string, string> = {
  draft: '草稿',
  awaiting_clone: '待复刻',
  processing: '远端处理中',
  verification_required: '需供应商验证',
  auditionable: '可试听',
  confirmed: '已确认',
  unavailable: '不可用',
};
export const voiceSampleSchema = z
  .object({
    media: voiceRefSchema,
    in: z.number().nonnegative(),
    out: z.number().positive(),
    transcript: z.string().default(''),
    source: z.string().min(1),
    purpose: z.enum(['reference', 'clone']),
    listened: z.boolean().default(false),
    notes: z.string().default(''),
  })
  .strict()
  .refine((v) => v.out > v.in, '样本结束必须晚于开始');
export const globalVoiceSchema = z
  .object({
    version: z.literal(1).default(1),
    name: z.string().trim().min(1).max(160),
    language: z.string().default('zh'),
    description: z.string().default(''),
    tags: z.array(z.string().max(80)).max(40).default([]),
    pronunciation: z.string().default(''),
    performance: z.string().default(''),
    samples: z.array(voiceSampleSchema).default([]),
    // Remote identity is written only by explicit registration or a persisted provider receipt.
    handle: z
      .object({
        connection: voiceRefSchema,
        protocol: z.enum(speechProtocols),
        modelId: z.string().min(1),
        region: z.string(),
        voiceId: z.string().min(1),
        expiresAt: z.number().nullable().default(null),
        providerStatus: z.string(),
        jobId: z.string().optional(),
      })
      .strict()
      .nullable()
      .default(null),
    state: z.enum(voiceStates).default('draft'),
    audition: voiceRefSchema.nullable().default(null),
    review: z
      .object({ listened: z.literal(true), notes: z.string().trim().min(1), at: z.number() })
      .strict()
      .nullable()
      .default(null),
  })
  .strict();
export type GlobalVoice = z.infer<typeof globalVoiceSchema>;
// Availability belongs to the actual provider identity, not a local description revision.
// Exclude mutable status/expiry and local evidence IDs; keep account, region and target model.
export function voiceHandleIdentity(handle: NonNullable<GlobalVoice['handle']>) {
  return {
    protocol: handle.protocol,
    connection: handle.connection,
    region: handle.region,
    modelId: handle.modelId,
    voiceId: handle.voiceId,
  };
}
export const performanceSchema = z
  .object({
    speed: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
    volume: z.number().finite().optional(),
    emotion: z.string().optional(),
    instructions: z.string().default(''),
  })
  .strict();
export const speechAllowanceSchema = z
  .object({
    enabled: z.boolean().default(false),
    connections: z.array(voiceRefSchema).default([]),
    maxVoiceCreations: z.number().int().nonnegative().default(0),
    maxSpeechRequests: z.number().int().nonnegative().default(0),
    maxSpeechCharacters: z.number().int().nonnegative().default(0),
    maxLipSyncRequests: z.number().int().nonnegative().default(0),
    maxLipSyncSeconds: z.number().nonnegative().default(0),
    maxTranscriptionRequests: z.number().int().nonnegative().default(0),
    maxTranscriptionSeconds: z.number().nonnegative().default(0),
  })
  .strict();
export const voiceApplicationSchema = z
  .object({
    version: z.literal(2),
    name: z.string().min(1),
    entity: voiceRefSchema,
    globalVoice: voiceRefSchema,
    language: z.string().min(1),
    pronunciation: z.string().default(''),
    timbre: z.string().min(1),
    performance: z.string().default(''),
    route: z.enum(['native', 'imported', 'tts']).default('tts'),
    requireVoiceIdentity: z.boolean().default(true),
  })
  .strict();

// Protocol limits are owned by the implemented adapter catalogue, not duplicated by forms.
export const speechCapabilities = {
  'minimax-speech': {
    minSampleSeconds: 10,
    maxSampleSeconds: 300,
    maxSampleBytes: 20 * 1024 ** 2,
    formats: ['wav', 'mp3', 'm4a'],
    maxCharacters: 10000,
    controls: ['speed', 'pitch', 'volume', 'emotion'],
    ranges: { speed: [0.5, 2], volume: [0, 10], pitch: [-12, 12] },
    clone: 'immediate',
    remoteCancel: false,
  },
  cosyvoice: {
    minSampleSeconds: 10,
    maxSampleSeconds: 20,
    maxSampleBytes: 10 * 1024 ** 2,
    formats: ['wav', 'mp3', 'm4a'],
    maxCharacters: 2000,
    controls: ['speed', 'pitch', 'volume'],
    ranges: { speed: [0.5, 2], volume: [0, 100], pitch: [0.5, 2] },
    clone: 'async',
    remoteCancel: false,
  },
  'doubao-speech': {
    minSampleSeconds: 10,
    maxSampleSeconds: 25,
    maxSampleBytes: 10 * 1024 ** 2,
    formats: ['wav', 'mp3', 'm4a'],
    maxCharacters: 1024,
    controls: ['speed', 'volume'],
    ranges: { speed: [-50, 100], volume: [-50, 100] },
    clone: 'async',
    remoteCancel: false,
  },
  'baidu-speech': {
    minSampleSeconds: 5,
    maxSampleSeconds: 20,
    maxSampleBytes: 5 * 1024 ** 2,
    formats: ['wav', 'mp3', 'm4a', 'ogg'],
    maxCharacters: 500,
    controls: ['speed', 'volume', 'pitch', 'emotion'],
    ranges: { speed: [0, 15], volume: [0, 15], pitch: [0, 15] },
    clone: 'immediate',
    remoteCancel: false,
  },
  'tencent-speech': {
    minSampleSeconds: 5,
    maxSampleSeconds: 15,
    maxSampleBytes: 2 * 1024 ** 2,
    formats: ['wav', 'mp3', 'm4a', 'aac'],
    maxCharacters: 150,
    controls: ['speed', 'volume'],
    ranges: { speed: [-2, 6], volume: [-10, 10] },
    clone: 'async',
    remoteCancel: false,
  },
} as const;
export function isSpeechProtocol(protocol: string): protocol is SpeechProtocol {
  return (speechProtocols as readonly string[]).includes(protocol);
}
