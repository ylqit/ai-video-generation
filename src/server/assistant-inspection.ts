import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Store, HttpError } from './db.js';
import type { RecordDoc } from '../shared/contracts.js';
import { assistantMethods } from '../shared/assistant.js';
import { nodeDefinitions } from '../shared/node-catalog.js';
import { mediaOperationSchema, mediaActions } from '../shared/node-operations.js';
import { analysisRequest } from './node-analysis.js';
import { synthesizeSchema } from './speech-production.js';
import { lipsyncSchema } from './sync-lipsync.js';
import { directorSceneSchema } from '../shared/director-scene.js';
import { domainSchemas } from '../shared/domain.js';
import { imageEditPlanSchema } from '../shared/image-edit-plan.js';
import { VoiceLibrary } from './voice-library.js';
import { generationDigest } from './h3-guided.js';

// Read tools own pagination, fixed object access and versioned method loading.
// They never expand the run's write scope or submit provider work.
export function inspectAssistantWorkspace(store: Store, run: RecordDoc, args: unknown) {
  const data = store.get(run.parentId!).data;

  const query = z
    .object({
      catalog: z.boolean().optional(),
      nodeId: z.string().optional(),
      document: z.object({ id: z.string(), revision: z.number().int().positive() }).optional(),
      referenceIndex: z.number().int().nonnegative().optional(),
      nodes: z.boolean().optional(),
      timeline: z.boolean().optional(),
      offset: z.number().int().nonnegative().default(0),
      outputOffset: z.number().int().nonnegative().default(0),
      objectSchema: z.enum(['entity', 'appearance', 'layout', 'director']).optional(),
      method: z.enum(['writing', 'directing', 'assets', 'editing']).optional(),
      library: z.enum(['image', 'video', 'audio', 'document', 'voice', 'dialogue']).optional(),
      operation: z.enum(['synthesize', 'lipsync']).optional(),
      search: z.string().max(200).default(''),
      limit: z.number().int().min(1).max(30).default(20),
    })
    .parse(args);
  let method: any = query.method ? assistantMethods[query.method] : null;
  if (query.method) {
    const source =
      'stages-v9/' +
      { writing: 'script', directing: 'director', assets: 'assets', editing: 'editorial' }[
        query.method
      ] +
      '.md';
    const file = path.resolve('skills/studio-director/references', source);
    if (!fs.existsSync(file)) throw new HttpError(503, '创作方法资料缺失：' + source);
    const rules = fs.readFileSync(file, 'utf8');
    method = {
      version: 'workbench-method-v2',
      source,
      sha256: generationDigest(rules),
      rules:
        method.rules +
        '\nStudio free creation overrides older stage approval requirements: reviews are optional, permissions and factual provenance remain mandatory. Use only the fields applicable to the current task.\n' +
        rules,
    };
  }
  let content: any = null;
  if (query.nodes) {
    const list = data.nodes.filter((n: any) => !query.search || n.title.includes(query.search));
    content = {
      total: list.length,
      offset: query.offset,
      nodes: list.slice(query.offset, query.offset + query.limit).map((n: any) => ({
        id: n.id,
        type: n.type,
        title: n.title,
        asset: n.asset,
        binding: n.binding,
        document: n.document,
        outputCount: n.outputs?.length || 0,
      })),
      nextOffset: query.offset + query.limit < list.length ? query.offset + query.limit : null,
    };
  } else if (query.timeline) {
    const record = data.edl ? store.get(data.edl.id, data.edl.revision) : null;
    content = record
      ? {
          id: record.id,
          revision: record.revision,
          ...record.data,
          clips: record.data.clips.slice(query.offset, query.offset + query.limit),
          audio: record.data.audio.slice(query.offset, query.offset + query.limit),
          overlays: record.data.overlays?.slice(query.offset, query.offset + query.limit),
          counts: {
            clips: record.data.clips.length,
            audio: record.data.audio.length,
            overlays: record.data.overlays?.length || 0,
          },
          offset: query.offset,
        }
      : null;
  } else if (query.nodeId) {
    const n = data.nodes.find((n: any) => n.id === query.nodeId);
    if (!n) throw new HttpError(404, '节点不存在');
    content = {
      ...n,
      text: (n.text || '').slice(query.offset, query.offset + 6000),
      textLength: n.text?.length || 0,
      nextTextOffset: query.offset + 6000 < (n.text?.length || 0) ? query.offset + 6000 : null,
      outputs: n.outputs?.slice(query.outputOffset, query.outputOffset + 8),
      outputCount: n.outputs?.length || 0,
      edges: data.edges.filter((e: any) => e.target === n.id).slice(0, 60),
    };
  } else if (query.document) {
    const d = store.get(query.document.id, query.document.revision);
    if (
      d.projectId !== run.projectId ||
      ![
        'chapter',
        'node_analysis',
        'entity',
        'appearance',
        'reference_pack',
        'directing',
        'episode',
        'series',
        'story_blueprint',
      ].includes(d.kind)
    )
      throw new HttpError(403, '文档不在可读取资料范围');
    const text = d.data.content ?? JSON.stringify(d.data);
    content = {
      id: d.id,
      revision: d.revision,
      kind: d.kind,
      text: text.slice(query.offset, query.offset + 6000),
      length: text.length,
      nextOffset: query.offset + 6000 < text.length ? query.offset + 6000 : null,
    };
  } else if (query.referenceIndex !== undefined) {
    const r = run.data.referenceContext?.items[query.referenceIndex];
    if (!r) throw new HttpError(404, '固定引用不存在');
    content = {
      ...r,
      text: r.text.slice(query.offset, query.offset + 6000),
      length: r.text.length,
      nextOffset: query.offset + 6000 < r.text.length ? query.offset + 6000 : null,
    };
  }
  const records =
    query.library === 'voice'
      ? new VoiceLibrary(store).list({
          search: query.search,
          offset: query.offset,
          limit: query.limit,
        }).items
      : query.library
        ? store.db
            .prepare(
              `SELECT id FROM documents WHERE project_id=? AND kind=?
          AND COALESCE(json_extract(data,'$.fileCleared'),0)=0
          AND (?='' OR json_extract(data,'$.mediaType')=?)
          AND (COALESCE(json_extract(data,'$.title'),'')||COALESCE(json_extract(data,'$.name'),'')) LIKE ?
          ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
            )
            .all(
              run.projectId,
              query.library === 'document'
                ? 'chapter'
                : query.library === 'dialogue'
                  ? 'dialogue_take'
                  : 'asset',
              ['document', 'dialogue'].includes(query.library) ? '' : query.library,
              query.library,
              '%' + query.search + '%',
              query.limit,
              query.offset,
            )
            .map((row) => store.get(String(row.id)))
            .map((d) => ({
              id: d.id,
              revision: d.revision,
              title: d.data.title || d.data.name,
              mediaType: d.data.mediaType,
              duration: d.data.duration,
              ...(query.library === 'dialogue' ? { data: d.data } : {}),
            }))
        : [];
  const operation = query.operation
    ? {
        requestSchema: z.toJSONSchema(
          query.operation === 'synthesize' ? synthesizeSchema : lipsyncSchema,
        ),
        episode: data.episodeId ? store.get(data.episodeId) : null,
      }
    : {};
  const inspectionDigest =
    content ||
    query.method ||
    query.library ||
    query.operation ||
    query.catalog ||
    query.objectSchema
      ? generationDigest({
          query,
          content,
          method,
          records,
          operation,
          catalog: query.catalog ? nodeDefinitions : null,
        })
      : null;
  return {
    progress:
      !!inspectionDigest &&
      !run.data.receipts.some((r: any) => r.result?.inspectionDigest === inspectionDigest),
    inspectionDigest,
    method,
    content,
    records,
    ...operation,
    summary: { nodes: data.nodes.length },
    ...(query.catalog
      ? {
          catalog: nodeDefinitions.map((d) => ({
            ...d,
            operations: d.actions.map((action) => {
              const task = [
                ...mediaActions,
                'generate',
                'vision',
                'transcribe',
                'text_generate',
                'rewrite',
                'synthesize',
                'lipsync',
                'previs_image',
                'previs_video',
              ].includes(action);
              const editor: Record<string, { tool: string; instructions: string }> = {
                bind: {
                  tool: 'write',
                  instructions:
                    'Read the fixed owned object first; set node.binding={id,revision,shotId?}. Use object_edit only to edit its contents after binding.',
                },
                video_draft: {
                  tool: 'write',
                  instructions:
                    'Create video_generate using an authorized model; connect this shot to its context port. prepare/generate consumes the bound director requirements.',
                },
                director_draft: {
                  tool: 'write',
                  instructions:
                    'Create a director node, connect shot context, then object_edit with the inspected director schema before previs export.',
                },
                inpaint: {
                  tool: 'write',
                  instructions:
                    'Create image_generate with settings.imageEdit from imageEditSchema, original source and explicit box/mask; connect the source and use generate with edit mode.',
                },
                relight: {
                  tool: 'write',
                  instructions:
                    'Create image_generate with settings.imageEdit action=relight and source; connect the original then generate in edit mode. This is an editing request, not exact 3D lighting.',
                },
                angle: {
                  tool: 'write',
                  instructions:
                    'Create image_generate with settings.imageEdit action=angle and source; connect the original then generate in edit mode.',
                },
                panorama: {
                  tool: 'write',
                  instructions:
                    'Create image_generate with settings.imageEdit action=panorama and source; connect the original then generate in edit mode.',
                },
                materialize: {
                  tool: 'materialize',
                  instructions:
                    'Select fixed analysis output and indices; create text, frames or shot cards without another model call.',
                },
                subtitles: {
                  tool: 'materialize',
                  instructions:
                    'Select fixed transcription output, action=subtitles and the destination clipIndex; original recognition remains immutable.',
                },
                timeline: {
                  tool: 'timeline',
                  instructions:
                    'Read current EDL and fixed media first, then submit the complete EDL preserving independent audio and captions.',
                },
                export: {
                  tool: 'export',
                  instructions:
                    'Export the fixed current EDL; successful export is not a quality judgment.',
                },
              };
              return task
                ? {
                    action,
                    kind: 'task',
                    tool: 'node_operation',
                    arguments: {
                      nodeId: '<target node id>',
                      operation: { action, request: '<matching schema>' },
                    },
                  }
                : { action, kind: 'editor', ...editor[action] };
            }),
          })),
          mediaSchema: z.toJSONSchema(mediaOperationSchema),
          analysisSchema: z.toJSONSchema(analysisRequest),
          imageEditSchema: z.toJSONSchema(imageEditPlanSchema),
        }
      : {}),
    ...(query.objectSchema
      ? {
          objectSchema: z.toJSONSchema(
            query.objectSchema === 'director'
              ? directorSceneSchema
              : domainSchemas[query.objectSchema],
          ),
        }
      : {}),
  };
}
