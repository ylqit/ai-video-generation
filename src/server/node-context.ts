import { Store, HttpError } from './db.js';
import type { CanvasContent, CanvasNode } from '../shared/canvas.js';
import { projectShotBrief, resolveCreativeBrief } from './creative-brief.js';
import { prepareShot } from '../shared/directing.js';
import { renderShotDescriptions } from './shot-description.js';
import { stagedShotConsumption } from './video-contract.js';

export function resolveNodeContext(store: Store, projectId: string, node: CanvasNode) {
  if (!node.binding) return null;
  const doc = store.get(node.binding.id, node.binding.revision);
  if (doc.projectId !== projectId) throw new HttpError(400, '业务对象不属于当前作品');
  let value: any = doc.data;
  if (node.binding.shotId) {
    value = (doc.data.shots || doc.data.result?.shots || []).find(
      (s: any) => s.id === node.binding!.shotId || s.key === node.binding!.shotId,
    );
    if (!value) throw new HttpError(404, '固定镜头不存在');
  }
  if (node.binding.path) {
    const parts = node.binding.path.split('.');
    if (parts.some((p) => ['__proto__', 'constructor', 'prototype'].includes(p)))
      throw new HttpError(400, '无效对象路径');
    for (const p of parts) value = value?.[p];
    if (value === undefined) throw new HttpError(404, '对象路径不存在');
  }
  return { source: { id: doc.id, revision: doc.revision }, kind: doc.kind, value };
}

// Shared professional renderer + fixed domain sources. No document-sized story is dumped into a shot.
export function projectNodeInputs(
  store: Store,
  projectId: string,
  data: CanvasContent,
  node: CanvasNode,
) {
  const edges = data.edges
    .filter((e) => e.target === node.id && e.relation === 'input')
    .map((e, i) => ({ e, i }))
    .sort((a, b) => (a.e.order ?? a.i) - (b.e.order ?? b.i));
  const nodes = [
    node,
    ...edges.map(({ e }) => data.nodes.find((n) => n.id === e.source)!).filter(Boolean),
  ];
  const contexts = nodes
    .map((n) => resolveNodeContext(store, projectId, n))
    .filter(Boolean) as NonNullable<ReturnType<typeof resolveNodeContext>>[];
  const shotContext = contexts.find((c) => c.value?.directing),
    shot = shotContext?.value;
  const dependencies: any[] = [],
    consumption: any[] = [],
    texts: string[] = [],
    records: any[] = [];
  const load = (ref: { id: string; revision: number }) => {
    const record = store.get(ref.id, ref.revision);
    if (record.projectId !== projectId) throw new HttpError(400, '镜头引用跨作品资料');
    if (!records.some((r) => r.id === ref.id && r.revision === ref.revision)) {
      records.push(record);
      dependencies.push({ id: ref.id, revision: ref.revision });
    }
    return record;
  };
  for (const c of contexts) load(c.source);
  const visible: string[] =
    shot?.directing?.presence?.visible ||
    (shot?.state?.instances || []).map((i: any) => i.instanceId);
  const relevant = (shot?.state?.instances || []).filter((i: any) =>
    visible.includes(i.instanceId),
  );
  for (const i of relevant) {
    if (i.entity) load(i.entity);
    if (i.appearance) load(i.appearance);
  }
  if (shot?.state?.layout) load(shot.state.layout);
  const episode = shotContext?.kind === 'episode' ? load(shotContext.source) : null;
  if (episode?.data.creationProfile && !contexts.some((c) => c.kind === 'creation_profile'))
    load(episode.data.creationProfile);
  let brief: any = { overrides: {}, modules: [], artBible: {}, artEntries: [], scope: {} },
    projection: any = { entries: [], decisions: [] };
  const profile = records.find((r) => r.kind === 'creation_profile');
  if (profile) {
    brief = resolveCreativeBrief(
      store,
      projectId,
      profile,
      episode ? { episodeId: episode.id, sceneId: shot.scene } : {},
      false,
      episode?.revision,
    );
    for (const m of brief.modules) dependencies.push(m.ref);
    if (shot?.directing?.presence) projection = projectShotBrief(brief, shot);
    else
      consumption.push({
        field: profile.id,
        status: 'planning_check',
        reason: '尚未选择镜头，局部美术条目不进入模型正文',
      });
    consumption.push(...projection.decisions);
  }
  for (const r of records) {
    if (r.kind === 'entity') {
      if (shot && !relevant.some((i: any) => i.entity?.id === r.id)) {
        consumption.push({ field: r.id, status: 'excluded', reason: '此主体未在当前镜头出场' });
        continue;
      }
      const ids = relevant.filter((i: any) => i.entity?.id === r.id).map((i: any) => i.instanceId);
      texts.push(
        `Stable identity ${ids.join(', ') || r.data.name}: ${(r.data.fixedFeatures || []).join('; ')}. ${r.data.description || ''}`,
      );
    } else if (r.kind === 'appearance') {
      if (shot && !relevant.some((i: any) => i.appearance?.id === r.id)) continue;
      if (!shot)
        texts.push(
          `Appearance: ${r.data.description || ''}; ${Object.values(r.data.features || {}).join('; ')}`,
        );
    } else if (
      !['episode', 'creation_profile', 'scene_layout', 'layout', 'reference_pack'].includes(r.kind)
    ) {
      const context = contexts.find((c) => c.source.id === r.id);
      if (context && context !== shotContext)
        texts.push(
          typeof context.value === 'string' ? context.value : JSON.stringify(context.value),
        );
    }
  }
  let spec: ReturnType<typeof prepareShot> | null = null;
  if (shot) {
    spec = prepareShot(shot, records);
    if (!spec.directing) throw new HttpError(400, '固定镜头导演契约无效，请在镜头编辑器修复字段');
    const staged = spec.directing.version !== 1 && spec.directing.contractRevision === 2;
    const input = {
      planning: { records },
      information: episode?.data.dramaturgy?.information || [],
      segment: { shotIds: [shot.id] },
    };
    const rendered = renderShotDescriptions(
      input,
      {
        ref: false,
        universal: spec.directing.version >= 2,
        seriesMode: spec.directing.version === 3,
        freeCreation: true,
        brief,
        specs: [spec],
        staged,
        projection: [projection],
        activeBindings: [],
      },
      { subjects: [] },
      (s) => s,
    );
    texts.push(rendered.visual, ...projection.entries.map((e: any) => e.text), ...rendered.lines);
    consumption.push(
      ...(staged
        ? stagedShotConsumption([spec])
        : [{ field: 'directing', status: 'text_request', reason: '专业镜头共用确定性渲染' }]),
      ...spec.issues.map((i) => ({ ...i, severity: 'suggestion', status: 'planning_check' })),
    );
  }
  for (const n of nodes) {
    if (n.document) {
      const doc = load(n.document);
      texts.push(doc.data.content || doc.data.text || '');
      consumption.push({ field: n.id, status: 'text_request', reason: '固定文档正文' });
    } else if (n.text) texts.push(n.text);
  }
  return { text: texts.filter(Boolean).join('\n\n'), dependencies, consumption, shot: spec };
}
