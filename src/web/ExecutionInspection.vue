<script setup lang="ts">
import { computed, ref } from 'vue';
const props = defineProps<{ preview: any }>();
const filter = ref('all'),
  page = ref(0);
const meanings: Record<string, string> = {
  text_request: '文字请求，需实片核对',
  model_input: '已连接模型条件',
  planning_check: '规划／预演检查',
  post_generation_review: '生成后审核',
  unsupported: '当前适配器不支持',
  excluded: '范围不符，已排除',
  not_consumed: '创作依据，未进入执行正文',
  consumed: '历史消费记录，需查看具体去向',
};
const rows = computed(() =>
  (props.preview?.preview?.inputs || props.preview?.inputs || []).flatMap((input: any) => {
    const prepared = input.prepared || input.input?.prepared || {};
    const seen = new Set<string>();
    return [...(prepared.consumption || []), ...(prepared.trace || [])]
      .filter((r) => {
        const key = JSON.stringify([r.shotId, r.field, r.status]);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((r: any) => ({
        ...r,
        group: input.segmentId || input.segment?.id || input.input?.segment?.id || '',
      }));
  }),
);
const visible = computed(() =>
  rows.value.filter((r: any) => filter.value === 'all' || r.status === filter.value),
);
</script>
<template>
  <details class="panel">
    <summary>要求实际进入了哪里 · {{ rows.length }} 项消费记录</summary>
    <p>文字、图片条件和预演都不能代替生成后的实际审核。</p>
    <label
      >消费方式<select v-model="filter" @change="page = 0">
        <option value="all">全部</option>
        <option v-for="(label, key) in meanings" :key="key" :value="key">{{ label }}</option>
      </select></label
    >
    <p v-if="!rows.length">当前预览尚未产生编译结果，请先处理上方输入问题。</p>
    <table v-else>
      <thead>
        <tr>
          <th>组／镜头</th>
          <th>要求</th>
          <th>实际用途</th>
          <th>原因与消费方</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(row, i) in visible.slice(page * 30, (page + 1) * 30)" :key="i">
          <td>{{ row.group }} / {{ row.shotId }}</td>
          <td>{{ row.field }}</td>
          <td>{{ meanings[row.status] || row.status }}</td>
          <td>
            {{ row.reason }}<small>{{ row.consumers?.join('、') }}</small>
          </td>
        </tr>
      </tbody>
    </table>
    <button :disabled="page === 0" @click="page--">上一页</button
    ><span>{{ visible.length }} 项 · 第 {{ page + 1 }} 页</span
    ><button :disabled="(page + 1) * 30 >= visible.length" @click="page++">下一页</button>
  </details>
</template>
<style scoped>
td {
  overflow-wrap: anywhere;
}
small {
  display: block;
}
</style>
