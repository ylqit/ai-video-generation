<script setup lang="ts">
import { ref, computed, watch, onBeforeUnmount } from 'vue';
import type { Job, RecordDoc } from '../shared/contracts';
import { api } from './api';
import GenerationPreview from './GenerationPreview.vue';
import GenerationReview from './GenerationReview.vue';
import CandidateReview from './CandidateReview.vue';
import SpeechResultReview from './SpeechResultReview.vue';
const props = defineProps<{ jobId: string; documents: RecordDoc[] }>();
const emit = defineEmits(['refresh']);
const job = ref<Job | null>(null),
  records = ref<RecordDoc[]>([]),
  error = ref(''),
  busy = ref(false);
let ticket = 0;
const recovering = ref(false);
const remoteId = ref('');
const remoteEvidence = ref('');
const nativeVideo = computed(
  () => job.value?.input.modelExecution && job.value.input.modelExecution.protocol !== 'comfy-h3',
);
async function tracking(action: 'resume-tracking' | 'suspend-tracking' | 'reconcile') {
  if (recovering.value) return;
  recovering.value = true;
  error.value = '';
  try {
    await api(
      `/${action === 'reconcile' && ['voice_clone', 'speech', 'lipsync'].includes(job.value?.kind || '') ? 'speech-jobs' : 'jobs'}/${props.jobId}/${action}`,
      'POST',
      action === 'reconcile'
        ? nativeVideo.value
          ? { remoteTaskId: remoteId.value, inspected: true, evidence: remoteEvidence.value }
          : { promptId: remoteId.value }
        : undefined,
    );
    await load();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    recovering.value = false;
  }
}
const canRecover = computed(() => {
  const j = job.value;
  if (!j || j.state !== 'failed') return false;
  if ((j.input.modelCharge || j.input.speechCharge) && !j.output.descriptor) return false;
  if (['voice_clone', 'speech', 'lipsync'].includes(j.kind)) return Boolean(j.output.descriptor);
  if (j.kind === 'image') return Boolean(j.output.descriptor);
  if (j.kind === 'generation') return Boolean(j.output.descriptor);
  if (j.kind === 'creative') return j.input.context?.schemaVersion === 9;
  return (
    ['export', 'media_process', 'previs'].includes(j.kind) ||
    (['media_analysis', 'transcription'].includes(j.kind) && Boolean(j.output.descriptor))
  );
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
    while (j.projectId) {
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
    <summary>任务详情、冻结输入与实际结果</summary>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="busy">读取中…</p>
    <template v-if="job"
      ><p>任务状态：{{ job.state }}</p>
      <p v-if="job.error" class="error">{{ job.error }}</p>
      <p v-if="job.output.canvasSyncError" class="error">
        媒体已归档，画布关联待恢复：{{ job.output.canvasSyncError }}
      </p>
      <p
        v-if="
          ['media_analysis', 'transcription', 'creative', 'image'].includes(job.kind) &&
          job.state === 'unknown'
        "
      >
        同步请求受理不明；保留原任务，不自动重新提交。先核对供应商请求及用量，再决定是否创建新尝试。
      </p>
      <template
        v-if="
          [
            'generation',
            'image',
            'creative',
            'voice_clone',
            'speech',
            'lipsync',
            'media_analysis',
            'transcription',
          ].includes(job.kind)
        "
      >
        <p v-if="job.state === 'unknown'">
          提交受理不明。请核对原连接中的任务编号及输入。API
          如未提供输入摘要，人工核对记录会独立保留，不会标成供应商已证明输入匹配。
        </p>
        <label
          v-if="
            job.state === 'unknown' && ['generation', 'voice_clone', 'lipsync'].includes(job.kind)
          "
          >已核对的远端任务编号<input v-model="remoteId" /><button
            :disabled="
              recovering || !remoteId.trim() || (nativeVideo && remoteEvidence.trim().length < 5)
            "
            @click="tracking('reconcile')"
          >
            核对并关联原任务
          </button></label
        >
        <label v-if="job.state === 'unknown' && nativeVideo"
          >已核对的输入、提交时间与依据<textarea v-model="remoteEvidence" />
        </label>
        <p v-if="job.output.remote">
          远端任务 {{ job.output.remote.taskId }} · {{ job.output.remote.protocol }}
        </p>
        <button
          v-if="job.state === 'cancelled' && job.output.waitSuspended"
          :disabled="recovering"
          @click="tracking('resume-tracking')"
        >
          恢复原任务跟踪
        </button>
        <button
          v-if="['submitted', 'running', 'unknown'].includes(job.state)"
          :disabled="recovering"
          @click="tracking('suspend-tracking')"
        >
          暂停本机跟踪（远端可能继续）
        </button>
        <p v-if="job.state === 'failed' && !job.output.descriptor">
          本任务没有可恢复的归档回执。若需重新生成，请回到来源节点准备新的尝试。
        </p>
      </template>
      <button @click="load">更新任务详情</button>
      <button v-if="canRecover" :disabled="recovering" @click="recover">
        {{ recovering ? '恢复中…' : job.output.descriptor ? '恢复原任务归档' : '恢复原任务' }}
      </button>
      <details>
        <summary>冻结输入与回执 JSON</summary>
        <pre>{{ JSON.stringify({ input: job.input, output: job.output }, null, 2) }}</pre>
      </details>
      <details v-if="['voice_clone', 'speech'].includes(job.kind)">
        <summary>可选声音检查</summary>
        <SpeechResultReview
          v-if="['voice_clone', 'speech'].includes(job.kind)"
          :job="job"
          :documents="records"
          @refresh="
            load();
            emit('refresh');
          "
        />
      </details>
      <p v-if="job.kind === 'speech' && job.state === 'unknown'">
        同步声音响应受理不明，不支持伪造远端任务查询。核对供应商用量后，必要时从台词准备明确的新尝试。
      </p>
      <GenerationPreview
        v-if="job.kind === 'generation' && job.input.prepared"
        :input="job.input" />
      <details v-if="['generation', 'lipsync'].includes(job.kind)">
        <summary>可选画面与候选检查</summary>
        <GenerationReview
          :job="job"
          :assets="records.filter((d) => d.kind === 'asset')"
        /><CandidateReview
          :job="job"
          :documents="records"
          @refresh="
            load();
            emit('refresh');
          "
        /></details
    ></template>
  </details>
</template>
