import { z } from 'zod';
import { contextReferencesSchema } from './workbench-context.js';
import { versionRef } from './domain.js';
import { executionSelectionSchema } from './models.js';
import { nodeTypes } from './node-catalog.js';

export const canvasNodeSchema = z
  .object({
    id: z.string().min(1).max(160),
    type: z.enum(nodeTypes),
    title: z.string().max(200),
    x: z.number().finite(),
    y: z.number().finite(),
    text: z.string().max(100000).default(''),
    document: versionRef.optional(),
    asset: versionRef.optional(),
    selected: z.boolean().default(false),
    binding: versionRef
      .extend({ shotId: z.string().optional(), path: z.string().optional() })
      .optional(),
    groupId: z.string().optional(),
    collapsed: z.boolean().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    outputs: z
      .array(
        z.object({
          key: z.string(),
          jobId: z.string(),
          asset: versionRef.optional(),
          document: versionRef.optional(),
          slot: z.string(),
          label: z.string(),
        }),
      )
      .optional(),
    range: z.object({ in: z.number().nonnegative(), out: z.number().positive() }).optional(),
    generation: z
      .object({
        model: executionSelectionSchema,
        mode: z.enum(['t2v', 'i2v', 'ref2va', 'generate', 'edit']),
        seconds: z.number().positive().max(900).default(10),
        sound: z.string().max(8000).default(''),
        music: z.string().max(8000).default(''),
      })
      .optional(),
  })
  .strict();
export const canvasEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().min(1),
    target: z.string().min(1),
    relation: z.enum(['organize', 'input', 'result']),
    asset: versionRef.optional(),
    purpose: z
      .enum([
        'identity',
        'style',
        'scene',
        'prop',
        'composition',
        'first_frame',
        'last_frame',
        'audio',
        'motion',
      ])
      .optional(),
    instruction: z.string().max(8000).default(''),
    sourceHandle: z.string().optional(),
    targetHandle: z.string().optional(),
    order: z.number().int().nonnegative().optional(),
  })
  .strict();
export const canvasSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    title: z.string().min(1).max(200),
    episodeId: z.string().nullable().default(null),
    forkedFrom: versionRef.optional(),
    nodes: z.array(canvasNodeSchema).max(5000),
    edges: z.array(canvasEdgeSchema).max(20000),
    edl: versionRef.optional(),
    agentRunId: z.string().optional(),
    sessionId: z.string().optional(),
    viewport: z
      .object({ x: z.number().finite(), y: z.number().finite(), zoom: z.number().min(0.1).max(4) })
      .default({ x: 0, y: 0, zoom: 1 }),
  })
  .strip()
  .superRefine((v, ctx) => {
    const ids = new Set(v.nodes.map((n) => n.id));
    if (ids.size !== v.nodes.length || new Set(v.edges.map((e) => e.id)).size !== v.edges.length)
      ctx.addIssue({ code: 'custom', message: '节点与连线 ID 必须唯一' });
    for (const edge of v.edges) {
      if (!ids.has(edge.source) || !ids.has(edge.target) || edge.source === edge.target)
        ctx.addIssue({ code: 'custom', message: '连线需要两个不同且存在的节点' });
      if (
        edge.relation === 'input' &&
        !edge.purpose &&
        (v.version === 1 || !['text', 'context'].includes(edge.targetHandle || ''))
      )
        ctx.addIssue({ code: 'custom', message: '模型输入需要明确参考用途' });
    }
  });
export type CanvasContent = z.infer<typeof canvasSchema>;
export type CanvasNode = z.infer<typeof canvasNodeSchema>;

export const canvasAssistantSchema = z
  .object({
    revision: z.number().int().positive(),
    goal: z.string().trim().min(1).max(10000),
    nodeIds: z.array(z.string()).default([]),
    writeScope: z.enum(['canvas', 'selected', 'new']).optional(),
    references: contextReferencesSchema.default([]),
    permissions: z.array(
      z.enum(['write', 'generate', 'select', 'edit', 'export', 'extract', 'analyze', 'derive']),
    ),
    models: z.array(executionSelectionSchema).min(1).max(20),
    budget: z.object({
      maxSteps: z.number().int().min(1).max(100).default(20),
      imageRequests: z.number().int().nonnegative().default(0),
      images: z.number().int().nonnegative().default(0),
      videoRequests: z.number().int().nonnegative().default(0),
      videoSeconds: z.number().nonnegative().default(0),
      speechRequests: z.number().int().nonnegative().default(0),
      speechCharacters: z.number().int().nonnegative().default(0),
      lipSyncRequests: z.number().int().nonnegative().default(0),
      lipSyncSeconds: z.number().nonnegative().default(0),
      analysisRequests: z.number().int().nonnegative().default(0),
      analysisImages: z.number().int().nonnegative().default(0),
      transcriptionRequests: z.number().int().nonnegative().default(0),
      transcriptionSeconds: z.number().nonnegative().default(0),
    }),
    idempotencyKey: z.string().min(8),
  })
  .strict();
