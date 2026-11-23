<script setup lang="ts">
import { computed, watch, onBeforeUnmount } from 'vue';
import type { EditDecisionList, RecordDoc } from '../shared/contracts';
import { timelineMap, visualLayerAt } from '../shared/edit-timeline';
import { clipGain } from '../shared/longform';
import { assetUrl } from './api';
import { pauseMediaPreviews } from './media-playback';
const props = defineProps<{
  edl: EditDecisionList;
  assets: RecordDoc[];
  frame: number;
  playing: boolean;
}>();
const emit = defineEmits(['frame', 'end', 'error']);
const map = computed(() => timelineMap(props.edl));
const assets = computed(() => new Map(props.assets.map((a) => [`${a.id}:${a.revision}`, a])));
const layers = computed(() =>
  map.value.clips.map((e) => ({
    ...e,
    ...visualLayerAt(e, props.frame),
    asset: assets.value.get(`${e.clip.assetId}:${e.clip.revision}`),
  })),
);
const visible = computed(() => layers.value.filter((e) => e.active));
const elements = new Map<string, HTMLMediaElement>();
let timer: ReturnType<typeof setInterval> | undefined,
  start = 0,
  from = 0,
  lastEmitted = -1;
function sync() {
  if (props.playing) pauseMediaPreviews();
  for (const [key, el] of elements) {
    let active = false,
      time = 0,
      volume = 0;
    if (key.startsWith('v')) {
      const e = layers.value[Number(key.slice(1))];
      if (e) {
        active = e.active;
        time = e.sourceFrame / 24;
        volume = clipGain(e.clip, (props.frame - e.startFrame) / 24);
      }
    } else {
      const a = props.edl.audio[Number(key.slice(1))];
      if (a) {
        const local = props.frame / 24 - a.start;
        active = local >= 0 && local < a.out - a.in;
        time = a.in + local;
        volume = clipGain(a, local);
      }
    }
    if (!active) {
      el.pause();
      continue;
    }
    el.volume = Math.max(0, Math.min(1, volume));
    if (
      Number.isFinite(el.duration) &&
      Math.abs(el.currentTime - time) > (props.playing ? 0.1 : 1 / 48)
    )
      el.currentTime = Math.max(0, Math.min(time, el.duration));
    if (props.playing && el.paused)
      void el.play().catch((e) => emit('error', `时间线播放失败：${e.message}`));
    if (!props.playing) el.pause();
  }
}
function bind(key: string, value: any) {
  const old = elements.get(key);
  if (old && old !== value) old.pause();
  if (value) elements.set(key, value);
  else elements.delete(key);
}
function stopClock() {
  if (timer) clearInterval(timer);
  timer = undefined;
  for (const el of elements.values()) el.pause();
}
watch(
  () => props.playing,
  (play) => {
    stopClock();
    if (play) {
      start = performance.now();
      from = props.frame;
      timer = setInterval(() => {
        const next = from + Math.floor(((performance.now() - start) * 24) / 1000);
        lastEmitted = Math.min(Math.max(0, map.value.frames - 1), next);
        emit('frame', lastEmitted);
        if (next >= map.value.frames) {
          stopClock();
          emit('end');
        }
      }, 20);
    }
    sync();
  },
  { immediate: true },
);
watch(
  () => props.frame,
  (frame) => {
    if (frame !== lastEmitted) {
      from = frame;
      start = performance.now();
    }
    sync();
  },
  { flush: 'post' },
);
watch(() => props.edl, sync, { deep: true, flush: 'post' });
onBeforeUnmount(stopClock);
</script>
<template>
  <div class="mapped-player" :style="{ aspectRatio: `${edl.width}/${edl.height}` }">
    <template v-for="e in visible" :key="e.clip.id || e.index">
      <img
        v-if="e.asset?.data.mediaType === 'image'"
        :src="assetUrl(e.clip.assetId, e.clip.revision)"
        :style="{ opacity: e.opacity, filter: `brightness(${e.brightness})` }"
        alt="时间线画面"
      />
      <video
        v-else
        :ref="(el) => bind('v' + e.index, el)"
        :src="assetUrl(e.clip.assetId, e.clip.revision)"
        :style="{ opacity: e.opacity, filter: `brightness(${e.brightness})` }"
        playsinline
        preload="auto"
        @loadedmetadata="sync"
      />
    </template>
    <audio
      v-for="(a, i) in edl.audio"
      :key="a.assetId + ':' + i"
      :ref="(el) => bind('a' + i, el)"
      :src="assetUrl(a.assetId, a.revision)"
      preload="metadata"
      @loadedmetadata="sync"
    />
    <span
      v-for="o in (edl.overlays || []).filter((o) => o.startFrame <= frame && o.endFrame > frame)"
      :key="o.id"
      class="overlay"
      :style="{
        color: o.color,
        fontSize: `${(o.fontSize / edl.height) * 100}cqh`,
        top: o.position === 'top' ? '8%' : o.position === 'center' ? '50%' : '90%',
        transform: o.position === 'top' ? 'translateX(-50%)' : 'translate(-50%,-100%)',
      }"
      >{{ o.text }}</span
    >
  </div>
</template>
<style scoped>
.mapped-player {
  position: relative;
  background: black;
  width: 100%;
  overflow: hidden;
  container-type: size;
}
.mapped-player img,
.mapped-player video {
  position: absolute;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.overlay {
  position: absolute;
  left: 50%;
  white-space: pre;
  text-align: center;
  pointer-events: none;
}
</style>
