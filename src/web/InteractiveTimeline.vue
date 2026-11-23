<script setup lang="ts">
import { ref, computed } from 'vue';
import type { EditDecisionList, RecordDoc } from '../shared/contracts';
import { timelineMap } from '../shared/edit-timeline';
import { editTimeline, type TimelineCommand } from '../shared/timeline-editing';
const props = defineProps<{ edl: EditDecisionList; assets: RecordDoc[]; frame: number }>();
const emit = defineEmits(['update', 'frame', 'notice', 'error', 'pause']);
const scale = ref(2),
  chosen = ref(-1),
  audioSelection = ref<number[]>([]),
  subtitleSelection = ref<string[]>([]),
  dragging = ref(-1),
  shift = ref(24),
  surface = ref<HTMLElement>();
const map = computed(() => timelineMap(props.edl)),
  width = computed(() => Math.max(720, map.value.frames * scale.value + 80));
const ticks = computed(() => {
  const every = scale.value < 1 ? 240 : scale.value < 3 ? 120 : 24;
  return Array.from({ length: Math.ceil(map.value.frames / every) + 1 }, (_, i) => i * every);
});
const name = (id: string) => props.assets.find((a) => a.id === id)?.data.name || '固定素材';
let pointer: any = null;
function apply(command: TimelineCommand, source = props.edl) {
  try {
    const r = editTimeline(source, command, props.assets);
    emit('update', r.edl);
    emit('notice', r.notices.join('；'));
    return true;
  } catch (e: any) {
    emit('error', e.message);
    return false;
  }
}
function seek(e: PointerEvent) {
  const box = surface.value!.getBoundingClientRect();
  emit('pause');
  emit(
    'frame',
    Math.max(0, Math.min(map.value.frames - 1, Math.round((e.clientX - box.left) / scale.value))),
  );
}
function start(
  e: PointerEvent,
  track: 'clips' | 'audio' | 'subtitle',
  index: number,
  boundary: 'in' | 'out' | 'move',
) {
  e.stopPropagation();
  e.preventDefault();
  emit('pause');
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  pointer = {
    x: e.clientX,
    track,
    index,
    boundary,
    source: JSON.parse(JSON.stringify(props.edl)),
    element: target,
  };
  if (track === 'clips') chosen.value = index;
}
function move(e: PointerEvent) {
  if (!pointer) return;
  const p = pointer,
    delta = Math.round((e.clientX - p.x) / scale.value),
    source = p.source;
  if (p.track === 'subtitle') {
    const o = source.overlays[p.index];
    apply({ action: 'shift', audio: [], subtitles: [o.id], deltaFrames: delta }, source);
    return;
  }
  if (p.boundary === 'move') {
    apply({ action: 'shift', audio: [p.index], subtitles: [], deltaFrames: delta }, source);
    return;
  }
  const clip = source[p.track][p.index];
  apply(
    {
      action: 'trim',
      track: p.track,
      index: p.index,
      boundary: p.boundary,
      seconds: Math.max(0, clip[p.boundary] + delta / 24),
    },
    source,
  );
}
function end() {
  pointer = null;
}
function split() {
  if (chosen.value < 0) return;
  apply({ action: 'split', index: chosen.value, frame: props.frame, newId: crypto.randomUUID() });
}
function toggleAudio(i: number) {
  audioSelection.value = audioSelection.value.includes(i)
    ? audioSelection.value.filter((v) => v !== i)
    : [...audioSelection.value, i];
}
function toggleSubtitle(id: string) {
  subtitleSelection.value = subtitleSelection.value.includes(id)
    ? subtitleSelection.value.filter((v) => v !== id)
    : [...subtitleSelection.value, id];
}
</script>
<template>
  <section
    class="interactive-timeline"
    aria-label="交互时间线"
    @keydown.stop
    @pointerup="end"
    @pointercancel="end"
  >
    <header class="timeline-controls">
      <strong>{{ map.frames }} 帧 · {{ (map.frames / 24).toFixed(3) }} 秒</strong
      ><label
        >缩放<input
          aria-label="时间线缩放"
          type="range"
          min="0.15"
          max="12"
          step="0.05"
          v-model.number="scale" /></label
      ><button :disabled="chosen < 0" @click="split">在播放头分割</button
      ><input
        aria-label="播放头帧"
        type="number"
        :value="frame"
        min="0"
        :max="map.frames - 1"
        @change="
          emit('pause');
          emit(
            'frame',
            Math.max(
              0,
              Math.min(
                map.frames - 1,
                Math.round(Number(($event.target as HTMLInputElement).value) || 0),
              ),
            ),
          );
        "
      /><label>选中音轨/字幕平移帧<input type="number" v-model.number="shift" /></label
      ><button
        :disabled="!audioSelection.length && !subtitleSelection.length"
        @click="
          apply({
            action: 'shift',
            audio: audioSelection,
            subtitles: subtitleSelection,
            deltaFrames: shift,
          })
        "
      >
        平移所选
      </button>
    </header>
    <div class="timeline-scroll">
      <div class="timeline-surface" ref="surface" :style="{ width: width + 'px' }">
        <div class="time-ruler" @pointerdown="seek">
          <span v-for="t in ticks" :key="t" :style="{ left: t * scale + 'px' }"
            >{{ (t / 24).toFixed(0) }}s</span
          >
        </div>
        <div class="timeline-lane visual-lane">
          <span class="lane-label">画面</span>
          <article
            v-for="entry in map.clips"
            :key="entry.clip.id"
            class="timeline-clip"
            :class="{ chosen: chosen === entry.index }"
            :style="{
              left: entry.startFrame * scale + 'px',
              width: Math.max(8, entry.frames * scale) + 'px',
            }"
            draggable="true"
            @dragstart="dragging = entry.index"
            @dragover.prevent
            @drop.prevent="
              if (dragging >= 0) apply({ action: 'reorder', index: dragging, to: entry.index });
              dragging = -1;
            "
            @dragend="dragging = -1"
            @click="
              chosen = entry.index;
              emit('frame', entry.startFrame);
              emit('pause');
            "
            :aria-label="'画面片段 ' + (entry.index + 1)"
          >
            <button
              class="trim-handle left"
              :aria-label="'裁剪片段 ' + (entry.index + 1) + ' 入点'"
              @pointerdown="start($event, 'clips', entry.index, 'in')"
              @pointermove="move"
              @lostpointercapture="end"
            >
              ❮</button
            ><span>{{ entry.index + 1 }} · {{ name(entry.clip.assetId) }}</span
            ><small>{{ entry.frames }} 帧</small
            ><button
              class="trim-handle right"
              :aria-label="'裁剪片段 ' + (entry.index + 1) + ' 出点'"
              @pointerdown="start($event, 'clips', entry.index, 'out')"
              @pointermove="move"
              @lostpointercapture="end"
            >
              ❯</button
            ><label v-if="entry.index" class="transition-handle" @click.stop
              >叠化<input
                type="number"
                min="0"
                :value="entry.clip.transition?.frames || 0"
                @change="
                  apply({
                    action: 'transition',
                    index: entry.index,
                    frames: Number(($event.target as HTMLInputElement).value),
                  })
                "
            /></label>
          </article>
        </div>
        <div v-for="(a, i) in edl.audio" :key="i" class="timeline-lane audio-lane">
          <span class="lane-label">音频 {{ i + 1 }}</span>
          <article
            class="timeline-audio"
            :style="{
              left: a.start * 24 * scale + 'px',
              width: Math.max(12, (a.out - a.in) * 24 * scale) + 'px',
            }"
            @pointerdown="start($event, 'audio', i, 'move')"
            @pointermove="move"
            @lostpointercapture="end"
          >
            <input
              type="checkbox"
              :aria-label="'选择音轨 ' + (i + 1)"
              :checked="audioSelection.includes(i)"
              @pointerdown.stop
              @change="toggleAudio(i)"
            /><span>{{ name(a.assetId) }}</span
            ><button
              class="trim-handle left"
              :aria-label="'裁剪音频 ' + (i + 1) + ' 入点'"
              @pointerdown="start($event, 'audio', i, 'in')"
              @pointermove="move"
            >
              ❮</button
            ><button
              class="trim-handle right"
              :aria-label="'裁剪音频 ' + (i + 1) + ' 出点'"
              @pointerdown="start($event, 'audio', i, 'out')"
              @pointermove="move"
            >
              ❯
            </button>
          </article>
        </div>
        <div class="timeline-lane subtitle-lane">
          <span class="lane-label">字幕</span>
          <article
            v-for="(o, i) in edl.overlays || []"
            :key="o.id"
            class="timeline-caption"
            :style="{
              left: o.startFrame * scale + 'px',
              width: Math.max(14, (o.endFrame - o.startFrame) * scale) + 'px',
            }"
            @pointerdown="start($event, 'subtitle', i, 'move')"
            @pointermove="move"
            @lostpointercapture="end"
          >
            <input
              type="checkbox"
              :aria-label="'选择字幕 ' + (i + 1)"
              :checked="subtitleSelection.includes(o.id)"
              @pointerdown.stop
              @change="toggleSubtitle(o.id)"
            /><span>{{ o.text }}</span>
          </article>
        </div>
        <div class="timeline-playhead" :style="{ left: frame * scale + 'px' }" />
      </div>
    </div>
    <p class="field-hint">
      拖动画面调整顺序；拖两端裁剪；拖音频/字幕移动。画面变化不会自动移动独立音轨和字幕。源音频保留采样精度。
    </p>
  </section>
</template>
