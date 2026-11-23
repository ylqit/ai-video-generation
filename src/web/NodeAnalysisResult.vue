<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { api, assetUrl } from './api';
const props = defineProps<{ record: RecordDoc; canvas: RecordDoc }>();
const emit = defineEmits(['close', 'refresh']);
const error = ref(''),
  busy = ref(false),
  clip = ref(0),
  edl = ref<any>(null);
const editing = ref(false),
  edited = ref<any[]>(
    structuredClone(props.record.data.editedSegments || props.record.data.segments || []),
  );
const boundNode = computed(() =>
  props.canvas.data.nodes.find((n: any) => n.binding?.id === props.record.id && !n.binding.path),
);
const segments = computed(
  () => props.record.data.editedSegments || props.record.data.segments || [],
);
if (props.canvas.data.edl)
  void api(`/records/${props.canvas.data.edl.id}/versions/${props.canvas.data.edl.revision}`)
    .then((r) => (edl.value = r))
    .catch((e) => (error.value = e.message));
async function materialize(action: string) {
  busy.value = true;
  error.value = '';
  try {
    await api(`/canvases/${props.canvas.id}/analysis-materialize`, 'POST', {
      revision: props.canvas.revision,
      analysis: { id: props.record.id, revision: props.record.revision },
      action,
      clipIndex: action === 'subtitles' ? clip.value : undefined,
      idempotencyKey: crypto.randomUUID(),
    });
    emit('refresh');
    emit('close');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function saveTranscript() {
  busy.value = true;
  error.value = '';
  try {
    await api(`/canvases/${props.canvas.id}/nodes/${boundNode.value.id}/object`, 'PUT', {
      canvasRevision: props.canvas.revision,
      objectRevision: props.record.revision,
      data: { content: edited.value.map((s) => s.text).join('\n'), segments: edited.value },
      idempotencyKey: crypto.randomUUID(),
    });
    emit('refresh');
    emit('close');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="analysis-result">
    <header>
      <h2>{{ record.data.title }}</h2>
      <button @click="emit('close')">关闭</button>
    </header>
    <p>
      {{ record.data.complete ? '结果已归档' : '部分结果 · 后续步骤未完成' }} ·
      {{ record.data.kind }}
    </p>
    <p class="muted">
      切镜是本地画面变化检测；视觉描述仅对应固定采样图，不能证明整个片段的动作或声音。
    </p>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div class="analysis-shots">
      <article v-for="s in record.data.shots || []" :key="s.index">
        <img
          v-if="s.frame"
          :src="assetUrl(s.frame.id, s.frame.revision)"
          loading="lazy"
          alt="采样关键帧"
        /><strong
          >镜头 {{ s.index + 1 }} · {{ s.start.toFixed(3) }}–{{ s.end.toFixed(3) }} 秒</strong
        >
        <p>{{ s.description || '未进行视觉描述' }}</p>
      </article>
    </div>
    <pre v-if="record.data.content">{{ record.data.content }}</pre>
    <div v-for="(s, i) in segments" :key="i" class="transcript-line">
      <small
        >{{ s.start.toFixed(3) }}–{{ s.end.toFixed(3) }} s · 说话人 {{ s.speaker ?? '未知' }}</small
      >
      <p>{{ s.text }}</p>
    </div>
    <section v-if="editing" class="transcript-editor">
      <p>编辑文本与时间；原始识别响应、词级时间和旧版本保持可追溯。</p>
      <article v-for="(s, i) in edited" :key="i">
        <div class="field-pair">
          <label
            >开始（源秒）<input
              type="number"
              min="0"
              step="0.001"
              v-model.number="s.start" /></label
          ><label
            >结束（源秒）<input type="number" min="0" step="0.001" v-model.number="s.end"
          /></label>
        </div>
        <textarea v-model="s.text" rows="2" />
      </article>
      <button :disabled="busy" @click="saveTranscript">保存编辑版本</button>
    </section>
    <footer>
      <button v-if="segments.length && boundNode" :disabled="busy" @click="editing = !editing">
        {{ editing ? '收起编辑' : '编辑转写与字幕' }}</button
      ><button
        v-if="['rewrite', 'text_generate'].includes(record.data.kind)"
        :disabled="busy"
        @click="materialize('apply_text')"
      >
        应用到原文（检查原文版本）</button
      ><button :disabled="busy" @click="materialize('text')">生成文本节点</button
      ><template v-if="record.data.shots?.length"
        ><button :disabled="busy" @click="materialize('frames')">固定关键帧节点</button
        ><button :disabled="busy" @click="materialize('shots')">生成镜头卡</button></template
      ><template v-if="segments.length"
        ><select v-model="clip" aria-label="字幕对应片段">
          <option v-for="(c, i) in edl?.data.clips || []" :key="i" :value="i">
            时间线片段 {{ Number(i) + 1 }}
          </option></select
        ><button :disabled="busy || !edl" @click="materialize('subtitles')">
          映射到片段字幕
        </button></template
      >
    </footer>
  </section>
</template>
