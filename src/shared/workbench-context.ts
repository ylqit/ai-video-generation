import { z } from 'zod';
import { versionRef } from './domain.js';

const selection = {
  range: z.object({ in: z.number().nonnegative(), out: z.number().positive() }).optional(),
  textRange: z
    .object({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
      expected: z.string().max(30000),
    })
    .optional(),
  imageHandling: z.enum(['image', 'metadata']).default('image'),
};
export const contextReferenceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('node'),
      canvas: versionRef,
      nodeId: z.string().min(1),
      ...selection,
    })
    .strict(),
  z
    .object({
      kind: z.literal('output'),
      canvas: versionRef,
      nodeId: z.string().min(1),
      outputKey: z.string().min(1),
      ...selection,
    })
    .strict(),
  z.object({ kind: z.literal('asset'), object: versionRef, ...selection }).strict(),
  z.object({ kind: z.literal('document'), object: versionRef, ...selection }).strict(),
]);
export const contextReferencesSchema = z.array(contextReferenceSchema).max(20);
export type ContextReference = z.infer<typeof contextReferenceSchema>;
export function contextReferenceKey(r: ContextReference) {
  return JSON.stringify([
    r.kind,
    'canvas' in r
      ? [r.canvas.id, r.canvas.revision, r.nodeId, r.kind === 'output' ? r.outputKey : null]
      : [r.object.id, r.object.revision],
    r.range ? [r.range.in, r.range.out] : null,
    r.textRange ? [r.textRange.start, r.textRange.end, r.textRange.expected] : null,
    r.imageHandling || 'image',
  ]);
}
