import { z } from 'zod';
import { creationRefSchema } from './creation.js';

// Editorial intent is metadata, separate from the V9 r2 professional result.
export const adaptationIntentSchema = z
  .object({
    version: z.literal(1),
    mode: z.enum(['original', 'faithful_adaptation', 'local_revision']),
    method: z.enum(['general', 'short_drama']).optional(),
    preserve: z.array(z.string().trim().min(1)).default([]),
    allow: z.array(z.string().trim().min(1)).default([]),
    pending: z.array(z.string().trim().min(1)).default([]),
    decisions: z
      .array(
        z
          .object({
            id: z.string().min(1),
            source: creationRefSchema,
            eventId: z.string().min(1),
            change: z.enum(['presentation', 'story']),
            before: z.string().min(1),
            after: z.string().min(1),
            reason: z.string().min(1),
            approved: z.boolean(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type AdaptationIntent = z.infer<typeof adaptationIntentSchema>;

export const sourceIndexSchema = z
  .object({
    version: z.literal(1),
    entries: z
      .array(
        z
          .object({
            id: z.string().min(1),
            title: z.string().min(1),
            source: creationRefSchema,
            start: z.number().int().nonnegative(),
            end: z.number().int().positive(),
            events: z.array(
              z
                .object({
                  id: z.string().min(1),
                  statement: z.string().min(1),
                  locked: z.boolean(),
                })
                .strict(),
            ),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
