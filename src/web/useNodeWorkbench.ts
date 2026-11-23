import { computed, ref, watch } from 'vue';
import { useCanvasDocument } from './useCanvasDocument';
import { nodeDefinitions, nodeMediaType } from '../shared/node-catalog';
import type { RecordDoc } from '../shared/contracts';
import { api } from './api';

export interface WorkbenchProps {
  project: RecordDoc;
  version: number;
  initialAction?: { action: string; value: any } | null;
  openCanvas?: { id: string; nodeId?: string; key: number };
}
// Coordinates saved canvas state, scoped editors and production commands; views share these operations.
export function useNodeWorkbench(props: WorkbenchProps) {
  const {
    current,
    draft,
    snapshot,
    dirty,
    conflict,
    comparison,
    compare,
    resolveComparison,
    load,
    changed,
    save,
    add,
    remove,
    duplicate,
    copySelection,
    paste,
    history,
    arrange,
    group,
  } = useCanvasDocument();
  const canvases = ref<RecordDoc[]>([]),
    selected = ref(''),
    selection = ref<string[]>([]),
    view = ref('canvas'),
    drawer = ref(''),
    shelf = ref(false),
    search = ref(''),
    showAgent = ref(false),
    busy = ref(false),
    error = ref(''),
    notice = ref(''),
    focusKey = ref(0),
    newCanvas = ref(false),
    name = ref('新画布'),
    episodeId = ref(''),
    episodes = ref<any[]>([]),
    records = ref<any[]>([]);
  const connection = ref<any>(null),
    purpose = ref('identity'),
    relation = ref('input'),
    preview = ref<any>(null),
    requestKey = ref(''),
    operation = ref(''),
    imageAction = ref(''),
    replacement = ref(false),
    candidate = ref<any>(null),
    result = ref<any>(null),
    inspectedJob = ref(''),
    conversion = ref<any>(null),
    pendingClip = ref(''),
    rewriteRange = ref<any>(null);
  watch(selected, () => {
    preview.value = null;
  });
  watch(drawer, (value, previous) => {
    if (previous === 'models' && value !== 'models') modelKey.value++;
  });
  const modelKey = ref(0);
  const node = computed(() => draft.value?.nodes.find((n) => n.id === selected.value));
  const assets = computed(() => snapshot.value.assets || []);
  const selectedAsset = computed(() =>
    assets.value.find(
      (a: any) => a.id === node.value?.asset?.id && a.revision === node.value?.asset?.revision,
    ),
  );
  const searchResults = computed(
    () =>
      draft.value?.nodes
        .filter((n) => search.value && n.title.toLowerCase().includes(search.value.toLowerCase()))
        .slice(0, 30) || [],
  );
  async function action(fn: () => Promise<void>) {
    if (busy.value) return;
    busy.value = true;
    error.value = '';
    try {
      await fn();
    } catch (e: any) {
      error.value = e.message;
    } finally {
      busy.value = false;
    }
  }
  async function refresh() {
    if (current.value) await load(current.value.id);
  }
  async function initialize() {
    canvases.value = await api(`/projects/${props.project.id}/canvases`);
    episodes.value = (await api(`/projects/${props.project.id}/objects?kind=episode`)).items;
    if (!canvases.value.length) {
      const c = await api(`/projects/${props.project.id}/canvases`, 'POST', {
        version: 2,
        title: '自由创作',
        episodeId: null,
        nodes: [],
        edges: [],
      });
      canvases.value = [c];
    }
    await load(props.openCanvas?.id || canvases.value[0].id, true);
    selected.value = props.openCanvas?.nodeId || '';
    if (props.initialAction?.action === 'bind') {
      const asset = props.initialAction.value;
      if (asset.projectId === props.project.id) {
        const existing = draft.value!.nodes.find(
          (n) => n.asset?.id === asset.id && n.asset?.revision === asset.revision,
        );
        if (existing) locate(existing.id);
        else {
          addNode(asset.data.mediaType, asset);
          await save();
        }
      }
    }
  }
  watch(
    () => props.project.id,
    () => {
      dirty.value = false;
      void action(initialize);
    },
    { immediate: true },
  );
  watch(
    () => props.version,
    () => void refresh().catch((e: any) => (error.value = e.message)),
  );
  watch(
    () => props.openCanvas?.key,
    () =>
      void action(async () => {
        await save();
        await load(props.openCanvas!.id, true);
        locate(props.openCanvas!.nodeId || '');
      }),
  );
  function locate(id: string) {
    selected.value = id;
    selection.value = id ? [id] : [];
    view.value = 'canvas';
    focusKey.value++;
  }
  function addNode(type: string, asset?: RecordDoc) {
    selected.value = add(type, asset);
    selection.value = [selected.value];
    view.value = 'canvas';
    focusKey.value++;
  }
  async function switchCanvas(id: string) {
    await action(async () => {
      await save();
      await load(id, true);
      selected.value = '';
      selection.value = [];
    });
  }
  async function createCanvas() {
    await action(async () => {
      await save();
      const c = await api(`/projects/${props.project.id}/canvases`, 'POST', {
        version: 2,
        title: name.value,
        episodeId: episodeId.value || null,
        nodes: [],
        edges: [],
      });
      canvases.value.push(c);
      newCanvas.value = false;
      await load(c.id);
    });
  }
  function move(event: any) {
    for (const moved of event.nodes || [event.node]) {
      const n = draft.value?.nodes.find((n) => n.id === moved.id);
      if (n) {
        n.x = moved.position.x;
        n.y = moved.position.y;
      }
    }
    changed();
  }
  function link() {
    if (!draft.value || !connection.value) return;
    draft.value.edges.push({
      id: crypto.randomUUID(),
      source: connection.value.source,
      target: connection.value.target,
      sourceHandle: connection.value.sourceHandle || undefined,
      targetHandle: connection.value.targetHandle || undefined,
      relation: relation.value as any,
      ...(relation.value === 'input'
        ? { asset: draft.value.nodes.find((n) => n.id === connection.value.source)?.asset }
        : {}),
      ...(relation.value === 'input' && !['text', 'context'].includes(connection.value.targetHandle)
        ? { purpose: purpose.value as any }
        : {}),
      instruction: '',
      order: draft.value.edges.filter((e) => e.target === connection.value.target).length,
    });
    connection.value = null;
    changed();
  }
  async function prepare() {
    await action(async () => {
      await save(inputNodes(selected.value));
      preview.value = await api(
        `/canvases/${current.value!.id}/nodes/${selected.value}/preview`,
        'POST',
        {},
      );
      requestKey.value = crypto.randomUUID();
    });
  }
  async function generate() {
    await action(async () => {
      await save(inputNodes(selected.value));
      await api(`/canvases/${current.value!.id}/nodes/${selected.value}/generate`, 'POST', {
        revision: current.value!.revision,
        digest: preview.value.digest,
        idempotencyKey: requestKey.value,
      });
      preview.value = null;
      notice.value = '任务已提交，结果将自动回到此节点';
      await refresh();
    });
  }
  function inputNodes(id: string) {
    const ids = new Set([id]);
    for (let count = -1; count !== ids.size;) {
      count = ids.size;
      for (const e of draft.value?.edges || [])
        if (e.relation === 'input' && ids.has(e.target)) ids.add(e.source);
    }
    return [...ids];
  }
  async function operate(id: string, a: string) {
    rewriteRange.value = null;
    await action(async () => {
      selected.value = id;
      selection.value = [id];
      await save(inputNodes(id));
      if (['bind'].includes(a)) {
        drawer.value = 'objects';
        return;
      }
      if (['timeline', 'export'].includes(a)) {
        pendingClip.value = a === 'timeline' ? id : '';
        view.value = 'edit';
        return;
      }
      if (['video_draft', 'director_draft'].includes(a)) {
        const origin = node.value!,
          next = add(a === 'video_draft' ? 'video_generate' : 'director'),
          n = draft.value!.nodes.find((n) => n.id === next)!;
        n.x = origin.x + 360;
        n.y = origin.y;
        draft.value!.edges.push({
          id: crypto.randomUUID(),
          source: origin.id,
          target: next,
          sourceHandle: 'context',
          targetHandle: 'context',
          relation: 'input',
          instruction: '',
          order: 0,
        });
        selected.value = next;
        changed();
        return;
      }
      if (['inpaint', 'relight', 'angle', 'panorama'].includes(a)) {
        if (!node.value?.asset) throw new Error('请先选择原图');
        imageAction.value = a;
        return;
      }
      if (a === 'generate') {
        preview.value = await api(`/canvases/${current.value!.id}/nodes/${id}/preview`, 'POST', {});
        requestKey.value = crypto.randomUUID();
        return;
      }
      if (a.startsWith('previs_')) {
        if (!node.value?.binding) {
          view.value = 'director';
          return;
        }
      }
      if (['materialize', 'subtitles'].includes(a)) {
        const o = node.value?.outputs?.findLast((o) => o.document);
        if (!o?.document && !node.value?.binding) throw new Error('请先完成拉片或转写');
        const ref = o?.document || node.value!.binding!;
        result.value = await api(`/records/${ref.id}/versions/${ref.revision}`);
        return;
      }
      operation.value = a;
    });
  }
  async function uploaded(items: RecordDoc[]) {
    await action(async () => {
      for (const a of items) addNode(a.data.mediaType, a);
      replacement.value = false;
      drawer.value = '';
      await save();
      await refresh();
    });
  }
  function bind(ref: any) {
    if (!node.value) addNode(ref.shotId ? 'shot' : 'entity');
    if (node.value) {
      node.value.binding = ref;
      changed();
      drawer.value = '';
      void action(async () => {
        await save();
        await refresh();
      });
    }
  }
  async function chooseAsset(a: RecordDoc) {
    if (replacement.value && node.value) {
      if (nodeMediaType(node.value.type) !== a.data.mediaType)
        throw new Error('替换素材类型不匹配');
      node.value.asset = { id: a.id, revision: a.revision };
      changed();
    } else addNode(a.data.mediaType, a);
    replacement.value = false;
    drawer.value = '';
    await action(async () => {
      await save();
      await refresh();
    });
  }
  async function openCandidate(o: any) {
    await action(async () => {
      if (o.document) {
        result.value = await api(`/records/${o.document.id}/versions/${o.document.revision}`);
      } else
        candidate.value = {
          output: o,
          asset: await api(`/records/${o.asset.id}/versions/${o.asset.revision}`),
        };
    });
  }
  async function pinCandidate(replace = false) {
    const a = candidate.value.asset;
    if (replace && node.value) {
      node.value.asset = { id: a.id, revision: a.revision };
      changed();
    } else {
      const source = node.value?.id;
      addNode(a.data.mediaType, a);
      if (source)
        draft.value!.edges.push({
          id: crypto.randomUUID(),
          source,
          target: selected.value,
          relation: 'result',
          instruction: '固定候选来源',
        });
      changed();
    }
    candidate.value = null;
    await action(async () => {
      await save();
      await refresh();
    });
  }
  function editDraft(plan: any) {
    const origin = node.value!,
      id = add('image_generate'),
      next = draft.value!.nodes.find((n) => n.id === id)!;
    next.title = origin.title + ' · 编辑';
    next.text = plan.instruction;
    next.settings = { imageEdit: plan };
    next.x = origin.x + 360;
    next.y = origin.y;
    draft.value!.edges.push({
      id: crypto.randomUUID(),
      source: origin.id,
      target: id,
      sourceHandle: 'image',
      targetHandle: 'references',
      relation: 'input',
      purpose: 'composition',
      instruction: '保留原图身份与构图；变化以编辑计划为准',
      order: 0,
    });
    selected.value = id;
    imageAction.value = '';
    changed();
  }
  async function openSeries() {
    drawer.value = 'series';
    const all = await Promise.all(
      ['series', 'creation_profile', 'voice_profile', 'episode'].map(
        async (kind) => (await api(`/projects/${props.project.id}/objects?kind=${kind}`)).items,
      ),
    );
    records.value = await Promise.all(
      all.flat().map((r: any) => api(`/records/${r.id}/versions/${r.revision}`)),
    );
  }
  async function migrate(apply = false) {
    await action(async () => {
      const r = await api(`/canvases/${current.value!.id}/conversion`, 'POST', {
        revision: current.value!.revision,
        apply,
      });
      if (apply) {
        dirty.value = false;
        conversion.value = null;
        await refresh();
      } else conversion.value = r;
    });
  }

  return {
    current,
    draft,
    snapshot,
    dirty,
    conflict,
    comparison,
    compare,
    resolveComparison,
    changed,
    save,
    remove,
    duplicate,
    copySelection,
    paste,
    history,
    arrange,
    group,
    canvases,
    selected,
    selection,
    view,
    drawer,
    shelf,
    search,
    showAgent,
    busy,
    error,
    notice,
    focusKey,
    newCanvas,
    name,
    episodeId,
    episodes,
    records,
    connection,
    purpose,
    relation,
    preview,
    operation,
    imageAction,
    replacement,
    candidate,
    result,
    inspectedJob,
    conversion,
    pendingClip,
    rewriteRange,
    modelKey,
    node,
    assets,
    selectedAsset,
    searchResults,
    action,
    refresh,
    locate,
    addNode,
    switchCanvas,
    createCanvas,
    move,
    link,
    prepare,
    generate,
    operate,
    uploaded,
    bind,
    chooseAsset,
    openCandidate,
    pinCandidate,
    editDraft,
    openSeries,
    migrate,
  };
}
