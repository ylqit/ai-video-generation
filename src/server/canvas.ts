import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { Store, HttpError } from './db.js';
import { StudioService } from './service.js';
import { DomainService } from './domain-service.js';
import { canvasSchema, type CanvasContent } from '../shared/canvas.js';
import { generationDigest } from './h3-guided.js';
import { prepareCanvasGeneration } from './canvas-generation.js';
import { edlSchema, type RecordDoc } from '../shared/contracts.js';
import { nodeMediaType } from '../shared/node-catalog.js';
import { resolveNodeContext } from './node-context.js';
import { validateCanvasPorts } from './canvas-patches.js';

export class CanvasService {
  constructor(public store: Store) {}
  get(id: string) {
    const doc = this.store.get(id);
    if (doc.kind !== 'canvas') throw new HttpError(400, '不是创作画布');
    return doc;
  }
  create(projectId: string, raw: unknown) {
    new StudioService(this.store).project(projectId);
    const data = canvasSchema.parse(raw);
    this.validate(projectId, data);
    return this.store.transaction(() => {
      const doc = this.store.create(
        'canvas',
        projectId,
        { ...data, nodes: [], edges: [] },
        data.episodeId || projectId,
      );
      return data.nodes.length ? this.save(doc.id, doc.revision, data) : doc;
    });
  }
  validate(projectId: string, data: CanvasContent) {
    if (data.version === 2) validateCanvasPorts(data);
    const service = new StudioService(this.store);
    if (data.forkedFrom)
      service.owned(data.forkedFrom.id, projectId, 'canvas', data.forkedFrom.revision);
    if (data.episodeId) service.owned(data.episodeId, projectId, 'episode');
    for (const edge of data.edges)
      if (edge.asset) {
        if (edge.relation !== 'input') throw new HttpError(400, '只有实际输入连线可以固定媒体');
        service.owned(edge.asset.id, projectId, 'asset', edge.asset.revision);
      }
    for (const node of data.nodes) {
      if (node.binding) resolveNodeContext(this.store, projectId, node);
      for (const output of node.outputs || []) {
        const job = this.store.job(output.jobId),
          ref = output.asset || output.document;
        if (!ref || job.projectId !== projectId) throw new HttpError(400, '任务输出归属不匹配');
        const result = this.store.get(ref.id, ref.revision);
        if (
          result.projectId !== projectId ||
          result.data.jobId !== job.id ||
          (output.asset && result.kind !== 'asset') ||
          (output.document && !job.output.documentIds?.includes(ref.id))
        )
          throw new HttpError(400, '输出没有真实任务来源');
      }
      if (node.document)
        service.owned(node.document.id, projectId, 'chapter', node.document.revision);
      if (!node.asset) continue;
      const asset = service.owned(node.asset.id, projectId, 'asset', node.asset.revision);
      if (nodeMediaType(node.type) !== asset.data.mediaType && node.type !== 'director')
        throw new HttpError(400, '节点与素材类型不匹配');
      if (node.range) {
        if (
          node.range.out <= node.range.in ||
          (asset.data.mediaType !== 'audio' &&
            (Math.abs(node.range.in * 24 - Math.round(node.range.in * 24)) > 1e-6 ||
              Math.abs(node.range.out * 24 - Math.round(node.range.out * 24)) > 1e-6))
        )
          throw new HttpError(400, '采用区间无效；视频需要有效的 24 fps 工作边界');
        if (
          asset.data.mediaType === 'image'
            ? node.range.in !== 0
            : node.range.out > asset.data.duration + 0.001
        )
          throw new HttpError(400, '采用区间超出实际素材');
      }
    }
  }
  save(id: string, revision: number, raw: unknown) {
    const data = canvasSchema.parse(raw),
      old = this.get(id);
    if (old.revision !== revision)
      throw new HttpError(409, '画布已由用户或 Agent 修改；保留草稿并重新比较');
    if (data.version === 2)
      for (const edge of data.edges) {
        if (
          edge.relation !== 'input' ||
          edge.asset ||
          ['text', 'context'].includes(edge.targetHandle || '')
        )
          continue;
        const previous = old.data.edges.find((e: any) => e.id === edge.id);
        edge.asset =
          previous?.asset ||
          (previous ? old.data.nodes.find((n: any) => n.id === previous.source)?.asset : null) ||
          data.nodes.find((n) => n.id === edge.source)?.asset;
      }
    this.validate(old.projectId, data);
    return this.store.transaction(() => {
      for (const node of data.nodes.filter((n) => n.type === 'document')) {
        const previous = old.data.nodes.find((n: any) => n.id === node.id);
        if (node.document) {
          const doc = this.store.get(node.document.id, node.document.revision);
          if (doc.data.content !== node.text || doc.data.title !== node.title) {
            if (this.store.get(doc.id).revision !== doc.revision)
              throw new HttpError(409, '正文已变化，请重新载入');
            const updated = this.store.update(doc.id, doc.revision, {
              ...doc.data,
              title: node.title,
              content: node.text,
            });
            node.document = { id: updated.id, revision: updated.revision };
          }
        } else {
          if (previous?.document)
            throw new HttpError(400, '文档节点不能抹除既有来源，请建立新的节点');
          const doc = this.store.create(
            'chapter',
            old.projectId,
            { title: node.title, content: node.text, source: 'canvas' },
            data.episodeId || old.projectId,
          );
          node.document = { id: doc.id, revision: doc.revision };
        }
      }
      const next = this.store.update(id, revision, { ...old.data, ...data });
      new DomainService(this.store).dependencies(next, [
        ...data.nodes.flatMap(
          (n) =>
            [n.asset, n.document, n.binding].filter(Boolean) as { id: string; revision: number }[],
        ),
        ...data.edges.flatMap((e) => (e.asset ? [e.asset] : [])),
      ]);
      return next;
    });
  }
  snapshot(id: string) {
    const doc = this.get(id);
    const jobs = this.store.db
      .prepare(
        "SELECT id,kind,state,hold_reason holdReason,error,created_at createdAt,json_extract(input,'$.canvasNodeId') nodeId,json_object('assetIds',json_extract(output,'$.assetIds'),'exportAssetId',json_extract(output,'$.exportAssetId')) output FROM jobs WHERE project_id=? AND (json_extract(input,'$.canvas.id')=? OR json_extract(input,'$.context.canvasId')=? OR json_extract(input,'$.edl.canvasId')=?) ORDER BY created_at DESC,id DESC LIMIT 40",
      )
      .all(doc.projectId, id, id, id)
      .map((r: any) => ({ ...r, output: JSON.parse(r.output) }));
    const edl = doc.data.edl ? this.store.get(doc.data.edl.id, doc.data.edl.revision) : null;
    const assets = doc.data.version === 2 ? [] : this.store.list('asset', doc.projectId);
    const fixed = new Map(assets.map((a) => [a.id + ':' + a.revision, a]));
    for (const ref of [
      ...doc.data.nodes.flatMap((n: any) => (n.asset ? [n.asset] : [])),
      ...doc.data.edges.flatMap((e: any) => (e.asset ? [e.asset] : [])),
      ...doc.data.nodes.flatMap((n: any) =>
        (n.outputs || []).filter((o: any) => o.asset).map((o: any) => o.asset),
      ),
      ...jobs
        .filter((j) => j.kind === 'export')
        .flatMap((j) =>
          (j.output.assetIds || []).map((assetId: string) => {
            const a = this.store.get(assetId);
            return { id: a.id, revision: a.revision };
          }),
        ),
      ...(edl
        ? [...edl.data.clips, ...edl.data.audio].map((c) => ({
            id: c.assetId,
            revision: c.revision,
          }))
        : []),
    ]) {
      fixed.set(ref.id + ':' + ref.revision, this.store.get(ref.id, ref.revision));
    }
    return {
      canvas: doc,
      assets: [...fixed.values()],
      library: assets,
      documents:
        doc.data.version === 2
          ? doc.data.nodes
              .filter((n: any) => n.document)
              .map((n: any) => this.store.get(n.document.id, n.document.revision))
          : this.store.list('chapter', doc.projectId),
      objects:
        doc.data.version === 2
          ? doc.data.nodes
              .filter((n: any) => n.binding)
              .map((n: any) => ({
                nodeId: n.id,
                ...resolveNodeContext(this.store, doc.projectId, n),
              }))
          : [],
      jobs: jobs.map((j) => ({
        id: j.id,
        kind: j.kind,
        state: j.state,
        holdReason: j.holdReason,
        error: j.error,
        output: j.output,
        nodeId: j.nodeId,
        createdAt: j.createdAt,
      })),
      assistant: doc.data.agentRunId ? this.store.get(doc.data.agentRunId) : null,
      edl,
    };
  }
  submit(id: string, nodeId: string, raw: any, assistantRunId?: string) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        digest: z.string().min(1),
        idempotencyKey: z.string().min(8),
      })
      .parse(raw);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
        .get(body.idempotencyKey);
      if (prior) {
        const job = this.store.job(String(prior.id));
        if (
          job.input.canvas?.id !== id ||
          job.input.canvasNodeId !== nodeId ||
          job.input.previewDigest !== body.digest ||
          job.input.assistantRunId !== assistantRunId
        )
          throw new HttpError(409, '幂等键已用于另一请求');
        return job;
      }
      if (this.get(id).data.version !== 2 && this.get(id).revision !== body.revision)
        throw new HttpError(409, '画布版本变化，请重新准备');
      const prepared = prepareCanvasGeneration(this.store, id, nodeId);
      if (prepared.digest !== body.digest) throw new HttpError(409, '生成输入变化，请重新准备');
      return this.store.createJob(
        prepared.input.modelExecution.capabilities.kind === 'image' ? 'image' : 'generation',
        prepared.projectId,
        prepared.episodeId,
        {
          ...prepared.input,
          previewDigest: prepared.digest,
          ...(assistantRunId ? { assistantRunId } : {}),
        },
        body.idempotencyKey,
      );
    });
  }
  collect(id: string, jobIds: string[]) {
    const doc = this.get(id),
      data = canvasSchema.parse(doc.data),
      added: string[] = [];
    for (const jobId of jobIds) {
      const job = this.store.job(jobId);
      if (
        job.projectId !== doc.projectId ||
        job.input.canvas?.id !== id ||
        job.state !== 'succeeded'
      )
        continue;
      const origin = data.nodes.find((n) => n.id === job.input.canvasNodeId);
      if (!origin) continue;
      for (const asset of this.store
        .list('asset', doc.projectId)
        .filter(
          (a) =>
            a.data.jobId === job.id &&
            ['generated', 'generated_image', 'dialogue_candidate', 'lipsync_candidate'].includes(
              a.data.category,
            ),
        )) {
        if (data.nodes.some((n) => n.asset?.id === asset.id)) continue;
        const nodeId = 'result:' + asset.id;
        data.nodes.push({
          id: nodeId,
          title: asset.data.name,
          type: asset.data.mediaType,
          text: '',
          x: origin.x + 360,
          y: origin.y + added.length * 240,
          selected: false,
          asset: { id: asset.id, revision: asset.revision },
        });
        data.edges.push({
          id: 'source:' + asset.id,
          source: origin.id,
          target: nodeId,
          relation: 'result',
          instruction: '实际任务 ' + job.id,
        });
        added.push(nodeId);
      }
    }
    return added.length ? this.save(id, doc.revision, data) : doc;
  }
  saveTimeline(id: string, revision: number, raw: unknown) {
    return this.store.transaction(() => {
      const canvas = this.get(id);
      if (canvas.revision !== revision) throw new HttpError(409, '画布已变化');
      const edl = edlSchema.parse(raw);
      if (edl.episodeId !== (canvas.data.episodeId || ''))
        throw new HttpError(400, '时间线归属与画布不同');
      const previous = canvas.data.edl;
      const doc = new StudioService(this.store).saveEdl(
        canvas.projectId,
        edl,
        previous?.revision,
        previous ? { id: previous.id } : undefined,
      );
      this.store.update(id, revision, {
        ...canvas.data,
        edl: { id: doc.id, revision: doc.revision },
      });
      return doc;
    });
  }
  export(id: string, raw: any, assistantRunId?: string) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        edl: z.object({ id: z.string(), revision: z.number().int().positive() }),
        idempotencyKey: z.string().min(8),
      })
      .parse(raw);
    return this.store.transaction(() => {
      const prior = this.store.db
        .prepare('SELECT id FROM jobs WHERE idempotency_key=?')
        .get(body.idempotencyKey);
      if (prior) {
        const job = this.store.job(String(prior.id));
        if (
          job.input.canvas?.id !== id ||
          job.input.edlRevision !== body.edl.revision ||
          job.input.edlId !== body.edl.id
        )
          throw new HttpError(409, '导出幂等键冲突');
        return job;
      }
      const canvas = this.get(id);
      if (
        canvas.revision !== body.revision ||
        generationDigest(canvas.data.edl) !== generationDigest(body.edl)
      )
        throw new HttpError(409, '时间线版本变化');
      const service = new StudioService(this.store),
        edl = service.owned(body.edl.id, canvas.projectId, 'edl', body.edl.revision);
      service.validateEdl(canvas.projectId, edl.data);
      const assets = [...edl.data.clips, ...edl.data.audio].map((c) =>
        service.owned(c.assetId, canvas.projectId, 'asset', c.revision),
      );
      return this.store.createJob(
        'export',
        canvas.projectId,
        canvas.data.episodeId,
        {
          canvas: { id, revision: canvas.revision },
          edl: edl.data,
          edlId: edl.id,
          edlRevision: edl.revision,
          assets,
          name: canvas.data.title,
          ...(assistantRunId ? { assistantRunId } : {}),
        },
        body.idempotencyKey,
      );
    });
  }
  finalize(id: string, revision: number, assetRef: { id: string; revision: number }) {
    return this.store.transaction(() => {
      const doc = this.get(id),
        asset = new StudioService(this.store).owned(
          assetRef.id,
          doc.projectId,
          'asset',
          assetRef.revision,
        );
      const job = asset.data.jobId ? this.store.job(asset.data.jobId) : null;
      if (doc.revision !== revision) throw new HttpError(409, '画布已变化');
      if (
        asset.data.category !== 'export' ||
        job?.input.canvas?.id !== id ||
        job.state !== 'succeeded'
      )
        throw new HttpError(400, '请选择此画布已归档的导出版本');
      if (
        doc.data.finalized?.some(
          (f: any) => f.asset.id === assetRef.id && f.asset.revision === assetRef.revision,
        )
      )
        return doc;
      return this.store.update(id, revision, {
        ...doc.data,
        finalized: [
          ...(doc.data.finalized || []),
          {
            id: randomUUID(),
            asset: assetRef,
            edl: { id: job.input.edlId, revision: job.input.edlRevision },
            at: Date.now(),
            quality: 'not_certified',
          },
        ],
      });
    });
  }
}
