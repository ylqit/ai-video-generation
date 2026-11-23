<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { assetUrl } from './api';
import DirectorSpace from './DirectorSpace.vue';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const frame = ref(0),
  playing = ref(false),
  sound = ref(false),
  audioError = ref('');
const audioElements = new Map<number, HTMLAudioElement>();
const director = computed(() => props.snapshot.results.director);
const shots = computed(() => {
  let start = 0;
  return (director.value?.data.result.shots || []).map((shot: any) => {
    const at = start;
    start += shot.frames;
    const image = props.snapshot.requirements.find(
      (r) =>
        r.shotIds.includes(shot.id) &&
        ['composition', 'action_start'].includes(r.purpose) &&
        r.binding,
    )?.binding?.asset;
    return { shot, start: at, end: start, image };
  });
});
const total = computed(() => shots.value.at(-1)?.end || 0);
const current = computed(() =>
  shots.value.find((s: any) => frame.value >= s.start && frame.value < s.end),
);
const audioTracks = computed(() => props.snapshot.results.editorial?.data.result.audio || []);
let timer: ReturnType<typeof setInterval> | undefined,
  started = 0,
  from = 0;
function syncAudio() {
  for (const [i, el] of audioElements) {
    const track = audioTracks.value[i];
    if (!track) {
      el.pause();
      continue;
    }
    const local = frame.value - track.startFrame;
    if (!sound.value || !playing.value || local < 0 || local >= track.outFrame - track.inFrame) {
      el.pause();
      continue;
    }
    const time = (track.inFrame + local) / 24;
    if (Math.abs(el.currentTime - time) > 0.2) el.currentTime = time;
    el.volume = track.volume;
    if (el.paused)
      void el.play().catch(() => {
        sound.value = false;
        audioError.value = '音轨无法播放，请检查素材或浏览器播放权限。';
      });
  }
}
function pause() {
  playing.value = false;
  if (timer) clearInterval(timer);
  timer = undefined;
  syncAudio();
}
function play() {
  if (!total.value) return;
  if (playing.value) {
    pause();
    return;
  }
  if (frame.value >= total.value - 1) frame.value = 0;
  playing.value = true;
  started = performance.now();
  from = frame.value;
  timer = setInterval(() => {
    frame.value = Math.min(
      total.value - 1,
      from + Math.floor(((performance.now() - started) * 24) / 1000),
    );
    syncAudio();
    if (frame.value === total.value - 1) pause();
  }, 40);
}
watch(
  () => [
    director.value?.id,
    director.value?.revision,
    props.snapshot.results.assets?.revision,
    props.snapshot.results.editorial?.revision,
  ],
  () => {
    pause();
    frame.value = 0;
  },
);
watch(sound, syncAudio);
onBeforeUnmount(pause);
</script>
<template>
  <details
    class="panel rehearsal"
    v-if="shots.length"
    @toggle="!($event.target as HTMLDetailsElement).open && pause()"
  >
    <summary>轻量预演 · 图片、布局、计划节奏与已有音频</summary>
    <p>这是固定导演方案的计划预演，不能证明真实动作、表演或画质已经通过。</p>
    <div v-if="current" class="stage">
      <img
        v-if="current.image"
        :src="assetUrl(current.image.id, current.image.revision)"
        :alt="current.shot.purpose"
      />
      <div v-else class="placeholder">本镜未指定构图图 · 预演文字与时间安排</div>
      <p>
        <strong>{{ current.shot.id }} · {{ current.shot.purpose }}</strong
        ><br />{{ current.shot.action }}
      </p>
      <p>
        观众注意：{{ current.shot.audienceFocus || '未声明' }} · 切出理由：{{
          current.shot.cutReason || '未声明'
        }}
      </p>
      <DirectorSpace
        v-if="director"
        :director="director.data.result"
        :shot="current.shot"
        :basis="{ id: director.id, revision: director.revision }"
      />
    </div>
    <button @click="play">{{ playing ? '暂停预演' : '播放计划' }}</button>
    <input
      aria-label="预演帧"
      type="range"
      min="0"
      :max="total - 1"
      v-model.number="frame"
      @input="pause"
    />
    <span>{{ (frame / 24).toFixed(2) }} / {{ (total / 24).toFixed(2) }} 秒</span>
    <label
      ><input type="checkbox" v-model="sound" />播放已有后期音轨（{{
        audioTracks.length
      }}
      条）</label
    >
    <p v-if="audioError" class="error">{{ audioError }}</p>
    <audio
      v-for="(track, i) in audioTracks"
      :key="track.asset.id + ':' + i"
      :ref="
        (el) => {
          if (el) audioElements.set(Number(i), el as HTMLAudioElement);
          else audioElements.delete(Number(i));
        }
      "
      :src="assetUrl(track.asset.id, track.asset.revision)"
      preload="metadata"
    />
  </details>
</template>
<style scoped>
.stage img {
  display: block;
  max-width: 100%;
  max-height: 400px;
  margin: auto;
}
.placeholder {
  padding: 50px 15px;
  background: #eef0f8;
  text-align: center;
}
input[type='range'] {
  width: 50%;
  margin: 16px;
}
label {
  display: block;
}
</style>
