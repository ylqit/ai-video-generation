import { z } from 'zod';
import { HttpError, type Store } from './db.js';
import { creationRefSchema } from '../shared/creation.js';
import { sourceIndexSchema, type AdaptationIntent } from '../shared/adaptation.js';
import { fixedSeriesRecord } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import { DomainService } from './domain-service.js';

// A textual index has verifiable source spans. Event summaries remain authored
// claims and are not observations, even when their facts are marked locked.
export class SourceAdaptation {
  constructor(public store: Store) {}
  preview(projectId: string, raw: unknown) {
    const refs = z.array(creationRefSchema).min(1).parse(raw);
    const entries = refs.flatMap((ref) => {
      const doc = fixedSeriesRecord(this.store, projectId, ref);
      if (doc.kind !== 'chapter' || typeof doc.data.text !== 'string')
        throw new HttpError(400, '来源索引需要固定的文本章节');
      const text = doc.data.text;
      const headings = [
        ...text.matchAll(/^(?:#{1,6}\s+.+|第[一二三四五六七八九十百千\d]+[章节回].*)$/gm),
      ];
      const starts = [...new Set([0, ...headings.map((m) => m.index!)])];
      return starts.map((start, n) => ({
        id: `source-${doc.id}-${start}`,
        title: headings.find((h) => h.index === start)?.[0] || doc.data.title,
        source: ref,
        start,
        end: starts[n + 1] ?? text.length,
        events: [],
      }));
    });
    const data = sourceIndexSchema.parse({ version: 1, entries });
    return {
      data,
      digest: generationDigest(data),
      note: '只按标题定位文本区间；事件须编辑审核，不做模型解析。范围为 UTF-16 左闭右开字符偏移。',
    };
  }
  save(projectId: string, raw: unknown) {
    const body = z
      .object({ data: sourceIndexSchema, idempotencyKey: z.string().min(8) })
      .strict()
      .parse(raw);
    return this.store.transaction(() => {
      const digest = generationDigest(body.data);
      const prior = this.store
        .list('source_index', projectId)
        .find((d) => d.data.key === body.idempotencyKey);
      if (prior) {
        if (prior.data.digest !== digest) throw new HttpError(409, '来源索引回执用于不同内容');
        return prior;
      }
      const ids = new Set<string>(),
        dependencies = new Map();
      for (const entry of body.data.entries) {
        const doc = fixedSeriesRecord(this.store, projectId, entry.source, 'chapter');
        if (entry.end <= entry.start || entry.end > doc.data.text.length)
          throw new HttpError(400, '来源文本区间越界');
        if (ids.has(entry.id)) throw new HttpError(400, '章节索引 ID 重复');
        ids.add(entry.id);
        for (const event of entry.events) {
          if (ids.has(event.id)) throw new HttpError(400, '来源事件 ID 重复');
          ids.add(event.id);
        }
        dependencies.set(`${doc.id}:${doc.revision}`, entry.source);
      }
      const index = this.store.create(
        'source_index',
        projectId,
        { ...body.data, key: body.idempotencyKey, digest },
        projectId,
      );
      new DomainService(this.store).dependencies(index, [...dependencies.values()]);
      return index;
    });
  }
}

export function validateAdaptationIntent(
  store: Store,
  projectId: string,
  intent: AdaptationIntent,
  sources: { id: string; revision: number }[],
) {
  const ids = new Set<string>();
  for (const decision of intent.decisions) {
    if (ids.has(decision.id)) throw new HttpError(400, '改编决策 ID 重复');
    ids.add(decision.id);
    if (
      !sources.some((r) => r.id === decision.source.id && r.revision === decision.source.revision)
    )
      throw new HttpError(400, '改编决策必须引用本次固定的来源索引');
    const index = fixedSeriesRecord(store, projectId, decision.source, 'source_index');
    const event = index.data.entries
      .flatMap((e: any) => e.events)
      .find((e: any) => e.id === decision.eventId);
    if (!event || event.statement !== decision.before)
      throw new HttpError(400, '改编决策的原事件与固定来源不符');
  }
}

export function indexedSource(store: Store, doc: any) {
  if (doc.kind !== 'source_index') return doc;
  return {
    ...doc,
    data: {
      ...doc.data,
      entries: doc.data.entries.map((entry: any) => {
        const source = fixedSeriesRecord(store, doc.projectId, entry.source, 'chapter');
        return { ...entry, text: source.data.text.slice(entry.start, entry.end) };
      }),
    },
  };
}
