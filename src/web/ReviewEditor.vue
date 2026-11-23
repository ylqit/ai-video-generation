<script setup lang="ts">
import VisualTransitions from './VisualTransitions.vue';
import { timelineMap } from '../shared/edit-timeline';
import TimelinePlayback from './TimelinePlayback.vue';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import type { EditDecisionList, RecordDoc } from '../shared/contracts';
import { parseSrt, renderSrt } from '../shared/creation-media';
import { api, assetUrl } from './api';

const browserCrypto = globalThis.crypto;
const props = defineProps<{ snapshot: WorkspaceSnapshot; initialCandidate?: any }>();
const emit = defineEmits(['refresh', 'preview']);
const name = ref('候选审看编辑'),
  saved = ref<RecordDoc | null>(null),
  edits = ref<RecordDoc[]>([]),
  assets = ref<RecordDoc[]>([]),
  exportJobs = ref<any[]>([]),
  exportAssets = ref<RecordDoc[]>([]);
const edl = ref<EditDecisionList>({
  schemaVersion: 2,
  episodeId: props.snapshot.run?.data.episodeId || '',
  width: 1280,
  height: 720,
  fps: 24,
  clips: [],
  audio: [],
  overlays: [],
});
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  selected = ref(0),
  frame = ref(0),
  playing = ref(false),
  video = ref<HTMLVideoElement | null>(null),
  audioElements = ref<HTMLAudioElement[]>([]);
const mediaIssues = ref<any[]>([]);
const baseline = ref(''),
  picked = ref(''),
  pendingCandidate = ref<any>(null),
  waveform = ref<number[]>([]),
  waveformMessage = ref('选择声音以读取实际波形'),
  audioSelection = ref(-1),
  srtSource = ref('人工字幕'),
  issueText = ref(''),
  issueCategory = ref('audio');
const storageKey = computed(() => `studio-review-draft:${props.snapshot.run?.id}`);
const serialized = computed(() => JSON.stringify({ name: name.value, edl: edl.value }));
const dirty = computed(() => serialized.value !== baseline.value);
const clip = computed(() => edl.value.clips[selected.value]);
const allAssets = computed(() => [
  ...new Map(
    [
      ...props.snapshot.assets,
      ...props.snapshot.candidates.flatMap(
        (c) => [c.video, c.audio].filter(Boolean) as RecordDoc[],
      ),
      ...assets.value,
    ].map((a) => [`${a.id}:${a.revision}`, a]),
  ).values(),
]);
const currentAsset = computed(() =>
  clip.value
    ? allAssets.value.find((a) => a.id === clip.value.assetId && a.revision === clip.value.revision)
    : null,
);
const totalFrames = computed(() => timelineMap(edl.value).frames);
const offsets = computed(() => timelineMap(edl.value).clips.map((c) => c.startFrame));
const activeCues = computed(() =>
  (edl.value.overlays || []).filter((c) => c.startFrame <= frame.value && c.endFrame > frame.value),
);
const selectedAudio = computed(() => edl.value.audio[audioSelection.value]);
const waveformSource = computed(
  () => selectedAudio.value || (currentAsset.value?.data.hasAudio ? clip.value : undefined),
);
const exportState = computed(() =>
  exportJobs.value.filter((j) => saved.value && j.input.reviewEdit.id === saved.value.id),
);
let animation = 0,
  previousTime = 0,
  loading = true,
  disposed = false,
  waveformTicket = 0,
  loadTicket = 0;

async function load() {
  if (!props.snapshot.run) return;
  const ticket = ++loadTicket;
  try {
    const [list, media, issues] = await Promise.all([
      api(`/creation-runs/${props.snapshot.run.id}/review-edits`),
      api(`/projects/${props.snapshot.project.id}/records?kind=asset&limit=200&offset=0`),
      api(`/creation-runs/${props.snapshot.run.id}/media-issues`),
    ]);
    const mediaItems = [...media.items];
    for (let offset = media.items.length; offset < media.total; offset += 200) {
      if (ticket !== loadTicket) return;
      const page = await api(
        `/projects/${props.snapshot.project.id}/records?kind=asset&limit=200&offset=${offset}`,
      );
      mediaItems.push(...page.items);
      if (!page.items.length) break;
    }
    for (const source of [...edl.value.clips, ...edl.value.audio]) {
      if (
        !mediaItems.some(
          (a: RecordDoc) => a.id === source.assetId && a.revision === source.revision,
        )
      )
        mediaItems.push(await api(`/records/${source.assetId}?revision=${source.revision}`));
    }
    if (ticket !== loadTicket) return;
    mediaIssues.value = issues.items;
    edits.value = list.items;
    exportJobs.value = list.jobs || [];
    assets.value = mediaItems;
    const exports = await Promise.all(
      exportState.value
        .filter((j) => j.state === 'succeeded')
        .flatMap((j) => (j.output.assetIds || []).map((id: string) => api(`/records/${id}`))),
    );
    if (ticket === loadTicket) exportAssets.value = exports;
  } catch (e: any) {
    error.value = e.message;
  }
}
function addAsset(asset: RecordDoc, replace = false) {
  if (!asset) return;
  if (asset.data.mediaType === 'audio') {
    error.value = '纯声音素材请使用“添加声音”';
    return;
  }
  const rate = asset.data.streams
    ?.find((s: any) => s.type === 'video')
    ?.frameRate?.split('/')
    .map(Number);
  const sourceDuration =
    asset.data.frameCount && rate?.[0]
      ? (asset.data.frameCount * (rate[1] || 1)) / rate[0]
      : asset.data.duration;
  const duration = asset.data.mediaType === 'image' ? 3 : Math.floor(sourceDuration * 24) / 24;
  if (!(duration > 0)) {
    error.value = '素材实际时长不可用';
    return;
  }
  const value = {
    ...(edl.value.schemaVersion === 3
      ? { id: replace ? clip.value.id : browserCrypto.randomUUID() }
      : {}),
    assetId: asset.id,
    revision: asset.revision,
    in: 0,
    out: replace && clip.value ? Math.min(duration, clip.value.out - clip.value.in) : duration,
    volume: replace && clip.value ? clip.value.volume : 1,
  };
  if (
    !edl.value.clips.length &&
    asset.data.width >= 128 &&
    asset.data.height >= 128 &&
    asset.data.width <= 3840 &&
    asset.data.height <= 3840
  ) {
    edl.value.width = Math.floor(asset.data.width / 2) * 2;
    edl.value.height = Math.floor(asset.data.height / 2) * 2;
  }
  if (replace && clip.value) edl.value.clips.splice(selected.value, 1, value);
  else {
    edl.value.clips.push(value);
    selected.value = edl.value.clips.length - 1;
  }
  seek(offsets.value[selected.value]);
}
function initial(value: any) {
  const candidate = value?.candidate || value;
  if (!candidate?.video) return;
  addAsset(candidate.video);
  if (value.frame !== undefined) seek(offsets.value[selected.value] + Number(value.frame));
}
async function openEdit(edit: RecordDoc) {
  stop();
  saved.value = edit;
  name.value = edit.data.name;
  edl.value = JSON.parse(JSON.stringify(edit.data.edl));
  selected.value = 0;
  frame.value = 0;
  baseline.value = JSON.stringify({ name: edit.data.name, edl: edit.data.edl });
  localStorage.removeItem(storageKey.value);
  for (const source of edit.data.sourceRefs)
    if (!allAssets.value.some((a) => a.id === source.id && a.revision === source.revision)) {
      try {
        assets.value.push(await api(`/records/${source.id}?revision=${source.revision}`));
      } catch (e: any) {
        error.value = e.message;
      }
    }
  await load();
}
function stop() {
  playing.value = false;
  video.value?.pause();
  audioElements.value.forEach((a) => a?.pause());
}
async function seek(target: number) {
  previousTime = performance.now();
  frame.value = Math.max(0, Math.min(Math.max(0, totalFrames.value - 1), Math.round(target)));
  selected.value = Math.max(
    0,
    offsets.value.findIndex(
      (start, i) =>
        frame.value >= start && frame.value < (offsets.value[i + 1] ?? totalFrames.value),
    ),
  );
  await nextTick();
  if (video.value && clip.value) {
    video.value.currentTime = clip.value.in + (frame.value - offsets.value[selected.value]) / 24;
    video.value.volume = clip.value.volume;
  }
  if (edl.value.schemaVersion !== 3) syncAudio(true);
}
function syncAudio(force = false) {
  audioElements.value.forEach((element, i) => {
    const track = edl.value.audio[i];
    if (!element || !track) return;
    const offset = frame.value / 24 - track.start,
      active = offset >= 0 && offset < track.out - track.in;
    element.volume = track.volume;
    if (!active) {
      element.pause();
      return;
    }
    const time = track.in + offset;
    if (force || Math.abs(element.currentTime - time) > 0.12) element.currentTime = time;
    if (playing.value)
      void element.play().catch((e) => {
        error.value = e.message;
        stop();
      });
    else element.pause();
  });
}
async function play() {
  if (!clip.value) return;
  if (playing.value) {
    stop();
    return;
  }
  if (frame.value >= totalFrames.value - 1) await seek(0);
  playing.value = true;
  previousTime = performance.now();
  await seek(frame.value);
  if (edl.value.schemaVersion === 3) return;
  if (video.value)
    await video.value.play().catch((e) => {
      error.value = e.message;
      stop();
    });
  syncAudio(true);
}
function tick(now: number) {
  if (playing.value && clip.value && edl.value.schemaVersion !== 3) {
    const next =
      video.value && currentAsset.value?.data.mediaType === 'video'
        ? offsets.value[selected.value] + Math.floor((video.value.currentTime - clip.value.in) * 24)
        : frame.value + Math.floor(((now - previousTime) * 24) / 1000 + 1e-7);
    if (video.value && currentAsset.value?.data.mediaType === 'video') previousTime = now;
    else if (next !== frame.value) previousTime += ((next - frame.value) * 1000) / 24;
    const end = offsets.value[selected.value] + Math.round((clip.value.out - clip.value.in) * 24);
    if (next >= end || video.value?.ended) {
      if (selected.value === edl.value.clips.length - 1) {
        frame.value = totalFrames.value - 1;
        stop();
      } else
        void seek(end)
          .then(() => video.value?.play())
          .catch((e) => {
            error.value = e.message;
            stop();
          });
    } else frame.value = Math.max(offsets.value[selected.value], next);
    syncAudio();
  }
  animation = requestAnimationFrame(tick);
}
function reorder(direction: number) {
  const destination = selected.value + direction;
  if (destination < 0 || destination >= edl.value.clips.length) return;
  const [value] = edl.value.clips.splice(selected.value, 1);
  edl.value.clips.splice(destination, 0, value);
  selected.value = destination;
  void seek(offsets.value[destination]);
}
function split() {
  if (!clip.value) return;
  if (
    edl.value.schemaVersion === 3 &&
    (clip.value.transition ||
      edl.value.clips[selected.value + 1]?.transition ||
      clip.value.visualFadeInFrames ||
      clip.value.visualFadeOutFrames)
  ) {
    error.value = '分割前先移除涉及该片段的画面转场，再按新边界设置';
    return;
  }
  const point = clip.value.in + (frame.value - offsets.value[selected.value]) / 24;
  if (point <= clip.value.in || point >= clip.value.out) {
    error.value = '请将播放头移到片段内部再分割';
    return;
  }
  edl.value.clips.splice(
    selected.value,
    1,
    { ...clip.value, out: point },
    currentAsset.value?.data.mediaType === 'image'
      ? {
          ...clip.value,
          ...(edl.value.schemaVersion === 3 ? { id: browserCrypto.randomUUID() } : {}),
          in: 0,
          out: clip.value.out - point,
        }
      : {
          ...clip.value,
          ...(edl.value.schemaVersion === 3 ? { id: browserCrypto.randomUUID() } : {}),
          in: point,
        },
  );
}
function setFrame(target: any, key: string, event: Event) {
  stop();
  target[key] = Number((event.target as HTMLInputElement).value) / 24;
}
function addAudio(asset: RecordDoc) {
  if (!asset) return;
  if (asset.data.mediaType !== 'audio' && !asset.data.hasAudio) {
    error.value = '所选素材没有可用声音';
    return;
  }
  edl.value.audio.push({
    assetId: asset.id,
    revision: asset.revision,
    in: 0,
    out: Math.floor(asset.data.duration * 24) / 24,
    start: frame.value / 24,
    volume: 1,
  });
  audioSelection.value = edl.value.audio.length - 1;
}
async function readWaveform() {
  const ticket = ++waveformTicket,
    track = waveformSource.value;
  waveform.value = [];
  if (!track) return;
  waveformMessage.value = '正在读取实际声音波形…';
  const context = new AudioContext();
  try {
    const response = await fetch(assetUrl(track.assetId, track.revision));
    if (!response.ok) throw new Error('声音文件读取失败');
    const buffer = await context.decodeAudioData(await response.arrayBuffer()),
      channel = buffer.getChannelData(0),
      size = Math.max(1, Math.ceil(channel.length / 160));
    const values = Array.from({ length: 160 }, (_, index) => {
      let peak = 0;
      for (let n = index * size; n < Math.min(channel.length, (index + 1) * size); n++)
        peak = Math.max(peak, Math.abs(channel[n]));
      return peak;
    });
    if (ticket === waveformTicket) {
      waveform.value = values;
      waveformMessage.value = `实际声音 · ${buffer.duration.toFixed(2)} 秒`;
    }
  } catch (e: any) {
    if (ticket === waveformTicket) waveformMessage.value = `浏览器无法解码波形：${e.message}`;
  } finally {
    await context.close();
  }
}
async function importMedia(event: Event) {
  const files = (event.target as HTMLInputElement).files;
  if (!files?.length) return;
  busy.value = true;
  try {
    const body = new FormData();
    Array.from(files).forEach((file) => body.append('files', file));
    const imported = await api(`/projects/${props.snapshot.project.id}/assets`, 'POST', body);
    assets.value.push(...imported);
    for (const asset of imported)
      asset.data.mediaType === 'audio' ? addAudio(asset) : addAsset(asset);
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function importSrt(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try {
    const cues = parseSrt(await file.text());
    if (cues.some((c) => c.endFrame > totalFrames.value))
      throw new Error('字幕超出当前剪辑时长，请先补齐片段或修正字幕时间');
    edl.value.overlays = cues;
    srtSource.value = `导入 ${file.name} · 待人工听辨核对`;
  } catch (e: any) {
    error.value = e.message;
  }
}
function downloadSrt() {
  try {
    const url = URL.createObjectURL(
        new Blob([renderSrt(edl.value.overlays || [])], { type: 'application/x-subrip' }),
      ),
      link = document.createElement('a');
    link.href = url;
    link.download = `${name.value}.srt`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e: any) {
    error.value = e.message;
  }
}
async function save() {
  if (!props.snapshot.run || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const submittedSerialization = serialized.value;
    const submitted = JSON.parse(submittedSerialization);
    const body = {
      name: submitted.name,
      edl: submitted.edl,
      ...(saved.value
        ? { revision: saved.value.revision }
        : { runRevision: props.snapshot.run.revision }),
    };
    saved.value = await api(
      saved.value
        ? `/review-edits/${saved.value.id}`
        : `/creation-runs/${props.snapshot.run.id}/review-edits`,
      saved.value ? 'PUT' : 'POST',
      body,
    );
    if (serialized.value === submittedSerialization) {
      name.value = saved.value!.data.name;
      edl.value = JSON.parse(JSON.stringify(saved.value!.data.edl));
    }
    baseline.value = JSON.stringify({ name: saved.value!.data.name, edl: saved.value!.data.edl });
    if (dirty.value)
      localStorage.setItem(
        storageKey.value,
        JSON.stringify({
          saved: saved.value,
          name: name.value,
          edl: edl.value,
          baseline: baseline.value,
        }),
      );
    else localStorage.removeItem(storageKey.value);
    notice.value = dirty.value ? '本次提交已保存；之后的修改仍未保存' : '审看编辑已保存';
    await load();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function exportMovie() {
  if (!saved.value || dirty.value) {
    error.value = '请先保存当前编辑，再导出准确版本';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    await api(`/review-edits/${saved.value.id}/export`, 'POST', {
      revision: saved.value.revision,
      idempotencyKey: crypto.randomUUID(),
    });
    await load();
    notice.value = '审看导出已进入本机媒体队列';
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function reportIssue() {
  if (!currentAsset.value || !props.snapshot.run || !issueText.value.trim()) return;
  try {
    await api(`/creation-runs/${props.snapshot.run.id}/media-issues`, 'POST', {
      object: { id: currentAsset.value.id, revision: currentAsset.value.revision },
      ...(currentAsset.value.data.jobId ? { jobId: currentAsset.value.data.jobId } : {}),
      category: issueCategory.value,
      description: issueText.value,
      evidence: 'user',
      ...(currentAsset.value.data.mediaType === 'video'
        ? {
            startFrame:
              Math.round(clip.value.in * 24) + frame.value - offsets.value[selected.value],
          }
        : {}),
    });
    issueText.value = '';
    notice.value = '问题已记录到当前素材固定版本';
    await load();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) {
    event.preventDefault();
    event.returnValue = '';
  }
}
watch(serialized, () => {
  if (!loading && dirty.value)
    localStorage.setItem(
      storageKey.value,
      JSON.stringify({
        saved: saved.value,
        name: name.value,
        edl: edl.value,
        baseline: baseline.value,
      }),
    );
});
watch(
  () => props.snapshot.jobs.map((j) => `${j.id}:${j.state}`).join('|'),
  () => void load(),
);
watch(
  () => props.initialCandidate,
  (value) => {
    if (!value) return;
    if (dirty.value && edl.value.clips.length) pendingCandidate.value = value;
    else initial(value);
  },
);
watch(
  () => edl.value.clips.map((c) => `${c.assetId}:${c.revision}:${c.in}:${c.out}`).join('|'),
  () => {
    stop();
    void seek(Math.min(frame.value, Math.max(0, totalFrames.value - 1)));
  },
);
watch(
  () =>
    waveformSource.value ? `${waveformSource.value.assetId}:${waveformSource.value.revision}` : '',
  () => void readWaveform(),
);
watch(
  () => clip.value?.volume,
  (volume) => {
    if (video.value && volume !== undefined) video.value.volume = volume;
  },
);
onMounted(async () => {
  const initialDraft = serialized.value;
  baseline.value = initialDraft;
  await load();
  if (disposed) return;
  const local = localStorage.getItem(storageKey.value);
  if (serialized.value !== initialDraft) notice.value = '已保留加载期间的编辑';
  else if (local) {
    try {
      const draft = JSON.parse(local);
      saved.value = draft.saved;
      name.value = draft.name;
      edl.value = draft.edl;
      baseline.value = draft.baseline;
      notice.value = '已恢复本机未保存编辑';
    } catch {
      error.value = '本机草稿无法读取';
    }
  } else if (props.initialCandidate) initial(props.initialCandidate);
  else if (edits.value.length) await openEdit(edits.value.at(-1)!);
  if (local) await load();
  if (disposed) return;
  loading = false;
  if (dirty.value)
    localStorage.setItem(
      storageKey.value,
      JSON.stringify({
        saved: saved.value,
        name: name.value,
        edl: edl.value,
        baseline: baseline.value,
      }),
    );
  window.addEventListener('beforeunload', beforeUnload);
  animation = requestAnimationFrame(tick);
});
onBeforeUnmount(() => {
  disposed = true;
  if (dirty.value)
    localStorage.setItem(
      storageKey.value,
      JSON.stringify({
        saved: saved.value,
        name: name.value,
        edl: edl.value,
        baseline: baseline.value,
      }),
    );
  stop();
  cancelAnimationFrame(animation);
  waveformTicket++;
  loadTicket++;
  window.removeEventListener('beforeunload', beforeUnload);
});
</script>

<template>
  <section class="review-editor">
    <header class="review-header">
      <div>
        <small>REVIEW EDIT</small>
        <h2>
          审看编辑 <span>{{ dirty ? '未保存' : saved ? `v${saved.revision}` : '新编辑' }}</span>
        </h2>
      </div>
      <button :disabled="busy || !edl.clips.length" @click="save">保存编辑</button
      ><button class="primary" :disabled="busy || dirty || !saved" @click="exportMovie">
        导出审看视频
      </button>
    </header>
    <p class="review-note">
      候选可以直接剪辑。审看导出保留准确素材版本和原声来源，供实际观看与核对。
    </p>
    <div v-if="!snapshot.run" class="empty">先创建作品，再添加审看编辑。</div>
    <template v-else>
      <div class="edit-name">
        <input v-model="name" aria-label="审看编辑名称" /><select
          :value="saved?.id || ''"
          :disabled="busy || (dirty && edl.clips.length > 0)"
          @change="
            openEdit(edits.find((e) => e.id === ($event.target as HTMLSelectElement).value)!)
          "
        >
          <option value="" disabled>打开已保存编辑</option>
          <option v-for="edit in edits" :key="edit.id" :value="edit.id">
            {{ edit.data.name }} · v{{ edit.revision }}
          </option></select
        ><button
          @click="
            save().then(() => {
              if (!dirty) {
                saved = null;
                name = '新的审看编辑';
                edl.clips = [];
                edl.audio = [];
                edl.overlays = [];
              }
            })
          "
          :disabled="busy"
        >
          另建编辑
        </button>
      </div>
      <div class="edit-name" aria-label="审看输出规格">
        <label
          >输出宽度
          <input
            v-model.number="edl.width"
            aria-label="审看输出宽度"
            type="number"
            min="128"
            max="3840"
            step="2"
            :disabled="busy"
        /></label>
        <label
          >输出高度
          <input
            v-model.number="edl.height"
            aria-label="审看输出高度"
            type="number"
            min="128"
            max="3840"
            step="2"
            :disabled="busy"
        /></label>
        <span>24 fps · 画面等比适配，留边补齐</span>
      </div>
      <p v-if="pendingCandidate" class="notice">
        收到新的候选，当前编辑已保留。<button
          @click="
            initial(pendingCandidate);
            pendingCandidate = null;
          "
        >
          加入当前剪辑
        </button>
      </p>
      <VisualTransitions v-model="edl" />
      <TimelinePlayback
        v-if="edl.schemaVersion === 3"
        :edl="edl"
        :assets="allAssets"
        :frame="frame"
        :playing="playing"
        @frame="
          frame = $event;
          selected = Math.max(
            0,
            offsets.findLastIndex((s) => s <= frame),
          );
        "
        @end="stop"
        @error="
          error = $event;
          stop();
        "
      />
      <div class="review-stage">
        <div
          v-if="edl.schemaVersion !== 3"
          class="monitor"
          :style="{ aspectRatio: `${edl.width}/${edl.height}` }"
        >
          <video
            v-if="currentAsset?.data.mediaType === 'video'"
            ref="video"
            :key="`${currentAsset.id}:${selected}`"
            :src="assetUrl(currentAsset.id, currentAsset.revision)"
            playsinline
            preload="auto"
            @loadedmetadata="seek(frame)"
            @click="play"
          />
          <img
            v-else-if="currentAsset?.data.mediaType === 'image'"
            :src="assetUrl(currentAsset.id, currentAsset.revision)"
          />
          <p v-else>从下方候选或素材库加入第一个片段</p>
          <div
            v-for="cue in activeCues"
            :key="cue.id"
            class="subtitle-preview"
            :class="cue.position"
            :style="{ color: cue.color, fontSize: `${(cue.fontSize / edl.height) * 100}cqh` }"
          >
            {{ cue.text }}
          </div>
          <span class="monitor-badge">审看编辑 · {{ (frame / 24).toFixed(2) }}s</span>
        </div>
        <div class="transport">
          <button :disabled="!clip" @click="play">{{ playing ? '暂停' : '播放' }}</button
          ><button
            @click="
              stop();
              seek(frame - 1);
            "
          >
            −1 帧</button
          ><input
            type="range"
            min="0"
            :max="Math.max(0, totalFrames - 1)"
            :value="frame"
            aria-label="剪辑播放头"
            @input="
              stop();
              seek(Number(($event.target as HTMLInputElement).value));
            "
          /><button
            @click="
              stop();
              seek(frame + 1);
            "
          >
            +1 帧</button
          ><span>{{ frame }} / {{ totalFrames }} 帧</span>
        </div>
      </div>
      <div class="asset-strip">
        <button
          v-for="candidate in snapshot.candidates.filter((c) => c.video)"
          :key="candidate.id"
          @click="addAsset(candidate.video!)"
        >
          <video
            :src="assetUrl(candidate.video!.id, candidate.video!.revision)"
            muted
            preload="metadata"
          /><span>＋ {{ candidate.label }}</span
          ><small>v{{ candidate.video!.revision }}</small>
        </button>
      </div>
      <div class="add-controls">
        <select v-model="picked" aria-label="固定版本素材">
          <option value="">选择项目素材</option>
          <option
            v-for="asset in allAssets"
            :key="`${asset.id}:${asset.revision}`"
            :value="`${asset.id}:${asset.revision}`"
          >
            {{ asset.data.name }} · {{ asset.data.mediaType }} · v{{ asset.revision }}
          </option></select
        ><button
          :disabled="!picked"
          @click="addAsset(allAssets.find((a) => `${a.id}:${a.revision}` === picked)!)"
        >
          添加画面</button
        ><button
          :disabled="!picked || !clip"
          @click="
            addAsset(
              allAssets.find((a) => `${a.id}:${a.revision}` === picked)!,
              true,
            )
          "
        >
          替换选中片段</button
        ><button
          :disabled="!picked"
          @click="addAudio(allAssets.find((a) => `${a.id}:${a.revision}` === picked)!)"
        >
          添加声音</button
        ><label class="file-button"
          >导入素材<input
            type="file"
            multiple
            accept="video/*,audio/*,image/*"
            @change="importMedia"
        /></label>
      </div>
      <div class="timeline-clips">
        <button
          v-for="(item, index) in edl.clips"
          :key="index"
          :class="{ active: selected === index }"
          :style="{ flexGrow: item.out - item.in }"
          @click="
            stop();
            seek(offsets[index]);
          "
        >
          <strong
            >{{ index + 1 }} ·
            {{
              allAssets.find((a) => a.id === item.assetId && a.revision === item.revision)?.data
                .name || '固定素材'
            }}</strong
          ><small
            >{{ Math.round((item.out - item.in) * 24) }} 帧 · 原声
            {{ Math.round(item.volume * 100) }}%</small
          >
        </button>
      </div>
      <div v-if="clip" class="clip-controls">
        <label
          >入点（帧）<input
            type="number"
            min="0"
            :value="Math.round(clip.in * 24)"
            @change="setFrame(clip, 'in', $event)" /></label
        ><label
          >出点（帧）<input
            type="number"
            min="1"
            :value="Math.round(clip.out * 24)"
            @change="setFrame(clip, 'out', $event)" /></label
        ><label
          >原声音量<input
            v-model.number="clip.volume"
            type="range"
            min="0"
            max="1"
            step="0.01" /></label
        ><button @click="clip.volume = clip.volume ? 0 : 1">
          {{ clip.volume ? '静音' : '恢复原声' }}</button
        ><button @click="reorder(-1)">前移</button><button @click="reorder(1)">后移</button
        ><button @click="split">播放头处分割</button
        ><button
          @click="
            stop();
            edl.clips.splice(selected, 1);
            selected = Math.max(0, selected - 1);
            seek(offsets[selected] || 0);
          "
        >
          移除片段
        </button>
      </div>
      <details open class="editor-section">
        <summary>声音轨道 · 原声由画面素材直接保留</summary>
        <p v-if="!edl.audio.length">可添加项目声音、从视频选择音轨，或导入本机音频。</p>
        <div
          v-for="(track, index) in edl.audio"
          :key="`${track.assetId}:${index}`"
          class="audio-track"
          :class="{ active: audioSelection === index }"
          @click="audioSelection = index"
        >
          <audio
            v-if="edl.schemaVersion !== 3"
            :ref="
              (el) => {
                audioElements[index] = el as HTMLAudioElement;
              }
            "
            :src="assetUrl(track.assetId, track.revision)"
            preload="metadata"
          /><strong
            >{{ allAssets.find((a) => a.id === track.assetId)?.data.name || '声音' }} · v{{
              track.revision
            }}</strong
          ><label
            >入点帧<input
              type="number"
              min="0"
              :value="Math.round(track.in * 24)"
              @change="setFrame(track, 'in', $event)" /></label
          ><label
            >出点帧<input
              type="number"
              :value="Math.round(track.out * 24)"
              @change="setFrame(track, 'out', $event)" /></label
          ><label
            >开始帧<input
              type="number"
              min="0"
              :value="Math.round(track.start * 24)"
              @change="setFrame(track, 'start', $event)" /></label
          ><label
            >音量<input
              v-model.number="track.volume"
              type="range"
              min="0"
              max="1"
              step="0.01" /></label
          ><button
            @click.stop="
              stop();
              edl.audio.splice(index, 1);
            "
          >
            移除
          </button>
        </div>
        <div class="waveform" v-if="waveform.length">
          <i
            v-for="(peak, index) in waveform"
            :key="index"
            :style="{ height: `${Math.max(1, peak * 100)}%` }"
          ></i>
        </div>
        <small>{{ waveformMessage }}</small>
      </details>
      <details open class="editor-section">
        <summary>字幕与画面文字</summary>
        <div class="subtitle-tools">
          <label class="file-button"
            >导入 SRT<input type="file" accept=".srt" @change="importSrt" /></label
          ><button
            @click="
              edl.overlays!.push({
                id: browserCrypto.randomUUID(),
                text: '新字幕',
                sourceDialogueId: null,
                startFrame: frame,
                endFrame: Math.min(totalFrames, frame + 48),
                position: 'bottom',
                fontSize: 32,
                color: '#ffffff',
              })
            "
            :disabled="!totalFrames"
          >
            添加字幕</button
          ><button @click="downloadSrt">下载 SRT</button
          ><small>{{ srtSource }}。未配置离线识别，字幕需人工听辨核对。</small>
        </div>
        <div
          v-for="(cue, index) in edl.overlays"
          :key="cue.id"
          class="subtitle-row"
          :class="{ current: activeCues.includes(cue) }"
        >
          <button
            @click="
              stop();
              seek(cue.startFrame);
            "
          >
            定位 {{ index + 1 }}</button
          ><textarea v-model="cue.text" rows="2" aria-label="字幕正文" /><label
            >开始帧<input v-model.number="cue.startFrame" type="number" min="0" /></label
          ><label>结束帧<input v-model.number="cue.endFrame" type="number" min="1" /></label
          ><select v-model="cue.position" aria-label="字幕位置">
            <option value="top">顶部</option>
            <option value="center">居中</option>
            <option value="bottom">底部</option></select
          ><label
            >字号<input v-model.number="cue.fontSize" type="number" min="12" max="160" /></label
          ><input v-model="cue.color" type="color" aria-label="字幕颜色" /><button
            @click="edl.overlays!.splice(index, 1)"
          >
            删除
          </button>
        </div>
      </details>
      <details class="editor-section">
        <summary>记录候选问题</summary>
        <div class="issue-form">
          <select v-model="issueCategory">
            <option value="audio">声音 / 对白</option>
            <option value="identity">主体一致性</option>
            <option value="action">动作</option>
            <option value="space">空间关系</option>
            <option value="style">画面风格</option>
            <option value="subtitle">字幕</option></select
          ><textarea v-model="issueText" placeholder="描述当前帧实际发现的问题" /><button
            :disabled="!issueText.trim() || !currentAsset"
            @click="reportIssue"
          >
            记录到素材版本
          </button>
        </div>
        <p
          v-for="issue in mediaIssues.filter(
            (i) =>
              i.data.object.id === currentAsset?.id &&
              i.data.object.revision === currentAsset?.revision,
          )"
          :key="issue.id"
        >
          {{ issue.data.category }} · {{ issue.data.description }}
          <small>v{{ issue.data.object.revision }} · {{ issue.data.evidence }}</small
          ><button
            v-if="issue.data.startFrame !== undefined && clip"
            @click="
              stop();
              seek(offsets[selected] + issue.data.startFrame - Math.round(clip.in * 24));
            "
          >
            定位问题帧
          </button>
        </p>
      </details>
      <div v-if="exportState.length" class="editor-section">
        <h3>实际审看导出</h3>
        <p v-for="job in exportState" :key="job.id">
          编辑 v{{ job.input.reviewEdit.revision }} ·
          {{
            {
              queued: '等待导出',
              running: '正在渲染',
              succeeded: '已完成',
              failed: '导出失败',
              cancelled: '已取消',
            }[job.state as string] || job.state
          }}
          <span v-if="job.error" class="error">{{ job.error }}</span>
        </p>
        <article v-for="asset in exportAssets" :key="asset.id" class="export-result">
          <video controls :src="assetUrl(asset.id, asset.revision)" preload="metadata" /><a
            :href="assetUrl(asset.id, asset.revision)"
            download
            >下载 {{ asset.data.name }}</a
          ><small>实际导出 · v{{ asset.revision }}</small>
        </article>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </template>
  </section>
</template>

<style scoped>
.review-editor {
  padding: 24px;
  max-width: 1500px;
  margin: auto;
}
.review-header,
.edit-name,
.transport,
.add-controls,
.clip-controls,
.subtitle-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.review-header > div {
  margin-right: auto;
}
.review-header small {
  font-size: 9px;
  color: #a39dbb;
  letter-spacing: 1.6px;
}
.review-header h2 {
  font-size: 20px;
  margin: 8px 0;
}
.review-header h2 span {
  font-size: 10px;
  font-weight: 400;
  color: #aaa7ba;
}
.review-note {
  font-size: 11px;
  color: #8f92a3;
  margin: 8px 0 22px;
}
.edit-name {
  margin-bottom: 18px;
}
.edit-name > input {
  flex: 1;
  min-width: 160px;
}
.review-stage {
  max-width: 920px;
  margin: 0 auto 22px;
}
.monitor {
  background: #151721;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  container-type: size;
  border-radius: 10px;
  color: #9f9dac;
}
.monitor video,
.monitor img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.monitor-badge {
  position: absolute;
  top: 12px;
  left: 12px;
  padding: 5px 8px;
  font-size: 9px;
  background: #141722a8;
  border-radius: 5px;
  color: #ddd;
}
.subtitle-preview {
  position: absolute;
  left: 4%;
  right: 4%;
  text-align: center;
  white-space: pre-wrap;
  text-shadow: 1px 1px 3px #000;
  pointer-events: none;
}
.subtitle-preview.bottom {
  bottom: 6%;
}
.subtitle-preview.top {
  top: 6%;
}
.subtitle-preview.center {
  top: 50%;
  transform: translateY(-50%);
}
.transport {
  margin-top: 10px;
  font-size: 10px;
}
.transport input {
  flex: 1;
  min-width: 90px;
}
.transport button {
  font-size: 10px;
}
.asset-strip {
  display: flex;
  gap: 10px;
  overflow: auto;
  margin: 16px 0;
}
.asset-strip > button {
  padding: 0;
  flex: 0 0 140px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}
.asset-strip video {
  width: 140px;
  height: 75px;
  object-fit: cover;
  background: #222;
}
.asset-strip span,
.asset-strip small {
  padding: 6px 9px;
  font-size: 10px;
}
.asset-strip small {
  padding-top: 0;
  color: #aaa;
}
.add-controls {
  margin: 20px 0 14px;
  font-size: 11px;
}
.add-controls select {
  max-width: 290px;
}
.file-button {
  position: relative;
  background: white;
  border: 1px solid var(--line);
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 11px;
  cursor: pointer;
  overflow: hidden;
}
.file-button input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}
.timeline-clips {
  display: flex;
  gap: 6px;
  overflow: auto;
  padding: 10px;
  background: #f1f1f8;
  border-radius: 8px;
  min-height: 85px;
}
.timeline-clips button {
  min-width: 110px;
  max-width: 420px;
  text-align: left;
  padding: 13px;
  background: #e8e5f3;
  border-color: transparent;
  overflow: hidden;
}
.timeline-clips button.active {
  border-color: #9b8fd1;
  background: #dfd9f0;
}
.timeline-clips strong,
.timeline-clips small {
  display: block;
  font-size: 10px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.timeline-clips small {
  margin-top: 8px;
  color: #9690aa;
}
.clip-controls {
  margin: 14px 0 24px;
}
.clip-controls label,
.audio-track label,
.subtitle-row label {
  font-size: 10px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  color: #9793a6;
}
.clip-controls input[type='number'],
.audio-track input[type='number'],
.subtitle-row input[type='number'] {
  width: 85px;
}
.clip-controls input[type='range'] {
  width: 95px;
}
.clip-controls button {
  font-size: 10px;
}
.editor-section {
  padding: 18px 0;
  border-top: 1px solid var(--line);
  font-size: 11px;
}
.editor-section summary {
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  margin-bottom: 16px;
}
.editor-section p,
.editor-section small {
  color: #9294a5;
}
.audio-track {
  display: flex;
  align-items: center;
  gap: 9px;
  flex-wrap: wrap;
  padding: 10px 6px;
  margin: 7px 0;
  border-radius: 5px;
}
.audio-track.active {
  background: #f3f1fb;
}
.audio-track strong {
  flex: 1;
  min-width: 120px;
  font-size: 11px;
}
.audio-track input[type='range'] {
  width: 80px;
}
.waveform {
  height: 62px;
  display: flex;
  align-items: center;
  gap: 1px;
  background: #f4f2fa;
  border-radius: 5px;
  padding: 6px;
  margin: 12px 0 7px;
}
.waveform i {
  display: block;
  flex: 1;
  background: #b4a5d4;
}
.subtitle-row {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-top: 10px;
  padding: 8px;
  border-radius: 6px;
}
.subtitle-row.current {
  background: #f0ecfa;
}
.subtitle-row textarea {
  flex: 1;
  min-width: 170px;
  font-size: 12px;
}
.subtitle-row input[type='color'] {
  width: 35px;
  height: 30px;
  padding: 2px;
}
.subtitle-row button,
.subtitle-row select {
  font-size: 10px;
}
.subtitle-tools {
  margin-bottom: 14px;
}
.issue-form {
  display: flex;
  gap: 10px;
  align-items: center;
  flex-wrap: wrap;
}
.issue-form textarea {
  flex: 1;
  min-width: 200px;
}
.export-result {
  display: inline-flex;
  flex-direction: column;
  gap: 9px;
  width: 300px;
  margin: 0 12px 14px 0;
}
.export-result video {
  width: 100%;
  border-radius: 6px;
  background: #151721;
}
.export-result a {
  font-size: 11px;
}
.notice {
  font-size: 11px;
  color: #81749e;
}
.review-editor button {
  white-space: nowrap;
}
@media (max-width: 800px) {
  .review-editor {
    padding: 14px;
  }
  .review-header h2 {
    font-size: 17px;
  }
  .monitor {
    min-height: 180px;
  }
  .add-controls select {
    max-width: 100%;
    width: 100%;
  }
  .subtitle-row textarea {
    flex-basis: 100%;
  }
  .clip-controls {
    gap: 8px;
  }
  .transport span {
    display: none;
  }
}
</style>
