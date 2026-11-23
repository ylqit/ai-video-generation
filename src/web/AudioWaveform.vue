<script setup lang="ts">
import { ref, onBeforeUnmount } from 'vue';
const props = defineProps<{ src: string }>();
const player = ref<HTMLAudioElement>(),
  peaks = ref<number[]>([]),
  error = ref(''),
  loading = ref(false),
  time = ref(0);
let context: AudioContext | undefined,
  controller = new AbortController();
async function load() {
  loading.value = true;
  error.value = '';
  try {
    const response = await fetch(props.src, { signal: controller.signal });
    if (!response.ok) throw new Error('音频读取失败');
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 100 * 1024 * 1024)
      throw new Error('波形预览支持 100 MB 以内素材，请先截取需要的范围');
    context = new AudioContext();
    const audio = await context.decodeAudioData(bytes),
      samples = audio.getChannelData(0),
      stride = Math.max(1, Math.floor(samples.length / 300));
    peaks.value = Array.from({ length: 300 }, (_, i) => {
      let peak = 0;
      for (let n = i * stride; n < Math.min(samples.length, (i + 1) * stride); n++)
        peak = Math.max(peak, Math.abs(samples[n]));
      return peak;
    });
    await context.close();
    context = undefined;
  } catch (e: any) {
    if (!controller.signal.aborted) error.value = e.message;
  } finally {
    loading.value = false;
  }
}
function seek(e: MouseEvent) {
  if (!player.value?.duration) return;
  const box = (e.currentTarget as Element).getBoundingClientRect();
  player.value.currentTime = ((e.clientX - box.left) / box.width) * player.value.duration;
}
onBeforeUnmount(() => {
  controller.abort();
  void context?.close();
});
</script>
<template>
  <div class="audio-waveform">
    <audio
      ref="player"
      :src="src"
      controls
      preload="metadata"
      @timeupdate="time = player?.currentTime || 0"
    /><button v-if="!peaks.length" :disabled="loading" @click="load">
      {{ loading ? '读取实际采样…' : '显示波形' }}</button
    ><svg v-else viewBox="0 0 600 80" @click="seek" aria-label="实际音频波形，点击定位">
      <line
        v-for="(v, i) in peaks"
        :key="i"
        :x1="i * 2"
        :x2="i * 2"
        :y1="40 - v * 38"
        :y2="40 + v * 38"
        stroke="#8973df"
      />
      <line
        :x1="(time / (player?.duration || 1)) * 600"
        :x2="(time / (player?.duration || 1)) * 600"
        y1="0"
        y2="80"
        stroke="#e99067"
      />
    </svg>
    <p v-if="error" class="inline-error">{{ error }}</p>
  </div>
</template>
<style scoped>
.audio-waveform audio,
.audio-waveform svg {
  width: 100%;
}
.audio-waveform svg {
  background: #f7f4ff;
  border-radius: 8px;
  cursor: crosshair;
}
</style>
