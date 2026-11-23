<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from './api';
import { speechAllowanceSchema } from '../shared/speech';
const props = defineProps<{ projectId?: string }>();
const policy = ref<any>({ revision: 0, data: speechAllowanceSchema.parse({}) }),
  usage = ref<any>({}),
  connections = ref<any[]>([]),
  error = ref(''),
  saved = ref(false);
const fields = [
  ['maxTranscriptionRequests', '转写请求数'],
  ['maxTranscriptionSeconds', '转写秒数'],
  ['maxVoiceCreations', '音色创建次数'],
  ['maxSpeechRequests', '合成请求数'],
  ['maxSpeechCharacters', '合成字符数'],
  ['maxLipSyncRequests', '口型请求数'],
  ['maxLipSyncSeconds', '口型秒数'],
];
async function load() {
  try {
    const [p, c] = await Promise.all([
      api('/speech-allowance?' + new URLSearchParams({ projectId: props.projectId || '' })),
      api('/model-connections'),
    ]);
    policy.value = { ...p.policy, data: speechAllowanceSchema.parse(p.policy.data) };
    usage.value = p.usage;
    connections.value = c.connections.filter((v: any) =>
      v.models.some((m: any) => m.capabilities.kind === 'speech' || m.preset === 'sync-lipsync'),
    );
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
function toggle(c: any, checked: boolean) {
  const refs = policy.value.data.connections;
  policy.value.data.connections = refs.filter((r: any) => r.id !== c.id);
  if (checked) policy.value.data.connections.push({ id: c.id, revision: c.revision });
  saved.value = false;
}
async function save() {
  try {
    policy.value = await api(
      '/speech-allowance?' + new URLSearchParams({ projectId: props.projectId || '' }),
      'PUT',
      policy.value,
    );
    saved.value = true;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
watch(() => props.projectId, load, { immediate: true });
</script>
<template>
  <details class="panel">
    <summary>{{ projectId ? '本作品' : '全局音色' }}声音执行范围与额度</summary>
    <p>
      额度累计计入已提交准备的任务；失败或受理不明不自动返还。费用未知，不显示为零。保存额度不会生成声音。
    </p>
    <p class="error" v-if="error">{{ error }}</p>
    <label><input type="checkbox" v-model="policy.data.enabled" />启用此范围的声音请求</label>
    <label v-for="c in connections" :key="c.id"
      ><input
        type="checkbox"
        :checked="
          policy.data.connections.some((r: any) => r.id === c.id && r.revision === c.revision)
        "
        @change="toggle(c, ($event.target as HTMLInputElement).checked)"
      />{{ c.data.name }} v{{ c.revision }}</label
    >
    <div class="form-grid">
      <label v-for="[key, label] in fields" :key="key"
        >{{ label }}<input type="number" min="0" v-model.number="policy.data[key]"
      /></label>
    </div>
    <p>
      已占用：创建 {{ usage.voiceCreations || 0 }} 次 · 合成 {{ usage.speechRequests || 0 }} 次／{{
        usage.speechCharacters || 0
      }}
      字 · 口型 {{ usage.lipSyncRequests || 0 }} 次／{{ usage.lipSyncSeconds || 0 }} 秒
    </p>
    <button @click="save">保存范围与额度</button><span v-if="saved">已保存</span>
  </details>
</template>
