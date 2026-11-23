import { inspectAssistantWorkspace } from './assistant-inspection.js';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { canvasNodeSchema, canvasEdgeSchema, canvasSchema } from '../shared/canvas.js';
import { prepareCanvasGeneration } from './canvas-generation.js';
import { extractFrameAsset } from './media-evidence.js';
import { prepareSpeech, submitSpeech } from './speech-production.js';
import { prepareLipSync, submitLipSync } from './sync-lipsync.js';
import { generationDigest } from './h3-guided.js';
import type { RecordDoc } from '../shared/contracts.js';

import { nodeOperation } from './node-execution.js';

import { saveCanvasObject } from './canvas-objects.js';
import { materializeAnalysis } from './analysis-materialization.js';

export const canvasTools = {
  materialize:
    'request JSON: {nodeId,analysis:{id,revision},action:text/frames/shots/subtitles/apply_text,indices?:number[],clipIndex?:number}. Turn a fixed analysis result associated with this scoped node into documents, frames, shot cards or timeline captions. apply_text checks unchanged original text. No new model request.',
  object_edit:
    'request JSON: {nodeId,data:complete editable object}. Edit the fixed bound entity, appearance, episode shot or director scene through the same version-checked object editor as the UI. For an unbound director node pass {scene:...}; inspect catalog for schema. Never invent observations.',
  node_operation:
    'request JSON: {nodeId,operation:{action,request:{...}}}. Query inspect {catalog:true} for node ports and real actions, plus media/analysis schemas. Prepares and executes the same service as the UI, within authorization. Local operations use derive permission; vision/transcription use analyze and request budgets. No invented quality judgments.',
  inspect:
    'Read scoped workspace state; {nodeId,offset?:text offset,outputOffset?:candidate offset}, {document:{id,revision},offset?:text offset}, {referenceIndex,offset?:text offset}, or request null, {catalog:true}, {objectSchema:entity/appearance/layout/director}, {method:writing/directing/assets/editing}, {library:image/video/audio/document/voice/dialogue,search?:text,limit?:1..30,offset?:number}, or {operation:synthesize/lipsync}. Voice inventory is the global versioned voice library. Inventory is metadata, not media perception.',
  write:
    'request JSON: {node:{id,type,title,x,y,text,document?,binding?,asset?,generation?,settings?,selected?,range?}}. Creates or edits one node; document nodes create versioned chapter records. Node types and ports come from inspect catalog. Image edits create an image_generate node with settings.imageEdit (inspect imageEditSchema), connect the fixed source image, then generate in edit mode. generation={model:one authorized selection,mode:t2v/i2v/ref2va/generate/edit,seconds,sound,music}. Existing fixed references must be retained unless explicitly replaced.',
  connect:
    'request JSON: {edge:{id,source,target,relation:organize/input/result,purpose?,instruction}}. Input purpose identity/style/scene/prop/composition/first_frame/last_frame/audio/motion. Result edges may only represent actual task results.',
  generate:
    'request JSON: {nodeId}. Prepares the current fixed node, then submits immediately within run authorization. All actual attempts use quota. Do not repeat for imagined quality failures.',
  select:
    'request JSON: {nodeId,range?:{in,out}}. Selects actual media without claiming quality. range uses seconds; video uses the 24fps work grid, audio retains precise source times.',
  timeline:
    'request JSON: {edl:{schemaVersion:3,episodeId:current episode or empty string,width,height,fps:24,clips:[{id,assetId,revision,in,out,volume,transition?,visualFadeInFrames?,visualFadeOutFrames?}],audio:[],overlays:[]}}. Frame based cuts/optional dissolve, no implicit music or retiming.',
  export: 'request null. Exports the current fixed timeline; does not certify its quality.',
  extract:
    'request JSON: {nodeId,frameIndex}. Extracts a real archived source frame into a reusable image node.',
  synthesize:
    'request JSON: {nodeId,request:existing speech preparation contract}. Uses listed fixed dialogue and voice references; no implicit cloning.',
  lipsync:
    'request JSON: {nodeId,request:existing lipsync preparation contract}. Uses actual video and audio; no implied listening or visual approval.',
  wait: 'request null. Pause with a concrete missing input or user decision; task waits are handled by runtime, not model polling.',
  finish: 'request null. Goal is complete, without asserting media quality.',
};

export function performAssistantTool(store: Store, root: string, run: RecordDoc, intent: any) {
  const service = new CanvasService(store),
    canvas = service.get(run.parentId!),
    data = canvasSchema.parse(canvas.data);
  const args = intent.request ? JSON.parse(intent.request) : {};
  const permitted = (name: string) => {
    if (!run.data.permissions.includes(name)) throw new HttpError(403, '操作超出允许范围：' + name);
  };
  const scoped = (id: string, allowNew = false) => {
    const node = data.nodes.find((n) => n.id === id);
    const created = run.data.createdNodes || [];
    if (
      (run.data.version >= 4 ? run.data.writeScope !== 'canvas' : run.data.nodeIds.length) &&
      !run.data.nodeIds.includes(id) &&
      !created.includes(id) &&
      !(allowNew && !node)
    )
      throw new HttpError(403, '节点不在授权范围');
    return node;
  };
  const assertTimelineScope = (edl: any) => {
    if (run.data.version >= 4 ? run.data.writeScope === 'canvas' : !run.data.nodeIds.length) return;
    if (
      run.data.version >= 4 &&
      run.data.writeScope === 'new' &&
      data.edl &&
      !run.data.receipts.some(
        (r: any) => r.action === 'timeline' && r.result.edl?.id === data.edl?.id,
      )
    )
      throw new HttpError(403, '只新增范围不能覆盖已有时间线；需要明确授权剪辑范围');
    const allowed = new Set(
      data.nodes
        .filter(
          (n) => run.data.nodeIds.includes(n.id) || (run.data.createdNodes || []).includes(n.id),
        )
        .flatMap((n) => (n.asset ? [n.asset.id + ':' + n.asset.revision] : [])),
    );
    if ([...edl.clips, ...edl.audio].some((c: any) => !allowed.has(c.assetId + ':' + c.revision)))
      throw new HttpError(403, '局部助手时间线包含未授权素材版本');
  };
  if (intent.action === 'inspect') return inspectAssistantWorkspace(store, run, args);
  if (intent.action === 'wait' || intent.action === 'finish')
    return {
      progress: false,
      state: intent.action === 'wait' ? 'waiting_input' : 'completed',
      reason: intent.reason,
    };
  if (intent.action === 'write') {
    // Object edits use fixed references; layout does not grant write access to other records.
    permitted('write');
    const node = canvasNodeSchema.parse(args.node),
      old = scoped(node.id, true);
    if (
      node.outputs?.length &&
      generationDigest(node.outputs) !== generationDigest(old?.outputs || [])
    )
      throw new HttpError(400, '助手不能伪造任务结果');
    if (old?.outputs) node.outputs = old.outputs;
    if (node.document) {
      const source = store.get(node.document.id, node.document.revision);
      const writable = data.nodes.some(
        (n) =>
          n.document?.id === source.id &&
          ((run.data.version >= 4 ? run.data.writeScope === 'canvas' : !run.data.nodeIds.length) ||
            run.data.nodeIds.includes(n.id) ||
            (run.data.createdNodes || []).includes(n.id)),
      );
      if (!writable && (source.data.content !== node.text || source.data.title !== node.title))
        throw new HttpError(403, '新增节点不能改写授权范围外的原文；请创建独立文档');
    }
    if (old && generationDigest(old) === generationDigest(node))
      return { progress: false, nodeId: node.id };
    if (old) data.nodes[data.nodes.findIndex((n) => n.id === node.id)] = node;
    else data.nodes.push(node);
    const next = service.save(canvas.id, canvas.revision, data);
    return {
      progress: true,
      canvasRevision: next.revision,
      createdNodes: old ? [] : [node.id],
      nodeId: node.id,
    };
  }
  if (intent.action === 'connect') {
    permitted('write');
    const edge = canvasEdgeSchema.parse(args.edge);
    scoped(edge.target);
    const previous = data.edges.find((e) => e.id === edge.id);
    if (previous) scoped(previous.target);
    if (edge.relation === 'result') throw new HttpError(400, '结果来源由实际归档回执建立');
    if (
      generationDigest(data.edges.find((e) => e.id === edge.id) || null) === generationDigest(edge)
    )
      return { progress: false };
    data.edges = data.edges.filter((e) => e.id !== edge.id);
    data.edges.push(edge);
    return {
      progress: true,
      canvasRevision: service.save(canvas.id, canvas.revision, data).revision,
    };
  }
  if (intent.action === 'node_operation') {
    if (!scoped(args.nodeId)) throw new HttpError(400, '目标节点不存在');
    const p: any = nodeOperation(store, canvas.id, args.nodeId, args.operation);
    const job: any = nodeOperation(store, canvas.id, args.nodeId, args.operation, {
      digest: p.digest,
      idempotencyKey: intent.key,
      assistantRunId: run.id,
    });
    return { progress: true, jobIds: [job.id], nodeId: args.nodeId };
  }
  if (intent.action === 'object_edit') {
    permitted('write');
    const node = scoped(args.nodeId);
    if (!node) throw new HttpError(400, '编辑节点不存在');
    const result = saveCanvasObject(store, canvas.id, node.id, {
      canvasRevision: canvas.revision,
      objectRevision: node.binding?.revision || 0,
      data: args.data,
      idempotencyKey: intent.key,
    });
    return {
      progress: true,
      nodeId: node.id,
      object: { id: result.object.id, revision: result.object.revision },
    };
  }
  if (intent.action === 'materialize') {
    permitted(args.action === 'subtitles' ? 'edit' : 'write');
    const node = scoped(args.nodeId);
    if (
      !node ||
      !(
        node.binding?.id === args.analysis?.id ||
        node.outputs?.some((o) => o.document?.id === args.analysis?.id)
      )
    )
      throw new HttpError(403, '分析结果不在当前节点范围');
    if (args.action === 'apply_text')
      scoped(
        store.job(store.get(args.analysis.id, args.analysis.revision).data.jobId).input
          .canvasNodeId,
      );
    if (args.action === 'subtitles' && data.edl)
      assertTimelineScope(store.get(data.edl.id, data.edl.revision).data);
    const result = materializeAnalysis(store, canvas.id, {
      ...args,
      revision: canvas.revision,
      idempotencyKey: intent.key,
    });
    return { progress: true, ...result, createdNodes: 'added' in result ? result.added : [] };
  }
  if (['generate', 'synthesize', 'lipsync'].includes(intent.action)) {
    permitted('generate');
    if (!scoped(args.nodeId)) throw new HttpError(400, '目标节点不存在');
    let job;
    if (intent.action === 'generate') {
      const p = prepareCanvasGeneration(store, canvas.id, args.nodeId);
      job = service.submit(
        canvas.id,
        args.nodeId,
        { revision: canvas.revision, digest: p.digest, idempotencyKey: intent.key },
        run.id,
      );
    } else if (intent.action === 'synthesize') {
      const p = prepareSpeech(store, run.projectId, 'speech', args.request);
      if (p.input.line && p.input.line.episode.id !== data.episodeId)
        throw new HttpError(403, '配音台词超出当前分集');
      job = submitSpeech(
        store,
        run.projectId,
        'speech',
        { request: args.request, digest: p.digest, idempotencyKey: intent.key, approved: true },
        {
          runId: run.id,
          canvas: { id: canvas.id, revision: canvas.revision },
          nodeId: args.nodeId,
        },
      );
    } else {
      const p = prepareLipSync(store, run.projectId, args.request);
      if (p.input.episode && p.input.episode.id !== data.episodeId)
        throw new HttpError(403, '口型片段超出当前分集');
      job = submitLipSync(
        store,
        run.projectId,
        { request: args.request, digest: p.digest, idempotencyKey: intent.key, approved: true },
        {
          runId: run.id,
          canvas: { id: canvas.id, revision: canvas.revision },
          nodeId: args.nodeId,
        },
      );
    }
    return { progress: true, jobIds: [job.id] };
  }
  if (intent.action === 'select') {
    permitted('select');
    const node = scoped(args.nodeId);
    if (!node?.asset) throw new HttpError(400, '只能选用实际素材');
    if (
      node.selected &&
      (!args.range || generationDigest(node.range) === generationDigest(args.range))
    )
      return { progress: false };
    node.selected = true;
    if (args.range) node.range = args.range;
    return {
      progress: true,
      canvasRevision: service.save(canvas.id, canvas.revision, data).revision,
    };
  }
  if (intent.action === 'timeline') {
    permitted('edit');
    assertTimelineScope(args.edl);
    const edl = service.saveTimeline(canvas.id, canvas.revision, args.edl);
    return { progress: true, edl: { id: edl.id, revision: edl.revision } };
  }
  if (intent.action === 'export') {
    permitted('export');
    if (!canvas.data.edl) throw new HttpError(409, '尚无时间线');
    assertTimelineScope(store.get(canvas.data.edl.id, canvas.data.edl.revision).data);
    const job = service.export(
      canvas.id,
      { revision: canvas.revision, edl: canvas.data.edl, idempotencyKey: intent.key },
      run.id,
    );
    return { progress: true, jobIds: [job.id] };
  }
  if (intent.action === 'extract') {
    return (async () => {
      permitted('extract');
      const node = scoped(args.nodeId);
      if (!node?.asset) throw new HttpError(400, '缺少源视频');
      const asset = await extractFrameAsset(
        store,
        root,
        node.asset.id,
        node.asset.revision,
        args.frameIndex,
      );
      const current = service.get(canvas.id);
      if (current.revision !== canvas.revision)
        throw new HttpError(409, '抽帧期间画布已修改；素材已保留，请重新连接');
      const id = 'frame:' + asset.id;
      if (data.nodes.some((n) => n.id === id)) return { progress: false, nodeId: id };
      data.nodes.push({
        id,
        type: 'image',
        title: asset.data.name,
        x: node.x + 340,
        y: node.y + 240,
        text: '',
        asset: { id: asset.id, revision: asset.revision },
        selected: false,
      });
      data.edges.push({
        id: 'source:' + id,
        source: node.id,
        target: id,
        relation: 'result',
        instruction: `源帧 ${args.frameIndex}`,
      });
      service.save(canvas.id, canvas.revision, data);
      return { progress: true, createdNodes: [id], nodeId: id };
    })();
  }
  throw new HttpError(400, '未实现的助手工具');
}
