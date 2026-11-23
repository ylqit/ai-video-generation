<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { CanvasNode, CanvasContent } from '../shared/canvas';
import { modelCapabilities } from '../shared/models';
import { modelParameterFields, generationCompatibility } from '../shared/model-parameters';
import { api } from './api';
import MediaPreview from './MediaPreview.vue';
import ContextReferencePicker from './ContextReferencePicker.vue';
const props = defineProps<{
  node: CanvasNode;
  canvasId: string;
  projectId: string;
  nodes: CanvasNode[];
  edges: CanvasContent['edges'];
  preview: any;
  busy: boolean;
  jobs: any[];
}>();
const emit = defineEmits([
  'change',
  'prepare',
  'generate',
  'models',
  'candidate',
  'reference',
  'upload',
  'remove-edge',
  'operation',
]);
const models = ref<any[]>([]),
  key = ref(''),
  error = ref(''),
  picker = ref(false),
  purpose = ref('identity'),
  page = ref(0);
const model = computed(() => models.value.find((m) => m.key === key.value));
const incoming = computed(() =>
  props.edges
    .filter((e) => e.target === props.node.id && e.relation === 'input')
    .sort((a, b) => (a.order || 0) - (b.order || 0)),
);
const conflicts = computed(() =>
  model.value && props.node.generation
    ? generationCompatibility(props.node.generation, model.value.protocol, model.value.capabilities)
    : [],
);
const history = computed(() =>
  [...(props.node.outputs || [])].reverse().slice(page.value * 4, page.value * 4 + 4),
);
const pending = computed(() => props.jobs.filter((j) => j.nodeId === props.node.id));
async function load() {
  try {
    const r = await api('/model-catalog'),
      kind = props.node.type === 'image_generate' ? 'image' : 'video';
    models.value = r.models
      .filter((m: any) => m.available && m.kind === kind && m.protocol !== 'sync-lipsync')
      .map((m: any) => ({ ...m, key: m.connection.id + ':' + m.connection.revision + ':' + m.id }));
    const s = props.node.generation?.model;
    if (s) {
      key.value = s.connection.id + ':' + s.connection.revision + ':' + s.modelId;
      if (!model.value) {
        const c = await api(
            '/model-connections/' + s.connection.id + '/versions/' + s.connection.revision,
          ),
          m = c.models.find((m: any) => m.id === s.modelId);
        if (m)
          models.value.push({
            ...m,
            key: key.value,
            connection: c,
            protocol: c.data.protocol,
            capabilities: modelCapabilities(m.preset, m.imageInput),
            parameterFields: modelParameterFields(
              c.data.protocol,
              modelCapabilities(m.preset, m.imageInput),
            ),
          });
      }
    }
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(load);
function choose() {
  const m = model.value;
  if (!m) return;
  const previous = props.node.generation;
  props.node.generation = {
    ...(previous || {
      mode: props.node.type === 'image_generate' ? 'generate' : 't2v',
      seconds: 10,
      sound: '',
      music: '',
    }),
    model: {
      connection: { id: m.connection.id, revision: m.connection.revision },
      modelId: m.id,
      mode: 'authored',
      promptProfile: 'automatic',
      parameters: { ...previous?.model.parameters },
    },
  };
  emit('change');
}
function parameter(key: string, value: any) {
  if (!props.node.generation) return;
  const p = props.node.generation.model.parameters as any;
  if (value === undefined || value === '') delete p[key];
  else p[key] = value;
  emit('change');
}
function reorder(index: number, delta: number) {
  const sorted = [...incoming.value],
    to = index + delta;
  if (to < 0 || to >= sorted.length) return;
  const [e] = sorted.splice(index, 1);
  sorted.splice(to, 0, e);
  sorted.forEach((e, i) => (e.order = i));
  emit('change');
}
watch(
  () => props.node.outputs?.length,
  () => (page.value = 0),
);
</script>
<template>
  <section class="production-tray" aria-label="节点制作托盘">
    <label
      >画面与动作 / Prompt<textarea v-model="node.text" rows="3" @input="emit('change')" />
    </label>
    <label
      >制作模型<select v-model="key" @change="choose">
        <option value="">选择已配置模型</option>
        <option v-for="m in models" :key="m.key" :value="m.key">
          {{ m.name }} · {{ m.connection.name || m.connection.data?.name }} · v{{
            m.connection.revision
          }}
        </option>
      </select></label
    >
    <button v-if="!models.length" @click="emit('models')">配置模型连接</button>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <template v-if="node.generation"
      ><div class="field-pair">
        <label
          >生成模式<select v-model="node.generation.mode" @change="emit('change')">
            <option
              v-if="!model?.capabilities.modes.includes(node.generation.mode)"
              :value="node.generation.mode"
            >
              {{ node.generation.mode }}（待调整）
            </option>
            <option v-for="m in model?.capabilities.modes" :key="m" :value="m">
              {{
                (
                  {
                    t2v: '文生视频',
                    i2v: '首尾帧',
                    ref2va: '参考生成',
                    generate: '生成图片',
                    edit: '编辑图片',
                  } as any
                )[m] || m
              }}
            </option>
          </select></label
        ><label v-if="node.type === 'video_generate'"
          >请求秒数<input
            type="number"
            v-model.number="node.generation.seconds"
            :min="model?.capabilities.minSeconds || 1"
            :max="model?.capabilities.maxSeconds"
            @input="emit('change')"
        /></label>
      </div>
      <details>
        <summary>模型参数与声音</summary>
        <label v-for="f in model?.parameterFields" :key="f.key"
          >{{ f.label
          }}<select
            v-if="f.type === 'select'"
            :value="(node.generation.model.parameters as any)[f.key] || ''"
            @change="parameter(f.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">适配器默认</option>
            <option v-for="v in f.values" :key="v">{{ v }}</option></select
          ><input
            v-else
            type="number"
            :value="(node.generation.model.parameters as any)[f.key]"
            :min="f.min"
            :max="f.max"
            :step="f.step || 1"
            @input="
              parameter(
                f.key,
                ($event.target as HTMLInputElement).value === ''
                  ? undefined
                  : Number(($event.target as HTMLInputElement).value),
              )
            " /></label
        ><template v-if="node.type === 'video_generate'"
          ><label
            >声音环境<textarea v-model="node.generation.sound" @input="emit('change')" /></label
          ><label>音乐<textarea v-model="node.generation.music" @input="emit('change')" /></label
        ></template>
        <p v-for="(value, k) in node.generation.model.parameters" :key="k">
          {{ k }} = {{ value }}
          <button @click="parameter(String(k), undefined)">明确移除此参数</button>
        </p>
      </details></template
    >
    <div class="tray-references">
      <strong>固定输入 · {{ incoming.length }}</strong>
      <div v-for="(e, i) in incoming" :key="e.id" class="tray-reference">
        <span
          >{{ i + 1 }}. {{ nodes.find((n) => n.id === e.source)?.title }}
          <small v-if="e.asset">v{{ e.asset.revision }}</small></span
        ><select v-if="e.purpose" v-model="e.purpose" @change="emit('change')">
          <option
            v-for="p in [
              'identity',
              'style',
              'scene',
              'prop',
              'composition',
              'first_frame',
              'last_frame',
              'motion',
              'audio',
            ]"
            :key="p"
          >
            {{ p }}
          </option></select
        ><button @click="reorder(i, -1)" :disabled="i === 0">↑</button
        ><button @click="reorder(i, 1)" :disabled="i === incoming.length - 1">↓</button
        ><button @click="emit('remove-edge', e.id)">×</button>
      </div>
      <div class="button-row">
        <select v-model="purpose" aria-label="新增参考用途">
          <option
            v-for="p in [
              'identity',
              'style',
              'scene',
              'prop',
              'composition',
              'first_frame',
              'last_frame',
              'motion',
              'audio',
            ]"
            :key="p"
          >
            {{ p }}
          </option></select
        ><button @click="picker = !picker">选择参考</button
        ><label class="attachment-button"
          >上传参考<input
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            @change="
              emit('upload', Array.from(($event.target as HTMLInputElement).files || []), purpose);
              ($event.target as HTMLInputElement).value = '';
            "
        /></label>
      </div>
    </div>
    <ContextReferencePicker
      v-if="picker"
      :project-id="projectId"
      :canvas-id="canvasId"
      :selected="[]"
      @add="emit('reference', $event, purpose)"
      @close="picker = false"
    />
    <p v-for="c in conflicts" :key="c" class="inline-error">{{ c }}</p>
    <div class="button-row">
      <button :disabled="busy || !node.generation || !!conflicts.length" @click="emit('prepare')">
        查看执行输入</button
      ><button
        class="primary"
        :disabled="busy || !preview || !!conflicts.length"
        @click="emit('generate')"
      >
        生成新候选
      </button>
    </div>
    <details v-if="preview" open>
      <summary>{{ preview.input.modelExecution.modelId }} · 固定执行预览</summary>
      <small>{{ preview.input.prepared.rulesVersion }}</small>
      <p v-for="b in preview.input.prepared.inputBindings" :key="b.id">
        {{ b.label }} · {{ b.purpose }} → {{ b.role }}
      </p>
      <details>
        <summary>最终 Prompt 与资料消费</summary>
        <pre>{{ preview.input.prepared.finalPrompt }}</pre>
        <pre>{{ preview.input.consumption }}</pre>
      </details>
      <small>预览无上传、无模型调用。生成按作品额度执行。</small>
    </details>
    <p v-for="j in pending" :key="j.id">
      {{ j.state }} · {{ j.error || j.holdReason || '候选归档后自动回填' }}
    </p>
    <details v-if="node.outputs?.length" open>
      <summary>历史候选 · {{ node.outputs.length }}</summary>
      <div class="tray-candidates">
        <article v-for="o in history" :key="o.key">
          <MediaPreview v-if="o.asset" :asset="o.asset" :type="o.slot" compact /><small>{{
            o.label
          }}</small
          ><button @click="emit('candidate', o)">比较 / 选用</button>
        </article>
      </div>
      <div class="button-row">
        <button :disabled="!page" @click="page--">上一页</button
        ><button :disabled="(page + 1) * 4 >= node.outputs.length" @click="page++">下一页</button>
      </div>
    </details>
  </section>
</template>
