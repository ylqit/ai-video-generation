import type { Express } from 'express';
import { z } from 'zod';
import { Store } from './db.js';
import { CanvasService } from './canvas.js';
import { ProductionAssistant } from './production-assistant.js';
import { prepareCanvasGeneration } from './canvas-generation.js';
import { patchCanvas, canvasConversion } from './canvas-patches.js';
import { nodeDefinitions } from '../shared/node-catalog.js';
import { registerNodeExecutionRoutes } from './node-execution.js';
import { registerCanvasObjectRoutes } from './canvas-objects.js';
import { registerConversationRoutes } from './canvas-conversation.js';
import { registerNodeReferenceRoutes } from './node-references.js';
import { registerAnalysisMaterializationRoutes } from './analysis-materialization.js';

export function registerCanvasRoutes(app: Express, store: Store, root: string) {
  registerNodeExecutionRoutes(app, store);
  registerAnalysisMaterializationRoutes(app, store);
  registerCanvasObjectRoutes(app, store);
  registerConversationRoutes(app, store, root);
  registerNodeReferenceRoutes(app, store);
  const service = new CanvasService(store),
    assistant = new ProductionAssistant(store, root);
  app.get('/api/node-definitions', (_req, res) => res.json(nodeDefinitions));
  app.patch('/api/canvases/:id', (req, res) =>
    res.json(patchCanvas(store, String(req.params.id), req.body)),
  );
  app.post('/api/canvases/:id/conversion', (req, res) =>
    res.json(
      canvasConversion(
        store,
        String(req.params.id),
        req.body.apply === true,
        z.number().int().positive().parse(req.body.revision),
      ),
    ),
  );
  app.get('/api/projects/:id/objects', (req, res) => {
    const projectId = String(req.params.id),
      kind = String(req.query.kind || 'episode'),
      offset = Math.max(0, Number(req.query.offset) || 0),
      q = String(req.query.q || '');
    const rows = store.db
      .prepare(
        "SELECT id,kind,revision,parent_id parentId,json_extract(data,'$.title') title,json_extract(data,'$.name') name FROM documents WHERE project_id=? AND kind=? AND (COALESCE(json_extract(data,'$.title'),'')||COALESCE(json_extract(data,'$.name'),'')) LIKE ? ORDER BY updated_at DESC,id LIMIT 40 OFFSET ?",
      )
      .all(projectId, kind, '%' + q + '%', offset);
    res.json({ items: rows, offset, hasMore: rows.length === 40 });
  });
  app.get('/api/media-index', (req, res) => {
    const q = z
      .object({
        projectId: z.string().default(''),
        mediaType: z.enum(['', 'image', 'video', 'audio']).default(''),
        q: z.string().max(200).default(''),
        offset: z.coerce.number().int().nonnegative().default(0),
      })
      .parse(req.query);
    const where =
      "a.kind='asset' AND COALESCE(json_extract(a.data,'$.fileCleared'),0)=0 AND (?='' OR a.project_id=?) AND (?='' OR json_extract(a.data,'$.mediaType')=?) AND json_extract(a.data,'$.name') LIKE ?";
    const args = [q.projectId, q.projectId, q.mediaType, q.mediaType, '%' + q.q + '%'];
    const total = Number(
      store.db.prepare('SELECT count(*) n FROM documents a WHERE ' + where).get(...args)?.n,
    );
    const items = store.db
      .prepare(
        "SELECT a.id,a.revision,a.project_id projectId,json_extract(a.data,'$.name') name,json_extract(a.data,'$.mediaType') mediaType,json_extract(p.data,'$.title') projectName FROM documents a LEFT JOIN documents p ON p.id=a.project_id WHERE " +
          where +
          ' ORDER BY a.updated_at DESC,a.id LIMIT 36 OFFSET ?',
      )
      .all(...args, q.offset);
    res.json({ items, total, offset: q.offset });
  });

  app.get('/api/projects/:id/canvases', (req, res) => {
    const projectId = String(req.params.id);
    const rows = store.db
      .prepare(
        `SELECT id,revision,parent_id,created_at,updated_at,
      json_extract(data,'$.title') title,json_extract(data,'$.episodeId') episode_id,
      json_extract(data,'$.version') version FROM documents
      WHERE kind='canvas' AND project_id=? ORDER BY created_at,id`,
      )
      .all(projectId);
    res.json(
      rows.map((r) => ({
        id: r.id,
        revision: r.revision,
        kind: 'canvas',
        projectId,
        parentId: r.parent_id,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        data: { title: r.title, episodeId: r.episode_id, version: r.version },
      })),
    );
  });
  app.post('/api/projects/:id/canvases', (req, res) =>
    res.status(201).json(service.create(String(req.params.id), req.body)),
  );
  app.get('/api/canvases/:id', (req, res) => res.json(service.snapshot(String(req.params.id))));
  app.put('/api/canvases/:id', (req, res) =>
    res.json(
      service.save(
        String(req.params.id),
        z.number().int().positive().parse(req.body.revision),
        req.body.data,
      ),
    ),
  );
  app.post('/api/canvases/:id/nodes/:node/preview', (req, res) =>
    res.json(prepareCanvasGeneration(store, String(req.params.id), String(req.params.node))),
  );
  app.post('/api/canvases/:id/nodes/:node/generate', (req, res) =>
    res.status(201).json(service.submit(String(req.params.id), String(req.params.node), req.body)),
  );
  app.post('/api/canvases/:id/collect', (req, res) =>
    res.json(service.collect(String(req.params.id), z.array(z.string()).parse(req.body.jobIds))),
  );
  app.put('/api/canvases/:id/timeline', (req, res) =>
    res.json(
      service.saveTimeline(
        String(req.params.id),
        z.number().int().positive().parse(req.body.revision),
        req.body.data,
      ),
    ),
  );
  app.post('/api/canvases/:id/export', (req, res) =>
    res.status(201).json(service.export(String(req.params.id), req.body)),
  );
  app.post('/api/canvases/:id/finalize', (req, res) =>
    res.json(
      service.finalize(
        String(req.params.id),
        z.number().int().positive().parse(req.body.revision),
        z.object({ id: z.string(), revision: z.number().int().positive() }).parse(req.body.asset),
      ),
    ),
  );
  app.post('/api/canvases/:id/assistant-runs', (req, res) =>
    res.status(201).json(assistant.create(String(req.params.id), req.body)),
  );
}
