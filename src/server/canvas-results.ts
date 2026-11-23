import { Store } from './db.js';
import { canvasSchema } from '../shared/canvas.js';

// Runs after archival, not on GET. A stable output key prevents duplicate receipts on recovery.
export function attachCanvasResults(store: Store, jobId: string) {
  return store.transaction(() => {
    const job = store.job(jobId),
      id = job.input.canvas?.id;
    if (!id || !(job.state === 'succeeded' || job.output.documentIds?.length)) return;
    let canvas;
    try {
      canvas = store.get(id);
    } catch {
      return;
    }
    if (canvas.projectId !== job.projectId || canvas.kind !== 'canvas' || canvas.data.version !== 2)
      return;
    const data = canvasSchema.parse(canvas.data),
      origin = data.nodes.find((n) => n.id === job.input.canvasNodeId);
    if (!origin) return; // media remain in the project's library even after the source node is removed
    const ids = new Set<string>(job.output.assetIds || []);
    for (const row of store.db
      .prepare(
        "SELECT id FROM documents WHERE kind='asset' AND project_id=? AND json_extract(data,'$.jobId')=?",
      )
      .all(job.projectId, job.id))
      ids.add(String(row.id));
    const outputs = origin.outputs || [],
      prior = new Set(outputs.map((o) => o.key));
    let changed = false;
    for (const assetId of ids) {
      const a = store.get(assetId),
        key = `${job.id}:asset:${a.id}`;
      if (
        prior.has(key) ||
        [
          'image_edit_raw',
          'image_edit_guide',
          'image_edit_mask',
          'lipsync_source',
          'provider_original',
        ].includes(a.data.category)
      )
        continue;
      outputs.push({
        key,
        jobId: job.id,
        slot: a.data.mediaType,
        asset: { id: a.id, revision: a.revision },
        label: a.data.name || origin.title,
      });
      changed = true;
      if (job.kind === 'media_process' && job.input.nodeOperation?.action !== 'analyze') {
        const nid = `result:${a.id}`;
        if (data.nodes.length < 5000 && !data.nodes.some((n) => n.id === nid)) {
          data.nodes.push({
            id: nid,
            type: a.data.mediaType,
            title: a.data.name || '派生素材',
            text: '',
            x: origin.x + 350,
            y: origin.y + outputs.length * 50,
            selected: false,
            asset: { id: a.id, revision: a.revision },
          });
          data.edges.push({
            id: `source:${a.id}`,
            source: origin.id,
            target: nid,
            relation: 'result',
            instruction: `任务 ${job.id}`,
          });
        }
      }
    }
    for (const documentId of job.output.documentIds || []) {
      const d = store.get(documentId),
        key = `${job.id}:document:${d.id}`,
        previous = outputs.find((o) => o.key === key);
      if (previous?.document?.revision === d.revision) continue;
      const previousRevision = previous?.document?.revision;
      if (previous) previous.document = { id: d.id, revision: d.revision };
      else
        outputs.push({
          key,
          jobId: job.id,
          slot: 'text',
          document: { id: d.id, revision: d.revision },
          label: d.data.title || '分析结果',
        });
      changed = true;
      if (d.data.kind === 'shot_detection' || d.data.kind === 'transcribe') {
        const nid = `result:${d.id}`,
          existing = data.nodes.find((n) => n.id === nid);
        if (existing?.binding?.id === d.id && existing.binding.revision === previousRevision)
          existing.binding.revision = d.revision;
        if (!existing && data.nodes.length < 5000) {
          data.nodes.push({
            id: nid,
            type: d.data.kind === 'transcribe' ? 'transcription' : 'analysis',
            title: d.data.title,
            text: '',
            x: origin.x + 350,
            y: origin.y + 250,
            binding: { id: d.id, revision: d.revision },
            selected: false,
          });
          data.edges.push({
            id: 'source:' + d.id,
            source: origin.id,
            target: nid,
            relation: 'result',
            instruction: '实际分析结果',
          });
        }
      }
    }
    if (changed) {
      origin.outputs = outputs;
      store.update(id, canvas.revision, { ...canvas.data, ...data });
    }
  });
}
