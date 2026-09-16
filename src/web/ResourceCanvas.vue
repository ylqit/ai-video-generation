<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import type { WorkspaceSnapshot, WorkspaceCard } from '../shared/workspace';
import { assetUrl } from './api';
const props = defineProps<{
  snapshot: WorkspaceSnapshot;
  positions: Record<string, { x: number; y: number }>;
}>();
const emit = defineEmits(['open', 'discuss', 'layout', 'select']);
const scale = ref(1),
  dragging = ref(false),
  multiSelected = ref(new Set<string>()),
  pan = ref({ x: 28, y: 28 }),
  selected = ref(''),
  showLines = ref(true);
const groupNames = ['故事与方向', '主体与参考', '场景与镜头', '视频与交付'];
const statusNames: Record<string, string> = {
  bound: '已绑定参考',
  authored: '规划已保存',
  in_scope: '本次制作范围',
  source: '来源资料',
  exported: '已导出 · 审看用途',
  available: '待绑定',
  stale: '需要复核',
};
const stageNames: Record<string, string> = {
  brief: '需求',
  script: '剧本',
  direction: '方向',
  director: '导演',
  assets: '资产需求',
  editorial: '声音与后期',
  candidate: '视频候选',
  image: '图片',
  audio: '音频',
  chapter: '来源',
  shot: '镜头',
  requirement: '素材需求',
  source: '来源',
  subject: '主体',
  scene: '场景',
  asset: '图片素材',
  export: '审看导出',
};
const grouping = (c: WorkspaceCard) =>
  Math.max(
    0,
    ['story/direction', 'subjects/references', 'scenes/shots', 'video/delivery'].indexOf(c.group),
  );
const cards = computed(() => {
  const counts = [0, 0, 0, 0];
  return props.snapshot.cards.map((c) => {
    const group = grouping(c),
      row = counts[group]++;
    const result = Object.values(props.snapshot.results).find((r) => r?.id === c.record?.id);
    const image =
      c.asset &&
      props.snapshot.assets.find((a) => a.id === c.asset!.id && a.revision === c.asset!.revision);
    return {
      ...c,
      groupIndex: group,
      position: props.positions[c.id] || { x: group * 292, y: 46 + row * 238 },
      image,
      summary: (c as any).summary || result?.data.result.summary || '',
      label: stageNames[c.type] || c.type,
    };
  });
});
const byId = computed(() => new Map(cards.value.map((c) => [c.id, c])));
let drag: {
  id: string | null;
  pointerId: number;
  x: number;
  y: number;
  startX: number;
  startY: number;
  moved: boolean;
  element: HTMLElement;
  previousPosition?: { x: number; y: number };
} | null = null;
const temporary = ref<Record<string, { x: number; y: number }>>({});
function position(card: any) {
  return temporary.value[card.id] || card.position;
}
function pointerDown(event: PointerEvent, card?: any) {
  if (drag || !event.isPrimary || event.button !== 0) return;
  if (
    (event.target as Element).closest(
      'button,a,video,audio,input,textarea,select,[contenteditable]:not([contenteditable="false"]),.canvas-controls',
    )
  )
    return;
  const element = event.currentTarget as HTMLElement;
  event.preventDefault();
  event.stopPropagation();
  const canvas = element.closest('.resource-canvas');
  if (!card) (canvas as HTMLElement | null)?.focus({ preventScroll: true });
  multiSelected.value.clear();
  const selection = element.ownerDocument.getSelection();
  if (canvas && selection) {
    for (let i = 0; i < selection.rangeCount; i++) {
      if (selection.getRangeAt(i).intersectsNode(canvas)) {
        selection.removeAllRanges();
        break;
      }
    }
  }
  element.setPointerCapture(event.pointerId);
  const start = card ? position(card) : pan.value;
  drag = {
    id: card?.id || null,
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    startX: start.x,
    startY: start.y,
    moved: false,
    element,
    previousPosition: card ? temporary.value[card.id] : undefined,
  };
  dragging.value = true;
  element.ownerDocument.defaultView?.addEventListener('blur', finishDrag);
  if (card) {
    element.focus({ preventScroll: true });
    selected.value = card.id;
    emit('select', card);
  }
}
function pointerMove(event: PointerEvent) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  if ((event.buttons & 1) === 0) {
    finishDrag();
    return;
  }
  const dx = event.clientX - drag.x,
    dy = event.clientY - drag.y;
  if (!drag.moved && dx * dx + dy * dy <= 16) return;
  drag.moved = true;
  if (drag.id)
    temporary.value[drag.id] = {
      x: drag.startX + dx / scale.value,
      y: drag.startY + dy / scale.value,
    };
  else pan.value = { x: drag.startX + dx, y: drag.startY + dy };
}
function finishDrag(event?: Event) {
  if (!drag) return;
  if (event && 'pointerId' in event && event.pointerId !== drag.pointerId) return;
  const current = drag;
  // Releasing capture can synchronously trigger lostpointercapture. End ownership first.
  drag = null;
  dragging.value = false;
  current.element.ownerDocument.defaultView?.removeEventListener('blur', finishDrag);
  const commit = event?.type === 'pointerup' && (event as PointerEvent).button === 0;
  if (!commit) {
    if (current.id) {
      if (current.previousPosition) temporary.value[current.id] = current.previousPosition;
      else delete temporary.value[current.id];
    } else pan.value = { x: current.startX, y: current.startY };
  }
  if (current.element.hasPointerCapture(current.pointerId))
    current.element.releasePointerCapture(current.pointerId);
  if (commit && current.id && current.moved)
    emit('layout', { ...props.positions, [current.id]: temporary.value[current.id] });
}
onBeforeUnmount(() => finishDrag());
function canvasKey(event: KeyboardEvent) {
  const target = event.target as HTMLElement;
  if (
    target.closest(
      'input,textarea,select,button,a,[contenteditable]:not([contenteditable="false"])',
    )
  )
    return;
  if (target.ownerDocument.activeElement !== target) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    multiSelected.value = new Set(cards.value.map((c) => c.id));
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    finishDrag();
    multiSelected.value.clear();
    selected.value = '';
    return;
  }
  const movement: Record<string, [number, number]> = {
    ArrowLeft: [40, 0],
    ArrowRight: [-40, 0],
    ArrowUp: [0, 40],
    ArrowDown: [0, -40],
  };
  if (movement[event.key]) {
    event.preventDefault();
    finishDrag();
    const [x, y] = movement[event.key];
    pan.value = { x: pan.value.x + x, y: pan.value.y + y };
  }
}
function wheel(event: WheelEvent) {
  if (
    (event.target as Element).closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
    )
  )
    return;
  event.preventDefault();
  finishDrag();
  if (event.ctrlKey)
    scale.value = Math.max(0.35, Math.min(1.6, scale.value - event.deltaY * 0.001));
  else {
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 500 : 1;
    pan.value = {
      x: pan.value.x - (event.shiftKey ? event.deltaY : event.deltaX) * unit,
      y: pan.value.y - (event.shiftKey ? 0 : event.deltaY) * unit,
    };
  }
}
function revealFocusedCard(event: FocusEvent) {
  if (drag) return;
  const card = (event.target as Element).closest('.resource-card');
  if (!card) return;
  const viewport = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const bounds = card.getBoundingClientRect();
  const left = viewport.left + 16,
    right = viewport.right - 16,
    top = viewport.top + 16,
    bottom = viewport.bottom - 76; // Keep focused content above the canvas controls.
  const dx =
    bounds.left < left || bounds.right - bounds.left > right - left
      ? left - bounds.left
      : Math.min(0, right - bounds.right);
  const dy =
    bounds.top < top || bounds.bottom - bounds.top > bottom - top
      ? top - bounds.top
      : Math.min(0, bottom - bounds.bottom);
  if (dx || dy) pan.value = { x: pan.value.x + dx, y: pan.value.y + dy };
}
function autoLayout() {
  finishDrag();
  temporary.value = {};
  pan.value = { x: 28, y: 28 };
  scale.value = 1;
  emit('layout', {});
}
function locate(id: string) {
  const c = byId.value.get(id);
  if (!c) return;
  finishDrag();
  selected.value = id;
  const p = position(c);
  pan.value = { x: 40 - p.x * scale.value, y: 80 - p.y * scale.value };
}
defineExpose({ locate });
</script>

<template>
  <div
    class="resource-canvas"
    :class="{ 'canvas-gesture': dragging }"
    tabindex="0"
    aria-label="资源画布"
    @keydown="canvasKey"
    @pointerdown="pointerDown($event)"
    @pointermove="pointerMove"
    @pointerup="finishDrag"
    @pointercancel="finishDrag"
    @lostpointercapture="finishDrag"
    @focusin="revealFocusedCard"
    @wheel="wheel"
  >
    <div
      class="canvas-world"
      :style="{ transform: `translate(${pan.x}px,${pan.y}px) scale(${scale})` }"
    >
      <h3
        v-for="(group, i) in groupNames"
        :key="group"
        class="canvas-group"
        :style="{ left: `${i * 292}px` }"
      >
        <span>{{ String(i + 1).padStart(2, '0') }}</span
        >{{ group }}
      </h3>
      <svg v-if="showLines" class="canvas-edges" width="1" height="1" aria-hidden="true">
        <template v-for="edge in snapshot.edges" :key="edge.id">
          <path
            v-if="byId.has(edge.from) && byId.has(edge.to)"
            :d="`M ${position(byId.get(edge.from)).x + 260} ${position(byId.get(edge.from)).y + 100} C ${position(byId.get(edge.from)).x + 310} ${position(byId.get(edge.from)).y + 100},${position(byId.get(edge.to)).x - 50} ${position(byId.get(edge.to)).y + 100},${position(byId.get(edge.to)).x} ${position(byId.get(edge.to)).y + 100}`"
          >
            <title>{{ edge.relation }}</title>
          </path>
        </template>
      </svg>
      <article
        v-for="card in cards"
        :key="card.id"
        class="resource-card"
        :class="{ selected: selected === card.id || multiSelected.has(card.id) }"
        :style="{ left: `${position(card).x}px`, top: `${position(card).y}px` }"
        tabindex="0"
        :aria-label="card.title"
        @pointerdown="pointerDown($event, card)"
        @dblclick="emit('open', card)"
        @keydown.enter="emit('open', card)"
      >
        <div class="resource-card-top">
          <span>{{ card.label }}</span
          ><span class="drag-handle" title="拖动仅改变展示位置">⠿</span>
        </div>
        <button
          class="resource-thumbnail"
          @click="emit('open', card)"
          @dragstart.prevent
          :aria-label="`预览 ${card.title}`"
        >
          <img
            v-if="card.image?.data.mediaType === 'image'"
            :src="assetUrl(card.image.id, card.image.revision)"
            :alt="card.title"
            :draggable="false"
            loading="lazy"
          /><video
            v-else-if="card.image?.data.mediaType === 'video'"
            :src="assetUrl(card.image.id, card.image.revision)"
            preload="metadata"
            muted
          /><span v-else-if="card.type === 'candidate'">▷</span
          ><span v-else-if="card.image?.data.mediaType === 'audio'">♫</span>
          <p v-else>{{ card.summary || (card.type === 'shot' ? '构图参考待制作' : card.title) }}</p>
        </button>
        <h4 :title="card.title">{{ card.title }}</h4>
        <div class="resource-card-footer">
          <span>{{
            card.status === 'adopted'
              ? card.type === 'asset'
                ? '参考已审看'
                : '已采用方案'
              : card.type === 'candidate' && card.status === 'succeeded'
                ? '待审看'
                : card.status === 'draft'
                  ? '创作草稿'
                  : card.status === 'missing'
                    ? '待制作'
                    : statusNames[card.status] || card.status
          }}</span
          ><button @click="emit('discuss', card)" aria-label="讨论此内容">讨论 ↗</button>
        </div>
      </article>
    </div>
    <div v-if="!cards.length" class="canvas-empty">
      <span>✧</span>
      <h2>从一个故事开始</h2>
      <p>在右侧描述目标，或导入已有剧本。创作成果会出现在这里。</p>
    </div>
    <div class="canvas-controls">
      <button
        @click="
          finishDrag();
          scale = Math.max(0.35, scale - 0.1);
        "
        aria-label="缩小画布"
      >
        −</button
      ><output>{{ Math.round(scale * 100) }}%</output
      ><button
        @click="
          finishDrag();
          scale = Math.min(1.6, scale + 0.1);
        "
        aria-label="放大画布"
      >
        ＋</button
      ><button @click="autoLayout">自动布局</button
      ><button :aria-pressed="showLines" @click="showLines = !showLines">引用连线</button>
    </div>
    <span class="canvas-hint">拖动画布 · Ctrl + 滚轮缩放 · 双击预览</span>
  </div>
</template>
