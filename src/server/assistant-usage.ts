import type { Store } from './db.js';
import { HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';

// Run authorization is narrower than project quotas. Both reserve in the same
// jobs transaction; failed and acceptance-unknown attempts still count.
export function reserveAssistantUsage(
  store: Store,
  projectId: string | null,
  kind: string,
  input: any,
) {
  const run = store.get(input.assistantRunId);
  if (
    run.kind !== 'assistant_run' ||
    ![2, 3, 4].includes(run.data.version) ||
    run.projectId !== projectId ||
    run.data.state !== 'active'
  )
    throw new HttpError(409, '助手不在可执行状态或任务归属不同');
  const canvas = store.get(run.parentId!);
  if (canvas.data.agentRunId !== run.id) throw new HttpError(409, '助手已失去推进权');
  if (
    input.modelExecution &&
    !run.data.models.some((m: any) => m.digest === input.modelExecution.digest)
  )
    throw new HttpError(403, '模型不在本次授权版本集合中');
  if (
    kind !== 'creative' &&
    !run.data.permissions.includes(
      kind === 'export'
        ? 'export'
        : ['media_analysis', 'transcription'].includes(kind)
          ? 'analyze'
          : ['media_process', 'previs'].includes(kind)
            ? 'derive'
            : 'generate',
    )
  )
    throw new HttpError(403, '操作超出运行授权');
  const jobs = store.jobs(projectId!).filter((j) => j.input.assistantRunId === run.id),
    b = run.data.budget;
  const used = {
    steps: jobs.filter((j) => j.kind === 'creative').length,
    imageRequests: jobs.filter((j) => j.kind === 'image').length,
    images: jobs.reduce((n, j) => n + (j.input.assistantCharge?.images || 0), 0),
    videoRequests: jobs.filter((j) => j.kind === 'generation').length,
    videoSeconds: jobs.reduce((n, j) => n + (j.input.assistantCharge?.videoSeconds || 0), 0),
    speechRequests: jobs.filter((j) => j.kind === 'speech').length,
    speechCharacters: jobs.reduce(
      (n, j) => n + (j.input.assistantCharge?.speechCharacters || 0),
      0,
    ),
    lipSyncRequests: jobs.filter((j) => j.kind === 'lipsync').length,
    lipSyncSeconds: jobs.reduce((n, j) => n + (j.input.assistantCharge?.lipSyncSeconds || 0), 0),
    analysisRequests: jobs.filter((j) => j.kind === 'media_analysis').length,
    analysisImages: jobs.reduce((n, j) => n + (j.input.assistantCharge?.analysisImages || 0), 0),
    transcriptionRequests: jobs.filter((j) => j.kind === 'transcription').length,
    transcriptionSeconds: jobs.reduce(
      (n, j) => n + (j.input.assistantCharge?.transcriptionSeconds || 0),
      0,
    ),
  };
  const charge = {
    analysisImages:
      kind === 'creative'
        ? input.context?.imageAssets?.length || 0
        : kind === 'media_analysis'
          ? input.assets?.length || 0
          : 0,
    transcriptionSeconds:
      kind === 'transcription' ? input.nodeOperation.end - input.nodeOperation.start : 0,
    images: kind === 'image' ? Number(input.prepared.request.n || 1) : 0,
    videoSeconds: kind === 'generation' ? Number(input.segment.duration) : 0,
    speechCharacters: kind === 'speech' ? Array.from(input.text || '').length : 0,
    lipSyncSeconds:
      kind === 'lipsync' ? Number((input.range?.outFrame - input.range?.inFrame) / 24 || 0) : 0,
  };
  if (kind === 'voice_clone') throw new HttpError(403, '本次创作助手不执行全局音色复刻');
  if (
    (kind === 'media_analysis' &&
      (used.analysisRequests >= (b.analysisRequests || 0) ||
        used.analysisImages + charge.analysisImages > (b.analysisImages || 0))) ||
    (kind === 'transcription' &&
      (used.transcriptionRequests >= (b.transcriptionRequests || 0) ||
        used.transcriptionSeconds + charge.transcriptionSeconds > (b.transcriptionSeconds || 0))) ||
    (kind === 'creative' &&
      (used.steps >= b.maxSteps ||
        used.analysisImages + charge.analysisImages > (b.analysisImages || 0))) ||
    (kind === 'image' &&
      (used.imageRequests >= b.imageRequests || used.images + charge.images > b.images)) ||
    (kind === 'generation' &&
      (used.videoRequests >= b.videoRequests ||
        used.videoSeconds + charge.videoSeconds > b.videoSeconds)) ||
    (kind === 'speech' &&
      (used.speechRequests >= b.speechRequests ||
        used.speechCharacters + charge.speechCharacters > b.speechCharacters)) ||
    (kind === 'lipsync' &&
      (used.lipSyncRequests >= b.lipSyncRequests ||
        !charge.lipSyncSeconds ||
        used.lipSyncSeconds + charge.lipSyncSeconds > b.lipSyncSeconds))
  )
    throw new HttpError(409, '本次助手请求或用量预算已达上限；需要新的明确授权');
  return {
    ...charge,
    authorization: generationDigest({
      goal: run.data.goal,
      nodeIds: run.data.nodeIds,
      ...(run.data.version >= 4
        ? { writeScope: run.data.writeScope, references: run.data.referenceContext?.digest }
        : {}),
      permissions: run.data.permissions,
      budget: b,
      models: run.data.models.map((m: any) => m.digest),
    }),
  };
}

// Recheck at the last local boundary before a new paid submission. A pause may
// arrive while an upload or credential read is in flight. Accepted jobs never use this guard.
export function assertAssistantMaySubmit(store: Store, job: { id: string; input: any }) {
  if (!job.input.assistantRunId) return;
  const run = store.get(job.input.assistantRunId),
    canvas = store.get(run.parentId!);
  if (canvas.data.agentRunId === run.id && ['active', 'waiting_job'].includes(run.data.state))
    return;
  const stopped =
    ['stopped', 'completed'].includes(run.data.state) || canvas.data.agentRunId !== run.id;
  store.patchJob(job.id, {
    state: 'queued',
    holdReason: stopped ? 'assistant_stopped' : 'assistant_paused',
    ...(stopped ? { cancelRequested: true } : {}),
  });
  throw new HttpError(
    409,
    stopped ? '助手已停止，未提交新的请求' : '助手已暂停，输入准备完成但尚未提交',
  );
}
