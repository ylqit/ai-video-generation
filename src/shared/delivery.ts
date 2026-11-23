import { z } from 'zod';
import { creationRefSchema, durationIntentSchema } from './creation.js';
import { edlSchema } from './contracts.js';

export const deliveryTargetSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('work') }).strict(),
  z.object({ mode: z.literal('scope'), scope: creationRefSchema }).strict(),
]);
export type DeliveryTarget = z.infer<typeof deliveryTargetSchema>;
export const deliveryCreateSchema = z
  .object({
    runRevision: z.number().int().positive(),
    target: deliveryTargetSchema,
    duration: durationIntentSchema.optional(),
    edlDraft: edlSchema,
    pendingChecks: z.array(z.string().min(1)).default([]),
    idempotencyKey: z.string().min(8),
  })
  .strict();
export const deliveryUpdateSchema = z
  .object({
    revision: z.number().int().positive(),
    runRevision: z.number().int().positive(),
    duration: durationIntentSchema,
    edlDraft: edlSchema,
    pendingChecks: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const deliveryConfirmSchema = z
  .object({
    revision: z.number().int().positive(),
    planRef: creationRefSchema.optional(),
    exportAsset: creationRefSchema,
    watched: z.boolean().default(false),
    listened: z.boolean().default(false),
    conclusion: z.string().trim().default(''),
    idempotencyKey: z.string().min(8),
    canon: z.unknown().optional(),
  })
  .strict();
