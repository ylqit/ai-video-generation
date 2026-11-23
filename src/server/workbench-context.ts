import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { contextReferencesSchema } from '../shared/workbench-context.js';
import { generationDigest } from './h3-guided.js';
import { resolveNodeContext } from './node-context.js';

const documentKinds = [
  'chapter',
  'node_analysis',
  'entity',
  'appearance',
  'reference_pack',
  'directing',
  'series',
  'episode',
  'story_blueprint',
];
/** Resolves read-only, fixed context. This function never grants a write scope or creates work. */
export function resolveWorkbenchContext(
  store: Store,
  projectId: string,
  raw: unknown,
  execution?: any,
  readWindow?: { offset: number; limit: number },
) {
  const references = contextReferencesSchema.parse(raw),
    assets: any[] = [],
    dependencies: any[] = [],
    issues: string[] = [];
  const owned = (ref: { id: string; revision: number }) => {
    const d = store.get(ref.id, ref.revision);
    if (d.projectId !== projectId) throw new HttpError(400, '引用不属于当前作品');
    dependencies.push({ id: d.id, revision: d.revision });
    return d;
  };
  const items = references.map((r, index) => {
    let title = '',
      text = '',
      asset: any = null,
      object: any = null;
    if (r.kind === 'node' || r.kind === 'output') {
      const c = owned(r.canvas);
      if (c.kind !== 'canvas') throw new HttpError(400, '引用必须指向画布');
      const n = c.data.nodes.find((n: any) => n.id === r.nodeId);
      if (!n) throw new HttpError(404, '固定画布版本中没有该节点');
      title = n.title;
      if (r.kind === 'output') {
        const output = n.outputs?.find((o: any) => o.key === r.outputKey);
        if (!output) throw new HttpError(404, '固定版本中没有该候选');
        title += ' · ' + (output.label || output.key);
        if (output.asset) asset = owned(output.asset);
        else if (output.document) object = owned(output.document);
      } else {
        text = n.text || '';
        if (n.asset) asset = owned(n.asset);
        if (n.document) object = owned(n.document);
        const linked = resolveNodeContext(store, projectId, n);
        if (linked?.source) {
          dependencies.push(linked.source);
          text += '\n关联制作资料：' + JSON.stringify(linked);
        }
      }
    } else {
      const d = owned(r.object);
      if (r.kind === 'asset') asset = d;
      else object = d;
      title = d.data.title || d.data.name || d.kind;
    }
    if (object) {
      if (!documentKinds.includes(object.kind))
        throw new HttpError(400, '此资料不能作为文档上下文');
      text = object.data.content ?? object.data.text ?? JSON.stringify(object.data);
    }
    if (r.textRange) {
      const s = r.textRange;
      if (s.end <= s.start || text.slice(s.start, s.end) !== s.expected)
        throw new HttpError(409, '引用选区与固定正文不符');
      text = s.expected;
    }
    const textLength = text.length;
    if (readWindow) text = text.slice(readWindow.offset, readWindow.offset + readWindow.limit);
    else if (text.length > 30000)
      throw new HttpError(400, '单项正文超过 30000 字符，请选择相关文本区间');
    let media: any = null,
      consumption = text ? 'text' : 'metadata';
    if (asset) {
      if (asset.kind !== 'asset') throw new HttpError(400, '不是媒体资产');
      const a = asset.data;
      if (
        r.range &&
        (a.mediaType === 'image' || r.range.out <= r.range.in || r.range.out > a.duration + 0.001)
      )
        throw new HttpError(400, '引用区间超出实际媒体');
      media = {
        id: asset.id,
        revision: asset.revision,
        type: a.mediaType,
        duration: a.duration,
        width: a.width,
        height: a.height,
        range: r.range,
      };
      if (a.mediaType === 'image' && r.imageHandling === 'image') {
        consumption = 'image';
        if (a.bytes > 20 * 1024 * 1024) issues.push(`${title}：图像超过 20 MiB，请先裁剪或派生`);
        else if (
          execution &&
          (execution.protocol !== 'chat-completions' || !execution.capabilities.imageInput)
        )
          issues.push(`${title}：模型未开放图像输入，请明确改为仅引用信息或切换模型`);
        else if (!assets.some((v) => v.id === asset.id && v.revision === asset.revision))
          assets.push({ id: asset.id, revision: asset.revision, data: a });
      } else if (a.mediaType !== 'image') consumption = 'metadata-needs-analysis';
    } else if (r.range) throw new HttpError(400, '没有媒体的引用不能设置时间区间');
    return {
      index,
      reference: r,
      title,
      text,
      media,
      consumption,
      ...(readWindow ? { textOffset: readWindow.offset, textLength } : {}),
      ...(consumption === 'metadata-needs-analysis'
        ? { note: '只提供区间和元数据；需要明确抽帧分析或转写才能读取视听内容' }
        : {}),
    };
  });
  const characters = items.reduce((s, i) => s + i.text.length, 0);
  if (characters > 100000) throw new HttpError(400, '引用正文总量超过 100000 字符，请缩小范围');
  return {
    version: 1,
    items,
    assets,
    dependencies,
    issues,
    size: { characters, images: assets.length },
    digest: generationDigest({ items, dependencies }),
  };
}

export function queryContextSources(store: Store, projectId: string, raw: unknown) {
  const q = z
    .object({
      scope: z.enum(['canvases', 'nodes', 'outputs', 'assets', 'documents']).default('nodes'),
      canvasId: z.string().optional(),
      nodeId: z.string().optional(),
      revision: z.coerce.number().int().positive().optional(),
      search: z.string().max(200).default(''),
      offset: z.coerce.number().int().nonnegative().default(0),
      limit: z.coerce.number().int().min(1).max(50).default(24),
    })
    .parse(raw);
  const pattern = '%' + q.search + '%';
  if (q.scope === 'nodes' || q.scope === 'outputs') {
    const c = store.get(q.canvasId || '', q.revision);
    if (c.projectId !== projectId || c.kind !== 'canvas') throw new HttpError(400, '画布归属不符');
    if (q.scope === 'outputs') {
      const node = c.data.nodes.find((n: any) => n.id === q.nodeId);
      if (!node) throw new HttpError(404, '节点不存在');
      const outputs = node.outputs || [];
      return {
        total: outputs.length,
        offset: q.offset,
        items: outputs.slice(q.offset, q.offset + q.limit).map((o: any) => ({
          key: o.key,
          title: o.label || o.key,
          asset: o.asset,
          type: o.slot,
          reference: {
            kind: 'output',
            canvas: { id: c.id, revision: c.revision },
            nodeId: node.id,
            outputKey: o.key,
            imageHandling: 'image',
          },
        })),
      };
    }
    const nodes = c.data.nodes.filter(
      (n: any) => !q.search || n.title.toLowerCase().includes(q.search.toLowerCase()),
    );
    return {
      total: nodes.length,
      offset: q.offset,
      items: nodes.slice(q.offset, q.offset + q.limit).map((n: any) => ({
        title: n.title,
        type: n.type,
        reference: {
          kind: 'node',
          canvas: { id: c.id, revision: c.revision },
          nodeId: n.id,
          imageHandling: 'image',
        },
        asset: n.asset,
        outputCount: n.outputs?.length || 0,
        outputs: (n.outputs || []).slice(0, 8).map((o: any) => ({
          key: o.key,
          title: o.label || o.key,
          asset: o.asset,
          type: o.slot,
          reference: {
            kind: 'output',
            canvas: { id: c.id, revision: c.revision },
            nodeId: n.id,
            outputKey: o.key,
            imageHandling: 'image',
          },
        })),
      })),
    };
  }
  const kinds =
    q.scope === 'canvases' ? ['canvas'] : q.scope === 'assets' ? ['asset'] : documentKinds;
  const where = `project_id=? AND kind IN (${kinds.map(() => '?').join(',')}) AND COALESCE(json_extract(data,'$.title'),json_extract(data,'$.name'),kind) LIKE ?`;
  const params = [projectId, ...kinds, pattern];
  const total = Number(
    store.db.prepare(`SELECT count(*) AS n FROM documents WHERE ${where}`).get(...params)?.n,
  );
  const rows = store.db
    .prepare(
      `SELECT id,revision,kind,json_extract(data,'$.title') AS title,json_extract(data,'$.name') AS name,json_extract(data,'$.mediaType') AS mediaType FROM documents WHERE ${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
    )
    .all(...params, q.limit, q.offset);
  return {
    total,
    offset: q.offset,
    items: rows.map((d: any) => ({
      id: d.id,
      revision: d.revision,
      title: d.title || d.name || d.kind,
      type: d.mediaType || d.kind,
      reference:
        q.scope === 'canvases'
          ? null
          : {
              kind: d.kind === 'asset' ? 'asset' : 'document',
              object: { id: d.id, revision: d.revision },
              imageHandling: 'image',
            },
      ...(d.kind === 'asset' ? { asset: { id: d.id, revision: d.revision } } : {}),
    })),
  };
}
