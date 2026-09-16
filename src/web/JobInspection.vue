<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import type { Job, RecordDoc } from '../shared/contracts';
import { api } from './api';
import GenerationPreview from './GenerationPreview.vue';
import GenerationReview from './GenerationReview.vue';
import CandidateReview from './CandidateReview.vue';
const props = defineProps<{ jobId: string; documents: RecordDoc[] }>();
const emit = defineEmits(['refresh']);
const job = ref<Job | null>(null),
  records = ref<RecordDoc[]>([]),
  error = ref(''),
  busy = ref(false);
let ticket = 0;
const recovering = ref(false);
const canRecover = computed(() => {
  const j = job.value;
  if (!j || j.state !== 'failed') return false;
  if (j.kind === 'generation') return Boolean(j.output.descriptor);
  if (j.kind === 'creative') return j.input.context?.schemaVersion === 9;
  return j.kind === 'export';
});
async function recover() {
  if (!canRecover.value || recovering.value) return;
  recovering.value = true;
  error.value = '';
  try {
    await api('/jobs/' + props.jobId + '/retry', 'POST');
    await load();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    recovering.value = false;
  }
}
async function load() {
  const seq = ++ticket;
  busy.value = true;
  error.value = '';
  try {
    const j = await api<Job>('/jobs/' + props.jobId);
    const ids = new Set<string>(
      [j.episodeId, ...(j.output.assetIds || []), j.output.videoAssetId].filter(Boolean),
    );
    const docs = await Promise.all([...ids].map((id) => api<RecordDoc>('/records/' + id)));
    let offset = 0;
    while (true) {
      const related = await api<any>(
        `/projects/${j.projectId}/records?jobId=${j.id}&limit=100&offset=${offset}`,
      );
      if (seq !== ticket) return;
      for (const d of related.items) {
        ids.add(d.id);
        if (!docs.some((v) => v.id === d.id)) docs.push(d);
      }
      offset += related.items.length;
      if (offset >= related.total || !related.items.length) break;
    }
    if (seq !== ticket) return;
    records.value = [...props.documents.filter((d) => !ids.has(d.id)), ...docs];
    job.value = j;
  } catch (e: any) {
    if (seq === ticket) error.value = e.message;
  } finally {
    if (seq === ticket) busy.value = false;
  }
}
watch(() => props.jobId, load, { immediate: true });
onBeforeUnmount(() => ticket++);
</script>
<template>
  <details open>
    <summary>读取冻结输入、执行预览与候选审核</summary>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="busy">读取中…</p>
    <template v-if="job"
      ><p>任务状态：{{ job.state }}</p>
      <p v-if="job.error" class="error">{{ job.error }}</p>
      <button @click="load">更新任务详情</button>
      <button v-if="canRecover" :disabled="recovering" @click="recover">
        {{ recovering ? '恢复中…' : job.output.descriptor ? '恢复原任务归档' : '恢复原任务' }}
      </button>
      <details>
        <summary>冻结输入与回执 JSON</summary>
        <pre>{{ JSON.stringify({ input: job.input, output: job.output }, null, 2) }}</pre>
      </details>
      <GenerationPreview v-if="job.input.prepared" :input="job.input" /><GenerationReview
        :job="job"
        :assets="records.filter((d) => d.kind === 'asset')" /><CandidateReview
        :job="job"
        :documents="records"
        @refresh="
          load();
          emit('refresh');
        "
    /></template>
  </details>
</template>
