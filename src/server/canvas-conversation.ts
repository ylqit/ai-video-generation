import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { ModelRegistry } from './model-registry.js';
import { executionSelectionSchema } from '../shared/models.js';
import { generationDigest } from './h3-guided.js';
import { ProductionAssistant } from './production-assistant.js';
import { contextReferenceSchema } from '../shared/workbench-context.js';
import { canvasAssistantSchema } from '../shared/canvas.js';
import { queryContextSources, resolveWorkbenchContext } from './workbench-context.js';

export function conversationMessages(store: Store, canvasId: string) {
  const canvas = new CanvasService(store).get(canvasId);
  return store.db
    .prepare(
      "SELECT * FROM documents WHERE kind='creation_message' AND parent_id=? ORDER BY created_at DESC,rowid DESC LIMIT 60",
    )
    .all(canvas.data.sessionId || '')
    .map((r) => store.decode(r))
    .reverse();
}
export function sendCanvasMessage(store: Store, root: string, canvasId: string, raw: unknown) {
  const body = z
    .object({
      text: z.string().trim().min(1).max(20000),
      mode: z.enum(['discussion', 'production', 'guide']),
      executionScope: canvasAssistantSchema
        .omit({ revision: true, goal: true, references: true, idempotencyKey: true })
        .optional(),
      version: z.literal(2).optional(),
      references: z
        .array(z.union([z.string(), contextReferenceSchema]))
        .max(20)
        .default([]),
      contextDigest: z.string().optional(),
      model: executionSelectionSchema.optional(),
      idempotencyKey: z.string().min(8),
    })
    .parse(raw);
  return store.transaction(() => {
    let canvas = new CanvasService(store).get(canvasId);
    const key = 'canvas_message:' + canvasId + ':' + body.idempotencyKey,
      digest = generationDigest(body),
      prior = store.setting<any>(key, null);
    if (prior) {
      if (prior.digest !== digest) throw new HttpError(409, '消息回执冲突');
      return prior;
    }
    const registry = new ModelRegistry(store);
    const requestedModel =
      body.mode === 'guide' && canvas.data.agentRunId
        ? store
            .get(canvas.data.agentRunId)
            .data.models.find((m: any) => m.capabilities.kind === 'text')?.selection
        : body.mode === 'production'
          ? body.executionScope?.models.find(
              (m) => registry.resolveSelection(m).capabilities.kind === 'text',
            )
          : body.model;
    const modelExecution = requestedModel ? registry.resolveSelection(requestedModel) : undefined;
    if (body.mode === 'discussion' && modelExecution?.capabilities.kind !== 'text')
      throw new HttpError(400, '请选择讨论使用的文字模型');
    const resolved = resolveWorkbenchContext(
      store,
      canvas.projectId,
      body.references.map((r) =>
        typeof r === 'string'
          ? {
              kind: 'node',
              canvas: { id: canvas.id, revision: canvas.revision },
              nodeId: r,
              imageHandling: 'metadata',
            }
          : r,
      ),
      modelExecution,
    );
    if (resolved.issues.length) throw new HttpError(400, resolved.issues.join('\n'));
    if (body.contextDigest && body.contextDigest !== resolved.digest)
      throw new HttpError(409, '引用预览已变化，请重新核对');
    let sessionId = canvas.data.sessionId;
    if (!sessionId) {
      const session = store.create(
        'assistant_session',
        canvas.projectId,
        { version: 1, title: '画布对话' },
        canvasId,
      );
      sessionId = session.id;
      canvas = store.update(canvas.id, canvas.revision, { ...canvas.data, sessionId });
    }
    const context = resolved.items;
    const history = conversationMessages(store, canvasId)
      .slice(-16)
      .map((m) => ({ role: m.data.role, text: m.data.text }));
    const message = store.create(
      'creation_message',
      canvas.projectId,
      {
        version: 2,
        role: 'user',
        text: body.text,
        mode: body.mode,
        references: context,
        contextDigest: resolved.digest,
      },
      sessionId,
    );
    let jobId: string | null = null;
    if (body.mode === 'production') {
      if (!body.executionScope) throw new HttpError(400, '制作需要明确执行范围与用量');
      const run = new ProductionAssistant(store, root).create(canvasId, {
        ...body.executionScope,
        revision: canvas.revision,
        goal: body.text,
        references: body.references.map((r) =>
          typeof r === 'string'
            ? {
                kind: 'node',
                canvas: { id: canvas.id, revision: canvas.revision },
                nodeId: r,
                imageHandling: 'metadata',
              }
            : r,
        ),
        idempotencyKey: body.idempotencyKey,
      });
      store.update(message.id, message.revision, { ...message.data, runId: run.id });
    } else if (body.mode === 'guide') {
      if (!canvas.data.agentRunId) throw new HttpError(400, '当前没有制作运行；可先讨论或启动制作');
      const run = store.get(canvas.data.agentRunId);
      new ProductionAssistant(store, root).control(run.id, {
        revision: run.revision,
        action: 'guide',
        message: body.text,
        references: resolved.items.map((i) => i.reference),
      });
    } else {
      const job = store.createJob(
        'media_analysis',
        canvas.projectId,
        canvas.data.episodeId || null,
        {
          canvas: { id: canvas.id, revision: canvas.revision },
          canvasNodeId: null,
          conversation: { sessionId, messageId: message.id },
          nodeOperation: { action: 'discuss', instruction: body.text },
          text: JSON.stringify({ history, context }),
          modelExecution,
          assets: resolved.assets,
          name: '画布讨论',
          dependencies: resolved.dependencies,
        },
        'discussion:' + canvasId + ':' + body.idempotencyKey,
      );
      jobId = job.id;
    }
    const receipt = { digest, messageId: message.id, jobId };
    store.setSetting(key, receipt);
    return receipt;
  });
}
export function attachConversationResult(store: Store, jobId: string) {
  const job = store.job(jobId),
    context = job.input.conversation;
  if (!context || !['succeeded', 'failed', 'unknown'].includes(job.state)) return;
  store.transaction(() => {
    const key = `conversation_receipt:${job.id}:${job.state}`;
    if (store.setting(key, false)) return;
    const docs = (job.output.documentIds || []).map((id: string) => store.get(id));
    store.create(
      'creation_message',
      job.projectId!,
      {
        role: 'assistant',
        text:
          job.state === 'succeeded'
            ? docs.map((d: any) => d.data.content).join('\n')
            : job.error || '请求需要核对',
        jobId: job.id,
        state: job.state,
        results: docs.map((d: any) => ({ id: d.id, revision: d.revision })),
      },
      context.sessionId,
    );
    store.setSetting(key, true);
  });
}
export function registerConversationRoutes(app: Express, store: Store, root: string) {
  app.post('/api/canvases/:id/context-detail', (req, res) => {
    const c = new CanvasService(store).get(String(req.params.id));
    const body = z
      .object({
        reference: contextReferenceSchema,
        offset: z.number().int().nonnegative().default(0),
      })
      .parse(req.body);
    // Reading a page does not prepare a model request. The send path always
    // resolves and hashes the complete explicitly selected context again.
    const result = resolveWorkbenchContext(
      store,
      c.projectId,
      [{ ...body.reference, textRange: undefined }],
      undefined,
      { offset: body.offset, limit: 6000 },
    );
    res.json(result.items[0]);
  });
  app.get('/api/projects/:id/context-sources', (req, res) =>
    res.json(queryContextSources(store, String(req.params.id), req.query)),
  );
  app.post('/api/canvases/:id/context-preview', (req, res) => {
    const c = new CanvasService(store).get(String(req.params.id));
    const model = req.body.model
      ? new ModelRegistry(store).resolveSelection(req.body.model)
      : undefined;
    const { assets, ...preview } = resolveWorkbenchContext(
      store,
      c.projectId,
      req.body.references || [],
      model,
    );
    res.json(preview);
  });
  app.get('/api/canvases/:id/conversation', (req, res) =>
    res.json({ messages: conversationMessages(store, String(req.params.id)) }),
  );
  app.post('/api/canvases/:id/conversation', (req, res) =>
    res.status(201).json(sendCanvasMessage(store, root, String(req.params.id), req.body)),
  );
}
