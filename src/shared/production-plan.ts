import { z } from 'zod';
import type { CreationRef, DurationIntent } from './creation.js';

export const deliveryCanvasSchema = z
  .object({
    width: z.number().int().min(128).max(3840).multipleOf(2),
    height: z.number().int().min(128).max(3840).multipleOf(2),
    mismatch: z.enum(['require_match', 'letterbox']).default('require_match'),
  })
  .strict();

export interface EffectiveEpisodePlan {
  version: 1;
  episode: CreationRef;
  series: CreationRef | null;
  slotId: string | null;
  duration: DurationIntent;
  runtime: { targetFrames: number; toleranceFrames: number } | null;
  canvas: z.infer<typeof deliveryCanvasSchema>;
  origins: {
    duration: 'episode' | 'slot' | 'series' | 'project' | 'request';
    canvas: 'episode' | 'series' | 'project';
  };
  dependencies: CreationRef[];
  warnings: string[];
}

export interface PredecessorStatus {
  status: 'confirmed' | 'waiting' | 'independent' | 'starting_point';
  canon: CreationRef | null;
  waiting: string | null;
  hypothetical: boolean;
  reason: string;
}

export function formatComparison(plan: EffectiveEpisodePlan, width: number, height: number) {
  const matches = width * plan.canvas.height === height * plan.canvas.width;
  return {
    generation: { width, height },
    delivery: plan.canvas,
    matches,
    ready: matches || plan.canvas.mismatch === 'letterbox',
    treatment: matches ? 'same_aspect' : plan.canvas.mismatch,
    message: matches
      ? '生成与交付画幅一致'
      : plan.canvas.mismatch === 'letterbox'
        ? '明确采用等比留边；字幕位于交付画布，不进行自动主体裁切'
        : '生成与交付画幅不同；请重新准备构图或在制作要求中明确选择留边',
  };
}
