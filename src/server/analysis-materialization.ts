import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { canvasSchema } from '../shared/canvas.js';
import { transcriptCues } from '../shared/node-operations.js';
import { timelineMap } from '../shared/edit-timeline.js';
import { generationDigest } from './h3-guided.js';

// Materialization is a user edit. Raw analysis and original recognition times remain immutable.
export function materializeAnalysis(store: Store, canvasId: string, raw: unknown) {
  const body = z
    .object({
      revision: z.number().int().positive(),
      analysis: z.object({ id: z.string(), revision: z.number().int().positive() }),
      action: z.enum(['text', 'frames', 'shots', 'subtitles', 'apply_text']),
      indices: z.array(z.number().int().nonnegative()).default([]),
      clipIndex: z.number().int().nonnegative().optional(),
      idempotencyKey: z.string().min(8),
    })
    .parse(raw);
  return store.transaction(() => {
    const key = 'analysis-materialize:' + body.idempotencyKey,
      prior = store.setting<any>(key, null),
      digest = generationDigest({ canvasId, ...body, revision: undefined });
    if (prior) {
      if (prior.digest !== digest) throw new HttpError(409, '操作标识已用于其他内容');
      return prior.result;
    }
    const service = new CanvasService(store),
      canvas = service.get(canvasId),
      analysis = store.get(body.analysis.id, body.analysis.revision);
    if (canvas.revision !== body.revision) throw new HttpError(409, '画布已变化，请重新查看结果');
    if (analysis.kind !== 'node_analysis' || analysis.projectId !== canvas.projectId)
      throw new HttpError(400, '分析来源不属于当前作品');
    const data = canvasSchema.parse(canvas.data),
      sourceNode = data.nodes.find(
        (n) =>
          n.binding?.id === analysis.id || n.outputs?.some((o) => o.document?.id === analysis.id),
      );
    if (!sourceNode) throw new HttpError(400, '分析未关联到此画布');
    const added: string[] = [];
    if (body.action === 'apply_text') {
      const job = store.job(analysis.data.jobId),
        node = data.nodes.find((n) => n.id === job.input.canvasNodeId),
        range = job.input.nodeOperation.textRange;
      if (
        job.input.canvas?.id !== canvasId ||
        !node ||
        !['document', 'note'].includes(node.type) ||
        !['rewrite', 'text_generate'].includes(analysis.data.kind)
      )
        throw new HttpError(400, '结果没有可修改的原文节点');
      if (node.text !== job.input.originalNodeText)
        throw new HttpError(409, '原文已被修改；请比较候选，不能覆盖用户的新内容');
      node.text = range
        ? node.text.slice(0, range.start) + analysis.data.content + node.text.slice(range.end)
        : analysis.data.content;
      const saved = service.save(canvasId, canvas.revision, data),
        result = { canvasRevision: saved.revision, nodeId: node.id };
      store.setSetting(key, { digest, result });
      return result;
    }
    if (body.action === 'subtitles') {
      if (!data.edl || body.clipIndex === undefined)
        throw new HttpError(400, '请选择已保存时间线中的来源片段');
      const edl = store.get(data.edl.id, data.edl.revision),
        clip = edl.data.clips[body.clipIndex],
        sources = analysis.data.sources || [analysis.data.source];
      if (
        !clip ||
        !sources.some((s: any) => s?.id === clip.assetId && s.revision === clip.revision)
      )
        throw new HttpError(400, '字幕必须对应实际源素材版本；派生配音请先建立明确时间映射');
      const map = timelineMap(edl.data),
        span = map.clips[body.clipIndex];
      const cues = transcriptCues(
        analysis.data.editedSegments || analysis.data.segments || [],
        clip.in,
        clip.out,
        span.startFrame / 24,
      );
      if (!cues.length) throw new HttpError(400, '所选范围没有句子时间戳');
      const overlays = cues.map((c, i) => ({
        ...c,
        id: `asr:${analysis.id}:${analysis.revision}:${body.clipIndex}:${i}`,
        sourceDialogueId: null,
        position: 'bottom',
        fontSize: 36,
        color: '#ffffff',
      }));
      const next = service.saveTimeline(canvasId, canvas.revision, {
        ...edl.data,
        schemaVersion: 3,
        overlays: [
          ...(edl.data.overlays || []).filter((o: any) => !overlays.some((n) => n.id === o.id)),
          ...overlays,
        ],
      });
      const result = { edl: { id: next.id, revision: next.revision }, count: cues.length };
      store.setSetting(key, { digest, result });
      return result;
    }
    const items =
      body.action === 'text'
        ? [null]
        : (analysis.data.shots || []).filter(
            (s: any) => !body.indices.length || body.indices.includes(s.index),
          );
    for (const [i, shot] of items.entries()) {
      const id = `analysis:${analysis.id}:${analysis.revision}:${body.action}:${shot?.index ?? 0}`;
      if (data.nodes.some((n) => n.id === id)) continue;
      if (body.action === 'frames' && !shot?.frame) continue;
      data.nodes.push({
        id,
        type: body.action === 'text' ? 'document' : body.action === 'frames' ? 'image' : 'shot',
        title: body.action === 'text' ? analysis.data.title : `镜头 ${(shot?.index ?? 0) + 1}`,
        text:
          body.action === 'text'
            ? analysis.data.content ||
              analysis.data.shots
                ?.map((s: any) => `${s.start}–${s.end}秒：${s.description || '尚未视觉分析'}`)
                .join('\n') ||
              ''
            : shot?.description || '',
        x: sourceNode.x + 360,
        y: sourceNode.y + i * 270,
        selected: false,
        ...(body.action === 'frames'
          ? { asset: shot.frame }
          : body.action === 'shots'
            ? { binding: { ...body.analysis, path: `shots.${shot.index}` } }
            : {}),
      });
      data.edges.push({
        id: 'source:' + id,
        source: sourceNode.id,
        target: id,
        relation: 'result',
        instruction: '固定分析结果派生',
      });
      added.push(id);
    }
    const next = added.length ? service.save(canvasId, canvas.revision, data) : canvas;
    const result = { canvasRevision: next.revision, added };
    store.setSetting(key, { digest, result });
    return result;
  });
}
export function registerAnalysisMaterializationRoutes(app: Express, store: Store) {
  app.post('/api/canvases/:id/analysis-materialize', (req, res) =>
    res.json(materializeAnalysis(store, String(req.params.id), req.body)),
  );
}
