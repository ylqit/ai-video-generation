<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue';
import { api } from './api';
import { speechCapabilities, isSpeechProtocol } from '../shared/speech';
const props = defineProps<{
    voice: any;
    projectId?: string;
    line?: any;
    text?: string;
    operation?: 'speech' | 'voice_clone';
  }>(),
  emit = defineEmits(['submitted']);
const models = ref<any[]>([]),
  chosen = ref(''),
  text = ref(props.text || '这是用于确认声音身份与发音的试听。'),
  performance = ref<any>({ instructions: '' }),
  options = ref<any>({}),
  sampleIndex = ref(0),
  authorized = ref(false),
  activate = ref(false),
  preview = ref<any>(null),
  request = ref<any>(null),
  error = ref(''),
  busy = ref(false),
  key = ref(''),
  job = ref('');
const operation = computed(() => props.operation || 'speech');
watch(chosen, () => {
  options.value = {};
  performance.value = { instructions: '' };
});
const selection = computed(() =>
  operation.value === 'speech' && props.voice.data.handle
    ? { connection: props.voice.data.handle.connection, modelId: props.voice.data.handle.modelId }
    : models.value.find((m) => m.key === chosen.value)?.selection,
);
const protocol = computed(() =>
  operation.value === 'speech'
    ? props.voice.data.handle?.protocol
    : models.value.find((m) => m.key === chosen.value)?.protocol,
);
const controls = computed(() =>
  isSpeechProtocol(protocol.value || '')
    ? speechCapabilities[protocol.value as keyof typeof speechCapabilities].controls
    : [],
);
const ranges = computed<Record<string, readonly number[]>>(() =>
  isSpeechProtocol(protocol.value || '')
    ? speechCapabilities[protocol.value as keyof typeof speechCapabilities].ranges
    : {},
);
onMounted(async () => {
  try {
    const c = await api('/model-connections');
    models.value = c.connections.flatMap((c: any) =>
      c.data.models
        .filter(
          (m: any) => isSpeechProtocol(c.data.protocol) && c.data.enabled && m.enabled !== false,
        )
        .map((m: any) => ({
          key: c.id + ':' + m.id,
          name: c.data.name + '／' + m.name + ' v' + c.revision,
          protocol: c.data.protocol,
          selection: { connection: { id: c.id, revision: c.revision }, modelId: m.id },
        })),
    );
  } catch (e: any) {
    error.value = e.message;
  }
});
watch(
  [
    () => props.voice,
    () => props.line,
    () => props.text,
    chosen,
    text,
    performance,
    options,
    sampleIndex,
    authorized,
    activate,
  ],
  () => {
    preview.value = null;
    request.value = null;
    job.value = '';
  },
  { deep: true },
);
async function prepare() {
  busy.value = true;
  try {
    const r: any = {
      voice: { id: props.voice.id, revision: props.voice.revision },
      selection: selection.value,
    };
    if (operation.value === 'voice_clone')
      Object.assign(r, {
        sampleIndex: sampleIndex.value,
        authorized: authorized.value,
        providerOptions: options.value,
      });
    else
      Object.assign(r, {
        text: props.text ?? text.value,
        performance: performance.value,
        ...(props.line ? { line: props.line } : {}),
        activateTemporaryVoice: activate.value,
      });
    preview.value = await api(
      '/' +
        operation.value +
        '/preview?' +
        new URLSearchParams({ projectId: props.projectId || '' }),
      'POST',
      r,
    );
    request.value = JSON.parse(JSON.stringify(r));
    key.value = crypto.randomUUID();
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function submit() {
  if (!preview.value || busy.value) return;
  busy.value = true;
  try {
    const j = await api(
      '/' +
        operation.value +
        '/submit?' +
        new URLSearchParams({ projectId: props.projectId || '' }),
      'POST',
      {
        request: request.value,
        digest: preview.value.digest,
        idempotencyKey: key.value,
        approved: true,
      },
    );
    job.value = j.id;
    emit('submitted', j);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="panel">
    <h4>
      {{
        operation === 'voice_clone' ? '准备音色复刻' : projectId ? '准备本句配音' : '生成新的试听'
      }}
    </h4>
    <p v-if="error" class="error">{{ error }}</p>
    <template v-if="operation === 'voice_clone'"
      ><label
        >语音模型<select v-model="chosen">
          <option value="">选择已启用语音模型</option>
          <option v-for="m in models" :key="m.key" :value="m.key">{{ m.name }}</option>
        </select></label
      >
      <label
        >克隆样本<select v-model.number="sampleIndex">
          <option v-for="(s, i) in voice.data.samples" :value="i">
            样本 {{ Number(i) + 1 }} · {{ s.in }}–{{ s.out }} 秒 · {{ s.purpose }}
          </option>
        </select></label
      >
      <label v-if="['minimax-speech', 'doubao-speech'].includes(protocol)"
        >唯一音色 ID／预付费槽位<input v-model="options.voiceId"
      /></label>
      <label v-if="protocol === 'cosyvoice'"
        >音色前缀<input v-model="options.prefix" maxlength="10"
      /></label>
      <label v-if="protocol === 'doubao-speech'"
        >槽位方式<select v-model="options.slotMode">
          <option value="prepaid">已购买槽位</option>
          <option value="postpaid">后付费临时音色</option>
        </select></label
      >
      <label v-if="['baidu-speech', 'tencent-speech'].includes(protocol)"
        >音色名称<input v-model="options.voiceName"
      /></label>
      <template v-if="protocol === 'tencent-speech'"
        ><label>供应商训练文本 ID<input v-model="options.textId" /></label
        ><label
          >供应商性别参数<select v-model.number="options.gender">
            <option :value="1">男声</option>
            <option :value="2">女声</option>
          </select></label
        ></template
      >
      <label
        ><input
          type="checkbox"
          v-model="authorized"
        />已确认此样本的复刻使用权限及供应商所需确认</label
      ></template
    >
    <template v-else
      ><p>
        固定声音 {{ voice.data.name }} v{{ voice.revision }} · {{ protocol }} ·
        {{ voice.data.handle?.modelId }}
      </p>
      <label
        >原文<textarea v-if="!text || !line" v-model="text" />
        <pre v-else>{{ props.text }}</pre>
      </label>
      <div class="form-grid">
        <label v-for="c in controls" :key="c"
          >{{ c }}（{{ ranges[c] ? ranges[c].join(' 至 ') : '供应商情绪名称' }}，可留空）<input
            v-if="c === 'emotion'"
            v-model="performance[c]" /><input
            v-else
            type="number"
            step="any"
            :min="ranges[c]?.[0]"
            :max="ranges[c]?.[1]"
            :value="performance[c]"
            @input="
              performance[c] =
                ($event.target as HTMLInputElement).value === ''
                  ? undefined
                  : Number(($event.target as HTMLInputElement).value)
            "
        /></label>
      </div>
      <label>人工表演说明<textarea v-model="performance.instructions" /></label
      ><label v-if="protocol === 'doubao-speech'"
        ><input type="checkbox" v-model="activate" />确认临时音色首次合成可能激活收费槽位</label
      ></template
    >
    <button :disabled="busy" @click="prepare">查看固定预览（不生成）</button>
    <template v-if="preview"
      ><p>
        本次：音色创建 {{ preview.usage.voiceCreations }} · 合成
        {{ preview.usage.speechRequests }} 次／{{ preview.usage.characters }} 字。费用待供应商核定。
      </p>
      <p v-for="w in preview.warnings">{{ w }}</p>
      <details>
        <summary>输入、声音版本与摘要</summary>
        <pre>{{ JSON.stringify(preview, null, 2) }}</pre>
      </details>
      <button :disabled="busy || !!job" @click="submit">确认此输入并创建任务</button></template
    >
    <p v-if="job">
      已创建任务 {{ job }}，可在任务中心跟踪及听审。保存响应不明时复用同一提交键核对。
    </p>
  </section>
</template>
