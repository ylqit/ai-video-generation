<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from './api';
const props = defineProps<{ facts: any[]; progress: any; seriesId: string }>();
const query = ref(''),
  page = ref(0),
  selected = ref<any>(null),
  error = ref('');
const rows = computed(() =>
  props.facts
    .flatMap((c) =>
      (c.data.facts || []).map((f: any) => ({
        canon: c,
        fact: f,
        problems:
          props.progress?.facts?.find((p: any) => p.id === c.id)?.problems ||
          (c.data.stale ? ['待复核'] : []),
      })),
    )
    .filter((r) =>
      `${r.fact.text} ${r.fact.instanceIds?.join(' ')} ${r.fact.kind} ${r.fact.effective?.slotId}`.includes(
        query.value,
      ),
    ),
);
watch(
  () => props.seriesId,
  () => {
    page.value = 0;
    selected.value = null;
    query.value = '';
  },
);
async function openSource(source: any) {
  selected.value = null;
  error.value = '';
  const reference = source.selection || source.series || source.reference;
  if (!reference) {
    error.value = '此记录没有固定来源';
    return;
  }
  const id = props.seriesId;
  try {
    const record = await api(`/records/${reference.id}?revision=${reference.revision}`);
    if (id === props.seriesId) selected.value = { source, record };
  } catch (e: any) {
    if (id === props.seriesId) error.value = e.message;
  }
}
</script>
<template>
  <section class="panel">
    <h3>本系列事实与角色认知</h3>
    <p>按固定剧情时点追溯。最近的确认链待复核时，不能回退较旧事实供正式生产。</p>
    <label>筛选内容、实例、类别或分集<input v-model="query" @input="page = 0" /></label>
    <table>
      <thead>
        <tr>
          <th>事实与类别</th>
          <th>来源与时点</th>
          <th>有效性</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows.slice(page * 20, page * 20 + 20)" :key="`${r.canon.id}:${r.fact.id}`">
          <td>
            {{ r.fact.text
            }}<small>{{ r.fact.kind }} · {{ r.fact.operation }} · {{ r.fact.id }}</small>
            <p v-if="r.fact.replaces">替代 {{ r.fact.replaces }}</p>
          </td>
          <td>
            {{ r.fact.effective?.slotId }}
            <p>Canon {{ r.canon.id }} v{{ r.canon.revision }}</p>
            <button @click="openSource(r.fact.source)">
              {{ r.fact.source?.kind || '未核实' }} · 查看固定证据
            </button>
          </td>
          <td>
            {{
              r.problems.length
                ? r.problems.join('；')
                : r.canon.data.confirmed
                  ? '已确认'
                  : '未确认'
            }}
          </td>
        </tr>
      </tbody>
    </table>
    <p v-if="!rows.length">没有符合筛选条件的确认事实。</p>
    <button :disabled="!page" @click="page--">上一页事实</button
    ><span>{{ rows.length }} 项 · 第 {{ page + 1 }} 页</span
    ><button :disabled="(page + 1) * 20 >= rows.length" @click="page++">下一页事实</button>
    <p class="error" v-if="error">{{ error }}</p>
    <details v-if="selected" open>
      <summary>固定来源及证据定位</summary>
      <pre>{{ JSON.stringify(selected, null, 2) }}</pre>
    </details>
  </section>
</template>
<style scoped>
small {
  display: block;
}
pre {
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
}
</style>
