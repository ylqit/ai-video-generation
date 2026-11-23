import type { Express } from 'express';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { SeriesProposals } from './series-proposal.js';
import { SourceAdaptation } from './source-adaptation.js';
import { episodeProductionSchema } from '../shared/series.js';
import { effectiveEpisodePlan, episodePredecessor } from './episode-plan.js';
import { StudioService } from './service.js';
import { ValidationExperiments } from './validation-experiment.js';

export function registerSeriesCreationRoutes(app: Express, store: Store) {
  const proposals = new SeriesProposals(store),
    sources = new SourceAdaptation(store);
  const experiments = new ValidationExperiments(store);
  app.post('/api/projects/:id/validation-experiments/prepare', (req, res) =>
    res.json(experiments.prepare(String(req.params.id), req.body)),
  );
  app.post('/api/projects/:id/validation-experiments', (req, res) =>
    res.json(experiments.save(String(req.params.id), req.body)),
  );
  app.get('/api/validation-experiments/:id/report', (req, res) =>
    res.json(experiments.report(String(req.params.id), req.query.blind === 'true')),
  );
  app.post('/api/validation-experiments/:id/attempts', (req, res) =>
    res.json(experiments.record(String(req.params.id), req.body)),
  );
  app.get('/api/series/:id/proposals', (req, res) => {
    const series = store.get(String(req.params.id));
    if (series.kind !== 'series') throw new HttpError(400, '请选择系列');
    res.json(store.list('series_proposal', series.projectId, series.id));
  });
  app.post('/api/series/:id/proposals/prepare', (req, res) =>
    res.json(proposals.prepare(String(req.params.id), req.body)),
  );
  app.post('/api/series/:id/proposals/generate', (req, res) =>
    res.json(proposals.generate(String(req.params.id), req.body)),
  );
  app.post('/api/series/:id/proposals', (req, res) =>
    res.json(proposals.save(String(req.params.id), req.body)),
  );
  app.post('/api/series-proposals/:id/preview', (req, res) =>
    res.json(proposals.preview(String(req.params.id), req.body)),
  );
  app.post('/api/series-proposals/:id/apply', (req, res) =>
    res.json(proposals.apply(String(req.params.id), req.body)),
  );
  app.post('/api/projects/:id/source-index/preview', (req, res) =>
    res.json(sources.preview(String(req.params.id), req.body.sources)),
  );
  app.post('/api/projects/:id/source-index', (req, res) =>
    res.json(sources.save(String(req.params.id), req.body)),
  );
  app.get('/api/episodes/:id/requirements', (req, res) => {
    const ep = store.get(String(req.params.id));
    if (ep.kind !== 'episode') throw new HttpError(400, '请选择分集');
    res.json({
      effectivePlan: effectiveEpisodePlan(store, ep),
      predecessor: episodePredecessor(store, ep),
    });
  });
  app.put('/api/episodes/:id/requirements', (req, res) => {
    const body = z
      .object({ revision: z.number().int().positive(), data: episodeProductionSchema })
      .strict()
      .parse(req.body);
    res.json(
      store.transaction(() => {
        const ep = store.get(String(req.params.id));
        if (ep.kind !== 'episode' || ep.data.seriesProduction?.slotId !== body.data.slotId)
          throw new HttpError(400, '请通过系列规划调整分集关联');
        const next = new StudioService(store).saveEpisode(ep.id, body.revision, {
          ...ep.data,
          seriesProduction: body.data,
        });
        effectiveEpisodePlan(store, next);
        return next;
      }),
    );
  });
}
