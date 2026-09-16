import { z } from 'zod';

// Spatial authoring has no provider vocabulary. Coordinates use the existing
// normalized floor plan: x right, y down, heading 0 north / clockwise.
const id = z.string().min(1).max(160);
const text = z.string().max(10000);
export const floorPointSchema = z
  .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
  .strict();
const heading = z.number().min(0).lt(360);
const frame = z.number().int().nonnegative();
export const frameWindowSchema = z
  .object({ startFrame: frame, endFrame: z.number().int().positive() })
  .strict();
export const mouthVisibilitySchema = z
  .object({
    visibility: z.enum(['visible', 'occluded', 'out_of_frame', 'unknown']),
    window: frameWindowSchema.nullable(),
  })
  .strict();
export const attentionSchema = z
  .object({
    subjectKey: id.nullable(),
    point: floorPointSchema.extend({ height: z.number().nonnegative() }).strict().nullable(),
    anchorId: id.nullable(),
    description: text,
  })
  .strict();
const cameraKey = z
  .object({
    frame,
    position: floorPointSchema,
    heading,
    height: z.number().positive(),
    pitch: z.number().min(-89).max(89),
    fov: z.number().min(5).max(150),
  })
  .strict();
export const sceneDesignSchema = z
  .object({
    id,
    sceneId: id,
    environmentKey: id.nullable(),
    applicability: z.enum(['spatial', 'not_applicable']),
    reason: text,
    source: z.object({ id, revision: z.number().int().positive() }).strict().nullable(),
    scale: z.enum(['schematic', 'measured']),
    space: z
      .object({
        width: z.number().positive(),
        depth: z.number().positive(),
        height: z.number().positive(),
      })
      .strict()
      .nullable(),
    regions: z.array(
      z
        .object({
          id,
          name: text,
          x: z.number().min(0).max(1),
          y: z.number().min(0).max(1),
          width: z.number().positive().max(1),
          height: z.number().positive().max(1),
        })
        .strict(),
    ),
    barriers: z.array(
      z
        .object({
          id,
          name: text,
          kind: z.enum(['wall', 'door']),
          start: floorPointSchema,
          end: floorPointSchema,
          height: z.number().positive(),
          thickness: z.number().positive(),
          open: z.boolean(),
          regions: z.array(id),
        })
        .strict(),
    ),
    anchors: z.array(
      z
        .object({
          id,
          subjectKey: id,
          label: text,
          kind: z.enum(['contact', 'operate', 'support', 'passage', 'look']),
          // Local coordinates on the subject proxy; normalHeading is relative to its heading.
          position: floorPointSchema
            .extend({ height: z.number().nonnegative() })
            .strict()
            .nullable(),
          normalHeading: heading.nullable(),
          reach: z.number().positive().nullable(),
        })
        .strict(),
    ),
    cameras: z.array(cameraKey.omit({ frame: true }).extend({ id, name: text }).strict()),
    proxies: z.array(
      z
        .object({
          subjectKey: id,
          shape: z.enum(['box', 'capsule', 'cylinder']),
          width: z.number().positive(),
          depth: z.number().positive(),
          height: z.number().positive(),
          color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        })
        .strict(),
    ),
    assumptions: z.array(text),
  })
  .strict();
const pose = z
  .object({ subjectKey: id, position: floorPointSchema.nullable(), heading: heading.nullable() })
  .strict();
export const shotStagingSchema = z
  .object({
    sceneDesignId: id,
    cameraId: id.nullable(),
    entry: z.array(pose),
    exit: z.array(pose),
    paths: z.array(
      z
        .object({
          subjectKey: id,
          keys: z.array(z.object({ frame, position: floorPointSchema, heading }).strict()).min(2),
        })
        .strict(),
    ),
    cameraKeys: z.array(cameraKey),
    axis: z
      .object({ from: floorPointSchema, to: floorPointSchema, crossingReason: text })
      .strict()
      .nullable(),
    doors: z.array(z.object({ barrierId: id, frame, open: z.boolean() }).strict()),
  })
  .strict();
export const interactionSchema = z
  .object({
    id,
    eventId: id,
    actorKey: id,
    targetKey: id,
    anchorId: id.nullable(),
    kind: z.enum(['observe', 'contact', 'operate', 'transfer', 'support', 'traverse']),
    effector: text,
    precondition: text,
    action: text,
    result: text,
    required: z.boolean(),
  })
  .strict();
export const referenceCoverageSchema = z
  .object({
    shotId: id,
    interactionIds: z.array(id),
    aspects: z
      .array(
        z.enum(['identity', 'space', 'prop', 'interaction', 'composition', 'style', 'boundary']),
      )
      .min(1),
  })
  .strict();
export type SceneDesign = z.infer<typeof sceneDesignSchema>;
export type ShotStaging = z.infer<typeof shotStagingSchema>;
