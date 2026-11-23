import { z } from 'zod';
import { predecessorCanon, episodeRuntime } from './series-production.js';
import { Store, HttpError } from './db.js';
import { CanvasService } from './canvas.js';
import { canvasSchema, canvasAssistantSchema } from '../shared/canvas.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest } from './h3-guided.js';
import { assistantDecisionSchema, assistantRules } from '../shared/assistant.js';
import { canvasTools, performAssistantTool } from './assistant-tools.js';
import type { Job, RecordDoc } from '../shared/contracts.js';
import { attachCanvasResults } from './canvas-results.js';
import { nodeDefinitions } from '../shared/node-catalog.js';
import { resolveWorkbenchContext } from './workbench-context.js';
import { contextReferenceSchema } from '../shared/workbench-context.js';

const done = ['succeeded', 'failed', 'cancelled'];
// Durable orchestration over existing jobs; actions and receipts share transactions.
export class ProductionAssistant {
  constructor(
    public store: Store,
    public root: string,
  ) {}
  get(id: string) {
    const doc = this.store.get(id);
    if (doc.kind !== 'assistant_run') throw new HttpError(400, '不是制作助手运行');
    return doc;
  }
  create(canvasId: string, raw: unknown) {
    const body = canvasAssistantSchema.parse(raw),
      digest = generationDigest(body);
    return this.store.transaction(() => {
      const canvas = new CanvasService(this.store).get(canvasId);
      const prior = this.store
        .list('assistant_run', canvas.projectId)
        .find((r) => r.data.idempotencyKey === body.idempotencyKey);
      if (prior) {
        if (prior.data.requestDigest !== digest || prior.parentId !== canvasId)
          throw new HttpError(409, '助手幂等键冲突');
        return prior;
      }
      if (canvas.revision !== body.revision) throw new HttpError(409, '画布已变化');
      if (
        canvas.data.agentRunId &&
        !['stopped', 'completed'].includes(this.get(canvas.data.agentRunId).data.state)
      )
        throw new HttpError(409, '画布已有推进所有者，请先停止该运行');
      if (body.nodeIds.some((id) => !canvas.data.nodes.some((n: any) => n.id === id)))
        throw new HttpError(400, '范围节点不存在');
      const registry = new ModelRegistry(this.store),
        models = body.models.map((m) => registry.resolveSelection(m));
      if (!models.some((m) => m.capabilities.kind === 'text'))
        throw new HttpError(400, '请选择已启用的文字模型');
      const referenceContext = resolveWorkbenchContext(
        this.store,
        canvas.projectId,
        body.references,
        models.find((m) => m.capabilities.kind === 'text'),
      );
      if (referenceContext.issues.length)
        throw new HttpError(400, referenceContext.issues.join('\n'));
      const writeScope = body.writeScope || (body.nodeIds.length ? 'selected' : 'canvas');
      if (writeScope === 'selected' && !body.nodeIds.length)
        throw new HttpError(400, '请明确可修改节点');
      const run = this.store.create(
        'assistant_run',
        canvas.projectId,
        {
          ...body,
          version: canvas.data.version === 2 ? 4 : 2,
          writeScope,
          referenceContext,
          requestDigest: digest,
          models,
          state: 'active',
          steps: [],
          receipts: [],
          intent: null,
          pendingDecision: null,
          waiting: null,
          noProgress: 0,
          createdNodes: [],
          guidance: [],
          note: '',
        },
        canvas.id,
      );
      this.store.update(canvas.id, canvas.revision, { ...canvas.data, agentRunId: run.id });
      return run;
    });
  }
  state(doc: RecordDoc) {
    const canvas = new CanvasService(this.store).get(doc.parentId!);
    if (canvas.data.agentRunId !== doc.id) throw new HttpError(409, '助手已失去画布推进权');
    const allowed = new Set([...doc.data.nodeIds, ...doc.data.createdNodes]);
    const nodes = canvas.data.nodes.filter(
      (n: any) =>
        (doc.data.version >= 4 ? doc.data.writeScope === 'canvas' : !doc.data.nodeIds.length) ||
        allowed.has(n.id),
    );
    const sourceIds = new Set(
      canvas.data.edges
        .filter((e: any) => nodes.some((n: any) => n.id === e.target))
        .map((e: any) => e.source),
    );
    const sources = canvas.data.nodes.filter(
      (n: any) => sourceIds.has(n.id) && !nodes.some((v: any) => v.id === n.id),
    );
    const refs = [...nodes, ...sources].flatMap((n: any) =>
      [n.asset, n.document, n.binding].filter(Boolean),
    );
    for (const edge of canvas.data.edges) {
      if (
        edge.asset &&
        nodes.some((n: any) => n.id === edge.target) &&
        !refs.some((r: any) => r.id === edge.asset.id && r.revision === edge.asset.revision)
      )
        refs.push(edge.asset);
    }
    const documents = refs.map((r: any) => this.store.get(r.id, r.revision));
    const episode = canvas.data.episodeId ? this.store.get(canvas.data.episodeId) : null;
    const story = episode?.data.seriesProduction
      ? {
          episode: {
            id: episode.id,
            revision: episode.revision,
            title: episode.data.title,
            seriesId: episode.data.seriesId,
          },
          runtime: episodeRuntime(this.store, episode),
          predecessor: predecessorCanon(this.store, episode),
          current: this.store
            .list('continuity', canvas.projectId, episode.id)
            .filter((c) => c.data.basis === 'authored_story'),
        }
      : null;
    const basis = generationDigest({
      story,
      canvas:
        doc.data.version >= 3
          ? {
              episodeId: canvas.data.episodeId,
              nodes: [...nodes, ...sources].map(({ x, y, groupId, collapsed, ...n }: any) => n),
              edges: canvas.data.edges.filter((e: any) =>
                nodes.some((n: any) => n.id === e.target),
              ),
            }
          : canvasSchema.parse(canvas.data),
      edl: canvas.data.edl || null,
      revisions: refs.map((r: any) =>
        doc.data.version >= 4 ? r : [r, this.store.get(r.id).revision],
      ),
      guidance: doc.data.guidance,
    });
    return { canvas, nodes, sources, documents, basis, story };
  }
  control(id: string, raw: unknown) {
    const body = z
      .object({
        revision: z.number().int().positive(),
        action: z.enum(['pause', 'resume', 'stop', 'release', 'guide']),
        message: z.string().max(10000).optional(),
        references: z.array(contextReferenceSchema).max(20).optional(),
      })
      .parse(raw);
    return this.store.transaction(() => {
      let doc = this.get(id);
      if (doc.revision !== body.revision) throw new HttpError(409, '运行状态已变化');
      if (![2, 3, 4].includes(doc.data.version)) {
        if (body.action !== 'stop' && body.action !== 'release')
          throw new HttpError(409, '旧运行保留历史；请在画布建立新的明确授权');
        return this.store.update(id, doc.revision, {
          ...doc.data,
          state: 'stopped',
          note: '旧运行已停止；已受理任务继续归档',
        });
      }
      if (body.action === 'resume' && ['completed', 'stopped'].includes(doc.data.state))
        throw new HttpError(409, '结束的运行不能重置预算');
      if (body.action === 'guide' && !body.message?.trim())
        throw new HttpError(400, '请填写引导内容');
      if (body.action === 'guide' && ['completed', 'stopped'].includes(doc.data.state))
        throw new HttpError(409, '结束的运行需要新建，不能通过引导重置范围或预算');
      if (body.action === 'resume') this.state(doc);
      const referenceContext =
        body.action === 'guide' && body.references?.length
          ? resolveWorkbenchContext(
              this.store,
              doc.projectId,
              body.references,
              doc.data.models.find((m: any) => m.capabilities.kind === 'text'),
            )
          : null;
      if (referenceContext?.issues.length)
        throw new HttpError(400, referenceContext.issues.join('\n'));
      const clearDecision =
        body.action === 'guide' || body.action === 'stop' || body.action === 'release';
      for (const job of this.store
        .jobs(doc.projectId)
        .filter((j) => j.input.assistantRunId === id && j.state === 'queued')) {
        if (
          body.action === 'stop' ||
          body.action === 'release' ||
          (body.action === 'guide' && job.kind === 'creative')
        )
          this.store.patchJob(job.id, { cancelRequested: true });
        else
          this.store.patchJob(job.id, {
            holdReason:
              body.action === 'pause'
                ? 'assistant_paused'
                : body.action === 'resume'
                  ? null
                  : job.holdReason,
          });
      }
      const waiting = !!doc.data.waiting;
      doc = this.store.update(id, doc.revision, {
        ...doc.data,
        ...(referenceContext ? { referenceContext } : {}),
        state:
          body.action === 'pause'
            ? 'paused'
            : body.action === 'stop' || body.action === 'release'
              ? 'stopped'
              : body.action === 'guide'
                ? doc.data.version >= 4 && doc.data.state !== 'paused'
                  ? waiting
                    ? 'waiting_job'
                    : 'active'
                  : 'paused'
                : waiting
                  ? 'waiting_job'
                  : 'active',
        ...(clearDecision ? { pendingDecision: null, intent: null } : {}),
        ...(body.action === 'guide'
          ? { guidance: [...doc.data.guidance, { text: body.message, at: Date.now() }] }
          : {}),
        note:
          body.action === 'stop'
            ? '停止后续动作；已受理任务继续归档'
            : body.action === 'guide'
              ? doc.data.version >= 4
                ? '引导已保存；下个安全决策点读取，已受理任务继续归档'
                : '引导已保存；恢复时读取当前工作区'
              : '',
      });
      return doc;
    });
  }
  completeDecision(job: Job, raw: unknown) {
    const decision = assistantDecisionSchema.parse(raw);
    return this.store.transaction(() => {
      const doc = this.get(job.input.assistantRunId),
        step = doc.data.steps.find((s: any) => s.jobId === job.id);
      if (!step) throw new HttpError(409, '决策不属于此运行');
      if (step.decision) {
        if (generationDigest(step.decision) !== generationDigest(decision))
          throw new HttpError(409, '重复回执内容不同');
        return doc;
      }
      return this.store.update(doc.id, doc.revision, {
        ...doc.data,
        steps: doc.data.steps.map((s: any) =>
          s.jobId === job.id ? { ...s, decision, receivedAt: Date.now() } : s,
        ),
      });
    });
  }
  async advance(id: string) {
    let doc = this.get(id);
    if (['paused', 'stopped', 'completed', 'waiting_input'].includes(doc.data.state)) return doc;
    if (![2, 3, 4].includes(doc.data.version))
      return this.pause(doc, '旧版运行已停止自动推进；在画布重新明确范围与预算后继续');
    try {
      const state = this.state(doc);
      if (doc.data.state === 'waiting_job') {
        const jobs = doc.data.waiting.jobs.map((j: string) => this.store.job(j));
        if (jobs.some((j: Job) => !done.includes(j.state))) return doc;
        return this.store.transaction(() => {
          if (state.canvas.data.version === 2)
            for (const job of jobs) attachCanvasResults(this.store, job.id);
          const canvas =
            state.canvas.data.version === 2
              ? this.store.get(state.canvas.id)
              : new CanvasService(this.store).collect(
                  state.canvas.id,
                  jobs.map((j: Job) => j.id),
                );
          const created = canvas.data.nodes
            .filter((n: any) => !state.canvas.data.nodes.some((v: any) => v.id === n.id))
            .map((n: any) => n.id);
          return this.store.update(id, doc.revision, {
            ...doc.data,
            state: 'active',
            waiting: null,
            createdNodes: [...doc.data.createdNodes, ...created],
            receipts: [
              ...doc.data.receipts,
              {
                key: doc.data.waiting.key + ':results',
                action: 'task_results',
                at: Date.now(),
                result: jobs.map((j: Job) => ({
                  id: j.id,
                  state: j.state,
                  output: j.output,
                  error: j.error,
                })),
              },
            ],
            note: '实际结果已归档；质量尚未观察',
          });
        });
      }
      if (doc.data.intent) {
        const intent = doc.data.intent;
        if (intent.basis !== state.basis)
          return this.pause(doc, '用户或其他内容已变化，旧决策未执行；恢复后重新读取', true);
        if (intent.action === 'extract') {
          const result = await performAssistantTool(this.store, this.root, doc, intent);
          return this.receipt(this.get(id), intent, result);
        }
        return this.store.transaction(() =>
          this.receipt(doc, intent, performAssistantTool(this.store, this.root, doc, intent)),
        );
      }
      if (doc.data.pendingDecision) {
        const job = this.store.job(doc.data.pendingDecision);
        if (!done.includes(job.state)) return doc;
        if (job.state !== 'succeeded')
          return this.pause(doc, job.error || '文字请求失败，不自动重复付费', true);
        const step = doc.data.steps.find((s: any) => s.jobId === job.id);
        if (!step?.decision) return this.pause(doc, '决策缺少实际回执', true);
        if (step.basis !== state.basis)
          return this.pause(doc, '决策期间工作区变化，旧决策已丢弃；恢复后重新读取', true);
        return this.store.update(id, doc.revision, {
          ...doc.data,
          pendingDecision: null,
          intent: {
            ...step.decision,
            key: 'assistant:' + id + ':tool:' + step.number,
            basis: state.basis,
            at: Date.now(),
          },
        });
      }
      if (doc.data.steps.length >= doc.data.budget.maxSteps)
        return this.pause(doc, '已达到决策预算；新预算需要新运行');
      const model = doc.data.models.find((m: any) => m.capabilities.kind === 'text');
      const context = {
        schemaVersion: 9,
        modelExecution: model,
        mode: 'assistant',
        runId: id,
        assistantRunId: id,
        canvasId: state.canvas.id,
        projectId: doc.projectId,
        goal: doc.data.goal,
        rules: assistantRules,
        tools: canvasTools,
        nodeDefinitions:
          doc.data.version >= 4
            ? nodeDefinitions.map(({ type, label, category }) => ({ type, label, category }))
            : nodeDefinitions,
        permissions: doc.data.permissions,
        models: doc.data.models,
        state: {
          episodeId: state.canvas.data.episodeId,
          nodes:
            doc.data.version >= 4
              ? state.nodes.slice(0, 40).map(({ text, outputs, ...n }: any) => ({
                  ...n,
                  text: text?.slice(0, 600),
                  outputs: outputs?.slice(-4),
                  truncated: (text?.length || 0) > 600,
                  outputCount: outputs?.length || 0,
                }))
              : state.nodes,
          nodeCount: state.nodes.length,
          sources:
            doc.data.version >= 4
              ? state.sources
                  .slice(0, 30)
                  .map(({ text, ...n }: any) => ({ ...n, text: text?.slice(0, 400) }))
              : state.sources,
          edges: state.canvas.data.edges
            .filter((e: any) => state.nodes.some((n: any) => n.id === e.target))
            .slice(0, doc.data.version >= 4 ? 80 : undefined),
          documents:
            doc.data.version >= 4
              ? state.documents.slice(0, 50).map((d) => ({
                  id: d.id,
                  revision: d.revision,
                  kind: d.kind,
                  title: d.data.title || d.data.name,
                }))
              : state.documents,
          references: doc.data.referenceContext?.items.map((i: any) => ({
            ...i,
            text: i.text.slice(0, 1500),
            truncated: i.text.length > 1500,
          })),
          story:
            doc.data.version >= 4 && state.story
              ? {
                  ...state.story,
                  current: state.story.current.map((d) => ({
                    id: d.id,
                    revision: d.revision,
                    kind: d.kind,
                  })),
                }
              : state.story,
          edl:
            doc.data.version >= 4
              ? state.canvas.data.edl || null
              : state.canvas.data.edl
                ? this.store.get(state.canvas.data.edl.id, state.canvas.data.edl.revision)
                : null,
          receipts: doc.data.receipts.slice(-8),
          guidance: doc.data.guidance.slice(-8),
        },
        imageAssets:
          doc.data.referenceContext?.assets.map((a: any) => ({ id: a.id, revision: a.revision })) ||
          [],
        budget: doc.data.budget,
        usedSteps: doc.data.steps.length,
        remainingSteps: doc.data.budget.maxSteps - doc.data.steps.length,
      };
      if (JSON.stringify(context).length > 180000)
        return this.pause(doc, '当前上下文过大，请缩小节点范围');
      return this.store.transaction(() => {
        doc = this.get(id);
        if (doc.data.state !== 'active' || doc.data.pendingDecision) return doc;
        const job = this.store.createJob(
          'creative',
          doc.projectId,
          state.canvas.data.episodeId,
          { context, modelExecution: model, assistantRunId: id },
          'assistant:' + id + ':decision:' + doc.data.steps.length,
        );
        return this.store.update(id, doc.revision, {
          ...doc.data,
          pendingDecision: job.id,
          steps: [
            ...doc.data.steps,
            {
              number: doc.data.steps.length + 1,
              jobId: job.id,
              basis: state.basis,
              at: Date.now(),
            },
          ],
        });
      });
    } catch (e) {
      if (!(e instanceof HttpError || e instanceof z.ZodError || e instanceof SyntaxError)) throw e;
      return this.pause(this.get(id), e.message, true);
    }
  }
  receipt(doc: RecordDoc, intent: any, result: any) {
    if (doc.data.receipts.some((r: any) => r.key === intent.key)) return doc;
    const noProgress = result.progress ? 0 : doc.data.noProgress + 1;
    return this.store.update(doc.id, doc.revision, {
      ...doc.data,
      state: ['paused', 'stopped'].includes(doc.data.state)
        ? doc.data.state
        : result.jobIds
          ? 'waiting_job'
          : result.state || (noProgress >= 2 ? 'paused' : 'active'),
      waiting: result.jobIds ? { key: intent.key, jobs: result.jobIds } : null,
      intent: null,
      noProgress,
      createdNodes: [...doc.data.createdNodes, ...(result.createdNodes || [])],
      note: noProgress >= 2 ? '连续两次没有实际进展' : intent.reason,
      receipts: [
        ...doc.data.receipts,
        { key: intent.key, action: intent.action, result, at: Date.now() },
      ],
    });
  }
  pause(doc: RecordDoc, note: string, discard = false) {
    return this.store.update(doc.id, doc.revision, {
      ...doc.data,
      state: 'paused',
      note,
      ...(discard ? { intent: null, pendingDecision: null } : {}),
    });
  }
}
