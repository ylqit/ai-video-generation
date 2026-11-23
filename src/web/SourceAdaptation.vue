<script setup lang="ts">
import { ref } from 'vue';
import { api, downloadJson } from './api';
import RecordPicker from './RecordPicker.vue';
import ContractField from './ContractField.vue';
const props = defineProps<{ projectId: string }>();
const emit = defineEmits(['reference']);
const source = ref<any>(null),
  index = ref<any>(null),
  saved = ref<any>(null),
  error = ref('');
async function prepare() {
  try {
    const preview = await api(`/projects/${props.projectId}/source-index/preview`, 'POST', {
      sources: [{ id: source.value.id, revision: source.value.revision }],
    });
    index.value = preview.data;
    saved.value = null;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function save() {
  try {
    saved.value = await api(`/projects/${props.projectId}/source-index`, 'POST', {
      data: index.value,
      idempotencyKey: crypto.randomUUID(),
    });
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <details class="panel">
    <summary>原文章节与改编事件索引</summary>
    <p>
      先导入 TXT／Markdown；标题仅用于定位。事件与保留要求由作者填写审核，不把自动切段当作理解原文。
    </p>
    <RecordPicker
      :project-id="projectId"
      kind="chapter"
      label="固定原文"
      @select="
        (r) => {
          source = r;
          index = saved = null;
        }
      "
    />
    <button :disabled="!source" @click="prepare">按标题建立索引草稿</button>
    <p class="error" v-if="error">{{ error }}</p>
    <div v-if="index">
      <article v-for="entry in index.entries" :key="entry.id">
        <label>章节标题<input v-model="entry.title" /></label>
        <p>{{ entry.id }} · 原文字符 [{{ entry.start }}, {{ entry.end }})</p>
        <ContractField label="本段来源事件（id、statement、locked）" v-model="entry.events" />
      </article>
      <button @click="save">确认并保存来源索引</button
      ><button @click="downloadJson('来源索引草稿.json', index)">导出索引</button>
    </div>
    <p v-if="saved">
      已保存 {{ saved.id }} v{{ saved.revision }}
      <button @click="emit('reference', saved)">加入当前创作引用</button>
    </p>
  </details>
</template>
