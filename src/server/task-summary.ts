import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { jobStates } from '../shared/contracts.js';

import { taskKindLabels, taskStateLabels } from '../shared/task-labels.js';

export function taskScopes(store: Store, raw: unknown) {
  const q = z
    .object({
      projectId: z.string().min(1),
      kind: z.enum(['series', 'episode']),
      offset: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(100).default(100),
    })
    .parse(raw);
  const items = store.db
    .prepare(
      "SELECT id,kind,json_extract(data,'$.title') title,json_extract(data,'$.seriesId') series_id FROM documents WHERE project_id=? AND kind=? ORDER BY created_at,id LIMIT ? OFFSET ?",
    )
    .all(q.projectId, q.kind, q.limit, q.offset)
    .map((r) => ({ id: r.id, kind: r.kind, data: { title: r.title, seriesId: r.series_id } }));
  const total = Number(
    store.db
      .prepare('SELECT count(*) n FROM documents WHERE project_id=? AND kind=?')
      .get(q.projectId, q.kind)?.n,
  );
  return { items, total, offset: q.offset, limit: q.limit };
}

export function taskSummary(store: Store, raw: unknown) {
  const q = z
    .object({
      projectId: z.string().optional(),
      scope: z.enum(['all', 'workspace', 'project']).default('all'),
      episodeId: z.string().optional(),
      seriesId: z.string().optional(),
      kind: z.string().optional(),
      protocol: z.string().optional(),
      state: z.enum(['', ...jobStates]).default(''),
      quality: z.enum(['', 'unreviewed', 'adopted', 'needs_review']).default(''),
      attention: z.enum(['0', '1']).default('0'),
      batchId: z.string().optional(),
      offset: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(100).default(25),
    })
    .parse(raw);
  if (q.scope === 'project' && !q.projectId) throw new HttpError(400, '请明确任务所属作品');
  const condition = `(?='' OR j.project_id=?) AND (?<>'workspace' OR j.project_id IS NULL)
    AND (?='' OR j.episode_id=?) AND (?='' OR json_extract(ep.data,'$.seriesId')=?)
    AND (?='' OR j.kind=?) AND (?='' OR json_extract(j.input,'$.modelExecution.protocol')=?)
    AND (?='' OR j.state=?) AND (?='' OR j.batch_id=?)`;
  const args = [
    q.projectId || '',
    q.projectId || '',
    q.scope,
    q.episodeId || '',
    q.episodeId || '',
    q.seriesId || '',
    q.seriesId || '',
    q.kind || '',
    q.kind || '',
    q.protocol || '',
    q.protocol || '',
    q.state,
    q.state,
    q.batchId || '',
    q.batchId || '',
  ];
  const sql = `WITH summary AS (SELECT j.id,j.project_id,j.episode_id,j.kind,j.state,j.prompt_id,j.error,j.created_at,j.updated_at,j.hold_reason,j.batch_id,
    COALESCE(json_extract(p.data,'$.title'),'全局音色') project_name, json_extract(ep.data,'$.title') episode_name, json_extract(ep.data,'$.seriesId') series_id,
    json_extract(s.data,'$.title') series_name,
    COALESCE(json_extract(j.input,'$.canvas.id'),json_extract(j.input,'$.context.canvasId')) canvas_id,
    json_extract(j.input,'$.canvasNodeId') canvas_node_id,
    (SELECT max(e.created_at) FROM events e WHERE e.job_id=j.id AND e.kind=j.state) stage_at,
    COALESCE((SELECT json_extract(n.value,'$.title') FROM documents c,json_each(c.data,'$.nodes') n WHERE c.kind='canvas' AND c.id=json_extract(j.input,'$.canvas.id') AND json_extract(n.value,'$.id')=json_extract(j.input,'$.canvasNodeId') LIMIT 1), substr(json_extract(j.input,'$.context.goal'),1,60),json_extract(j.input,'$.name'),json_extract(j.input,'$.segment.id'),substr(json_extract(j.input,'$.context.request'),1,80),j.kind) target,
    json_extract(j.input,'$.modelExecution.modelId') model, json_extract(j.input,'$.modelExecution.protocol') protocol,
    json_extract(j.input,'$.voice.data.name') voice, json_extract(j.input,'$.voice.revision') voice_revision,
    json_extract(j.output,'$.waitSuspended') suspended, json_extract(j.output,'$.descriptor') descriptor,
    json_extract(j.output,'$.remoteStatus') remote_status,
    CASE WHEN json_extract(j.output,'$.basisCorrected')=1 OR j.hold_reason='dependencies_need_review' THEN 'needs_review'
      WHEN EXISTS(SELECT 1 FROM documents c,json_each(c.data,'$.nodes') n JOIN documents a ON a.id=json_extract(n.value,'$.asset.id') WHERE c.kind='canvas' AND c.project_id=j.project_id AND json_extract(n.value,'$.selected')=1 AND json_extract(a.data,'$.jobId')=j.id) THEN 'adopted'
      WHEN j.kind='voice_clone' AND EXISTS(SELECT 1 FROM library_items i JOIN library_versions v ON v.id=i.id AND v.revision=i.revision WHERE i.id=json_extract(j.output,'$.voiceResult.id') AND json_extract(v.bundle,'$.data.state')='confirmed') THEN 'adopted'
      WHEN j.kind='speech' AND j.project_id IS NULL AND EXISTS(SELECT 1 FROM library_items i JOIN library_versions v ON v.id=i.id AND v.revision=i.revision WHERE json_extract(v.bundle,'$.data.audition.id')=json_extract(j.output,'$.libraryMedia.id') AND json_extract(v.bundle,'$.data.state')='confirmed') THEN 'adopted'
      WHEN j.kind='speech' AND EXISTS(SELECT 1 FROM documents d WHERE d.kind='dialogue_take' AND json_extract(d.data,'$.synthesisJobId')=j.id AND COALESCE(json_extract(d.data,'$.stale'),0)=0) THEN 'adopted'
      WHEN j.kind='lipsync' AND EXISTS(SELECT 1 FROM documents d WHERE d.kind='segment_selection' AND json_extract(d.data,'$.jobId')=j.id AND COALESCE(json_extract(d.data,'$.stale'),0)=0) THEN 'adopted'
      WHEN j.kind NOT IN ('speech','lipsync') AND EXISTS(SELECT 1 FROM documents a WHERE a.kind='asset' AND json_extract(a.data,'$.jobId')=j.id AND json_extract(a.data,'$.adopted')=1) THEN 'adopted'
      ELSE 'unreviewed' END quality
    FROM jobs j LEFT JOIN documents p ON p.id=j.project_id LEFT JOIN documents ep ON ep.id=j.episode_id LEFT JOIN documents s ON s.id=json_extract(ep.data,'$.seriesId') WHERE ${condition})
    SELECT * FROM summary WHERE (?='' OR quality=?) AND (?='0' OR state IN ('unknown','failed') OR quality='needs_review')`;
  const filtered = [...args, q.quality, q.quality, q.attention];
  const total = Number(store.db.prepare(`SELECT count(*) n FROM (${sql})`).get(...filtered)?.n);
  const rows = store.db
    .prepare(sql + ' ORDER BY created_at DESC,id LIMIT ? OFFSET ?')
    .all(...filtered, q.limit, q.offset);
  const items = rows.map((r: any) => ({
    id: r.id,
    projectId: r.project_id,
    episodeId: r.episode_id,
    canvasId: r.canvas_id,
    canvasNodeId: r.canvas_node_id,
    seriesId: r.series_id,
    ownership: r.project_id ? 'project' : 'workspace',
    title: [r.project_name, r.series_name, r.episode_name, r.target].filter(Boolean).join('／'),
    kind: r.kind,
    kindLabel: taskKindLabels[r.kind as keyof typeof taskKindLabels] || r.kind,
    state: r.state,
    stage: r.suspended
      ? '本机跟踪已暂停'
      : taskStateLabels[r.state as keyof typeof taskStateLabels],
    model: r.model,
    protocol: r.protocol,
    voice: r.voice,
    voiceRevision: r.voice_revision,
    quality: r.quality,
    qualityLabel:
      r.quality === 'adopted'
        ? '已选用 · 不代表质量通过'
        : r.quality === 'needs_review'
          ? '依据需复核'
          : r.state === 'succeeded'
            ? r.kind === 'speech' || r.kind === 'voice_clone'
              ? '可使用 · 未听审'
              : r.kind === 'lipsync'
                ? '可使用 · 口型未观察'
                : '可使用 · 未观察'
            : '尚无选用记录',
    holdReason:
      (
        {
          voice_disabled: '音色已停用',
          voice_unavailable: '远端音色未就绪或已过期，请查询原音色',
          model_connection_disabled: '模型或连接已停用',
          dependencies_need_review: '实际消费依据需要复核',
          creation_mode_review: '等待创作确认',
        } as Record<string, string>
      )[r.hold_reason] || r.hold_reason,
    holdReasonCode: r.hold_reason,
    error: r.error,
    remoteStatus: r.remote_status,
    batchId: r.batch_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    elapsedSeconds:
      ['succeeded', 'failed', 'cancelled'].includes(r.state) && !r.stage_at
        ? null
        : Math.max(
            0,
            Math.floor(
              ((['succeeded', 'failed', 'cancelled'].includes(r.state) ? r.stage_at : Date.now()) -
                r.created_at) /
                1000,
            ),
          ),
    actions: r.suspended
      ? ['resume-tracking']
      : r.state === 'queued'
        ? ['cancel']
        : r.state === 'unknown'
          ? [
              ...(['image', 'speech', 'creative', 'media_analysis', 'transcription'].includes(
                r.kind,
              )
                ? []
                : ['reconcile']),
              'suspend-tracking',
            ]
          : ['submitted', 'running'].includes(r.state)
            ? ['suspend-tracking']
            : r.state === 'failed'
              ? r.descriptor
                ? ['recover-archive']
                : ['prepare-new-attempt']
              : r.state === 'succeeded'
                ? ['review']
                : [],
  }));
  return { items, total, offset: q.offset, limit: q.limit };
}
