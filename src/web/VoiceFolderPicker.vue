<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from './api';
const props = defineProps<{ value?: string | null; label?: string }>(),
  emit = defineEmits(['select']);
const trail = ref<any[]>([]),
  selectedPath = ref<any[]>([]),
  folders = ref<any[]>([]),
  error = ref('');
async function open(index: number, folder?: any) {
  try {
    trail.value = trail.value.slice(0, index);
    if (folder) trail.value.push(folder);
    folders.value = await api(
      '/voice-folders?' + new URLSearchParams({ parentId: trail.value.at(-1)?.id || '' }),
    );
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
watch(
  () => props.value,
  async (id) => {
    try {
      selectedPath.value = id ? await api(`/voice-folders/${id}/path`) : [];
      trail.value = [...selectedPath.value];
      await open(trail.value.length);
    } catch (e: any) {
      error.value = e.message;
    }
  },
  { immediate: true },
);
</script>
<template>
  <details>
    <summary>
      {{ label || '选择目录' }} · {{ selectedPath.map((f) => f.name).join(' / ') || '根目录' }}
    </summary>
    <nav aria-label="音色目录">
      <button type="button" @click="open(0)">根目录</button
      ><button type="button" v-for="(f, i) in trail" :key="f.id" @click="open(i + 1)">
        {{ f.name }} /
      </button>
    </nav>
    <button type="button" v-for="f in folders" :key="f.id" @click="open(trail.length, f)">
      ▸ {{ f.name }}
    </button>
    <p v-if="error" class="error">{{ error }}</p>
    <button type="button" @click="emit('select', trail.at(-1)?.id || null)">使用当前目录</button>
  </details>
</template>
