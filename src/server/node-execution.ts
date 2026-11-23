import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { nodeDefinitions } from '../shared/node-catalog.js';
import { mediaActions } from '../shared/node-operations.js';
import { prepareMediaOperation, submitMediaOperation } from './node-media.js';
import { prepareNodeAnalysis, submitNodeAnalysis } from './node-analysis.js';
import { prepareDirector, submitDirector } from './director-production.js';
import { prepareSpeech, submitSpeech } from './speech-production.js';
import { prepareLipSync, submitLipSync } from './sync-lipsync.js';
import { prepareCanvasGeneration } from './canvas-generation.js';

export function nodeOperation(
  store: Store,
  canvasId: string,
  nodeId: string,
  raw: any,
  submission?: { digest: string; idempotencyKey: string; assistantRunId?: string },
) {
  const { action, request } = z
    .object({ action: z.string(), request: z.record(z.string(), z.unknown()).default({}) })
    .parse(raw);
  const canvas = new CanvasService(store).get(canvasId),
    node = canvas.data.nodes.find((n: any) => n.id === nodeId),
    definition = nodeDefinitions.find((d) => d.type === node?.type);
  if (!node || !definition?.actions.includes(action)) throw new HttpError(400, '此节点没有该操作');
  const body = { request: { ...request, action }, ...submission };
  if (mediaActions.includes(action))
    return submission
      ? submitMediaOperation(store, canvasId, nodeId, body, submission.assistantRunId)
      : prepareMediaOperation(store, canvasId, nodeId, body.request);
  if (['vision', 'transcribe', 'text_generate', 'rewrite'].includes(action))
    return submission
      ? submitNodeAnalysis(store, canvasId, nodeId, body, submission.assistantRunId)
      : prepareNodeAnalysis(store, canvasId, nodeId, body.request);
  if (action.startsWith('previs_'))
    return submission
      ? submitDirector(store, canvasId, nodeId, body, submission.assistantRunId)
      : prepareDirector(store, canvasId, nodeId, body.request);
  const context = {
    runId: submission?.assistantRunId,
    canvas: { id: canvas.id, revision: canvas.revision },
    nodeId,
  };
  if (action === 'synthesize')
    return submission
      ? submitSpeech(
          store,
          canvas.projectId,
          'speech',
          {
            request,
            digest: submission.digest,
            idempotencyKey: submission.idempotencyKey,
            approved: true,
          },
          context,
        )
      : prepareSpeech(store, canvas.projectId, 'speech', request);
  if (action === 'lipsync')
    return submission
      ? submitLipSync(
          store,
          canvas.projectId,
          {
            request,
            digest: submission.digest,
            idempotencyKey: submission.idempotencyKey,
            approved: true,
          },
          context,
        )
      : prepareLipSync(store, canvas.projectId, request);
  if (action === 'generate')
    return submission
      ? new CanvasService(store).submit(
          canvasId,
          nodeId,
          { revision: canvas.revision, ...submission },
          submission.assistantRunId,
        )
      : prepareCanvasGeneration(store, canvasId, nodeId);
  throw new HttpError(400, '此操作在当前编辑器中完成，不创建任务');
}
export function registerNodeExecutionRoutes(app: Express, store: Store) {
  app.post('/api/canvases/:id/nodes/:node/operation-preview', (req, res) =>
    res.json(nodeOperation(store, String(req.params.id), String(req.params.node), req.body)),
  );
  app.post('/api/canvases/:id/nodes/:node/operation-run', (req, res) => {
    const body = z
      .object({
        operation: z.unknown(),
        digest: z.string().length(64),
        idempotencyKey: z.string().min(8),
      })
      .parse(req.body);
    res.status(201).json(
      nodeOperation(store, String(req.params.id), String(req.params.node), body.operation, {
        digest: body.digest,
        idempotencyKey: body.idempotencyKey,
      }),
    );
  });
}
