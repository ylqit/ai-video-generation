<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { WorkspaceData } from './workspace-data';
const props = defineProps<{ projectId: string; kind: string; label?: string }>();
const emit = defineEmits(['select']);
const q = ref(''),
  offset = ref(0),
  page = ref<any>({ items: [], total: 0 }),
  error = ref('');
const data = new WorkspaceData();
let ticket = 0;
async function load() {
  const t = ++ticket;
  data.begin();
  error.value = '';
  try {
    const r = await data.read(
      `/projects/${props.projectId}/record-index?kind=${encodeURIComponent(props.kind)}&q=${encodeURIComponent(q.value)}&offset=${offset.value}&limit=25`,
    );
    if (t === ticket) page.value = r;
  } catch (e: any) {
    if (e.name !== 'AbortError') error.value = e.message;
  }
}
watch(
  () => [props.projectId, props.kind, q.value],
  () => {
    offset.value = 0;
    void load();
  },
  { immediate: true },
);
watch(offset, load);
onBeforeUnmount(() => data.dispose());
</script>
<template>
  <div class="record-picker">
    <label>{{ label || '搜索引用' }}<input v-model="q" placeholder="按名称搜索整个项目" /></label>
    <p class="error" v-if="error">{{ error }}</p>
    <select
      :aria-label="label || '选择固定引用'"
      @change="
        emit(
          'select',
          page.items.find((d: any) => d.id === ($event.target as HTMLSelectElement).value),
        );
        ($event.target as HTMLSelectElement).value = '';
      "
    >
      <option value="">选择固定版本 · {{ page.total }} 项</option>
      <option v-for="d in page.items" :value="d.id">{{ d.name }} · v{{ d.revision }}</option>
    </select>
    <div class="actions">
      <button :disabled="offset === 0" @click="offset = Math.max(0, offset - 25)">上一页</button
      ><button :disabled="offset + 25 >= page.total" @click="offset += 25">下一页</button>
    </div>
  </div>
</template>
