<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from './api';
const props = defineProps<{ runId: string; revision: number }>();
const emit = defineEmits(['refresh']);
const view = ref<any>(null),
  bindings = ref<any[]>([]),
  error = ref(''),
  busy = ref(false);
watch(() => [props.runId, props.revision], load, { immediate: true });
async function load() {
  const id = props.runId;
  try {
    const result = await api(`/creation-runs/${id}/subject-bindings`);
    if (id !== props.runId) return;
    view.value = result;
    bindings.value = result.subjects.map((s: any) => ({
      ...s.binding,
      subjectKey: s.key,
      subjectDigest: s.subjectDigest,
      decision: s.binding?.decision || 'new',
      entity: s.binding?.entity || null,
      instanceId: s.binding?.instanceId || null,
      reason: s.binding?.reason || '',
    }));
  } catch (e: any) {
    error.value = e.message;
  }
}
function choose(index: number, value: string) {
  const selected = view.value.available.find(
    (a: any) => `${a.entity.id}:${a.entity.revision}:${a.instanceId}` === value,
  );
  Object.assign(
    bindings.value[index],
    selected
      ? { decision: 'reuse', entity: selected.entity, instanceId: selected.instanceId }
      : { decision: 'new', entity: null, instanceId: null },
  );
}
async function save() {
  busy.value = true;
  try {
    await api(`/creation-runs/${props.runId}/subject-bindings`, 'PUT', {
      revision: view.value.run.revision,
      script: view.value.script,
      bindings: bindings.value,
      idempotencyKey: crypto.randomUUID(),
    });
    error.value = '';
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details class="panel" v-if="view?.subjects.length" open>
    <summary>本集主体与系列实例 · 采用剧本前确认</summary>
    <p>同名只提供提示，不会自动合并。共享外观图仍可对应不同实例；服装、伤损和持物分别管理。</p>
    <p class="error" v-if="error">{{ error }}</p>
    <table>
      <thead>
        <tr>
          <th>本集主体</th>
          <th>明确决定</th>
          <th>理由与实际消费</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(s, i) in view.subjects as any[]" :key="s.key">
          <td>
            {{ s.name }} <small>{{ s.key }}</small>
            <p v-if="s.suggestions.length" class="warning">有同名实例，请核对身份</p>
          </td>
          <td>
            <select
              :disabled="!view.editable"
              :aria-label="`${s.name} 的实例`"
              :value="
                bindings[i].entity
                  ? `${bindings[i].entity.id}:${bindings[i].entity.revision}:${bindings[i].instanceId}`
                  : ''
              "
              @change="choose(i, ($event.target as HTMLSelectElement).value)"
            >
              <option value="">本集新实例</option>
              <option
                v-for="a in view.available"
                :value="`${a.entity.id}:${a.entity.revision}:${a.instanceId}`"
              >
                {{ a.name }} · {{ a.instanceId }} · v{{ a.entity.revision }}
              </option>
            </select>
          </td>
          <td>
            <input
              v-model="bindings[i].reason"
              :disabled="!view.editable"
              placeholder="身份核对理由"
            /><small v-if="s.consumed"
              >当前准备使用 {{ s.consumed.instanceId }} / {{ s.consumed.entity.id }} v{{
                s.consumed.entity.revision
              }}</small
            >
          </td>
        </tr>
      </tbody>
    </table>
    <p v-for="problem in view.issues" class="warning">{{ problem }}</p>
    <button v-if="view.editable" @click="save" :disabled="busy">确认当前剧本的实例映射</button>
    <p v-else>当前剧本已固定；如需改动身份映射，请先发起剧本修订。</p>
  </details>
</template>
