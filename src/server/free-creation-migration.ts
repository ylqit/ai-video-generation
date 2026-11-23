import { Store, HttpError } from './db.js';
import { productionHead } from './creation-heads.js';
import { CanvasService } from './canvas.js';
import { generationDigest } from './h3-guided.js';
import type { CanvasContent } from '../shared/canvas.js';

// Explicit, additive transition. Revisions/jobs/media are never rewritten. A preview
// binds both current documents and task lifecycle so a live workspace cannot race apply.
export function previewFreeCreationMigration(store: Store) {
  const projects = store.list('project').map((p) => {
    const docs = store.list(undefined, p.id),
      canvases = docs.filter((d) => d.kind === 'canvas');
    const targets = docs.filter((d) => d.kind === 'episode');
    if (!targets.length) targets.push(p);
    return {
      projectId: p.id,
      targets: targets
        .filter((t) => !canvases.some((c) => c.data.migrationSource?.id === t.id))
        .map((t) => ({
          id: t.id,
          revision: t.revision,
          title: t.data.title,
          episodeId: t.kind === 'episode' ? t.id : null,
        })),
      pauseRuns: docs
        .filter(
          (d) =>
            (d.kind === 'assistant_run' &&
              d.data.version !== 2 &&
              !['stopped', 'completed', 'paused'].includes(d.data.state)) ||
            (d.kind === 'creation_run' && !d.data.paused && d.data.state !== 'complete'),
        )
        .map((d) => ({ id: d.id, revision: d.revision, kind: d.kind })),
    };
  });
  const jobs = store.db
    .prepare('SELECT id,state,prompt_id,input,output FROM jobs ORDER BY id')
    .all();
  const heads = store.db.prepare('SELECT id,revision FROM documents ORDER BY id').all();
  return {
    version: 1,
    projects,
    activeJobs: jobs
      .filter((j) => !['failed', 'succeeded', 'cancelled'].includes(String(j.state)))
      .map((j) => ({ id: j.id, state: j.state, remoteId: j.prompt_id })),
    digest: generationDigest({ projects, jobs, heads }),
  };
}

export function applyFreeCreationMigration(store: Store, digest: string) {
  return store.transaction(() => {
    if (store.db.prepare('SELECT name FROM leases WHERE expires>?').get(Date.now()))
      throw new HttpError(409, '请停止服务后迁移，不能与运行中的 Worker 并发');
    const preview = previewFreeCreationMigration(store);
    if (preview.digest !== digest) throw new HttpError(409, '迁移范围或任务状态已变化，请重新预览');
    const service = new CanvasService(store),
      created: string[] = [];
    for (const project of preview.projects) {
      const docs = store.list(undefined, project.projectId);
      for (const target of project.targets) {
        const sources = docs.filter(
          (d) => d.kind === 'chapter' && (d.parentId === target.id || !target.episodeId),
        );
        const nodes: CanvasContent['nodes'] = sources.map((d, i) => ({
          id: 'document:' + d.id,
          type: 'document',
          title: d.data.title || '来源正文',
          text: d.data.content || '',
          x: 40 + i * 320,
          y: 40,
          document: { id: d.id, revision: d.revision },
          selected: false,
        }));
        const ep = store.get(target.id);
        if (target.episodeId) {
          const head = productionHead(store, target.episodeId);
          const ref =
            head.runId && !head.conflict ? store.get(head.runId).data.results?.script : null;
          if (ref) {
            const result = store.get(ref.id, ref.revision);
            const content = result.data.result?.screenplayText;
            if (content) {
              const chapter = store.create(
                'chapter',
                project.projectId,
                {
                  title: '剧本 · 迁移副本',
                  content,
                  source: 'authoring_migration',
                  sourceRef: ref,
                },
                target.episodeId,
              );
              nodes.unshift({
                id: 'document:' + chapter.id,
                type: 'document',
                title: chapter.data.title,
                text: content,
                document: { id: chapter.id, revision: chapter.revision },
                x: 40,
                y: 40,
                selected: false,
              });
            }
          }
        }
        if (target.episodeId)
          for (const shot of ep.data.shots || []) {
            nodes.push({
              id: 'shot:' + shot.id,
              type: 'video',
              title: shot.title || shot.id,
              text: shot.directing?.execution?.action || shot.description || '',
              x: 40 + (nodes.length % 4) * 320,
              y: 340 + Math.floor(nodes.length / 4) * 240,
              selected: false,
            });
          }
        for (const s of docs.filter(
          (d) => d.kind === 'segment_selection' && d.parentId === target.id,
        )) {
          const asset = store.get(s.data.video.id, s.data.video.revision);
          nodes.push({
            id: 'selected:' + s.id,
            type: 'video',
            title: asset.data.name || s.data.segmentId,
            text: '历史选用；观察记录保留在原记录中',
            x: 40 + (nodes.length % 4) * 320,
            y: 700 + Math.floor(nodes.length / 4) * 240,
            asset: s.data.video,
            range: { in: s.data.in, out: s.data.out },
            selected: true,
          });
        }
        const canvas = service.create(project.projectId, {
          version: 1,
          title: target.title || '历史作品',
          episodeId: target.episodeId,
          nodes,
          edges: [],
        });
        const edl = docs.find((d) => d.kind === 'edl' && d.parentId === target.id);
        store.update(canvas.id, canvas.revision, {
          ...canvas.data,
          migrationSource: { id: target.id, revision: target.revision },
          ...(edl ? { edl: { id: edl.id, revision: edl.revision } } : {}),
        });
        created.push(canvas.id);
      }
      for (const ref of project.pauseRuns) {
        const run = store.get(ref.id);
        store.update(run.id, run.revision, {
          ...run.data,
          ...(run.kind === 'assistant_run' ? { state: 'paused' } : { paused: true }),
          note: '已迁移至自由创作；旧自动推进暂停，已提交任务保留原输入继续恢复',
        });
      }
    }
    store.event(null, 'free_creation_migrated', {
      version: 1,
      digest,
      created,
      activeJobs: preview.activeJobs,
    });
    return {
      created,
      paused: preview.projects.flatMap((p) => p.pauseRuns),
      preservedJobs: preview.activeJobs,
    };
  });
}
