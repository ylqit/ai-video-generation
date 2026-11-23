<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CanvasNode } from '../shared/canvas';
import { api } from './api';
const props = defineProps<{ node: CanvasNode }>();
const emit = defineEmits(['change', 'rewrite', 'select']);
const mode = ref('edit'),
  area = ref<HTMLTextAreaElement>(),
  baseline = ref(props.node.text),
  compareRevision = ref(props.node.document?.revision || 1),
  compareError = ref(''),
  start = ref(0),
  end = ref(0);
const blocks = computed(() =>
  props.node.text.split('\n').map((text) => ({
    text: text.replace(/^#{1,6}\s|^[-*]\s/, ''),
    heading: /^#{1,6}\s/.test(text),
    bullet: /^[-*]\s/.test(text),
  })),
);
async function loadVersion() {
  if (!props.node.document) return;
  try {
    const record = await api(
      `/records/${props.node.document.id}/versions/${compareRevision.value}`,
    );
    baseline.value = record.data.content;
    compareError.value = '';
  } catch (e: any) {
    compareError.value = e.message;
  }
}
function selected() {
  start.value = area.value?.selectionStart || 0;
  end.value = area.value?.selectionEnd || 0;
  emit('select', props.node.id);
}
</script>
<template>
  <article class="document-paper">
    <header>
      <input v-model="node.title" aria-label="文档标题" @input="emit('change')" />
      <div class="button-row">
        <button @click="mode = 'edit'">编辑</button
        ><button @click="mode = 'read'">Markdown 基础阅读</button
        ><button @click="mode = 'compare'">比较本次修改</button>
      </div>
    </header>
    <textarea
      v-if="mode === 'edit'"
      ref="area"
      v-model="node.text"
      @input="emit('change')"
      @select="selected"
      placeholder="创意、原文、剧本…"
    />
    <div v-else-if="mode === 'read'" class="markdown-reading">
      <template v-for="(b, i) in blocks" :key="i"
        ><h3 v-if="b.heading">{{ b.text }}</h3>
        <p v-else>{{ b.bullet ? '• ' : '' }}{{ b.text }}</p></template
      >
    </div>
    <section v-else>
      <div v-if="node.document" class="button-row">
        <label
          >比较固定版本<input
            type="number"
            min="1"
            :max="node.document.revision"
            v-model.number="compareRevision" /></label
        ><button @click="loadVersion">读取历史正文</button>
      </div>
      <p v-if="compareError" class="inline-error">{{ compareError }}</p>
      <div class="document-comparison">
        <div>
          比较依据
          <pre>{{ baseline }}</pre>
        </div>
        <div>
          当前编辑
          <pre>{{ node.text }}</pre>
        </div>
      </div>
    </section>
    <footer>
      <small>固定文档 v{{ node.document?.revision || 1 }} · 正文与画布共用</small
      ><button
        :disabled="end <= start"
        @click="
          emit('rewrite', { nodeId: node.id, start, end, expected: node.text.slice(start, end) })
        "
      >
        改写所选文字
      </button>
    </footer>
  </article>
</template>
<style scoped>
.document-paper header {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.document-paper header > input {
  flex: 1;
}
.document-paper footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.markdown-reading {
  padding: 20px;
  white-space: pre-wrap;
  min-height: 220px;
}
.document-comparison {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.document-comparison pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: #f7f5fb;
  padding: 15px;
  font-size: 13px;
}
.document-paper button {
  font-size: 11px;
}
</style>
