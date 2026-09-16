<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { api } from './api';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['created', 'refresh']);
const inspection = ref<any>(null),
  runs = ref<any[]>([]);
const error = ref(''),
  busy = ref(false);
const attempts = new Map<string, string>();
const run = computed(() => props.snapshot.run);
const stateNames: Record<string, string> = {
  active: '制作中',
  paused: '已暂停',
  awaiting_review: '待审查',
  awaiting_assets: '待参考',
  awaiting_media_review: '待审看',
  needs_revision: '待修订',
  completed: '已完成',
  failed: '需处理',
  cancelled: '已取消',
  ready: '已准备',
};
function bodyKey(body: any) {
  const digest = JSON.stringify(body);
  if (!attempts.has(digest)) attempts.set(digest, crypto.randomUUID());
  return attempts.get(digest)!;
}
async function act(action: () => Promise<void>) {
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
  if (!run.value) return null;
  const ticket = ++loadTicket,
    current = run.value;
  const detail = await api(`/creation-runs/${current.id}`);
  const versions = (await api(`/projects/${props.snapshot.project.id}/creation-runs`)).filter(
    (r: any) => r.data.episodeId === current.data.episodeId,
  );
  if (ticket !== loadTicket || run.value?.id !== current.id) return null;
  inspection.value = detail;
  runs.value = versions;
  return detail;
}
async function activate() {
  await act(async () => {
    const runId = run.value!.id,
      detail = await load();
    if (!detail || run.value?.id !== runId) return;
    const body = {
      runRevision: detail.run.revision,
      expectedHeadRevision: detail.productionHead.revision,
      expectedPreviousRunId: detail.productionHead.runId,
    };
    await api(`/creation-runs/${runId}/activate`, 'POST', {
      ...body,
      idempotencyKey: bodyKey(body),
    });
    await load();
    emit('refresh');
  });
}
watch(
  () => [run.value?.id, run.value?.revision],
  () =>
    void act(async () => {
      await load();
    }),
  { immediate: true },
);
</script>
<template>
  <section v-if="run" class="versions-panel" aria-label="创作版本与制作归属">
    <label
      >创作版本<select
        :value="run.id"
        @change="emit('created', ($event.target as HTMLSelectElement).value)"
      >
        <option v-for="r in runs" :key="r.id" :value="r.id">
          {{ r.id === inspection?.productionHead.runId ? '当前制作 · ' : '草稿或历史 · '
          }}{{ snapshot.project.data.title }} · {{ r.id.slice(0, 8) }} / v{{ r.revision }} ·
          {{ new Date(r.createdAt).toLocaleDateString() }} ·
          {{ stateNames[r.data.state] || '待处理' }}
        </option>
      </select></label
    >
    <details>
      <summary>查看此版本的完整需求</summary>
      <p>{{ run.data.request }}</p>
    </details>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <template v-if="inspection?.productionHead.runId !== run.id"
      ><p>当前是独立草稿。完成专业阶段与本次参考确认后，可切换为当前制作版本。</p>
      <button :disabled="busy || !run.data.results.assets" @click="activate">
        激活此制作版本
      </button></template
    >
  </section>
</template>
<style scoped>
.versions-panel {
  min-width: 0;
  grid-template-columns: minmax(0, 1fr);
  border: 1px solid var(--border, #d6d9e0);
  border-radius: 10px;
  padding: 16px;
  margin: 12px 0;
  display: grid;
  gap: 12px;
}
.versions-panel label {
  display: inline-flex;
  gap: 8px;
  margin: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.versions-panel select {
  min-width: 0;
  width: 100%;
  max-width: 100%;
}
.versions-panel > * {
  min-width: 0;
  max-width: 100%;
}
</style>
