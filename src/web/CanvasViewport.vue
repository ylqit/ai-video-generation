<script setup lang="ts">
import { computed, watch } from 'vue';
import { VueFlow, useVueFlow } from '@vue-flow/core';
import '@vue-flow/core/dist/style.css';
import '@vue-flow/core/dist/theme-default.css';
import type { CanvasContent } from '../shared/canvas';
import CanvasNodeCard from './CanvasNodeCard.vue';
const props = defineProps<{
  content: CanvasContent;
  selected: string;
  selectedIds: string[];
  focusKey?: number;
}>();
const emit = defineEmits([
  'select',
  'selection',
  'move',
  'connect',
  'agent',
  'add',
  'arrange',
  'viewport',
  'action',
  'collapse',
  'duplicate',
  'copy',
  'paste',
  'group',
  'undo',
  'redo',
  'remove',
  'reference',
  'upload',
  'range',
  'frame',
]);
const { fitView, zoomIn, zoomOut, setCenter, screenToFlowCoordinate, viewport } =
  useVueFlow('creative');
function keyboard(e: KeyboardEvent) {
  if (
    (e.target as HTMLElement).closest(
      'input,textarea,select,[contenteditable],video,audio,[role="slider"]',
    )
  )
    return;
  const actions: Record<string, string> = {
    c: 'copy',
    d: 'duplicate',
    z: e.shiftKey ? 'redo' : 'undo',
    y: 'redo',
  };
  const action =
    e.key === 'Delete' ? 'remove' : e.ctrlKey || e.metaKey ? actions[e.key.toLowerCase()] : '';
  if (action) {
    e.preventDefault();
    emit(action as any);
  }
}
function toggle(id: string) {
  emit(
    'selection',
    props.selectedIds.includes(id)
      ? props.selectedIds.filter((v) => v !== id)
      : [...props.selectedIds, id],
  );
}
function focus(node: any) {
  emit('select', node.id);
  if (
    ['image_generate', 'video_generate', 'document'].includes(node.data.type) ||
    viewport.value.zoom < 0.6
  )
    setCenter(node.position.x + 180, node.position.y + Math.min(300, (innerHeight - 240) / 2), {
      zoom: 1,
      duration: 200,
    });
}
function drop(e: DragEvent) {
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  emit('upload', {
    files: Array.from(e.dataTransfer.files),
    position: screenToFlowCoordinate({ x: e.clientX, y: e.clientY }),
  });
}
function pasteFiles(e: ClipboardEvent) {
  if ((e.target as HTMLElement).closest('input,textarea,[contenteditable]')) return;
  if (e.clipboardData?.files.length) {
    e.preventDefault();
    emit('upload', { files: Array.from(e.clipboardData.files) });
  } else {
    e.preventDefault();
    emit('paste');
  }
}
const nodeIndex = computed(() => new Map(props.content.nodes.map((n) => [n.id, n])));
const visible = computed(() =>
  props.content.nodes.filter((n) => !n.groupId || !nodeIndex.value.get(n.groupId)?.collapsed),
);
const visibleIds = computed(() => new Set(visible.value.map((n) => n.id)));
const flowNodes = computed(() =>
  visible.value.map((n) => ({
    id: n.id,
    type: 'studio',
    position: { x: n.x, y: n.y },
    data: n,
    selected: props.selectedIds.includes(n.id),
  })),
);
const flowEdges = computed(() =>
  props.content.edges
    .filter((e) => visibleIds.value.has(e.source) && visibleIds.value.has(e.target))
    .map((e) => ({
      ...e,
      label:
        e.relation === 'input'
          ? `${(e.order ?? 0) + 1} · ${e.purpose || '内容'}`
          : e.relation === 'result'
            ? '来源'
            : '关联',
      style: {
        stroke: e.relation === 'input' ? '#7664e7' : '#c2bdcf',
        strokeDasharray: e.relation === 'organize' ? '5 5' : 'none',
      },
    })),
);
watch(
  () => props.focusKey,
  () => {
    const n = props.content.nodes.find((n) => n.id === props.selected);
    if (n) setCenter(n.x + 145, n.y + 120, { zoom: 1, duration: 250 });
  },
);
</script>
<template>
  <main
    class="flow-surface"
    tabindex="0"
    aria-label="制作画布"
    @keydown="keyboard"
    @dragover.prevent
    @drop="drop"
    @paste="pasteFiles"
  >
    <div class="canvas-toolbar">
      <button
        class="primary"
        @click="emit('reference', selectedIds)"
        :disabled="!selectedIds.length"
      >
        加入助手{{ selectedIds.length ? ' · ' + selectedIds.length : '' }}
      </button>
      <button @click="emit('undo')" title="撤销布局与内容">↶</button
      ><button @click="emit('redo')" title="重做">↷</button
      ><button @click="emit('duplicate')" :disabled="!selectedIds.length">复制</button
      ><button @click="emit('group')" :disabled="!selectedIds.length">分组</button
      ><button @click="emit('arrange')">整理{{ selectedIds.length ? '选中' : '' }}</button
      ><button @click="fitView({ padding: 0.15, maxZoom: 1 })">适应</button>
    </div>
    <VueFlow
      id="creative"
      :nodes="flowNodes"
      :edges="flowEdges"
      :default-viewport="content.viewport"
      :min-zoom="0.1"
      :max-zoom="3"
      :delete-key-code="null"
      :only-render-visible-elements="true"
      :selection-on-drag="true"
      :pan-on-drag="[1, 2]"
      @node-click="focus($event.node)"
      @selection-change="
        emit(
          'selection',
          $event.nodes.map((n: any) => n.id),
        )
      "
      @node-drag-stop="emit('move', $event)"
      @connect="emit('connect', $event)"
      @move-end="emit('viewport', $event.flowTransform)"
    >
      <template #node-studio="{ data }"
        ><CanvasNodeCard
          :node="data"
          :checked="selectedIds.includes(data.id)"
          :compact="viewport.zoom < 0.6"
          @check="toggle(data.id)"
          @range="emit('range', data.id, $event)"
          @frame="emit('frame', data.id, $event)"
          @action="emit('action', data.id, $event)"
          @collapse="emit('collapse', data.id)"
          ><template v-if="selected === data.id && viewport.zoom >= 0.6" #tray
            ><slot name="tray" :node="data" /></template></CanvasNodeCard
      ></template>
    </VueFlow>
    <div v-if="!content.nodes.length" class="canvas-welcome">
      <span>◇</span>
      <h2>内容、素材与制作，在这里连接</h2>
      <p>从文档、上传素材或一个生成节点开始。按住中键拖动画布，拖动空白处框选。</p>
      <button class="primary" @click="emit('agent')">与助手讨论</button
      ><button @click="emit('add', 'document')">写文档</button>
    </div>
    <div class="canvas-zoom">
      <button @click="zoomOut()">−</button><button @click="zoomIn()">＋</button>
    </div>
  </main>
</template>
