<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import type { WorkspaceSnapshot, WorkspaceLayout } from '../shared/workspace';
import { executionTextFields } from '../shared/execution-text';
import { api, assetUrl } from './api';
import ResourceCanvas from './ResourceCanvas.vue';
import StoryboardView from './StoryboardView.vue';
import ContentPreview from './ContentPreview.vue';
import AuthoringEditor from './AuthoringEditor.vue';
import MediaLibrary from './MediaLibrary.vue';
import AssistantPanel from './AssistantPanel.vue';
import HandoffPanel from './HandoffPanel.vue';
import ReviewEditor from './ReviewEditor.vue';
import DeliveryPlans from './DeliveryPlans.vue';
import CreationVersions from './CreationVersions.vue';
import ReferenceConfirmation from './ReferenceConfirmation.vue';
import JobInspection from './JobInspection.vue';
import ProjectTools from './ProjectTools.vue';
const props = defineProps<{
  project: RecordDoc;
  version: number;
  initialAction?: { action: string; value: any } | null;
}>();
const emit = defineEmits(['projects', 'actionOpened']);
const snapshot = ref<WorkspaceSnapshot | null>(null),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  runId = ref(''),
  episodeId = ref('');
const view = ref<'canvas' | 'storyboard' | 'timeline'>('canvas'),
  layout = ref<WorkspaceLayout>({
    positions: {},
    view: 'canvas',
    assistantWidth: 400,
    assistantCollapsed: false,
    filters: {},
  });
const preview = ref<any>(null),
  previewCandidate = ref(''),
  previewFocus = ref<any>(null),
  editing = ref<any>(null),
  handoff = ref<any>(null),
  binding = ref<any>(null),
  boundAsset = ref<any>(null),
  inspected = ref(false),
  bindingNote = ref('');
const discussionRefs = ref<any[]>([]),
  tasksOpen = ref(false),
  jobDetail = ref(''),
  showSeries = ref(false),
  toolsTab = ref('profile'),
  candidateForEdit = ref<any>(null);
const scopeForm = ref<any>(null),
  scopeWording = ref<any[]>([]),
  wordingReviewed = ref(false),
  executionPreview = ref<any>(null),
  scopeOutput = ref({ width: 1280, height: 736, steps: 20, seed: 0 });
const run = computed(() => snapshot.value?.run),
  activeJobs = computed(
    () => snapshot.value?.jobs.filter((j) => !['succeeded', 'cancelled'].includes(j.state)) || [],
  );
const stateNames: Record<string, string> = {
  active: '准备继续',
  working: '创作中',
  awaiting_approval: '待审稿',
  needs_revision: '需要修订',
  waiting: '等待处理',
  awaiting_assets: '准备素材',
  awaiting_production_approval: '待生成确认',
  generating: '生成中',
  awaiting_review: '待审 · 未正式采用',
  exporting: '导出中',
  export_failed: '导出待恢复',
  awaiting_final_confirmation: '等待最终确认',
  complete: '已确认交付',
  paused: '已暂停',
};
const rangeText = computed(() => {
  const windows = snapshot.value?.scope?.data.windows || [];
  return windows.length
    ? `${Math.min(...windows.map((w) => w.startFrame)) / 24}–${Math.max(...windows.map((w) => w.endFrame)) / 24} 秒`
    : '待选择';
});
let ticket = 0,
  loadedLayout = false,
  layoutSaving = false,
  layoutPending = false,
  disposed = false;
async function refresh() {
  const seq = ++ticket;
  try {
    const data = await api<WorkspaceSnapshot>(
      `/projects/${props.project.id}/workspace?` +
        new URLSearchParams({ runId: runId.value, episodeId: episodeId.value }),
    );
    if (seq !== ticket || disposed) return;
    snapshot.value = data;
    if (!loadedLayout) {
      layout.value = structuredClone(data.layout.data);
      if (matchMedia('(max-width:1199px)').matches) layout.value.assistantCollapsed = true;
      view.value = layout.value.view;
      loadedLayout = true;
    }
    if (!runId.value && data.run) runId.value = data.run.id;
    if (props.initialAction) {
      const { action, value } = props.initialAction;
      emit('actionOpened');
      if (action === 'bind') bindFromPreview(value);
      else if (action === 'discuss') await discuss(value);
      else if (action === 'inspect') jobDetail.value = value;
      else if (action === 'reviewEdit' || action === 'review') timeline(value);
    }
  } catch (e: any) {
    if (seq === ticket) error.value = e.message;
  }
}
watch(
  () => props.version,
  () => void refresh(),
);
watch(runId, () => void refresh());
watch(episodeId, () => {
  runId.value = '';
  snapshot.value = null;
  editing.value = preview.value = handoff.value = binding.value = null;
  discussionRefs.value = [];
  candidateForEdit.value = null;
  void refresh();
});
void refresh();
async function act(fn: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await fn();
    await refresh();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function saveLayout() {
  if (layoutSaving) {
    layoutPending = true;
    return;
  }
  if (!snapshot.value) return;
  layoutSaving = true;
  try {
    const saved = await api(`/projects/${props.project.id}/workspace-layout`, 'PUT', {
      revision: snapshot.value.layout.revision,
      layout: layout.value,
    });
    snapshot.value.layout = saved;
  } catch (e: any) {
    error.value = '布局未保存：' + e.message;
  } finally {
    layoutSaving = false;
    if (layoutPending) {
      layoutPending = false;
      void saveLayout();
    }
  }
}
function switchView(next: 'canvas' | 'storyboard' | 'timeline') {
  view.value = next;
  layout.value.view = next;
  void saveLayout();
}
function positions(value: any) {
  layout.value.positions = value;
  void saveLayout();
}
function collapseAssistant() {
  layout.value.assistantCollapsed = !layout.value.assistantCollapsed;
  void saveLayout();
}
function resizeAssistant(event: PointerEvent) {
  const element = event.currentTarget as HTMLElement;
  const start = event.clientX,
    width = layout.value.assistantWidth;
  element.setPointerCapture(event.pointerId);
  const move = (e: PointerEvent) =>
    (layout.value.assistantWidth = Math.max(340, Math.min(560, width + start - e.clientX)));
  const end = () => {
    element.removeEventListener('pointermove', move);
    element.removeEventListener('pointerup', end);
    void saveLayout();
  };
  element.addEventListener('pointermove', move);
  element.addEventListener('pointerup', end, { once: true });
}
async function recordFor(value: any) {
  const ref = value.record || value;
  if (ref.data) return ref;
  if (!ref.id) return null;
  return api(`/records/${ref.id}${ref.revision ? '?revision=' + ref.revision : ''}`);
}
async function openCard(card: any) {
  if (card.type === 'candidate') {
    previewCandidate.value = card.id;
    preview.value = snapshot.value?.candidates.find((c) => c.id === card.id)?.video || { data: {} };
    return;
  }
  if (card.type === 'requirement') {
    handoff.value = snapshot.value?.requirements.find(
      (r) => r.id === card.id || `requirement:${r.id}` === card.id,
    );
    return;
  }
  previewFocus.value = ['subject', 'scene', 'shot'].includes(card.type)
    ? { type: card.type, id: card.id.slice(card.type.length + 1) }
    : null;
  await act(async () => {
    preview.value = await recordFor(card.asset || card.record || card);
    previewCandidate.value = '';
  });
}
async function discuss(value: any) {
  await act(async () => {
    const record = await recordFor(value.record || value);
    if (!record) return;
    const ref = {
      id: record.id,
      revision: record.revision,
      title:
        value.title ||
        record.data.result?.title ||
        record.data.name ||
        record.data.title ||
        '所选内容',
      ...(value.shotId ? { shotId: value.shotId } : {}),
      ...(value.subjectKey ? { subjectKey: value.subjectKey } : {}),
      ...(value.type === 'shot' ? { shotId: value.shotIds[0] } : {}),
      ...(value.sceneId || value.type === 'scene'
        ? { sceneId: value.sceneId || value.id.slice('scene:'.length) }
        : {}),
    };
    if (
      !discussionRefs.value.some(
        (r) =>
          r.id === ref.id &&
          r.revision === ref.revision &&
          r.shotId === ref.shotId &&
          r.sceneId === ref.sceneId &&
          r.subjectKey === ref.subjectKey,
      )
    )
      discussionRefs.value.push(ref);
    layout.value.assistantCollapsed = false;
    preview.value = null;
  });
}
function openCandidate(id: string) {
  previewCandidate.value = id;
  preview.value = snapshot.value?.candidates.find((c) => c.id === id)?.video || { data: {} };
}
function chooseScope(ids: string[]) {
  scopeForm.value = { name: '本次制作范围', mode: 'selection', shotIds: [...ids], groupIds: [] };
  scopeOutput.value = { ...(snapshot.value?.scope?.data.output || scopeOutput.value) };
  const existing = snapshot.value?.scope?.data.executionText?.entries || [];
  scopeWording.value = executionTextFields(
    Object.fromEntries(
      Object.entries(snapshot.value?.results || {}).map(([stage, doc]) => [
        stage,
        doc!.data.result,
      ]),
    ),
  )
    .filter((field) => /[\u3400-\u9fff]/.test(field.source))
    .map((field) => ({
      ...field,
      text:
        existing.find((entry) => entry.path === field.path && entry.source === field.source)
          ?.text || '',
    }));
  wordingReviewed.value = false;
}
async function saveScope() {
  await act(async () => {
    if (scopeWording.value.some((entry) => entry.text.trim()) && !wordingReviewed.value)
      throw new Error('请核对执行文案与原意一致后保存范围');
    await api(`/creation-runs/${run.value!.id}/scopes`, 'POST', {
      runRevision: run.value!.revision,
      ...scopeForm.value,
      output: scopeOutput.value,
      ...(scopeWording.value.some((entry) => entry.text.trim())
        ? {
            executionText: {
              reviewed: wordingReviewed.value,
              entries: scopeWording.value
                .filter((entry) => entry.text.trim())
                .map(({ path, source, text }) => ({ path, source, text })),
            },
          }
        : {}),
      activate: true,
    });
    scopeForm.value = null;
    notice.value = '本次制作范围已固定，尚未创建生成任务。';
  });
}
async function prepare() {
  await act(async () => {
    const scope = snapshot.value!.scope!;
    executionPreview.value = await api(`/creation-scopes/${scope.id}/preview`, 'POST', {
      revision: scope.revision,
      runRevision: run.value!.revision,
    });
  });
}
async function submit() {
  await act(async () => {
    const scope = snapshot.value!.scope!;
    await api(`/creation-scopes/${scope.id}/submit`, 'POST', {
      revision: scope.revision,
      runRevision: run.value!.revision,
      digest: executionPreview.value.preview.digest,
      idempotencyKey: crypto.randomUUID(),
    });
    executionPreview.value = null;
    notice.value = '执行请求已进入统一任务队列。';
  });
}
async function approve(result: any) {
  await act(() =>
    api(`/creation-runs/${run.value!.id}/approve`, 'POST', {
      result: { id: result.id, revision: result.revision },
      idempotencyKey: crypto.randomUUID(),
    }),
  );
}
const bindingAttempts = new Map<string, string>();
async function saveBinding() {
  await act(async () => {
    if (!inspected.value || !['image', 'audio'].includes(boundAsset.value?.data.mediaType))
      throw new Error('请实际审看图片或听审音频后，再绑定参考用途');
    const body = {
      runRevision: run.value!.revision,
      items: [
        {
          requirementId: binding.value.id,
          asset: { id: boundAsset.value.id, revision: boundAsset.value.revision },
          inspected: inspected.value,
          conclusion: bindingNote.value,
        },
      ],
    };
    const digest = JSON.stringify(body);
    if (!bindingAttempts.has(digest)) bindingAttempts.set(digest, crypto.randomUUID());
    await api(`/creation-runs/${run.value!.id}/reference-confirmations`, 'POST', {
      ...body,
      idempotencyKey: bindingAttempts.get(digest),
    });
    binding.value = null;
    boundAsset.value = null;
    inspected.value = false;
    bindingNote.value = '';
  });
}
function bindFromPreview(asset: any) {
  preview.value = null;
  boundAsset.value = asset;
  binding.value = { id: '' };
}
function timeline(candidate: any) {
  candidateForEdit.value = candidate;
  preview.value = null;
  switchView('timeline');
}
onBeforeUnmount(() => {
  disposed = true;
  ticket++;
});
</script>

<template>
  <main v-if="snapshot" class="work-studio">
    <header class="work-header">
      <div class="work-title">
        <button class="icon-button" @click="$emit('projects')" aria-label="返回项目">←</button>
        <div>
          <h1>{{ project.data.title }}</h1>
          <span
            >完整作品 {{ snapshot.timing.totalFrames / 24 }} 秒 <i>·</i> 本次 {{ rangeText }}
            <i>·</i> 请求 {{ snapshot.timing.requestedFrames / 24 }} 秒</span
          >
        </div>
      </div>
      <div class="work-status">
        <span class="status-tag review">{{ stateNames[run?.data.state] || '待开始创作' }}</span
        ><span class="allowance"
          >剩余 {{ snapshot.allowance.remainingGenerations }} 次 /
          {{ snapshot.allowance.remainingSeconds }} 秒</span
        ><button
          @click="
            toolsTab = project.data.mode === 'series' ? 'series' : 'profile';
            showSeries = true;
          "
        >
          项目内容</button
        ><button
          v-if="run"
          :disabled="busy"
          @click="
            act(() =>
              api(`/creation-runs/${run!.id}/pause`, 'POST', {
                revision: run!.revision,
                paused: !run!.data.paused,
              }),
            )
          "
        >
          {{ run.data.paused ? '恢复' : '暂停' }}
        </button>
      </div>
    </header>
    <nav class="work-tabs" aria-label="作品视图">
      <div class="view-tabs">
        <button
          v-for="[id, label] in [
            ['canvas', '资源画布'],
            ['storyboard', '分镜'],
            ['timeline', '时间线'],
          ]"
          :key="id"
          :class="{ active: view === id }"
          @click="switchView(id as any)"
        >
          {{ label }}
        </button>
      </div>
      <div class="toolbar">
        <select v-if="project.data.mode === 'series'" v-model="episodeId" aria-label="选择分集">
          <option value="">选择分集</option>
          <option v-for="episode in snapshot.episodes" :key="episode.id" :value="episode.id">
            {{ episode.data.title }}
          </option></select
        ><button
          v-if="view === 'timeline' && run"
          @click="
            toolsTab = 'formal';
            showSeries = true;
          "
        >
          正式装配</button
        ><button v-if="snapshot.scope" :disabled="busy" @click="prepare">生成预览</button
        ><button @click="collapseAssistant">
          {{ layout.assistantCollapsed ? '打开创作助手' : '收起助手' }}
        </button>
      </div>
    </nav>
    <div v-if="error" class="work-banner error" role="alert">
      {{ error }}<button @click="error = ''" aria-label="关闭错误">×</button>
    </div>
    <div v-if="notice" class="work-banner" role="status">
      {{ notice }}<button @click="notice = ''" aria-label="关闭提示">×</button>
    </div>
    <div class="work-panels">
      <section class="central-workspace">
        <div v-if="view === 'canvas' && snapshot.candidates.length" class="review-arrival">
          <div>
            <strong>{{ snapshot.candidates.length }} 个真实候选等待审看</strong
            ><span
              >全片 {{ snapshot.timing.totalFrames / 24 }} 秒 · 已生成本次范围 ·
              其余镜头仍为规划</span
            >
          </div>
          <div class="candidate-quick">
            <button v-for="c in snapshot.candidates" :key="c.id" @click="openCandidate(c.id)">
              <video
                v-if="c.video"
                :src="assetUrl(c.video.id, c.video.revision)"
                muted
                preload="metadata"
              /><span>{{ c.label }} ▷</span>
            </button>
          </div>
        </div>
        <ResourceCanvas
          v-if="view === 'canvas'"
          :snapshot="snapshot"
          :positions="layout.positions"
          @open="openCard"
          @discuss="discuss"
          @layout="positions"
        />
        <StoryboardView
          v-else-if="view === 'storyboard'"
          :snapshot="snapshot"
          @edit="editing = $event"
          @scope="chooseScope"
          @candidate="openCandidate"
          @preview="openCard"
          @discuss="discuss"
          @handoff="handoff = $event"
        />
        <div v-else class="timeline-scroll" tabindex="0" aria-label="时间线与交付滚动区域">
          <CreationVersions :snapshot="snapshot" @created="runId = $event" @refresh="refresh" />
          <ReferenceConfirmation :snapshot="snapshot" @refresh="refresh" />
          <DeliveryPlans :snapshot="snapshot" @refresh="refresh" />
          <ReviewEditor
            :key="snapshot.run?.id"
            :snapshot="snapshot"
            :initial-candidate="candidateForEdit"
            @refresh="refresh"
            @preview="openCandidate"
          />
        </div>
      </section>
      <aside
        v-if="!layout.assistantCollapsed"
        class="assistant-dock"
        :style="{ width: layout.assistantWidth + 'px' }"
      >
        <div
          class="assistant-resizer"
          role="separator"
          aria-label="调整助手宽度"
          tabindex="0"
          @pointerdown="resizeAssistant"
          @keydown.left="
            layout.assistantWidth = Math.min(560, layout.assistantWidth + 20);
            saveLayout();
          "
          @keydown.right="
            layout.assistantWidth = Math.max(340, layout.assistantWidth - 20);
            saveLayout();
          "
        ></div>
        <AssistantPanel
          :episode-id="episodeId || undefined"
          :snapshot="snapshot"
          :references="discussionRefs"
          @remove-ref="discussionRefs.splice($event, 1)"
          @refresh="refresh"
          @open="openCard"
          @created="runId = $event"
          @close="collapseAssistant"
          @approve="approve"
          @source-imported="discuss"
        />
      </aside>
    </div>
    <footer class="task-strip">
      <button @click="tasksOpen = !tasksOpen">
        {{ tasksOpen ? '⌄' : '⌃' }} 任务
        <span>{{
          activeJobs.length ? `${activeJobs.length} 项需要关注` : '没有进行中的任务'
        }}</span></button
      ><span
        >{{ snapshot.candidates.length }} 个候选 · 实际采用
        {{ snapshot.timing.adoptedFrames / 24 }} 秒</span
      >
      <div v-if="tasksOpen" class="task-popover">
        <button v-for="job in snapshot.jobs" :key="job.id" @click="jobDetail = job.id">
          <span>{{ job.kind }} · {{ job.state }}</span
          ><small>{{ new Date(job.createdAt).toLocaleString() }}</small>
        </button>
      </div>
    </footer>
    <ContentPreview
      v-if="preview"
      :record="preview"
      :focus="previewFocus"
      :candidates="previewCandidate ? snapshot.candidates : undefined"
      :initial-candidate="previewCandidate"
      @close="
        preview = null;
        previewCandidate = '';
      "
      @discuss="discuss"
      @edit="
        editing = $event.record ? $event : { record: $event };
        preview = null;
      "
      @handoff="
        handoff = $event;
        preview = null;
      "
      @bind="bindFromPreview"
      @candidate="openCandidate"
      @review-edit="timeline"
      @inspect="
        jobDetail = $event;
        preview = null;
      "
      @review="
        candidateForEdit = $event;
        preview = null;
        switchView('timeline');
      "
    />
    <AuthoringEditor
      v-if="editing && run"
      :record="editing.record"
      :run="run"
      :shot-id="editing.shotId"
      :scene-id="editing.sceneId"
      :context="editing.context"
      :subject-key="editing.subjectKey"
      @close="editing = null"
      @saved="
        editing = null;
        refresh();
        notice = '新草稿已保存，请审稿后采用。';
      "
    />
    <HandoffPanel
      v-if="handoff && run"
      :requirement="handoff"
      :snapshot="snapshot"
      @close="handoff = null"
      @refresh="refresh"
      @bind="
        binding = handoff;
        handoff = null;
        boundAsset = $event;
      "
    />
    <div v-if="scopeForm" class="modal-backdrop" @click.self="scopeForm = null">
      <form class="dialog" v-dialog-focus="() => (scopeForm = null)" @submit.prevent="saveScope">
        <header>
          <h2>选择执行范围</h2>
          <button type="button" @click="scopeForm = null">×</button>
        </header>
        <label>范围名称<input v-model="scopeForm.name" /></label>
        <p>选中 {{ scopeForm.shotIds.length }} 镜。完整作品保持可编辑，范围外不会自动生成。</p>
        <div class="form-row">
          <label>宽度<input v-model.number="scopeOutput.width" type="number" step="32" /></label
          ><label>高度<input v-model.number="scopeOutput.height" type="number" step="32" /></label>
        </div>
        <div class="form-row">
          <label
            >采样步数<input
              v-model.number="scopeOutput.steps"
              type="number"
              min="1"
              max="50" /></label
          ><label>Seed<input v-model.number="scopeOutput.seed" type="number" min="0" /></label>
        </div>
        <details v-if="scopeWording.length" class="execution-wording">
          <summary>执行文案 · {{ scopeWording.length }} 项原文</summary>
          <p>
            为 H3
            准备英文执行描述。原故事、台词与时序保持原版本；留空沿用原文。保存的译文只适用于本次固定范围。
          </p>
          <div v-for="entry in scopeWording" :key="entry.path">
            <p>
              <strong>{{ entry.label }}</strong>
            </p>
            <p class="wording-source">{{ entry.source }}</p>
            <label
              >{{ entry.path }} 执行译文<textarea
                v-model="entry.text"
                rows="5"
                @input="wordingReviewed = false"
              />
            </label>
          </div>
          <label><input v-model="wordingReviewed" type="checkbox" />已核对执行文案与原意一致</label>
        </details>
        <footer>
          <button type="button" @click="scopeForm = null">取消</button
          ><button
            class="primary"
            :disabled="busy || (scopeWording.some((e) => e.text.trim()) && !wordingReviewed)"
          >
            保存范围
          </button>
        </footer>
      </form>
    </div>
    <div v-if="executionPreview" class="modal-backdrop" @click.self="executionPreview = null">
      <section class="dialog wide" v-dialog-focus="() => (executionPreview = null)">
        <header>
          <h2>生成预览</h2>
          <button @click="executionPreview = null">×</button>
        </header>
        <p>
          范围 {{ rangeText }} · {{ snapshot.scope?.data.output.width }} ×
          {{ snapshot.scope?.data.output.height }} · {{ snapshot.scope?.data.output.steps }} 步
        </p>
        <div class="reference-strip">
          <img
            v-for="item in snapshot.requirements.filter((r) => r.inScope && r.binding?.asset)"
            :key="item.id"
            :src="assetUrl(item.binding.asset.id, item.binding.asset.revision)"
            :alt="item.description"
          />
        </div>
        <p v-for="(issue, i) in executionPreview.issues || []" :key="i">{{ issue.message }}</p>
        <p>本次准备不消耗额度。提交会按范围创建现有生产任务。</p>
        <details>
          <summary>固定输入、声音安排与能力检查</summary>
          <pre>{{ JSON.stringify(executionPreview, null, 2) }}</pre>
        </details>
        <footer>
          <button @click="executionPreview = null">关闭</button
          ><button
            class="primary"
            :disabled="
              busy ||
              snapshot.allowance.remainingGenerations <= 0 ||
              !executionPreview.preview?.digest
            "
            @click="submit"
          >
            确认提交生成
          </button>
        </footer>
      </section>
    </div>
    <div v-if="binding" class="modal-backdrop" @click.self="binding = null">
      <section class="dialog wide" v-dialog-focus="() => (binding = null)">
        <header>
          <h2>绑定参考用途</h2>
          <button @click="binding = null">×</button>
        </header>
        <label
          >素材需求<select v-model="binding.id">
            <option value="">请选择用途</option>
            <option v-for="r in snapshot.requirements" :key="r.id" :value="r.id">
              {{ r.description }} · {{ r.purpose }}
            </option>
          </select></label
        ><MediaLibrary
          v-if="!boundAsset"
          :project="project"
          :version="version"
          pick
          @pick="boundAsset = $event"
        /><template v-else
          ><img
            v-if="boundAsset.data.mediaType === 'image'"
            class="binding-image"
            :src="assetUrl(boundAsset.id, boundAsset.revision)"
            :alt="boundAsset.data.name"
          /><audio v-else :src="assetUrl(boundAsset.id, boundAsset.revision)" controls />
          <p>{{ boundAsset.data.name }}</p>
          <button
            @click="
              boundAsset = null;
              inspected = false;
            "
          >
            重新选择</button
          ><label class="check"
            ><input v-model="inspected" type="checkbox" />我已实际审看／听审此素材</label
          ><label>用途与审看结论<textarea v-model="bindingNote" rows="3" /></label
          ><button
            class="primary"
            :disabled="busy || !inspected || !binding.id || !bindingNote.trim()"
            @click="saveBinding"
          >
            绑定这个版本
          </button></template
        >
      </section>
    </div>
    <div v-if="jobDetail" class="modal-backdrop" @click.self="jobDetail = ''">
      <section class="dialog wide" v-dialog-focus="() => (jobDetail = '')">
        <header>
          <h2>任务记录</h2>
          <button @click="jobDetail = ''">×</button>
        </header>
        <JobInspection :job-id="jobDetail" :documents="snapshot.assets" @refresh="refresh" />
      </section>
    </div>
    <div v-if="showSeries" class="modal-backdrop" @click.self="showSeries = false">
      <section class="dialog wide" v-dialog-focus="() => (showSeries = false)">
        <header>
          <h2>项目内容与精细编辑</h2>
          <button @click="showSeries = false">×</button>
        </header>
        <ProjectTools
          :project="project"
          :episode-id="run?.data.episodeId || episodeId"
          :initial="toolsTab"
          :version="version"
          @refresh="refresh"
        />
      </section>
    </div>
  </main>
  <div v-else class="empty-state">
    <p>{{ error || '正在读取作品…' }}</p>
    <button v-if="error" @click="refresh">重新读取</button>
  </div>
</template>
