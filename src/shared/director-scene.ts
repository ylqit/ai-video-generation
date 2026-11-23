import { z } from 'zod';
const vector = z.object({
  x: z.number().min(-1000).max(1000),
  y: z.number().min(-1000).max(1000),
  z: z.number().min(-1000).max(1000),
});
const pose = z.object({
  frame: z.number().int().nonnegative(),
  position: vector,
  rotation: vector.default({ x: 0, y: 0, z: 0 }),
});
export const directorSceneSchema = z
  .object({
    version: z.literal(1).default(1),
    frames: z.number().int().min(1).max(7200).default(120),
    width: z.number().int().min(128).max(1920).default(960),
    height: z.number().int().min(128).max(1920).default(540),
    background: z
      .string()
      .regex(/^#[\da-f]{6}$/i)
      .default('#eae8f5'),
    objects: z
      .array(
        z.object({
          id: z.string().min(1),
          name: z.string().default('对象'),
          shape: z.enum(['box', 'sphere', 'cylinder', 'person']),
          color: z.string().regex(/^#[\da-f]{6}$/i),
          size: vector,
          keys: z.array(pose).min(1).max(300),
        }),
      )
      .max(150)
      .default([]),
    camera: z
      .object({
        focalLength: z.number().min(10).max(300).default(35),
        target: vector.default({ x: 0, y: 1, z: 0 }),
        keys: z.array(pose).min(1).max(300),
      })
      .default({
        focalLength: 35,
        target: { x: 0, y: 1, z: 0 },
        keys: [{ frame: 0, position: { x: 5, y: 3, z: 8 }, rotation: { x: 0, y: 0, z: 0 } }],
      }),
    light: z
      .object({
        position: vector.default({ x: 4, y: 7, z: 4 }),
        intensity: z.number().min(0).max(10).default(3),
        ambient: z.number().min(0).max(5).default(1),
      })
      .default({ position: { x: 4, y: 7, z: 4 }, intensity: 3, ambient: 1 }),
  })
  .superRefine((s, c) => {
    if (s.width % 2 || s.height % 2) c.addIssue({ code: 'custom', message: '输出尺寸需为偶数' });
    if (new Set(s.objects.map((o) => o.id)).size !== s.objects.length)
      c.addIssue({ code: 'custom', message: '代理对象 ID 重复' });
    for (const o of [...s.objects, s.camera])
      if (
        new Set(o.keys.map((k) => k.frame)).size !== o.keys.length ||
        o.keys.some((k) => k.frame >= s.frames)
      )
        c.addIssue({ code: 'custom', message: '关键帧重复或超出片段' });
    if (s.objects.some((o) => Object.values(o.size).some((v) => v <= 0)))
      c.addIssue({ code: 'custom', message: '代理物尺寸需为正数' });
  });
export type DirectorScene = z.infer<typeof directorSceneSchema>;
export function directorPose(keys: DirectorScene['camera']['keys'], frame: number) {
  const sorted = [...keys].sort((a, b) => a.frame - b.frame),
    a = [...sorted].reverse().find((k) => k.frame <= frame) || sorted[0],
    b = sorted.find((k) => k.frame >= frame) || sorted.at(-1)!;
  const t = a.frame === b.frame ? 0 : (frame - a.frame) / (b.frame - a.frame);
  const mix = (x: { x: number; y: number; z: number }, y: typeof x) => ({
    x: x.x + (y.x - x.x) * t,
    y: x.y + (y.y - x.y) * t,
    z: x.z + (y.z - x.z) * t,
  });
  return { position: mix(a.position, b.position), rotation: mix(a.rotation, b.rotation) };
}
