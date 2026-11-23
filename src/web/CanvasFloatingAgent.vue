<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { contextReferenceKey, type ContextReference } from '../shared/workbench-context';
import { api, assetUrl } from './api';
import { useFloatingAssistantWindow } from './useFloatingAssistantWindow';
import ContextReferencePicker from './ContextReferencePicker.vue';
import AssistantReferences from './AssistantReferences.vue';
import AssistantExecutionScope from './AssistantExecutionScope.vue';
const props = defineProps<{
  canvas: RecordDoc;
  run: RecordDoc | null;
  selectedIds: string[];
  busy: boolean;
  version: number;
  additions?: { key: number; references: ContextReference[] };
  saveReferences: (ids: string[]) => Promise<RecordDoc>;
}>();
const emit = defineEmits(['refresh', 'locate', 'close', 'attach']);
const { panel, minimal, docked, position, size, start, move, stop, rememberWindow } =
  useFloatingAssistantWindow();
const messages = ref<any[]>([]),
  text = ref(''),
  mode = ref('discussion'),
  model = ref(''),
  models = ref<any[]>([]),
  error = ref(''),
  sending = ref(false),
  picker = ref(false),
  preview = ref<any>(null),
  references = ref<ContextReference[]>([]);
const scope = ref<any>({
  writeScope: 'new',
  permissions: ['write', 'select', 'edit', 'export', 'extract', 'derive'],
  modelKeys: [],
  budget: {
    maxSteps: 20,
    imageRequests: 0,
    images: 0,
    videoRequests: 0,
    videoSeconds: 0,
    speechRequests: 0,
    speechCharacters: 0,
    lipSyncRequests: 0,
    lipSyncSeconds: 0,
    analysisRequests: 0,
    analysisImages: 0,
    transcriptionRequests: 0,
    transcriptionSeconds: 0,
  },
});
const active = computed(
  () => props.run && !['stopped', 'completed'].includes(props.run.data.state),
);
const draftKey = 'studio:conversation-v2:' + props.canvas.id;
let receipt = crypto.randomUUID(),
  loading = true,
  pendingMessage: any = null;
function persist() {
  localStorage.setItem(
    draftKey,
    JSON.stringify({
      text: text.value,
      mode: mode.value,
      model: model.value,
      scope: scope.value,
      references: references.value,
      receipt,
      pendingMessage,
    }),
  );
}
watch(
  [text, mode, model, references, scope],
  () => {
    if (loading) return;
    receipt = crypto.randomUUID();
    pendingMessage = null;
    preview.value = null;
    persist();
  },
  { deep: true, flush: 'sync' },
);
function add(refs: ContextReference[]) {
  const keys = new Set(references.value.map(contextReferenceKey));
  references.value = [
    ...references.value,
    ...refs.filter((r) => !keys.has(contextReferenceKey(r))),
  ].slice(0, 20);
  minimal.value = false;
}
watch(
  () => props.additions?.key,
  () => {
    if (props.additions) add(props.additions.references);
  },
  { immediate: true },
);
function addSelected() {
  add(
    props.selectedIds.map((nodeId) => ({
      kind: 'node',
      canvas: { id: props.canvas.id, revision: props.canvas.revision },
      nodeId,
      imageHandling: 'image',
    })),
  );
}
async function load() {
  try {
    messages.value = (await api('/canvases/' + props.canvas.id + '/conversation')).messages;
  } catch (e: any) {
    error.value = e.message;
  }
}
watch(() => props.version, load);
const selectedModel = computed(() =>
  mode.value === 'production'
    ? active.value
      ? props.run?.data.models.find((m: any) => m.capabilities.kind === 'text')?.selection
      : models.value.find((m) => m.kind === 'text' && scope.value.modelKeys.includes(m.key))
          ?.selection
    : models.value.find((m) => m.key === model.value)?.selection,
);
async function fixRelatedDrafts() {
  const ids = references.value
    .filter(
      (r) =>
        r.kind === 'node' &&
        r.canvas.id === props.canvas.id &&
        r.canvas.revision === props.canvas.revision,
    )
    .map((r) => (r as any).nodeId);
  if (!ids.length) return;
  const previousRevision = props.canvas.revision;
  const saved = await props.saveReferences(ids);
  const updated = references.value.map((r) =>
    r.kind === 'node' &&
    r.canvas.id === saved.id &&
    r.canvas.revision === previousRevision &&
    ids.includes(r.nodeId)
      ? { ...r, canvas: { id: saved.id, revision: saved.revision } }
      : r,
  );
  if (JSON.stringify(updated) !== JSON.stringify(references.value)) references.value = updated;
}
async function inspect() {
  error.value = '';
  try {
    await fixRelatedDrafts();
    preview.value = await api('/canvases/' + props.canvas.id + '/context-preview', 'POST', {
      references: references.value,
      model: selectedModel.value,
    });
  } catch (e: any) {
    error.value = e.message;
    throw e;
  }
}
async function send() {
  if (sending.value) return;
  sending.value = true;
  error.value = '';
  try {
    if (pendingMessage) {
      const submitted = pendingMessage;
      await api('/canvases/' + props.canvas.id + '/conversation', 'POST', submitted);
      if (receipt === submitted.idempotencyKey) {
        pendingMessage = null;
        text.value = '';
        references.value = [];
      }
      await load();
      emit('refresh');
      return;
    }
    await inspect();
    if (preview.value.issues.length) throw new Error(preview.value.issues.join('\n'));
    if (
      mode.value === 'production' &&
      scope.value.writeScope === 'selected' &&
      !props.selectedIds.length
    )
      throw new Error('请勾选可修改节点，或选择只新增内容');
    pendingMessage = JSON.parse(
      JSON.stringify({
        version: 2,
        text: text.value,
        mode: mode.value === 'production' && active.value ? 'guide' : mode.value,
        references: references.value,
        contextDigest: preview.value.digest,
        model: selectedModel.value,
        ...(mode.value === 'production' && !active.value
          ? {
              executionScope: {
                ...scope.value,
                modelKeys: undefined,
                nodeIds: scope.value.writeScope === 'selected' ? props.selectedIds : [],
                models: models.value
                  .filter((m) => scope.value.modelKeys.includes(m.key))
                  .map((m) => m.selection),
              },
            }
          : {}),
        idempotencyKey: receipt,
      }),
    );
    persist();
    const submitted = pendingMessage;
    await api('/canvases/' + props.canvas.id + '/conversation', 'POST', submitted);
    if (receipt === submitted.idempotencyKey) {
      pendingMessage = null;
      text.value = '';
      references.value = [];
    }
    await load();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    sending.value = false;
  }
}
async function control(action: string) {
  try {
    await api('/assistant-runs/' + props.run!.id + '/control', 'POST', {
      revision: props.run!.revision,
      action,
    });
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(async () => {
  try {
    const local = JSON.parse(localStorage.getItem(draftKey) || 'null');
    if (local) {
      text.value = local.text;
      mode.value = local.mode;
      model.value = local.model;
      scope.value = local.scope;
      references.value = local.references;
      receipt = local.receipt;
      pendingMessage = local.pendingMessage || null;
    }
    if (props.additions) add(props.additions.references);
    const r = await api('/model-connections');
    models.value = r.connections
      .filter((c: any) => c.currentlyEnabled)
      .flatMap((c: any) =>
        c.models
          .filter((m: any) => m.enabled !== false)
          .map((m: any) => ({
            key: c.id + ':' + m.id,
            label: m.name + ' · ' + c.data.name,
            kind: m.capabilities.kind,
            imageInput: m.capabilities.imageInput,
            selection: {
              connection: { id: c.id, revision: c.revision },
              modelId: m.id,
              mode: 'authored',
              promptProfile: 'automatic',
              parameters: {},
            },
          })),
      );
    if (!model.value) model.value = models.value.find((m) => m.kind === 'text')?.key || '';
    if (!scope.value.modelKeys.length && model.value) scope.value.modelKeys = [model.value];
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading = false;
    persist();
  }
});
onBeforeUnmount(persist);
</script>
<template>
  <section
    class="floating-agent"
    ref="panel"
    :class="{ docked, minimal }"
    :style="
      docked
        ? {}
        : {
            left: position.x + 'px',
            top: position.y + 'px',
            ...(!minimal ? { width: size.width + 'px', height: size.height + 'px' } : {}),
          }
    "
    aria-label="画布创作助手"
    @keydown.stop
    @paste="
      (e) => {
        if (e.clipboardData?.files.length) {
          e.preventDefault();
          emit('attach', Array.from(e.clipboardData.files));
        }
      }
    "
    @dragover.prevent
    @drop.prevent="emit('attach', Array.from($event.dataTransfer?.files || []))"
  >
    <header @pointerdown="start" @pointermove="move" @pointerup="stop">
      <strong>✧ 创作助手</strong><span>{{ active ? '制作进行中' : '与你一起创作' }}</span
      ><button
        @click="
          docked = !docked;
          rememberWindow();
        "
        :title="docked ? '浮动' : '停靠'"
      >
        {{ docked ? '↗' : '⇥' }}</button
      ><button
        @click="
          minimal = !minimal;
          rememberWindow();
        "
      >
        {{ minimal ? '展开' : '－' }}</button
      ><button @click="emit('close')" aria-label="关闭助手">×</button>
    </header>
    <template v-if="!minimal">
      <div class="floating-agent-body" aria-live="polite">
        <p v-if="!messages.length" class="quiet-empty">
          勾选画布节点并加入助手，也可以直接描述目标。引用与可修改范围分别设置。
        </p>
        <article v-for="m in messages" :key="m.id" :class="['chat-message', m.data.role]">
          <small>{{ m.data.role === 'user' ? '你' : 'Studio' }}</small>
          <p>{{ m.data.text }}</p>
          <button
            v-for="(r, i) in m.data.references || []"
            :key="i"
            @click="emit('locate', r.reference || { nodeId: r.nodeId })"
          >
            @{{ r.title }}</button
          ><small v-if="m.data.state === 'unknown'">受理待核对 · 未重发</small>
        </article>
        <article v-if="run" class="agent-running-card">
          <strong>{{ run.data.goal }}</strong>
          <p>{{ run.data.note || run.data.state }}</p>
          <small
            >决策 {{ run.data.steps.length }} / {{ run.data.budget.maxSteps }} ·
            {{ run.data.receipts.length }} 条操作回执</small
          >
          <div class="button-row">
            <button
              v-if="active"
              @click="
                control(
                  run.data.state === 'paused' || run.data.state === 'waiting_input'
                    ? 'resume'
                    : 'pause',
                )
              "
            >
              {{
                run.data.state === 'paused' || run.data.state === 'waiting_input' ? '继续' : '暂停'
              }}</button
            ><button v-if="active" @click="control('stop')">停止后续动作</button>
          </div>
          <details>
            <summary>步骤与实际结果</summary>
            <p v-for="r in run.data.receipts" :key="r.key">
              {{ r.action }} ·
              {{ r.result?.nodeId || (r.result?.jobIds ? '任务已提交' : '回执已保存')
              }}<button
                v-if="r.result?.nodeId"
                @click="emit('locate', { nodeId: r.result.nodeId })"
              >
                定位
              </button>
            </p>
          </details>
        </article>
      </div>
      <ContextReferencePicker
        v-if="picker"
        :project-id="canvas.projectId"
        :canvas-id="canvas.id"
        :selected="references"
        @add="add"
        @close="picker = false"
      />
      <form class="floating-agent-compose" @submit.prevent="send">
        <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
        <div class="button-row">
          <select v-model="mode" aria-label="助手模式">
            <option value="discussion">讨论</option>
            <option value="production">{{ active ? '引导制作' : '制作' }}</option></select
          ><select v-model="model" aria-label="讨论模型">
            <option value="">选择文字模型</option>
            <option
              v-for="m in models.filter((m) => m.kind === 'text')"
              :key="m.key"
              :value="m.key"
            >
              {{ m.label }}{{ m.imageInput ? ' · 可读图' : '' }}
            </option></select
          ><button type="button" @click="picker = !picker">＋ 引用</button
          ><button type="button" :disabled="!selectedIds.length" @click="addSelected">
            勾选 {{ selectedIds.length }} 项</button
          ><label class="attachment-button"
            >附件<input
              type="file"
              multiple
              accept="image/*,video/*,audio/*,.txt,.md"
              @change="
                emit('attach', Array.from(($event.target as HTMLInputElement).files || []));
                ($event.target as HTMLInputElement).value = '';
              "
          /></label>
        </div>
        <AssistantReferences
          :canvas-id="canvas.id"
          :references="references"
          :preview="preview"
          :nodes="canvas.data.nodes"
          @update="references = $event"
          @inspect="inspect().catch(() => {})"
          @locate="emit('locate', $event)"
        />
        <details v-if="preview" class="context-consumption">
          <summary>
            实际输入：{{ preview.size.characters }} 字符 / {{ preview.size.images }} 张图片
          </summary>
          <p v-for="(i, n) in preview.items" :key="n">
            <img
              v-if="i.media?.type === 'image'"
              :src="assetUrl(i.media.id, i.media.revision)"
              alt="固定图片"
              loading="lazy"
            />{{ i.title }} · {{ i.consumption }} {{ i.note
            }}<button v-if="i.reference.nodeId" type="button" @click="emit('locate', i.reference)">
              定位
            </button>
          </p>
          <p v-for="issue in preview.issues" :key="issue" class="inline-error">{{ issue }}</p>
        </details>
        <AssistantExecutionScope
          v-if="mode === 'production' && !active"
          :value="scope"
          :models="models"
          :selected-ids="selectedIds"
          @change="scope = $event"
        />
        <textarea
          v-model="text"
          rows="3"
          placeholder="讨论内容，或描述希望完成的制作…"
          aria-label="助手消息"
        />
        <div class="button-row">
          <button type="button" :disabled="sending" @click="inspect().catch(() => {})">
            查看实际输入</button
          ><small>{{ references.length }}/20 项引用</small
          ><button class="primary" :disabled="sending || busy || !text.trim() || !model">
            {{
              sending
                ? '正在固定输入…'
                : mode === 'discussion'
                  ? '发送讨论'
                  : active
                    ? '发送引导'
                    : '开始制作'
            }}
          </button>
        </div>
      </form>
    </template>
  </section>
</template>
