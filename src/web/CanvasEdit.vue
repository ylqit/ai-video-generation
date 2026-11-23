<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { RecordDoc, EditDecisionList } from '../shared/contracts';
import type { CanvasContent } from '../shared/canvas';
import { timelineMap, edlSchema } from '../shared/edit-timeline';
import { api, assetUrl } from './api';
import TimelinePlayback from './TimelinePlayback.vue';
import VisualTransitions from './VisualTransitions.vue';
import InteractiveTimeline from './InteractiveTimeline.vue';
import MediaPreview from './MediaPreview.vue';
import { editTimeline, type TimelineCommand } from '../shared/timeline-editing';
const props = defineProps<{
  canvas: RecordDoc;
  content: CanvasContent;
  snapshot: any;
  dirty: boolean;
  pendingClip?: string;
}>();
const emit = defineEmits(['refresh', 'save-canvas', 'clip-added']);
const edl = ref<EditDecisionList>({
  schemaVersion: 3,
  episodeId: '',
  width: 1280,
  height: 720,
  fps: 24,
  clips: [],
  audio: [],
  overlays: [],
});
const frame = ref(0),
  playing = ref(false),
  changed = ref(false),
  busy = ref(false),
  error = ref(''),
  name = ref(localStorage.getItem('studio:edit-notes:' + props.canvas.id) || ''),
  timelineBase = ref(props.snapshot.edl?.revision || 0),
  timelineConflict = ref(false),
  notice = ref(''),
  exportKey = ref(crypto.randomUUID());
const localKey = 'studio:edit:' + props.canvas.id;
watch(name, (value) => localStorage.setItem('studio:edit-notes:' + props.canvas.id, value));
const map = computed(() => timelineMap(edl.value));
const available = computed(() => {
  const media = new Map(
    props.snapshot.assets.map((a: any) => [a.id + ':' + a.revision, a.data.mediaType]),
  );
  return props.content.nodes
    .filter((n) => n.asset)
    .map((n) => ({ ...n, mediaType: media.get(n.asset!.id + ':' + n.asset!.revision) }));
});
const output = computed(() =>
  props.snapshot.assets.filter(
    (a: any) =>
      a.data.category === 'export' && props.snapshot.jobs.some((j: any) => j.id === a.data.jobId),
  ),
);
watch(
  () => props.snapshot.edl?.revision || 0,
  (revision) => {
    if (changed.value) {
      timelineConflict.value = revision !== timelineBase.value;
      return;
    }
    edl.value = props.snapshot.edl
      ? JSON.parse(JSON.stringify(props.snapshot.edl.data))
      : { ...edl.value, episodeId: props.content.episodeId || '' };
    timelineBase.value = revision;
    const local = localStorage.getItem(localKey);
    if (local) {
      try {
        const saved = JSON.parse(local);
        edl.value = saved.data;
        changed.value = true;
        timelineConflict.value = saved.base !== revision;
        notice.value = '已恢复本机剪辑草稿';
      } catch {
        error.value = '剪辑草稿无法读取，服务端时间线保留';
      }
    }
  },
  { immediate: true },
);
watch(
  () => props.pendingClip,
  (id) => {
    if (!id) return;
    const node = props.content.nodes.find((n) => n.id === id);
    if (node) add(node);
    emit('clip-added');
  },
  { immediate: true },
);
function change() {
  changed.value = true;
  exportKey.value = crypto.randomUUID();
  localStorage.setItem(localKey, JSON.stringify({ base: timelineBase.value, data: edl.value }));
}
function reloadTimeline() {
  edl.value = JSON.parse(
    JSON.stringify(
      props.snapshot.edl?.data || { ...edl.value, clips: [], audio: [], overlays: [] },
    ),
  );
  timelineBase.value = props.snapshot.edl?.revision || 0;
  changed.value = false;
  timelineConflict.value = false;
  localStorage.removeItem(localKey);
}
function add(node: any) {
  const asset = props.snapshot.assets.find(
    (a: any) => a.id === node.asset.id && a.revision === node.asset.revision,
  );
  if (!asset) return;
  const out =
    node.range?.out ||
    (asset.data.mediaType === 'image'
      ? 3
      : asset.data.mediaType === 'audio'
        ? asset.data.duration
        : Math.floor(asset.data.duration * 24) / 24);
  const part = {
    assetId: asset.id,
    revision: node.asset.revision,
    in: node.range?.in || 0,
    out,
    volume: 1,
  };
  if (asset.data.mediaType === 'audio') {
    const rate = Number(asset.data.streams?.find((s: any) => s.type === 'audio')?.sampleRate);
    edl.value.audio.push({
      ...part,
      start: frame.value / 24,
      ...(rate > 0
        ? {
            in: Math.round(part.in * rate) / rate,
            out: Math.round(part.out * rate) / rate,
            sampleRange: {
              sampleRate: rate,
              inSample: Math.round(part.in * rate),
              outSample: Math.round(part.out * rate),
            },
          }
        : {}),
    });
  } else edl.value.clips.push({ ...part, id: crypto.randomUUID() });
  change();
}
function command(value: TimelineCommand) {
  try {
    const result = editTimeline(edl.value, value, props.snapshot.assets);
    edl.value = result.edl;
    notice.value = result.notices.join('；');
    error.value = '';
    playing.value = false;
    frame.value = Math.max(0, Math.min(frame.value, timelineMap(result.edl).frames - 1));
    change();
  } catch (e: any) {
    error.value = e.message;
  }
}
function move(i: number, delta: number) {
  const j = i + delta;
  if (j < 0 || j >= edl.value.clips.length) return;
  command({ action: 'reorder', index: i, to: j });
}
function subtitle() {
  edl.value.overlays ||= [];
  edl.value.overlays.push({
    id: crypto.randomUUID(),
    text: '字幕',
    sourceDialogueId: null,
    startFrame: frame.value,
    endFrame: Math.min(frame.value + 72, map.value.frames),
    position: 'bottom',
    fontSize: 36,
    color: '#ffffff',
  });
  change();
}
async function save() {
  if (timelineConflict.value) throw new Error('服务端剪辑已变化，草稿已保留。请先比较版本。');
  const fresh = await api('/canvases/' + props.canvas.id);
  if ((fresh.edl?.revision || 0) !== timelineBase.value) throw new Error('剪辑版本冲突');
  const data = edlSchema.parse(edl.value);
  const saved = await api(`/canvases/${props.canvas.id}/timeline`, 'PUT', {
    revision: fresh.canvas.revision,
    data,
  });
  timelineBase.value = saved.revision;
  changed.value = false;
  localStorage.removeItem(localKey);
  emit('refresh');
}
async function perform(fn: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await fn();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function exportNow() {
  await perform(async () => {
    if (changed.value || !timelineBase.value) await save();
    const fresh = await api('/canvases/' + props.canvas.id);
    if ((fresh.edl?.revision || 0) !== timelineBase.value)
      throw new Error('剪辑版本冲突，请核对当前固定版本');
    await api(`/canvases/${props.canvas.id}/export`, 'POST', {
      revision: fresh.canvas.revision,
      edl: fresh.canvas.data.edl,
      idempotencyKey: exportKey.value,
    });
    emit('refresh');
  });
}
async function finalize(asset: any) {
  await perform(async () => {
    await api(`/canvases/${props.canvas.id}/finalize`, 'POST', {
      revision: props.canvas.revision,
      asset: { id: asset.id, revision: asset.revision },
    });
    emit('refresh');
  });
}
</script>
<template>
  <div class="edit-workspace">
    <aside class="edit-bin">
      <h3>可用素材</h3>
      <p class="field-hint">直接加入视频、静态图片或独立音轨。</p>
      <button v-for="n in available" :key="n.id" class="edit-bin-item" @click="add(n)">
        <img
          v-if="n.mediaType === 'image'"
          :src="assetUrl(n.asset!.id, n.asset!.revision)"
          alt=""
        /><span v-else>{{ n.mediaType === 'video' ? '▷' : '♫' }}</span
        ><strong>{{ n.title }}</strong
        ><small>＋ 加入{{ n.mediaType === 'audio' ? '音轨' : '时间线' }}</small>
      </button>
    </aside>
    <main class="edit-main">
      <header>
        <h2>剪辑与导出</h2>
        <div class="button-row">
          <button :disabled="busy || !edl.clips.length" @click="perform(save)">保存剪辑</button
          ><button class="primary" :disabled="busy || !edl.clips.length" @click="exportNow">
            导出 MP4
          </button>
        </div>
      </header>
      <p v-if="error" class="inline-error">{{ error }}</p>
      <p v-if="notice" class="workspace-notice">{{ notice }}</p>
      <div v-if="timelineConflict" class="workspace-notice">
        服务端剪辑已更新。本机草稿保留，尚未覆盖任何版本。
        <details>
          <summary>比较服务端剪辑</summary>
          <pre>{{ snapshot.edl?.data }}</pre>
        </details>
        <button @click="reloadTimeline">载入服务端版本</button>
      </div>
      <div class="edit-player">
        <TimelinePlayback
          v-if="edl.clips.length"
          :edl="edl"
          :assets="snapshot.assets"
          :frame="frame"
          :playing="playing"
          @frame="frame = $event"
          @end="playing = false"
          @error="error = $event"
        />
        <div v-else class="quiet-empty">从左侧加入素材，开始剪辑。</div>
      </div>
      <div class="playback-controls">
        <button :disabled="!edl.clips.length" @click="playing = !playing">
          {{ playing ? '暂停' : '播放' }}</button
        ><input
          aria-label="播放位置"
          type="range"
          min="0"
          :max="Math.max(0, map.frames - 1)"
          v-model.number="frame"
        /><span>{{ (frame / 24).toFixed(2) }} / {{ (map.frames / 24).toFixed(2) }} 秒</span>
      </div>
      <InteractiveTimeline
        :edl="edl"
        :assets="snapshot.assets"
        :frame="frame"
        @update="
          edl = $event;
          frame = Math.max(0, Math.min(frame, timelineMap(edl).frames - 1));
          error = '';
          change();
        "
        @frame="frame = $event"
        @pause="playing = false"
        @notice="notice = $event"
        @error="error = $event"
      />
      <section class="clip-properties">
        <h3>画面片段</h3>
        <div v-for="(c, i) in edl.clips" :key="c.id" class="clip-row">
          <strong>{{ i + 1 }}</strong
          ><label
            >入点帧<input
              type="number"
              :value="Math.round(c.in * 24)"
              @change="
                command({
                  action: 'trim',
                  track: 'clips',
                  index: i,
                  boundary: 'in',
                  seconds: Number(($event.target as HTMLInputElement).value) / 24,
                })
              " /></label
          ><label
            >出点帧<input
              type="number"
              :value="Math.round(c.out * 24)"
              @change="
                command({
                  action: 'trim',
                  track: 'clips',
                  index: i,
                  boundary: 'out',
                  seconds: Number(($event.target as HTMLInputElement).value) / 24,
                })
              " /></label
          ><label
            >原声音量<input
              type="number"
              min="0"
              max="1"
              step=".1"
              v-model.number="c.volume"
              @input="change" /></label
          ><button @click="move(i, -1)" :disabled="!i" title="前移">←</button
          ><button @click="move(i, 1)" :disabled="i === edl.clips.length - 1" title="后移">→</button
          ><button
            @click="
              edl.clips.splice(i, 1);
              change();
            "
          >
            移除
          </button>
        </div>
      </section>
      <div @input="change" @change="change"><VisualTransitions v-model="edl" /></div>
      <details class="panel" :open="edl.audio.length > 0">
        <summary>独立音轨 · J / L 剪辑与声音包络</summary>
        <div v-for="(a, i) in edl.audio" :key="i" class="clip-row">
          <strong>{{ i + 1 }}</strong
          ><label
            >时间线起点帧<input
              type="number"
              :value="a.start * 24"
              @change="
                command({
                  action: 'shift',
                  audio: [i],
                  subtitles: [],
                  deltaFrames:
                    Number(($event.target as HTMLInputElement).value) - Math.round(a.start * 24),
                })
              " /></label
          ><label
            >源入点秒<input
              type="number"
              step="any"
              :value="a.in"
              @change="
                command({
                  action: 'trim',
                  track: 'audio',
                  index: i,
                  boundary: 'in',
                  seconds: Number(($event.target as HTMLInputElement).value),
                })
              " /></label
          ><label
            >源出点秒<input
              type="number"
              step="any"
              :value="a.out"
              @change="
                command({
                  action: 'trim',
                  track: 'audio',
                  index: i,
                  boundary: 'out',
                  seconds: Number(($event.target as HTMLInputElement).value),
                })
              " /></label
          ><label
            >音量<input
              type="number"
              v-model.number="a.volume"
              min="0"
              max="1"
              step=".1"
              @input="change" /></label
          ><label
            >淡入帧<input
              type="number"
              v-model.number="a.fadeInFrames"
              min="0"
              @input="change" /></label
          ><label
            >淡出帧<input
              type="number"
              v-model.number="a.fadeOutFrames"
              min="0"
              @input="change" /></label
          ><button
            @click="
              edl.audio.splice(i, 1);
              change();
            "
          >
            移除
          </button>
        </div>
        <p>使用外部对白时，可将对应画面原声音量设为 0，避免对白叠加。</p>
      </details>
      <details class="panel">
        <summary>字幕与画布</summary>
        <div class="field-pair">
          <label>宽<input type="number" v-model.number="edl.width" @input="change" /></label
          ><label>高<input type="number" v-model.number="edl.height" @input="change" /></label>
        </div>
        <button :disabled="!map.frames" @click="subtitle">在当前位置加入字幕</button>
        <div v-for="(o, i) in edl.overlays" :key="o.id" class="clip-row">
          <input v-model="o.text" @input="change" aria-label="字幕文字" /><label
            >起点帧<input type="number" v-model.number="o.startFrame" @input="change" /></label
          ><label>终点帧<input type="number" v-model.number="o.endFrame" @input="change" /></label
          ><button
            @click="
              edl.overlays!.splice(i, 1);
              change();
            "
          >
            移除
          </button>
        </div>
      </details>
      <details class="panel">
        <summary>可选检查与问题记录</summary>
        <p>
          可检查裁剪、人物、动作接点、字幕、声音和剧情。未审看、未听审不会阻止导出，也不代表检查通过。
        </p>
        <textarea v-model="name" placeholder="个人问题记录（本机保存，不表示检查通过）" />
      </details>
      <section v-if="output.length" class="export-results">
        <h3>导出版本</h3>
        <article v-for="a in output" :key="a.id">
          <MediaPreview :asset="a" :type="a.data.mediaType" /><strong>{{ a.data.name }}</strong
          ><a :href="assetUrl(a.id, a.revision)" download>下载 MP4</a
          ><button @click="finalize(a)" :disabled="busy">标记定稿</button
          ><small v-if="canvas.data.finalized?.some((f: any) => f.asset.id === a.id)"
            >已固定作品版本 · 不代表质量认证</small
          >
        </article>
      </section>
    </main>
  </div>
</template>
