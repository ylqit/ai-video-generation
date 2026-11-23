<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { api, assetUrl } from './api';
const props = defineProps<{ scope: any }>();
const sides = ref<any[]>([]),
  seconds = ref(1),
  playing = ref(-1),
  loop = ref(false),
  error = ref('');
const players: HTMLVideoElement[] = [];
let ticket = 0;
function stop() {
  playing.value = -1;
  for (const player of players) player?.pause();
}
watch(
  () => props.scope.digest,
  async () => {
    stop();
    const current = ++ticket;
    sides.value = [];
    error.value = '';
    try {
      const values = await Promise.all(
        props.scope.content.clips.map(async (clip: any) => ({
          ...clip,
          adopted: clip.selection
            ? await api(`/records/${clip.selection.id}?revision=${clip.selection.revision}`)
            : null,
        })),
      );
      if (current === ticket) sides.value = values;
    } catch (e: any) {
      if (current === ticket) error.value = e.message;
    }
  },
  { immediate: true },
);
const windows = computed(() => {
  const span = Number.isFinite(seconds.value) ? Math.min(30, Math.max(0.25, seconds.value)) : 1;
  return sides.value.map((clip, index) => ({
    ...clip,
    start: index === 0 ? Math.max(clip.in, clip.out - span) : clip.in,
    end: index === 0 ? clip.out : Math.min(clip.out, clip.in + span),
  }));
});
async function play(index = 0) {
  stop();
  error.value = '';
  const player = players[index],
    window = windows.value[index];
  if (!player || !window) return;
  player.currentTime = window.start;
  playing.value = index;
  try {
    await player.play();
  } catch (e: any) {
    error.value = `播放失败：${e.message}`;
    stop();
  }
}
function advance(index: number) {
  if (playing.value !== index || players[index].currentTime < windows.value[index].end) return;
  if (index + 1 < windows.value.length) void play(index + 1);
  else if (loop.value) void play(0);
  else stop();
}
const stateRows = computed(() => {
  const boundaries = sides.value.map((clip, index) => {
    const selection = clip.adopted?.data;
    const part = selection?.composition
      ? index === 0
        ? selection.composition.parts.at(-1)
        : selection.composition.parts[0]
      : selection;
    const side = index === 0 ? 'end' : 'start',
      field = index === 0 ? 'out' : 'in';
    if (
      part?.video?.id !== clip.assetId ||
      part?.video?.revision !== clip.revision ||
      Math.round(part[field] * 24) !== Math.round(clip[field] * 24)
    )
      return null;
    return selection?.boundary?.[side];
  });
  const [left, right] = boundaries;
  const keys = new Set<string>(
    [...(left?.facts || []), ...(right?.facts || [])].map((f) => `${f.instanceId}.${f.key}`),
  );
  return [...keys].map((key) => ({
    key,
    left: left?.facts.find((f: any) => `${f.instanceId}.${f.key}` === key),
    right: right?.facts.find((f: any) => `${f.instanceId}.${f.key}` === key),
  }));
});
watch(seconds, stop);
onBeforeUnmount(() => {
  ticket++;
  stop();
});
</script>
<template>
  <section class="panel">
    <h4>实际采用接点 · {{ scope.key }}</h4>
    <p>
      两侧原片连播用于动作比较。实际声音与转场效果请用原时间线或固定导出审核；播放不会自动勾选通过。
    </p>
    <div class="toolbar">
      <label
        >两侧查看秒数<input
          v-model.number="seconds"
          type="number"
          min="0.25"
          max="30"
          step="0.25" /></label
      ><label><input v-model="loop" type="checkbox" />循环</label
      ><button @click="play(0)">左右连播</button><button @click="stop">停止</button>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <div class="join-sides">
      <article v-for="(clip, index) in windows" :key="`${clip.assetId}:${clip.revision}`">
        <strong>{{ index === 0 ? '左侧出口' : '右侧入口' }}</strong
        ><video
          :ref="
            (el) => {
              if (el) players[index] = el as HTMLVideoElement;
            }
          "
          :src="assetUrl(clip.assetId, clip.revision)"
          muted
          controls
          preload="metadata"
          @timeupdate="advance(index)"
          @ended="advance(index)"
        />
        <p>
          源帧 [{{ Math.round(clip.start * 24) }}, {{ Math.round(clip.end * 24) }}) ·
          {{ clip.assetId }} v{{ clip.revision }}
        </p>
        <button @click="play(index)">播放这一侧</button>
        <details>
          <summary>采用边界与观察窗口</summary>
          <pre>{{ JSON.stringify(clip.adopted?.data.boundary || '无实际边界证据', null, 2) }}</pre>
        </details>
      </article>
    </div>
    <p>
      以下是采用记录中的状态。若 EDL 裁剪已离开原观察边界，须重新审查，不能直接当作当前接点事实。
    </p>
    <table>
      <thead>
        <tr>
          <th>实例属性</th>
          <th>左侧记录</th>
          <th>右侧记录</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in stateRows" :key="row.key">
          <td>{{ row.key }}</td>
          <td>
            {{ row.left?.status === 'known' ? JSON.stringify(row.left.value) : '未知／未观察' }}
          </td>
          <td>
            {{ row.right?.status === 'known' ? JSON.stringify(row.right.value) : '未知／未观察' }}
          </td>
        </tr>
      </tbody>
    </table>
    <details>
      <summary>转场、动作与空间要求</summary>
      <pre>{{
        JSON.stringify(
          scope.content.clips.map((c: any) => ({ incoming: c.incoming, contract: c.contract })),
          null,
          2,
        )
      }}</pre>
    </details>
  </section>
</template>
<style scoped>
.join-sides {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
video {
  width: 100%;
  max-height: 260px;
}
pre {
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
}
@media (max-width: 700px) {
  .join-sides {
    grid-template-columns: 1fr;
  }
}
</style>
