import { z } from 'zod';
import { Store, HttpError } from './db.js';
import { versionRef } from '../shared/domain.js';
import { stateFactSchema } from '../shared/shot-semantics.js';

// Authorial decisions are independent of delivery. This API deliberately cannot
// write media observations; those retain their evidence-aware review endpoints.
export function saveStoryBasis(store: Store, projectId: string, raw: unknown, revision?: number) {
  const data = z
    .object({
      schemaVersion: z.literal(4),
      basis: z.literal('authored_story'),
      episode: versionRef,
      facts: z.array(
        z.object({
          id: z.string().min(1),
          text: z.string().min(1),
          kind: z.enum([
            'world',
            'character_knowledge',
            'character_misbelief',
            'audience_knowledge',
          ]),
          instanceIds: z.array(z.string()).default([]),
          source: versionRef.optional(),
        }),
      ),
      attributes: z.array(stateFactSchema).default([]),
      previous: versionRef.nullable().default(null),
      note: z.string().default(''),
    })
    .strict()
    .parse(raw);
  const ep = store.get(data.episode.id, data.episode.revision);
  if (ep.kind !== 'episode' || ep.projectId !== projectId)
    throw new HttpError(400, '剧情依据归属错误');
  if (store.get(ep.id).revision !== ep.revision) throw new HttpError(409, '分集已变化');
  if (new Set(data.facts.map((f) => f.id)).size !== data.facts.length)
    throw new HttpError(400, '事实 ID 重复');
  for (const r of [
    ...data.facts.flatMap((f) => (f.source ? [f.source] : [])),
    ...(data.previous ? [data.previous] : []),
  ]) {
    const source = store.get(r.id, r.revision);
    if (source.projectId !== projectId) throw new HttpError(400, '剧情来源跨作品');
  }
  const old = store
    .list('continuity', projectId, ep.id)
    .find((d) => d.data.basis === 'authored_story');
  const body = {
    ...data,
    seriesId: ep.data.seriesId,
    episodeNumber: ep.data.number,
    confirmed: true,
    stale: false,
    dependencies: [
      data.episode,
      ...data.facts.flatMap((f) => (f.source ? [f.source] : [])),
      ...(data.previous ? [data.previous] : []),
    ],
  };
  return old
    ? store.update(old.id, revision ?? -1, body)
    : store.create('continuity', projectId, body, ep.id);
}
