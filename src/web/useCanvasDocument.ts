import { ref, computed } from 'vue';
import { canvasSchema, type CanvasContent, type CanvasNode } from '../shared/canvas';
import type { RecordDoc } from '../shared/contracts';
import { nodeDefinitions } from '../shared/node-catalog';
import { api } from './api';
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// Owns draft recovery, structural patches, history and concurrent receipt reconciliation.
export function useCanvasDocument() {
  const current = ref<RecordDoc | null>(null),
    draft = ref<CanvasContent | null>(null),
    snapshot = ref<any>({ assets: [], jobs: [] }),
    dirty = ref(false),
    conflict = ref(''),
    comparison = ref<any>(null);
  const undoStack = ref<CanvasContent[]>([]),
    redoStack = ref<CanvasContent[]>([]);
  let checkpoint: CanvasContent | null = null,
    pending: { key: string; body: any } | null = null,
    loadSequence = 0;
  let saving: Promise<void> | null = null;
  const key = () => `studio:canvas:${current.value?.id}`;
  function operations(base: CanvasContent, next: CanvasContent) {
    const changes: any[] = [];
    for (const [target, field] of [
      ['node', 'nodes'],
      ['edge', 'edges'],
    ] as const) {
      const before = new Map(base[field].map((v) => [v.id, v])),
        after = new Map(next[field].map((v) => [v.id, v]));
      for (const [id, value] of after) {
        const old = before.get(id);
        if (!old) {
          changes.push({ target, id, action: 'add', values: value });
          continue;
        }
        const values: Record<string, unknown> = {};
        for (const name of new Set([...Object.keys(old), ...Object.keys(value)])) {
          if (['id', 'outputs'].includes(name)) continue;
          if (JSON.stringify((old as any)[name]) !== JSON.stringify((value as any)[name]))
            values[name] = (value as any)[name] ?? null;
        }
        if (Object.keys(values).length) changes.push({ target, id, action: 'update', values });
      }
      for (const id of before.keys())
        if (!after.has(id)) changes.push({ target, id, action: 'remove' });
    }
    const values: Record<string, unknown> = {};
    for (const field of ['title', 'viewport', 'episodeId'] as const)
      if (JSON.stringify(base[field]) !== JSON.stringify(next[field])) values[field] = next[field];
    if (Object.keys(values).length) changes.push({ target: 'canvas', action: 'update', values });
    return changes;
  }
  function applyChanges(data: CanvasContent, changes: any[]) {
    for (const change of changes) {
      if (change.target === 'canvas') {
        Object.assign(data, change.values);
        continue;
      }
      const items = change.target === 'node' ? data.nodes : data.edges,
        index = items.findIndex((v) => v.id === change.id);
      if (change.action === 'remove') {
        if (index >= 0) items.splice(index, 1);
        if (change.target === 'node')
          data.edges = data.edges.filter((e) => e.source !== change.id && e.target !== change.id);
      } else if (change.action === 'add') {
        if (index >= 0) throw new Error('节点 ID 已存在，请复制为新节点后保存');
        items.push(change.values);
      } else {
        if (index < 0) throw new Error('对象已被移除，请复制本机内容到新节点；本机草稿保留');
        for (const [field, value] of Object.entries(change.values)) {
          if (value === null) delete (items[index] as any)[field];
          else (items[index] as any)[field] = value;
        }
      }
    }
    return data;
  }
  async function compare() {
    if (!current.value || !draft.value) return;
    const latest = await api('/canvases/' + current.value.id),
      changes = operations(canvasSchema.parse(current.value.data), draft.value!);
    comparison.value = {
      latest,
      changes,
      rows: changes.map((c) => {
        const server =
          c.target === 'canvas'
            ? latest.canvas.data
            : latest.canvas.data[c.target === 'node' ? 'nodes' : 'edges'].find(
                (v: any) => v.id === c.id,
              );
        return {
          target: c.target,
          id: c.id,
          action: c.action,
          local: c.values ?? '移除',
          server:
            c.action === 'update'
              ? Object.fromEntries(Object.keys(c.values).map((k) => [k, server?.[k] ?? null]))
              : (server ?? null),
        };
      }),
    };
  }
  function resolveComparison(keepLocal: boolean) {
    if (!comparison.value || !current.value || !draft.value) return;
    const { latest, changes } = comparison.value,
      data = keepLocal
        ? applyChanges(canvasSchema.parse(latest.canvas.data), changes)
        : canvasSchema.parse(latest.canvas.data);
    localStorage.setItem(
      key() + ':before-merge',
      JSON.stringify({ baseDocument: current.value, data: draft.value }),
    );
    current.value = latest.canvas;
    snapshot.value = latest;
    draft.value = data;
    pending = null;
    conflict.value = '';
    comparison.value = null;
    undoStack.value = [];
    redoStack.value = [];
    changed(false);
  }
  async function load(id: string, restore = false) {
    const sequence = ++loadSequence,
      data = await api('/canvases/' + id);
    if (sequence !== loadSequence) return;
    snapshot.value = data;
    if (dirty.value && current.value?.id === id) {
      // Server-owned results merge without treating archival as a user edit.
      for (const n of draft.value!.nodes) {
        const incoming = data.canvas.data.nodes.find((v: any) => v.id === n.id);
        if (incoming) n.outputs = incoming.outputs;
      }
      return;
    }
    current.value = data.canvas;
    draft.value = canvasSchema.parse(data.canvas.data);
    conflict.value = '';
    if (restore) {
      const saved = localStorage.getItem(key());
      if (saved) {
        try {
          const local = JSON.parse(saved);
          if (local.baseDocument) {
            current.value = local.baseDocument;
          }
          draft.value = canvasSchema.parse(local.data);
          dirty.value = true;
        } catch {
          conflict.value = '本机草稿无法读取，服务器资料保留';
        }
      }
    }
    checkpoint = copy(draft.value!);
    undoStack.value = [];
    redoStack.value = [];
  }
  function changed(history = true) {
    if (!draft.value || !current.value) return;
    if (history && checkpoint) {
      undoStack.value.push(checkpoint);
      if (undoStack.value.length > 100) undoStack.value.shift();
      redoStack.value = [];
    }
    checkpoint = copy(draft.value);
    dirty.value = true;
    pending = null;
    localStorage.setItem(
      key(),
      JSON.stringify({
        base: current.value.revision,
        baseDocument: current.value,
        data: draft.value,
      }),
    );
  }
  async function persist(nodeIds?: string[]) {
    if (!dirty.value || !draft.value || !current.value) return;
    if (current.value.data.version === 1) throw new Error('请先预览并转换旧画布；原任务与媒体不变');
    const requested = operations(canvasSchema.parse(current.value.data), draft.value).filter(
      (c) =>
        !nodeIds ||
        (c.target === 'node' && nodeIds.includes(c.id)) ||
        (c.target === 'edge' &&
          (nodeIds.includes(c.values?.source) ||
            nodeIds.includes(c.values?.target) ||
            [...draft.value!.edges, ...current.value!.data.edges].some(
              (e) => e.id === c.id && nodeIds.includes(e.target),
            ))),
    );
    if (!pending || JSON.stringify(pending.body.operations) !== JSON.stringify(requested))
      pending = {
        key: crypto.randomUUID(),
        body: {
          revision: current.value.revision,
          operations: requested,
        },
      };
    if (!pending.body.operations.length) {
      if (nodeIds) return;
      dirty.value = false;
      pending = null;
      localStorage.removeItem(key());
      return;
    }
    const submitted = applyChanges(
        canvasSchema.parse(current.value.data),
        copy(pending.body.operations),
      ),
      canvasId = current.value.id,
      request = pending;
    const saved = await api(`/canvases/${canvasId}`, 'PATCH', {
      ...request.body,
      idempotencyKey: request.key,
    });
    if (current.value?.id !== canvasId) return;
    // Keep edits made while PATCH was in flight; only the submitted state was saved.
    const late = operations(submitted, draft.value!),
      merged = applyChanges(canvasSchema.parse(saved.data), late);
    current.value = saved;
    draft.value = merged;
    dirty.value = late.length > 0;
    conflict.value = '';
    pending = null;
    checkpoint = copy(merged);
    if (dirty.value)
      localStorage.setItem(
        key(),
        JSON.stringify({ base: saved.revision, baseDocument: saved, data: merged }),
      );
    else localStorage.removeItem(key());
  }
  async function save(nodeIds?: string[]) {
    if (saving) await saving;
    saving = persist(nodeIds).finally(() => {
      saving = null;
    });
    return saving;
  }
  function add(type: string, asset?: RecordDoc) {
    if (!draft.value) return '';
    const n = draft.value.nodes.length,
      id = crypto.randomUUID();
    draft.value.nodes.push({
      id,
      type,
      title: asset?.data.name || nodeDefinitions.find((d) => d.type === type)?.label || '新节点',
      text: '',
      x: 80 + (n % 4) * 350,
      y: 80 + Math.floor(n / 4) * 310,
      selected: false,
      ...(asset ? { asset: { id: asset.id, revision: asset.revision } } : {}),
    });
    changed();
    return id;
  }
  function remove(ids: string[]) {
    if (!draft.value) return;
    draft.value.nodes = draft.value.nodes.filter((n) => !ids.includes(n.id));
    draft.value.edges = draft.value.edges.filter(
      (e) => !ids.includes(e.source) && !ids.includes(e.target),
    );
    for (const n of draft.value.nodes) if (n.groupId && ids.includes(n.groupId)) delete n.groupId;
    changed();
  }
  let clipboard: { nodes: CanvasNode[]; edges: CanvasContent['edges'] } | null = null;
  function copySelection(ids: string[]) {
    if (!draft.value) return;
    const selected = new Set(ids);
    clipboard = copy({
      nodes: draft.value.nodes.filter((n) => selected.has(n.id)),
      edges: draft.value.edges.filter(
        (e) => selected.has(e.source) && selected.has(e.target) && e.relation !== 'result',
      ),
    });
  }
  function paste() {
    if (!draft.value || !clipboard) return [];
    const ids = new Map(clipboard.nodes.map((n) => [n.id, crypto.randomUUID()]));
    for (const original of clipboard.nodes) {
      const n = copy(original);
      n.id = ids.get(original.id)!;
      n.x += 60;
      n.y += 60;
      delete n.outputs;
      delete n.document;
      if (n.groupId) n.groupId = ids.get(n.groupId);
      draft.value.nodes.push(n);
    }
    for (const e of clipboard.edges)
      draft.value.edges.push({
        ...copy(e),
        id: crypto.randomUUID(),
        source: ids.get(e.source)!,
        target: ids.get(e.target)!,
      });
    changed();
    return [...ids.values()];
  }
  function duplicate(ids: string[]) {
    copySelection(ids);
    return paste();
  }
  function history(direction: 'undo' | 'redo') {
    const from = direction === 'undo' ? undoStack : redoStack,
      to = direction === 'undo' ? redoStack : undoStack;
    if (!from.value.length || !draft.value) return;
    to.value.push(copy(draft.value));
    const next = from.value.pop()!;
    for (const n of next.nodes) {
      const old = draft.value.nodes.find((x) => x.id === n.id);
      if (old) n.outputs = old.outputs;
    }
    draft.value = next;
    changed(false);
  }
  function arrange(ids: string[] = []) {
    draft.value?.nodes
      .filter((n) => !ids.length || ids.includes(n.id))
      .forEach((n, i) => {
        n.x = 80 + (i % 4) * 350;
        n.y = 80 + Math.floor(i / 4) * 310;
      });
    changed();
  }
  function group(ids: string[]) {
    if (!draft.value || !ids.length) return;
    const id = add('group');
    const group = draft.value.nodes.find((n) => n.id === id)!;
    group.title = '节点分组';
    for (const n of draft.value.nodes) if (ids.includes(n.id) && n.type !== 'group') n.groupId = id;
    changed();
    return id;
  }
  const canUndo = computed(() => undoStack.value.length > 0),
    canRedo = computed(() => redoStack.value.length > 0);
  return {
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
    canUndo,
    canRedo,
  };
}
