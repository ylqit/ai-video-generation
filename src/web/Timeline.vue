<script setup lang="ts">
import AssemblyReview from './AssemblyReview.vue';
import RecordPicker from './RecordPicker.vue';
import ContractField from './ContractField.vue';
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import {
  type RecordDoc,
  type EditDecisionList,
  clipDuration,
  timelineDuration,
} from '../shared/contracts';
import { api, assetUrl, downloadJson } from './api';
import { clipGain } from '../shared/longform';
const props = defineProps<{ episode: RecordDoc; assets: RecordDoc[]; saved?: RecordDoc }>();
const emit = defineEmits(['refresh']);
const edl = ref<EditDecisionList>({
    schemaVersion: 2,
    episodeId: props.episode.id,
    width: 864,
    height: 480,
    fps: 24,
    clips: [],
    audio: [],
  }),
  revision = ref<number>(),
  error = ref(''),
  busy = ref(false),
  notice = ref('');
const total = computed(() => timelineDuration(edl.value)),
  position = ref(0),
  playEnd = ref<number | null>(null),
  playing = ref(false),
  activeIndex = ref(0);
let animation = 0,
  lastTime = 0,
  loadedEpisode = '',
  loadedData = '';
const elements = new Map<string, HTMLMediaElement>();
const mediaBindings = new Map<string, (el: any) => void>();
watch(
  () => [props.episode.id, props.saved?.id, props.saved?.revision],
  () => {
    if (loadedEpisode === props.episode.id) {
      if (!props.saved || props.saved.revision === revision.value) return;
      if (JSON.stringify(edl.value) !== loadedData) {
        error.value =
          '服务端时间线已到达或更新，当前未保存修改已保留。请先导出草稿，再重新打开比较。';
        return;
      }
    }
    stop();
    playEnd.value = null;
    position.value = 0;
    edl.value = props.saved
      ? JSON.parse(JSON.stringify(props.saved.data))
      : {
          schemaVersion: 2,
          episodeId: props.episode.id,
          width: props.episode.data.dramaturgy?.canvas?.width || 864,
          height: props.episode.data.dramaturgy?.canvas?.height || 480,
          fps: 24,
          clips: [],
          audio: [],
        };
    revision.value = props.saved?.revision;
    loadedEpisode = props.episode.id;
    loadedData = JSON.stringify(edl.value);
  },
  { immediate: true },
);
function mediaBinding(key: string) {
  if (!mediaBindings.has(key))
    mediaBindings.set(key, (el) => {
      const previous = elements.get(key);
      if (previous && previous !== el) previous.pause();
      if (el) elements.set(key, el);
      else elements.delete(key);
    });
  return mediaBindings.get(key)!;
}
const frozenMedia = ref<Record<string, RecordDoc>>({});
let mediaTicket = 0;
watch(
  () =>
    [
      props.episode.id,
      ...edl.value.clips.map((c) => `${c.assetId}:${c.revision}`),
      ...edl.value.audio.map((c) => `${c.assetId}:${c.revision}`),
    ].join('|'),
  async () => {
    const ticket = ++mediaTicket;
    const refs = [
      ...new Map(
        [...edl.value.clips, ...edl.value.audio].map((c) => [`${c.assetId}:${c.revision}`, c]),
      ).values(),
    ];
    try {
      for (let i = 0; i < refs.length; i += 4) {
        const records = await Promise.all(
          refs
            .slice(i, i + 4)
            .map(
              (c) =>
                frozenMedia.value[`${c.assetId}:${c.revision}`] ||
                api(`/records/${c.assetId}/versions/${c.revision}`),
            ),
        );
        if (ticket !== mediaTicket) return;
        for (const record of records) frozenMedia.value[`${record.id}:${record.revision}`] = record;
      }
    } catch (e: any) {
      if (ticket === mediaTicket) {
        error.value = '固定媒体版本读取失败：' + e.message;
        stop();
      }
    }
  },
  { immediate: true },
);
function media(id: string, revision?: number) {
  return revision
    ? frozenMedia.value[`${id}:${revision}`] ||
        props.assets.find((a) => a.id === id && a.revision === revision)
    : props.assets.find((a) => a.id === id);
}
function add(id: string, audio = false) {
  const asset = media(id);
  if (!asset) return;
  const clip = {
    assetId: id,
    revision: asset.revision,
    in: 0,
    out:
      edl.value.schemaVersion === 2
        ? Math.floor((asset.data.duration || 5) * 24) / 24
        : asset.data.duration || 5,
    volume: 1,
  };
  if (audio) edl.value.audio.push({ ...clip, start: 0 });
  else edl.value.clips.push(clip);
}
async function assemble() {
  error.value = '';
  try {
    stop();
    edl.value = await api(`/episodes/${props.episode.id}/assemble`);
  } catch (e: any) {
    error.value = e.message;
  }
}
function stop() {
  playing.value = false;
  cancelAnimationFrame(animation);
  for (const el of elements.values()) el.pause();
}
function sync() {
  let start = 0,
    index = 0;
  for (; index < edl.value.clips.length - 1; index++) {
    if (position.value < start + clipDuration(edl.value.clips[index])) break;
    start += clipDuration(edl.value.clips[index]);
  }
  activeIndex.value = index;
  for (const [key, el] of elements) {
    let local: number | undefined,
      volume = 1;
    if (key.startsWith('v')) {
      const i = Number(key.slice(1)),
        c = edl.value.clips[i];
      if (i === index && c) {
        local = c.in + position.value - start;
        volume = clipGain(c, position.value - start);
      }
    } else {
      const c = edl.value.audio[Number(key.slice(1))];
      if (c && position.value >= c.start && position.value < c.start + clipDuration(c)) {
        local = c.in + position.value - c.start;
        volume = clipGain(c, position.value - c.start);
      }
    }
    if (local === undefined) {
      el.pause();
      continue;
    }
    el.volume = Math.min(1, volume);
    if (Number.isFinite(el.duration) && Math.abs(el.currentTime - local) > 0.12)
      el.currentTime = Math.min(local, el.duration);
    if (playing.value && el.paused)
      el.play().catch((e) => {
        if (playing.value) {
          error.value = '预览播放失败：' + e.message;
          stop();
        }
      });
    else if (!playing.value) el.pause();
  }
}
function tick(t: number) {
  if (!playing.value) return;
  if (lastTime)
    position.value = Math.min(playEnd.value ?? total.value, position.value + (t - lastTime) / 1000);
  lastTime = t;
  sync();
  if (position.value >= (playEnd.value ?? total.value)) {
    stop();
    playEnd.value = null;
  } else animation = requestAnimationFrame(tick);
}
function play() {
  if (!edl.value.clips.length) return;
  if (playing.value) {
    stop();
    return;
  }
  if (position.value >= total.value) position.value = 0;
  playing.value = true;
  lastTime = 0;
  sync();
  animation = requestAnimationFrame(tick);
}
async function save() {
  const owner = props.episode.id,
    submitted = JSON.stringify(edl.value);
  busy.value = true;
  error.value = '';
  try {
    const d = await api(`/projects/${props.episode.projectId}/edl`, 'POST', {
      revision: revision.value,
      data: JSON.parse(submitted),
    });
    if (owner !== props.episode.id) return;
    if (JSON.stringify(edl.value) !== submitted) {
      revision.value = d.revision;
      loadedData = JSON.stringify(d.data);
      emit('refresh');
      error.value = '上次提交已保存；保存期间的新编辑仍保留在草稿，请再次保存后导出。';
      return;
    }
    edl.value = d.data;
    revision.value = d.revision;
    loadedData = JSON.stringify(d.data);
    emit('refresh');
    return d;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function exportVideo(partial = false) {
  const d = await save();
  if (d)
    try {
      const job = await api(`/edls/${d.id}/export`, 'POST', {
        revision: d.revision,
        name: props.episode.data.title + ' · 成片',
        idempotencyKey: crypto.randomUUID(),
        allowPartial: partial,
      });
      notice.value = `成片任务已进入本地媒体队列（${job.id}），完成后可在资产库与任务记录中查看。`;
      emit('refresh');
    } catch (e: any) {
      error.value = e.message;
    }
}
onBeforeUnmount(stop);
</script>
<template>
  <section>
    <div class="section-head">
      <div>
        <h2>剪辑 · {{ episode.data.title }}</h2>
        <button @click="assemble">从已审核片段选择装配</button>
        <p>同一时间线驱动预览与 FFmpeg 导出 · {{ total.toFixed(2) }} 秒</p>
      </div>
      <div class="actions">
        <button @click="downloadJson('时间线草稿.json', edl)">导出时间线 JSON</button>
        <button @click="save" :disabled="busy">保存时间线</button
        ><button @click="exportVideo(true)" :disabled="busy || !edl.clips.length">
          导出时间线草稿</button
        ><button class="primary" @click="exportVideo(false)" :disabled="busy || !edl.clips.length">
          {{ episode.data.seriesProduction ? '生成审核版' : '生成成片' }}
        </button>
      </div>
    </div>
    <p class="error" v-if="error">{{ error }}</p>
    <p v-if="notice">{{ notice }}</p>
    <div class="preview" :style="{ aspectRatio: `${edl.width}/${edl.height}` }">
      <template v-for="(c, i) in edl.clips" :key="i + '-' + c.assetId"
        ><img
          v-if="media(c.assetId, c.revision)?.data.mediaType === 'image'"
          v-show="i === activeIndex"
          :src="assetUrl(c.assetId, c.revision)"
          alt="图片镜头" /><video
          v-else-if="Math.abs(i - activeIndex) <= 1"
          v-show="i === activeIndex"
          :ref="mediaBinding('v' + i)"
          :src="assetUrl(c.assetId, c.revision)"
          preload="metadata"
          playsinline
          @loadedmetadata="sync"
        ></video></template
      ><span v-if="!edl.clips.length">选择已采用素材开始剪辑</span>
    </div>
    <audio
      v-for="(c, i) in edl.audio"
      :key="i + '-' + c.assetId"
      :ref="mediaBinding('a' + i)"
      :src="assetUrl(c.assetId, c.revision)"
      preload="metadata"
    ></audio>
    <div class="playback">
      <button @click="play">{{ playing ? '暂停' : '播放' }}</button
      ><input
        type="range"
        min="0"
        :max="total || 1"
        step="0.01"
        v-model.number="position"
        @input="sync"
      /><span>{{ position.toFixed(2) }} / {{ total.toFixed(2) }}s</span>
    </div>
    <div class="form-grid">
      <label>画布宽<input type="number" step="2" v-model.number="edl.width" /></label
      ><label>画布高<input type="number" step="2" v-model.number="edl.height" /></label>
    </div>
    <p v-if="edl.schemaVersion === 2">
      帧时间线 · {{ Math.round(total * 24) }} 帧 · 入点和出点按 1/24
      秒填写；保存时拒绝非整帧区间。图片放大不改变原始生成分辨率。
    </p>
    <button
      v-else
      @click="
        stop();
        edl.schemaVersion = 2;
        for (const c of [...edl.clips, ...edl.audio]) {
          c.in = Math.ceil(c.in * 24) / 24;
          c.out = Math.floor(c.out * 24) / 24;
        }
        for (const c of edl.audio) c.start = Math.round(c.start * 24) / 24;
      "
    >
      创建整帧时间线草稿（入点向内取整，需重新检查时长）
    </button>
    <div class="timeline-track">
      <div v-for="(c, i) in edl.clips" class="timeline-block" :style="{ flex: clipDuration(c) }">
        {{ i + 1 }} · {{ media(c.assetId)?.data.name
        }}<small>{{ clipDuration(c).toFixed(2) }}s</small>
      </div>
    </div>
    <AssemblyReview
      v-if="episode.data.seriesProduction && saved"
      :edl-id="saved.id"
      :episode="episode"
      @refresh="emit('refresh')"
      @play="
        (window) => {
          const { dependencies: _deps, ...fixed } = saved!.data;
          const { dependencies: _local, ...current } = edl as any;
          if (JSON.stringify(current) !== JSON.stringify(fixed)) {
            error = '先保存时间线，再按固定区间审核';
            return;
          }
          stop();
          position = window.startFrame / 24;
          playEnd = window.endFrame / 24;
          play();
        }
      "
    />
    <div v-if="episode.data.seriesProduction">
      <RecordPicker
        :project-id="episode.projectId"
        kind="dialogue_take"
        label="采用对白素材（需要静音重叠原声）"
        @select="
          async (r) => {
            const take = await api(`/records/${r.id}/versions/${r.revision}`);
            edl.audio.push({
              assetId: take.data.asset.id,
              revision: take.data.asset.revision,
              in: take.data.in,
              out: take.data.out,
              start: 0,
              volume: 1,
              dialogueTake: { id: r.id, revision: r.revision },
              originalAudio: 'muted',
              lipSyncReviewed: false,
            });
          }
        "
      /><ContractField label="声音轨对白绑定与口型审核" v-model="edl.audio" />
    </div>
    <h3>视频轨</h3>
    <div class="clip-row" v-for="(c, i) in edl.clips" :key="i">
      <label v-if="episode.data.seriesProduction"
        >内容用途<select v-model="c.role">
          <option value="story">正片</option>
          <option value="intro">片头</option>
          <option value="outro">片尾</option>
          <option value="recap">回顾</option>
        </select></label
      ><span>{{ i + 1 }}. {{ media(c.assetId)?.data.name }} · v{{ c.revision }}</span
      ><template v-if="edl.schemaVersion === 2"
        ><label
          >入点帧<input
            type="number"
            min="0"
            step="1"
            :value="Math.round(c.in * 24)"
            @input="c.in = ($event.target as HTMLInputElement).valueAsNumber / 24" /></label
        ><label
          >出点帧<input
            type="number"
            min="1"
            step="1"
            :value="Math.round(c.out * 24)"
            @input="
              c.out = ($event.target as HTMLInputElement).valueAsNumber / 24
            " /></label></template
      ><template v-else
        ><label>入点<input type="number" min="0" step="0.01" v-model.number="c.in" /></label
        ><label>出点<input type="number" step="0.01" v-model.number="c.out" /></label></template
      ><label
        >音量<input type="number" min="0" max="1" step="0.1" v-model.number="c.volume" /></label
      ><button
        :disabled="i === 0"
        @click="
          stop();
          [edl.clips[i - 1], edl.clips[i]] = [edl.clips[i], edl.clips[i - 1]];
        "
      >
        上移</button
      ><button
        @click="
          stop();
          edl.clips.splice(i, 1);
        "
      >
        移除
      </button>
      <template v-if="edl.schemaVersion === 2"
        ><label
          >淡入帧<input type="number" min="0" step="1" v-model.number="c.fadeInFrames" /></label
        ><label
          >淡出帧<input type="number" min="0" step="1" v-model.number="c.fadeOutFrames" /></label
      ></template>
    </div>
    <select
      @change="
        add(($event.target as HTMLSelectElement).value);
        ($event.target as HTMLSelectElement).value = '';
      "
    >
      <option value="">＋ 添加已采用视频或图片</option>
      <option
        v-for="a in assets.filter((a) => a.data.adopted && a.data.mediaType !== 'audio')"
        :value="a.id"
      >
        {{ a.data.name }}
      </option>
    </select>
    <h3>外部音轨</h3>
    <div class="clip-row" v-for="(c, i) in edl.audio">
      <span>{{ media(c.assetId)?.data.name }}</span
      ><template v-if="edl.schemaVersion === 2"
        ><label
          >开始帧<input
            type="number"
            min="0"
            step="1"
            :value="Math.round(c.start * 24)"
            @input="c.start = ($event.target as HTMLInputElement).valueAsNumber / 24" /></label
        ><label
          >入点帧<input
            type="number"
            min="0"
            step="1"
            :value="Math.round(c.in * 24)"
            @input="c.in = ($event.target as HTMLInputElement).valueAsNumber / 24" /></label
        ><label
          >出点帧<input
            type="number"
            min="1"
            step="1"
            :value="Math.round(c.out * 24)"
            @input="
              c.out = ($event.target as HTMLInputElement).valueAsNumber / 24
            " /></label></template
      ><template v-else
        ><label>开始<input type="number" min="0" step="0.01" v-model.number="c.start" /></label
        ><label>入点<input type="number" min="0" step="0.01" v-model.number="c.in" /></label
        ><label>出点<input type="number" step="0.01" v-model.number="c.out" /></label></template
      ><label
        >音量<input type="number" min="0" max="1" step="0.1" v-model.number="c.volume" /></label
      ><button
        @click="
          stop();
          edl.audio.splice(i, 1);
        "
      >
        移除
      </button>
      <template v-if="edl.schemaVersion === 2"
        ><label
          >淡入帧<input type="number" min="0" step="1" v-model.number="c.fadeInFrames" /></label
        ><label
          >淡出帧<input type="number" min="0" step="1" v-model.number="c.fadeOutFrames" /></label
      ></template>
    </div>
    <select
      @change="
        add(($event.target as HTMLSelectElement).value, true);
        ($event.target as HTMLSelectElement).value = '';
      "
    >
      <option value="">＋ 添加已采用音频</option>
      <option
        v-for="a in assets.filter(
          (a) => a.data.adopted && (a.data.mediaType === 'audio' || a.data.hasAudio),
        )"
        :value="a.id"
      >
        {{ a.data.name }}
      </option>
    </select>
    <p class="muted">
      音量设为 0 即静音；片段硬切，按顺序拼接；图片时长由出点指定。复杂转场和字幕暂不启用。
    </p>
  </section>
</template>
