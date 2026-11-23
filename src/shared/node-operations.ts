import { z } from 'zod';
import { versionRef } from './domain.js';

export const mediaOperationSchema = z
  .object({
    action: z.enum([
      'crop',
      'mark',
      'grid',
      'frame',
      'trim',
      'extract_audio',
      'separate',
      'analyze',
      'speed',
    ]),
    source: versionRef.optional(),
    start: z.number().finite().nonnegative().default(0),
    end: z.number().finite().positive().optional(),
    frame: z.union([z.enum(['first', 'last']), z.number().int().nonnegative()]).default('first'),
    box: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    rows: z.number().int().min(1).max(12).default(2),
    columns: z.number().int().min(1).max(12).default(2),
    color: z
      .string()
      .regex(/^#[a-fA-F0-9]{6}$/)
      .default('#6957e8'),
    thickness: z.number().int().min(1).max(30).default(4),
    rate: z.number().min(0.25).max(4).default(1),
    threshold: z.number().min(0.01).max(0.99).default(0.3),
    maxShots: z.number().int().min(1).max(100).default(24),
  })
  .strict();
export type MediaOperation = z.infer<typeof mediaOperationSchema>;
export const mediaActions = [
  'crop',
  'mark',
  'grid',
  'frame',
  'trim',
  'extract_audio',
  'separate',
  'analyze',
  'speed',
];
export function transcriptCues(
  segments: { start: number; end: number; text: string }[],
  sourceStart: number,
  sourceEnd: number,
  timelineStart: number,
  playbackRate = 1,
) {
  return segments
    .filter((s) => s.end > sourceStart && s.start < sourceEnd)
    .map((s) => ({
      startFrame: Math.round(
        (timelineStart + (Math.max(s.start, sourceStart) - sourceStart) / playbackRate) * 24,
      ),
      endFrame: Math.round(
        (timelineStart + (Math.min(s.end, sourceEnd) - sourceStart) / playbackRate) * 24,
      ),
      text: s.text,
    }))
    .filter((s) => s.endFrame > s.startFrame);
}
