import type express from 'express';
import { Store, HttpError } from './db.js';
import { CreationMediaService } from './creation-media.js';

export function registerCreationMediaRoutes(app: express.Express, store: Store, root: string) {
  const service = new CreationMediaService(store, root);
  app.get('/api/creation-runs/:id/asset-tasks', (req, res) =>
    res.json({
      items: service.assetTasks(
        String(req.params.id),
        req.query.requirementId ? String(req.query.requirementId) : undefined,
      ),
    }),
  );
  app.post('/api/creation-runs/:id/asset-tasks', (req, res) =>
    res.status(201).json(service.createAssetTask(String(req.params.id), req.body)),
  );
  app.get('/api/creation-runs/:id/review-edits', (req, res) =>
    res.json({
      items: service.reviewEdits(String(req.params.id)),
      jobs: store
        .jobs(store.get(String(req.params.id)).projectId)
        .filter(
          (j) =>
            j.kind === 'export' &&
            j.input.creationRunId === String(req.params.id) &&
            j.input.reviewEdit,
        )
        .map((j) => ({ ...j, input: { reviewEdit: j.input.reviewEdit } })),
    }),
  );
  app.post('/api/creation-runs/:id/review-edits', async (req, res) =>
    res.status(201).json(await service.saveReview(String(req.params.id), req.body)),
  );
  app.put('/api/review-edits/:id', async (req, res) => {
    const edit = store.get(String(req.params.id));
    if (edit.kind !== 'creation_review_edit') throw new HttpError(400, '不是审看编辑');
    res.json(await service.saveReview(edit.data.runId, req.body, edit.id));
  });
  app.post('/api/review-edits/:id/export', async (req, res) =>
    res.status(201).json(await service.exportReview(String(req.params.id), req.body)),
  );
  app.get('/api/creation-runs/:id/media-issues', (req, res) => {
    const run = store.get(String(req.params.id));
    if (run.kind !== 'creation_run') throw new HttpError(400, '不是创作运行');
    res.json({
      items: store.list('creation_media_issue', run.projectId).filter((i) => i.parentId === run.id),
    });
  });
  app.post('/api/creation-runs/:id/media-issues', (req, res) =>
    res.status(201).json(service.mediaIssue(String(req.params.id), req.body)),
  );
  app.get('/api/creation-runs/:id/transcription-availability', (req, res) => {
    const run = store.get(String(req.params.id));
    if (run.kind !== 'creation_run') throw new HttpError(400, '不是创作运行');
    res.json({
      available: false,
      reason: '当前 Worker 未配置离线语音识别执行器；可导入 SRT 并人工核对。',
    });
  });
}
