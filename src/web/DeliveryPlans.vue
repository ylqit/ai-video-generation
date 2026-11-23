<script setup lang="ts">
import VisualTransitions from './VisualTransitions.vue';
import { timelineMap } from '../shared/edit-timeline';
import { computed, onBeforeUnmount, ref, toRaw, watch } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { parseSrt } from '../shared/creation-media';
import { api, assetUrl } from './api';
import AssemblyReview from './AssemblyReview.vue';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['refresh']);
const mode = ref<'scope' | 'work'>('scope'),
  plans = ref<any[]>([]),
  view = ref<any>(null),
  draft = ref<any>(null);
const busy = ref(false),
  error = ref(''),
  watched = ref(false),
  listened = ref(false),
  played = ref(false),
  conclusion = ref('');
const reviewEdits = ref<any[]>([]),
  selectedEdit = ref(''),
  audioAsset = ref('');
const attempts = new Map<string, string>();
const run = computed(() => props.snapshot.run);
const episode = computed(() =>
  props.snapshot.episodes.find((e) => e.id === run.value?.data.episodeId),
);
const canon = ref<any>(null);
const output = computed(() => view.value?.assets.at(-1));
const frames = computed(() => (draft.value ? timelineMap(draft.value.edlDraft).frames : 0));
const dirty = computed(
  () =>
    !!view.value &&
    !!draft.value &&
    (JSON.stringify(draft.value.edlDraft) !== JSON.stringify(view.value.edl.data) ||
      JSON.stringify(draft.value.duration) !== JSON.stringify(view.value.plan.data.duration) ||
      JSON.stringify(draft.value.pendingChecks) !==
        JSON.stringify(view.value.plan.data.pendingChecks)),
);
const audioAssets = computed(() =>
  props.snapshot.assets.filter(
    (a) => a.data.adopted && (a.data.mediaType === 'audio' || a.data.hasAudio),
  ),
);
function key(body: unknown) {
  const digest = JSON.stringify(body);
  if (!attempts.has(digest)) attempts.set(digest, crypto.randomUUID());
  return attempts.get(digest)!;
}
async function perform(action: () => Promise<void>) {
  busy.value = true;
  error.value = '';
  try {
    await action();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
let loadTicket = 0;
onBeforeUnmount(() => loadTicket++);
async function load() {
  if (!run.value) return;
  const ticket = ++loadTicket,
    runId = run.value.id;
  const result = await api(`/creation-runs/${runId}`);
  if (ticket !== loadTicket || run.value?.id !== runId) return;
  plans.value = result.deliveryPlans || [];
  if (view.value) {
    const planId = view.value.plan.id;
    const next = await api(`/delivery-plans/${planId}`);
    if (ticket !== loadTicket || run.value?.id !== runId || view.value?.plan.id !== planId) return;
    if (
      next.basisDigest !== view.value.basisDigest ||
      JSON.stringify(next.assets) !== JSON.stringify(view.value.assets)
    ) {
      watched.value = false;
      listened.value = false;
      played.value = false;
      conclusion.value = '';
      canon.value = null;
    }
    view.value = next;
  }
}
async function prepare() {
  await perform(async () => {
    const scope = props.snapshot.scope;
    if (mode.value === 'scope' && !scope) throw new Error('请先保存执行范围');
    const query =
      mode.value === 'scope'
        ? `mode=scope&scopeId=${scope!.id}&scopeRevision=${scope!.revision}`
        : 'mode=work';
    draft.value = await api(`/creation-runs/${run.value!.id}/delivery-preview?${query}`);
    view.value = null;
    const edits = await api(`/creation-runs/${run.value!.id}/review-edits`);
    reviewEdits.value = edits.items || [];
  });
}
async function select(id: string) {
  loadTicket++;
  await perform(async () => {
    view.value = await api(`/delivery-plans/${id}`);
    draft.value = {
      target: view.value.plan.data.target,
      duration: structuredClone(toRaw(view.value.plan.data.duration)),
      edlDraft: structuredClone(toRaw(view.value.edl.data)),
      pendingChecks: [...view.value.plan.data.pendingChecks],
    };
    watched.value = false;
    listened.value = false;
    played.value = false;
    conclusion.value = '';
    canon.value = null;
  });
}
async function save() {
  await perform(async () => {
    const submittedDraft = JSON.stringify(draft.value),
      submitted = JSON.parse(submittedDraft),
      planRef = view.value ? { id: view.value.plan.id, revision: view.value.plan.revision } : null,
      runId = run.value!.id;
    const current = await api(`/creation-runs/${runId}`);
    if (run.value?.id !== runId || view.value?.plan.id !== planRef?.id) return;
    const base = {
      runRevision: current.run.revision,
      duration:
        submitted.duration.mode === 'derive'
          ? { mode: 'derive' }
          : submitted.duration.mode === 'exact'
            ? { mode: 'exact', seconds: submitted.duration.seconds }
            : {
                ...submitted.duration,
                tolerancePercent: submitted.duration.tolerancePercent ?? 5,
              },
      edlDraft: submitted.edlDraft,
      pendingChecks: submitted.pendingChecks,
    };
    const body = planRef
      ? { ...base, revision: planRef.revision }
      : { ...base, target: submitted.target };
    const plan = await api(
      planRef ? `/delivery-plans/${planRef.id}` : `/creation-runs/${runId}/delivery-plans`,
      planRef ? 'PUT' : 'POST',
      planRef ? body : { ...body, idempotencyKey: key(body) },
    );
    const saved = await api(`/delivery-plans/${plan.id}`);
    if (run.value?.id !== runId || view.value?.plan.id !== planRef?.id) return;
    view.value = saved;
    watched.value = false;
    listened.value = false;
    played.value = false;
    conclusion.value = '';
    canon.value = null;
    if (JSON.stringify(draft.value) === submittedDraft) {
      draft.value.edlDraft = structuredClone(toRaw(view.value.edl.data));
      draft.value.duration = structuredClone(toRaw(view.value.plan.data.duration));
      draft.value.pendingChecks = [...view.value.plan.data.pendingChecks];
    }
    await load();
    emit('refresh');
  });
}
async function exportPlan() {
  await perform(async () => {
    if (
      JSON.stringify(draft.value.edlDraft) !== JSON.stringify(view.value.edl.data) ||
      JSON.stringify(draft.value.duration) !== JSON.stringify(view.value.plan.data.duration) ||
      JSON.stringify(draft.value.pendingChecks) !==
        JSON.stringify(view.value.plan.data.pendingChecks)
    )
      throw new Error('请先保存后期修改');
    const body = { revision: view.value.plan.revision, basisDigest: view.value.basisDigest };
    await api(`/delivery-plans/${view.value.plan.id}/export`, 'POST', {
      ...body,
      idempotencyKey: key(body),
    });
    await load();
    emit('refresh');
  });
}
async function confirm() {
  if (busy.value || !view.value || view.value.validConfirmation || !output.value) return;
  await perform(async () => {
    if (dirty.value) throw new Error('请先保存修改并导出对应版本，再确认实际成片');
    const current = await api(`/creation-runs/${run.value!.id}`);
    const body = {
      revision: current.run.revision,
      planRef: { id: view.value.plan.id, revision: view.value.plan.revision },
      exportAsset: { id: output.value.id, revision: output.value.revision },
      watched: watched.value,
      listened: listened.value,
      conclusion: conclusion.value,
      ...(episode.value?.data.seriesProduction && view.value.plan.data.target.mode === 'work'
        ? { canon: canon.value }
        : {}),
    };
    await api(`/creation-runs/${run.value!.id}/final-confirmation`, 'POST', {
      ...body,
      idempotencyKey: key(body),
    });
    await load();
    emit('refresh');
  });
}
async function importSrt(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  await perform(async () => {
    draft.value.edlDraft.overlays = parseSrt(await file.text());
  });
}
function importEdit() {
  const edit = reviewEdits.value.find((e) => e.id === selectedEdit.value);
  if (!edit) return;
  const edl = edit.data.edl;
  draft.value.edlDraft.audio = structuredClone(toRaw(edl.audio));
  draft.value.edlDraft.overlays = structuredClone(toRaw(edl.overlays || []));
  draft.value.pendingChecks.push('已导入审看版声音和字幕，请逐项校对本次输出坐标');
}
function addAudio() {
  const asset = audioAssets.value.find((a) => a.id === audioAsset.value);
  if (!asset) return;
  draft.value.edlDraft.audio.push({
    assetId: asset.id,
    revision: asset.revision,
    in: 0,
    out: Math.min(Math.floor(asset.data.duration * 24), frames.value) / 24,
    start: 0,
    volume: 1,
  });
}
watch(
  () => run.value?.id,
  () => {
    view.value = null;
    draft.value = null;
    plans.value = [];
    watched.value = false;
    listened.value = false;
    played.value = false;
    conclusion.value = '';
    canon.value = null;
  },
);
watch(
  () => [
    run.value?.id,
    run.value?.revision,
    props.snapshot.jobs.map((j) => `${j.id}:${j.state}`).join('|'),
  ],
  () => void perform(load),
  { immediate: true },
);
</script>
<template>
  <VisualTransitions v-if="draft" v-model="draft.edlDraft" />
  <section
    v-if="run && snapshot.results.director"
    class="delivery-plans"
    aria-label="样片与整片交付"
  >
    <header>
      <h2>样片与整片交付</h2>
      <button :disabled="busy" @click="perform(load)">刷新</button>
    </header>
    <p>
      全片计划 {{ (snapshot.timing.totalFrames / 24).toFixed(2) }} 秒 · 本次范围
      {{ (snapshot.timing.requestedFrames / 24).toFixed(2) }} 秒
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="delivery-actions">
      <select v-model="mode">
        <option value="scope">当前范围样片</option>
        <option value="work">完整作品</option></select
      ><button :disabled="busy" @click="prepare">准备新的交付</button>
    </div>
    <button v-for="p in plans" :key="p.id" :disabled="busy" @click="select(p.id)">
      {{ p.data.target.mode === 'scope' ? '范围样片' : '完整作品' }} · 版本 {{ p.revision }} ·
      {{ p.id.slice(0, 8) }}
    </button>
    <template v-if="draft">
      <h3>{{ draft.target.mode === 'scope' ? '范围样片' : '完整作品' }}后期</h3>
      <p v-if="draft.missingGroups?.length" class="error">
        尚未采用：{{ draft.missingGroups.join('、') }}
      </p>
      <p>
        实际采用 {{ frames }} 帧 / {{ (frames / 24).toFixed(2) }} 秒。更改入出点会更新实际使用范围。
      </p>
      <label
        >交付时长<select v-model="draft.duration.mode">
          <option value="exact">精确</option>
          <option value="approximate">约定容差</option>
          <option value="derive">按采用推导</option>
        </select></label
      >
      <label v-if="draft.duration.mode !== 'derive'"
        >秒数<input v-model.number="draft.duration.seconds" type="number" min="0.1" step="0.1"
      /></label>
      <label v-if="draft.duration.mode === 'approximate'"
        >容差百分比<input
          v-model.number="draft.duration.tolerancePercent"
          type="number"
          min="0"
          max="50"
      /></label>
      <div v-for="(c, i) in draft.edlDraft.clips" :key="i">
        <span>视频 {{ Number(i) + 1 }} · {{ c.in.toFixed(2) }}–{{ c.out.toFixed(2) }} 秒</span
        ><label
          >原音音量<input v-model.number="c.volume" type="number" min="0" max="1" step="0.1"
        /></label>
      </div>
      <details>
        <summary>导入审看版的声音与字幕</summary>
        <select v-model="selectedEdit">
          <option value="">选择审看版</option>
          <option v-for="e in reviewEdits" :key="e.id" :value="e.id">
            {{ e.data.name }}
          </option></select
        ><button :disabled="!selectedEdit" @click="importEdit">导入并校对</button>
      </details>
      <h4>附加音轨</h4>
      <select v-model="audioAsset">
        <option value="">选择已采用声音</option>
        <option v-for="a in audioAssets" :key="a.id" :value="a.id">
          {{ a.data.name }}
        </option></select
      ><button :disabled="!audioAsset" @click="addAudio">添加音轨</button>
      <div v-for="(a, i) in draft.edlDraft.audio" :key="i">
        <audio controls :src="assetUrl(a.assetId, a.revision)" /><label
          >输出起点（秒）<input
            v-model.number="a.start"
            type="number"
            min="0"
            :step="1 / 24" /></label
        ><label>源入点<input v-model.number="a.in" type="number" min="0" :step="1 / 24" /></label
        ><label>源出点<input v-model.number="a.out" type="number" min="0" :step="1 / 24" /></label
        ><label
          >音量<input v-model.number="a.volume" type="number" min="0" max="1" step="0.1" /></label
        ><button @click="draft.edlDraft.audio.splice(i, 1)">移除音轨</button>
      </div>
      <h4>字幕</h4>
      <label>导入 SRT<input type="file" accept=".srt" @change="importSrt" /></label>
      <div v-for="(o, i) in draft.edlDraft.overlays" :key="o.id">
        <textarea v-model="o.text" /><label
          >起帧<input v-model.number="o.startFrame" type="number" min="0" /></label
        ><label>止帧<input v-model.number="o.endFrame" type="number" min="1" /></label
        ><button @click="draft.edlDraft.overlays.splice(i, 1)">移除字幕</button>
      </div>
      <p v-for="(check, i) in draft.pendingChecks" :key="check" class="error">
        {{ check }} <button @click="draft.pendingChecks.splice(i, 1)">已实际校对并处理</button>
      </p>
      <button :disabled="busy || !draft.edlDraft.clips.length" @click="save">
        保存后期与交付计划
      </button>
    </template>
    <template v-if="view">
      <AssemblyReview
        v-if="
          output &&
          (view?.edl.data.schemaVersion === 3 ||
            (episode?.data.seriesProduction && view.plan.data.target.mode === 'work'))
        "
        :key="`${view.plan.id}:${view.plan.revision}:${output.id}`"
        :edl-id="view.edl.id"
        :episode="episode"
        :fixed-export="{ id: output.id, revision: output.revision }"
        prepare-only
        @prepared="canon = $event.canon"
        @refresh="perform(load)"
      />
      <p v-for="blocker in view.blockers" :key="blocker" class="error">{{ blocker }}</p>
      <button :disabled="busy || view.blockers.length > 0" @click="exportPlan">导出这一版</button>
      <p v-for="j in view.exports" :key="j.id">导出状态：{{ j.state }} {{ j.error }}</p>
      <template v-if="output"
        ><video
          controls
          :src="assetUrl(output.id, output.revision)"
          @playing="played = true"
          @error="
            played = false;
            watched = false;
            listened = false;
          "
        /><a :href="assetUrl(output.id, output.revision)" download>下载这一版</a>
        <p v-if="view.validConfirmation">
          这一版已确认交付{{ view.plan.data.target.mode === 'scope' ? '；范围外制作继续保留' : '' }}
        </p>
        <form v-else @submit.prevent="confirm">
          <label
            ><input
              v-model="watched"
              type="checkbox"
              :disabled="!played"
            />已完整观看这一版画面与字幕</label
          ><label
            ><input
              v-model="listened"
              type="checkbox"
              :disabled="!played"
            />已核对对白、声音或明确的无声安排</label
          ><textarea v-model="conclusion" placeholder="可选观看备注；未检查不表示质量通过" /><button
            :disabled="busy || view.blockers.length > 0"
          >
            固定这一版作品
          </button>
        </form></template
      >
    </template>
  </section>
</template>
<style scoped>
.delivery-plans {
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  padding: 20px;
  border: 1px solid var(--border, #d6d9e0);
  border-radius: 12px;
  margin: 16px 0;
  display: grid;
  gap: 12px;
}
.delivery-plans header,
.delivery-actions {
  display: flex;
  gap: 12px;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
}
.delivery-plans > *,
.delivery-plans select {
  min-width: 0;
  max-width: 100%;
}
.delivery-plans input[type='checkbox'] {
  width: auto;
}
.delivery-plans label {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  margin: 6px;
}
.delivery-plans input[type='number'] {
  width: 100px;
}
.delivery-plans video {
  width: 100%;
  max-height: 420px;
}
.delivery-plans textarea {
  width: 100%;
  min-height: 60px;
}
.delivery-plans form {
  display: grid;
  gap: 12px;
}
</style>
