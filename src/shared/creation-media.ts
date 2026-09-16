import { z } from 'zod';
import { authoringStages, creationOverlaySchema, creationRefSchema } from './creation.js';
import { scopedRevisionSchema } from './workspace.js';

export const messageReferenceSchema = creationRefSchema
  .extend({
    subjectKey: z.string().min(1).optional(),
    shotId: z.string().min(1).optional(),
    sceneId: z.string().min(1).optional(),
  })
  .strict();
export const creationMessageSchema = z
  .object({
    revision: z.number().int().positive(),
    mode: z.enum(['discuss', 'revise', 'execute']),
    request: z.string().trim().min(1).max(100000),
    references: z.array(messageReferenceSchema).max(100).default([]),
    idempotencyKey: z.string().min(8),
    stage: z.enum(authoringStages).optional(),
    writable: scopedRevisionSchema.optional(),
    action: z
      .object({ type: z.string().min(1) })
      .strict()
      .optional(),
  })
  .strict();
export const discussionResponseSchema = z
  .object({
    answer: z.string().trim().min(1).max(100000),
    resultLinks: z
      .array(creationRefSchema.extend({ title: z.string().max(200) }).strict())
      .max(100),
  })
  .strict();
export const deliveryManifestSchema = z
  .object({
    taskId: z.string(),
    taskRevision: z.number().int().positive(),
    deliveryId: z.string().min(1),
    assets: z.array(z.object({ viewId: z.string(), file: z.string() }).strict()).min(1),
    executionReceipt: z
      .object({
        reportedCalls: z.number().int().nonnegative(),
        tool: z.string().min(1),
        notes: z.string().max(10000).default(''),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SubtitleCue = z.infer<typeof creationOverlaySchema>;

// SRT times are milliseconds. EDL uses explicit 24 fps frame boundaries.
export function parseSrt(text: string): SubtitleCue[] {
  const blocks = text
    .replace(/^\uFEFF/, '')
    .replace(/\r/g, '')
    .trim()
    .split(/\n\s*\n/);
  if (!text.trim()) return [];
  return blocks.map((block, index) => {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0])) lines.shift();
    const match = /^(\d{2,}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2,}):(\d{2}):(\d{2}),(\d{3})$/.exec(
      lines.shift() || '',
    );
    if (!match || !lines.join('\n').trim()) throw new Error(`SRT 第 ${index + 1} 段格式无效`);
    const values = match.slice(1).map(Number);
    if ([values[1], values[2], values[5], values[6]].some((v) => v > 59))
      throw new Error(`SRT 第 ${index + 1} 段时间无效`);
    const seconds = (offset: number) =>
      values[offset] * 3600 +
      values[offset + 1] * 60 +
      values[offset + 2] +
      values[offset + 3] / 1000;
    const startFrame = Math.round(seconds(0) * 24),
      endFrame = Math.round(seconds(4) * 24);
    if (endFrame <= startFrame) throw new Error(`SRT 第 ${index + 1} 段结束时间必须晚于开始时间`);
    return {
      id: `srt-${index + 1}`,
      text: lines.join('\n'),
      sourceDialogueId: null,
      startFrame,
      endFrame,
      position: 'bottom',
      fontSize: 32,
      color: '#ffffff',
    };
  });
}
export function renderSrt(cues: SubtitleCue[]): string {
  const time = (frame: number) => {
    const ms = Math.round((frame / 24) * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
  };
  return cues
    .map((raw, i) => {
      const cue = creationOverlaySchema.parse(raw);
      if (cue.endFrame <= cue.startFrame) throw new Error('字幕结束时间必须晚于开始时间');
      return `${i + 1}\n${time(cue.startFrame)} --> ${time(cue.endFrame)}\n${cue.text}`;
    })
    .join('\n\n');
}
