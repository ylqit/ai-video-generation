<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, downloadJson } from './api';
import ContractField from './ContractField.vue';
const props = defineProps<{ seriesId: string; projectId: string }>();
const draft = ref<any>(null),
  prepared = ref<any>(null),
  saved = ref<any>(null),
  error = ref('');
watch(
  () => props.seriesId,
  () => {
    draft.value = {
      seriesId: props.seriesId,
      seeds: [104729, 130363],
      assets: [],
      recipe: {
        baseline: 'native-h3-directed-v4',
        experimental: 'campus-state-order',
        experimentalRevision: 'proposal-1',
        change: '同一事实与素材，仅调整当前状态、事件先后和揭示窗口；须先采用专业修订再编译',
      },
      environment: { nodeVersion: '', workflowDigest: '', inspected: false },
      quote: {
        source: '',
        checkedAt: '',
        currency: 'CNY',
        videoPerRequest: null,
        textPerRequest: null,
      },
    };
    prepared.value = saved.value = null;
  },
  { immediate: true },
);
watch(
  draft,
  () => {
    prepared.value = saved.value = null;
  },
  { deep: true },
);
async function prepare() {
  try {
    prepared.value = await api(
      `/projects/${props.projectId}/validation-experiments/prepare`,
      'POST',
      draft.value,
    );
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function save() {
  try {
    saved.value = await api(`/projects/${props.projectId}/validation-experiments`, 'POST', {
      input: draft.value,
      digest: prepared.value.digest,
      idempotencyKey: `experiment-${prepared.value.digest}`,
    });
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <details class="panel">
    <summary>校园二维日漫 · 真实对照准备包</summary>
    <p>
      人物 16 次、动作 12 次、剧情 10 次；视频总上限 38 次 / 380 请求秒，另列文字 8
      次。此入口只准备与保存实验，不提交任何任务。
    </p>
    <ContractField label="固定条件、已审素材角色、环境及报价依据" v-model="draft" />
    <button @click="prepare">检查并准备对照清单</button>
    <p class="error" v-if="error">{{ error }}</p>
    <div v-if="prepared">
      <p v-for="b in prepared.blockers" class="warning">{{ b }}</p>
      <p>冻结摘要 {{ prepared.digest }} · 当前执行授权：无</p>
      <table>
        <thead>
          <tr>
            <th>案例</th>
            <th>条件差异</th>
            <th>缺少的素材／实际前段</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="c in prepared.cases">
            <td>{{ c.id }}</td>
            <td>{{ c.difference }}</td>
            <td>{{ c.missing.join('、') }} {{ c.dependsOn.join('、') }}</td>
          </tr>
        </tbody>
      </table>
      <button @click="save">保存实验准备记录</button
      ><button @click="downloadJson('真实对照验证准备包.json', prepared)">导出完整验证包</button>
    </div>
    <p v-if="saved">已保存 {{ saved.id }}；真实任务 0。后段须等待已采用边界，再重新固定输入。</p>
  </details>
</template>
