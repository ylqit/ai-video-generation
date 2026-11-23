import { z } from 'zod';
import { versionRef } from './domain.js';
export const imageEditPlanSchema = z
  .object({
    version: z.literal(1),
    action: z.enum(['inpaint', 'relight', 'angle', 'panorama']),
    source: versionRef,
    instruction: z.string().trim().min(1).max(10000),
    box: z
      .object({
        x: z.number().int().nonnegative(),
        y: z.number().int().nonnegative(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    azimuth: z.number().min(-180).max(180).default(0),
    elevation: z.number().min(-90).max(90).default(0),
    strength: z.number().min(0).max(2).default(1),
  })
  .strict()
  .refine((p) => p.action !== 'inpaint' || !!p.box, '局部重绘需要明确选区');
export function imageEditInstructions(p: z.infer<typeof imageEditPlanSchema>) {
  if (p.action === 'inpaint')
    return `Edit only the rectangle x=${p.box!.x}, y=${p.box!.y}, width=${p.box!.width}, height=${p.box!.height} in original image pixel coordinates. The additional green outline marks the editable region; remove the outline in the result. Keep composition and identity. ${p.instruction}`;
  if (p.action === 'relight')
    return `Image editing request: relight the existing scene from azimuth ${p.azimuth} degrees, elevation ${p.elevation} degrees, relative intensity ${p.strength}. Preserve identity and composition. ${p.instruction}`;
  return `Image editing request: ${p.action === 'angle' ? 'change viewpoint' : 'prepare a panorama-derived composition'} with azimuth ${p.azimuth} degrees and elevation ${p.elevation} degrees. Preserve subject identity and authored state. ${p.instruction}`;
}
