<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, downloadJson } from './api';
import RecordPicker from './RecordPicker.vue';
import ContractField from './ContractField.vue';
import AdaptationIntent from './AdaptationIntent.vue';
const props = defineProps<{
  seriesId: string;
  projectId: string;
  seriesRevision: number;
  plan: any;
}>();
const emit = defineEmits(['refresh']);
const request = ref(''),
  approach = ref('specification_first'),
  sources = ref<any[]>([]),
  adaptation = ref<any>({
    version: 1,
    mode: 'original',
    preserve: [],
    allow: [],
    pending: [],
    decisions: [],
  }),
  prepared = ref<any>(null),
  result = ref<any>(null),
  proposals = ref<any[]>([]),
  preview = ref<any>(null),
  chosen = ref<any>(null),
  error = ref(''),
  busy = ref(false);
watch(
  () => [props.seriesId, props.seriesRevision],
  async () => {
    prepared.value = preview.value = null;
    await load();
  },
  { immediate: true },
);
watch(
  [request, approach, sources, adaptation],
  () => {
    prepared.value = null;
  },
  { deep: true },
);
async function load() {
  const id = props.seriesId;
  try {
    const docs = await api(`/series/${id}/proposals`);
    if (id === props.seriesId) proposals.value = docs;
  } catch (e: any) {
    error.value = e.message;
  }
}
function input() {
  return {
    request: request.value,
    approach: approach.value,
    requestedEpisodes: approach.value === 'specification_first' ? props.plan.targetEpisodes : null,
    requestedRuntime: approach.value === 'specification_first' ? props.plan.runtime : null,
    sources: sources.value,
    adaptation: adaptation.value,
  };
}
async function prepare() {
  try {
    prepared.value = await api(`/series/${props.seriesId}/proposals/prepare`, 'POST', input());
    error.value = '';
    result.value ||= {
      version: 1,
      title: '',
      rationale: '',
      story: { goal: '', conflict: '', ending: '', characters: [], information: [] },
      episodes: [
        {
          title: '',
          question: '',
          conflict: '',
          choice: '',
          outcome: '',
          openQuestions: [],
          runtime: { ...props.plan.runtime },
          sourceEntryIds: [],
        },
      ],
      assumptions: [],
      openQuestions: [],
    };
  } catch (e: any) {
    error.value = e.message;
  }
}
async function generate() {
  busy.value = true;
  try {
    const job = await api(`/series/${props.seriesId}/proposals/generate`, 'POST', {
      input: input(),
      digest: prepared.value.digest,
      approved: true,
      idempotencyKey: crypto.randomUUID(),
    });
    error.value = `文字任务 ${job.id} 已提交；完成后刷新提案。不会自动建立分集或媒体任务。`;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function save() {
  try {
    await api(`/series/${props.seriesId}/proposals`, 'POST', {
      input: input(),
      digest: prepared.value.digest,
      result: result.value,
      idempotencyKey: crypto.randomUUID(),
    });
    await load();
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function compare(p: any) {
  try {
    chosen.value = p;
    preview.value = await api(`/series-proposals/${p.id}/preview`, 'POST', {
      revision: p.revision,
      ...(props.plan.profile ? { profile: props.plan.profile } : {}),
    });
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function apply() {
  busy.value = true;
  try {
    await api(`/series-proposals/${chosen.value.id}/apply`, 'POST', {
      revision: chosen.value.revision,
      ...(props.plan.profile ? { profile: props.plan.profile } : {}),
      digest: preview.value.digest,
      idempotencyKey: `proposal-apply-${preview.value.digest}`,
    });
    preview.value = null;
    emit('refresh');
    await load();
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details class="panel">
    <summary>整季故事提案 · 无剧本也可以开始</summary>
    <p>从一句创意或固定原文形成季纲，审核后应用到现有规划。剧本按集展开，计划不代表实际呈现。</p>
    <label>创意或改编目标<textarea v-model="request" aria-label="整季创意" /></label>
    <label
      >创作起点<select v-model="approach">
        <option value="specification_first">按当前集数与时长创作</option>
        <option value="story_first">先故事，再建议集数与时长</option>
      </select></label
    >
    <AdaptationIntent v-model="adaptation" />
    <RecordPicker
      :project-id="projectId"
      kind="chapter"
      label="固定原文"
      @select="(r) => sources.push({ id: r.id, revision: r.revision })"
    />
    <RecordPicker
      :project-id="projectId"
      kind="source_index"
      label="章节与事件索引"
      @select="(r) => sources.push({ id: r.id, revision: r.revision })"
    />
    <p v-for="(s, i) in sources">
      {{ s.id }} v{{ s.revision }} <button @click="sources.splice(i, 1)">移除</button>
    </p>
    <button @click="prepare">准备整季提案输入（不调用模型）</button
    ><button @click="load">刷新提案</button>
    <p class="error" v-if="error">{{ error }}</p>
    <div v-if="prepared">
      <p>
        固定摘要 {{ prepared.digest }}；文字请求上限 1 次，自动修复 0 次；{{
          prepared.context.modelExecution?.modelId || '尚未配置文字模型，可以手工填写提案'
        }}
      </p>
      <button :disabled="busy || !prepared.context.modelExecution" @click="generate">
        确认执行这一次文字请求
      </button>
      <button @click="downloadJson('整季提案准备.json', prepared)">导出准备结果</button>
      <details>
        <summary>手工编写或粘贴已审核提案</summary>
        <ContractField label="整季提案" v-model="result" /><button @click="save">
          保存待采用提案
        </button>
      </details>
    </div>
    <article v-for="p in proposals" :key="p.id">
      <strong>{{ p.data.result?.title || '未通过结构检查的提案' }}</strong
      ><span> · {{ p.data.adopted ? '曾采用' : '待审核' }}</span>
      <p>{{ p.data.result?.rationale }}</p>
      <p v-for="issue in p.data.issues" class="warning">{{ issue }}</p>
      <details>
        <summary>季纲与逐集变化</summary>
        <pre>{{ JSON.stringify(p.data.result, null, 2) }}</pre>
      </details>
      <button :disabled="!p.data.valid || p.data.adopted" @click="compare(p)">
        比较并预览规划变更
      </button>
    </article>
    <div v-if="preview">
      <p>{{ preview.differences.note }}</p>
      <p v-if="preview.differences.specificationChanged" class="warning">
        提案建议改变请求规格，请核对各集承载量。
      </p>
      <table>
        <thead>
          <tr>
            <th>集</th>
            <th>核心问题与结果</th>
            <th>秒</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in preview.plan.data.slots">
            <td>{{ s.title }} {{ s.active ? '' : '历史保留' }}</td>
            <td>{{ s.question }} → {{ s.outcome }}</td>
            <td>{{ (s.runtime || preview.plan.data.runtime).targetFrames / 24 }}</td>
          </tr>
        </tbody>
      </table>
      <button :disabled="busy" @click="apply">确认采用提案到规划</button>
    </div>
  </details>
</template>
