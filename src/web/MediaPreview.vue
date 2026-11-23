<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import { api, assetUrl } from './api';
import { registerMediaPreview } from './media-playback';
const props = defineProps<{
  asset: { id: string; revision: number };
  type: string;
  compact?: boolean;
  range?: { in: number; out: number };
}>();
const emit = defineEmits(['time', 'range', 'frame']);
const host = ref<HTMLElement>(),
  player = ref<HTMLMediaElement>(),
  visible = ref(false),
  cache = ref<any>(null),
  error = ref(''),
  time = ref(0),
  duration = ref(0),
  zoom = ref(false);
let observer: IntersectionObserver | undefined, release: (() => void) | undefined;
async function load() {
  try {
    cache.value = await api(
      '/assets/' + props.asset.id + '/preview?revision=' + props.asset.revision,
    );
  } catch (e: any) {
    error.value = e.message;
  }
}
async function prepare() {
  try {
    await api('/assets/' + props.asset.id + '/preview', 'POST', { revision: props.asset.revision });
    cache.value = { state: 'queued' };
  } catch (e: any) {
    error.value = e.message;
  }
}
async function sync() {
  release?.();
  release = undefined;
  await nextTick();
  if (player.value) release = registerMediaPreview(player.value);
}
watch([visible, () => props.asset.id, () => props.asset.revision, () => props.compact], () => {
  sync();
  if (visible.value) load();
});
function update() {
  time.value = player.value?.currentTime || 0;
  emit('time', time.value);
  if (props.range && time.value >= props.range.out) player.value?.pause();
}
const fps = computed(() => cache.value?.fps || 24);
function step(delta: number) {
  if (player.value) {
    player.value.pause();
    player.value.currentTime = Math.max(
      0,
      Math.min(
        duration.value - 1 / fps.value,
        Math.round(time.value * fps.value + delta) / fps.value,
      ),
    );
  }
}
function mark(boundary: 'in' | 'out') {
  const at =
    props.type === 'video'
      ? Math.min(Math.floor(duration.value * 24) / 24, Math.round(time.value * 24) / 24)
      : time.value;
  const r = {
    in: props.range?.in || 0,
    out:
      props.range?.out ||
      (props.type === 'video' ? Math.floor(duration.value * 24) / 24 : duration.value),
    [boundary]: at,
  };
  if (r.out > r.in) emit('range', r);
  else error.value = '终点必须在起点之后';
}
onMounted(() => {
  observer = new IntersectionObserver(
    (entries) => {
      visible.value = entries[0].isIntersecting;
    },
    { rootMargin: '100px' },
  );
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => {
  observer?.disconnect();
  release?.();
});
</script>
<template>
  <div ref="host" class="media-preview nodrag nowheel" @pointerdown.stop @keydown.stop>
    <template v-if="visible"
      ><img
        v-if="type === 'image'"
        :src="compact && cache?.url ? cache.url : assetUrl(asset.id, asset.revision)"
        alt="固定图片"
        loading="lazy"
        @click="zoom = true"
      /><template v-else-if="type === 'video'"
        ><img v-if="compact && cache?.url" :src="cache.url" alt="视频封面" /><video
          v-else-if="!compact"
          ref="player"
          :src="assetUrl(asset.id, asset.revision)"
          :poster="cache?.url || undefined"
          controls
          preload="none"
          playsinline
          @loadedmetadata="duration = player?.duration || 0"
          @timeupdate="update"
        /><span v-else>▷ 视频 · 放大以播放</span></template
      ><template v-else-if="type === 'audio'"
        ><img v-if="cache?.url" :src="cache.url" alt="音频波形" /><audio
          v-if="!compact"
          ref="player"
          :src="assetUrl(asset.id, asset.revision)"
          controls
          preload="none"
          @loadedmetadata="duration = player?.duration || 0"
          @timeupdate="update"
      /></template>
      <div v-if="type !== 'image' && !compact" class="media-controls">
        <small>{{ time.toFixed(3) }} / {{ duration.toFixed(3) }} s</small
        ><button v-if="type === 'video'" title="前一帧" @click="step(-1)">‹</button
        ><button v-if="type === 'video'" title="后一帧" @click="step(1)">›</button
        ><button @click="mark('in')" :disabled="!duration">设起点</button
        ><button @click="mark('out')" :disabled="!duration || time <= (range?.in || 0)">
          设终点</button
        ><button
          v-if="type === 'video'"
          @click="emit('frame', Math.round(time * fps))"
          :disabled="!duration"
        >
          提取此帧
        </button>
      </div>
      <button v-if="!compact && cache?.state === 'missing'" class="preview-cache" @click="prepare">
        准备本机{{ type === 'audio' ? '波形' : '封面' }}</button
      ><button
        v-else-if="!compact && cache && !['missing', 'ready'].includes(cache.state)"
        @click="load"
      >
        预览缓存 · {{ cache.state }} · 刷新
      </button>
    </template>
    <p v-if="error" class="field-hint">{{ error }}</p>
    <Teleport to="body"
      ><div v-if="zoom" class="image-lightbox" @click="zoom = false">
        <button>关闭</button
        ><img :src="assetUrl(asset.id, asset.revision)" alt="图片原尺寸预览" /></div
    ></Teleport>
  </div>
</template>
