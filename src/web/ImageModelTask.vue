<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { api } from './api';
const props = defineProps<{ task: any }>();
const emit = defineEmits(['refresh']);
const promptSource = ref('task'),
  overrideReviewed = ref(false),
  basis = ref<any>(null),
  referencePurposes = ref<Record<string, string>>({}),
  referencePreserve = ref<Record<string, string>>({}),
  referenceAllow = ref<Record<string, string>>({});
const viewId = ref(''),
  operation = ref('generate'),
  prompt = ref(''),
  references = ref<string[]>([]),
  assets = ref<any[]>([]);
const preview = ref<any>(null),
  job = ref<any>(null),
  error = ref(''),
  busy = ref(false);
let alive = true,
  loadTicket = 0;
onBeforeUnmount(() => {
  alive = false;
});
watch(
  () => props.task.id,
  async () => {
    const ticket = ++loadTicket;
    viewId.value = props.task.data.views?.[0]?.id || '';
    prompt.value =
      typeof props.task.data.requirements === 'string'
        ? props.task.data.requirements
        : JSON.stringify(props.task.data.requirements, null, 2);
    preview.value = null;
    job.value = null;
    try {
      const list = await api(
        `/projects/${props.task.projectId}/records?kind=asset&mediaType=image&limit=100`,
      );
      if (alive && ticket === loadTicket)
        assets.value = (list.items || list).filter((a: any) => a.data?.adopted && !a.data?.stale);
    } catch (e: any) {
      if (alive) error.value = e.message;
    }
  },
  { immediate: true },
);
watch(
  [
    viewId,
    operation,
    prompt,
    promptSource,
    overrideReviewed,
    referencePurposes,
    referencePreserve,
    referenceAllow,
    references,
    () => props.task.revision,
  ],
  () => {
    preview.value = null;
  },
  { deep: true },
);
watch(
  [viewId, () => props.task.id, () => props.task.revision],
  async () => {
    if (!viewId.value) return;
    const view = viewId.value,
      revision = props.task.revision,
      taskId = props.task.id;
    basis.value = null;
    try {
      const data = await api(
        `/asset-tasks/${props.task.id}/preparation?viewId=${encodeURIComponent(view)}`,
      );
      if (
        alive &&
        props.task.id === taskId &&
        viewId.value === view &&
        props.task.revision === revision
      )
        basis.value = data;
    } catch (e: any) {
      if (alive) error.value = e.message;
    }
  },
  { immediate: true },
);
async function prepare() {
  busy.value = true;
  error.value = '';
  preview.value = null;
  try {
    const preparation = {
      promptSource: promptSource.value,
      overrideReviewed: overrideReviewed.value,
      referenceUses: references.value.map((id) => ({
        asset: { id, revision: assets.value.find((a) => a.id === id).revision },
        purpose: referencePurposes.value[id] || 'identity',
        preserve: (referencePreserve.value[id] || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
        allow: (referenceAllow.value[id] || '')
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      })),
      taskRevision: props.task.revision,
      viewId: viewId.value,
      operation: operation.value,
      prompt: prompt.value,
      references: references.value.map((id) => ({
        id,
        revision: assets.value.find((a) => a.id === id).revision,
      })),
    };
    const result = await api(`/asset-tasks/${props.task.id}/model-preview`, 'POST', preparation);
    preview.value = { ...result, preparation, idempotencyKey: crypto.randomUUID() };
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function submit() {
  if (!preview.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    job.value = await api(`/asset-tasks/${props.task.id}/model-generate`, 'POST', {
      preparation: preview.value.preparation,
      digest: preview.value.digest,
      idempotencyKey: preview.value.idempotencyKey,
      approved: true,
    });
    preview.value = null;
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function refresh() {
  try {
    job.value = await api(`/jobs/${job.value.id}`);
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <details class="image-model-task">
    <summary>使用已配置的图片模型制作候选</summary>
    <p>
      先在模型设置固定图片模型与项目额度。预览只检查固定输入；确认后进入原任务队列，结果需审看采用。
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <fieldset :disabled="busy">
      <label
        >视图<select v-model="viewId">
          <option v-for="v in task.data.views" :value="v.id">{{ v.label || v.id }}</option>
        </select></label
      >
      <label
        >操作<select v-model="operation">
          <option value="generate">生成</option>
          <option value="edit">编辑参考图</option>
        </select></label
      >
      <label
        >图片要求来源<select v-model="promptSource">
          <option value="task">已采用的素材任务（推荐）</option>
          <option value="reviewed_override">明确核对的覆盖文本</option>
        </select></label
      >
      <template v-if="promptSource === 'task'">
        <pre>{{ basis?.prompt || '正在读取固定需求' }}</pre>
        <p v-if="basis?.direction">
          视觉方向依据：v{{ basis.direction.reference.revision }} · {{ basis.direction.visual
          }}<br />固定视觉语言与当前图片要求共同进入执行正文；后续剧情不进入图片身份描述。
        </p></template
      >
      <template v-else
        ><label>本次图片要求<textarea v-model="prompt" rows="8" /></label
        ><label
          ><input
            type="checkbox"
            v-model="overrideReviewed"
          />已核对覆盖文本与素材用途、当前视觉方向及剧情状态</label
        ></template
      >
      <div v-if="operation === 'edit'">
        <div v-for="a in assets" :key="a.id">
          <label
            ><input type="checkbox" v-model="references" :value="a.id" />{{
              a.data.name || a.id
            }}
            v{{ a.revision
            }}<select
              v-if="references.includes(a.id)"
              v-model="referencePurposes[a.id]"
              aria-label="图片参考用途"
            >
              <option value="identity">身份（默认）</option>
              <option value="appearance">当前外观</option>
              <option value="environment">环境</option>
              <option value="style">画风</option>
              <option value="composition">构图</option>
              <option value="action_start">动作起点</option>
              <option value="action_end">动作终点</option>
            </select></label
          >
          <template v-if="references.includes(a.id)">
            <label
              >此图需要保持（每行一项）<textarea v-model="referencePreserve[a.id]" rows="2" />
            </label>
            <label
              >此图允许改变（每行一项）<textarea v-model="referenceAllow[a.id]" rows="2" />
            </label>
          </template>
        </div>
        <p v-if="!assets.length">先在素材库导入并采用参考图片。</p>
      </div>
      <button @click="prepare">查看图片执行预览</button>
    </fieldset>
    <div v-if="preview">
      <p>
        {{ preview.input.modelExecution.connection.data.name }} ·
        {{ preview.input.modelExecution.modelId }} · 固定 v{{
          preview.input.modelExecution.connection.revision
        }}
      </p>
      <pre>{{ preview.input.prepared.request }}</pre>
      <details>
        <summary>参考绑定与消费说明</summary>
        <pre>{{ preview.input.prepared.bindings }}</pre>
        <pre>{{ preview.input.prepared.consumption }}</pre>
      </details>
      <p>
        参考：{{
          preview.input.assets.map((a: any) => `${a.asset.id} v${a.asset.revision}`).join('、') ||
          '无'
        }}
      </p>
      <button :disabled="busy" class="primary" @click="submit">
        确认生成 {{ preview.input.prepared.request.n }} 张候选
      </button>
    </div>
    <p v-if="job">
      任务 {{ job.id }} · {{ job.state }} <button @click="refresh">刷新结果与候选</button
      ><span v-if="job.error">{{ job.error }}</span>
    </p>
  </details>
</template>
<style scoped>
label {
  display: block;
  margin: 0.6rem 0;
}
textarea {
  width: 100%;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.image-model-task {
  margin: 1rem 0;
  padding: 1rem;
  border: 1px solid var(--border, #ddd);
}
</style>
