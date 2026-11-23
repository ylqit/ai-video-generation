<script setup lang="ts">
import type { ImportItem } from './useWorkbenchImports';
defineProps<{ items: ImportItem[] }>();
const emit = defineEmits(['retry', 'close']);
const labels: Record<string, string> = {
  queued: '等待上传',
  uploading: '上传中',
  processing: '解析与归档',
  reconciling: '核对原回执',
  ready: '就绪',
  failed: '需要处理',
  'needs-file': '需要原文件',
};
</script>
<template>
  <section class="import-progress" aria-label="逐文件导入">
    <header><strong>导入文件</strong><button @click="emit('close')">收起</button></header>
    <article v-for="i in items" :key="i.key">
      <span>{{ i.name }}</span
      ><small>{{ labels[i.status] }} {{ i.status === 'uploading' ? i.progress + '%' : '' }}</small>
      <p v-if="i.error">{{ i.error }}</p>
      <button v-if="['failed', 'needs-file'].includes(i.status)" @click="emit('retry', i)">
        核对 / 继续此文件
      </button>
    </article>
  </section>
</template>
