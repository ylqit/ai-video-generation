<script setup lang="ts">
import { ref, watch } from 'vue';
import { downloadJson } from './api';
const props = defineProps<{ modelValue: any; label: string }>();
const emit = defineEmits(['update:modelValue']);
const text = ref(''),
  error = ref(''),
  dirty = ref(false);
watch(
  () => props.modelValue,
  (value) => {
    if (!dirty.value) text.value = JSON.stringify(value ?? null, null, 2);
  },
  { immediate: true, deep: true },
);
function apply() {
  try {
    const parsed = JSON.parse(text.value);
    dirty.value = false;
    emit('update:modelValue', parsed);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <details class="panel">
    <summary>{{ label }}</summary>
    <p>编辑后先应用到当前草稿，再使用所在表单的保存或预览。服务端验证引用和业务规则。</p>
    <textarea :aria-label="label" v-model="text" rows="12" @input="dirty = true" />
    <p class="error" v-if="error">{{ error }}</p>
    <button @click="apply">应用字段草稿</button
    ><button @click="downloadJson(label + '.json', { text })">导出编辑内容</button>
  </details>
</template>
