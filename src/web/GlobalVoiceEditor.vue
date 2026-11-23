<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from './api';
import { useDraft } from './drafts';
import { globalVoiceSchema, voiceStateLabels } from '../shared/speech';
import SpeechRequest from './SpeechRequest.vue';
const props = defineProps<{ initial?: any; folderId?: string | null }>(),
  emit = defineEmits(['saved', 'close']);
const current = ref<any>(props.initial || null),
  data = ref<any>(
    JSON.parse(JSON.stringify(props.initial?.data || globalVoiceSchema.parse({ name: '新音色' }))),
  ),
  error = ref(''),
  busy = ref(false),
  models = ref<any[]>([]),
  model = ref(''),
  voiceId = ref(''),
  providerStatus = ref('registered'),
  audition = ref<any>(props.initial?.data.audition),
  notes = ref(''),
  listened = ref(false);
const draft = useDraft(
  () => 'global-voice:' + (props.initial?.id || 'new'),
  () => props.initial?.revision || 0,
  data,
);
onMounted(async () => {
  try {
    const c = await api('/model-connections');
    models.value = c.connections.flatMap((c: any) =>
      c.models
        .filter((m: any) => m.capabilities.kind === 'speech')
        .map((m: any) => ({
          key: c.id + ':' + m.id,
          name: c.data.name + '／' + m.name,
          connection: { id: c.id, revision: c.revision },
          modelId: m.id,
        })),
    );
  } catch (e: any) {
    error.value = e.message;
  }
});
const saveKey = ref(''),
  saveSignature = ref('');
const pendingSaveKey = 'studio:pending-voice-save:' + (props.initial?.id || 'new');
async function save() {
  busy.value = true;
  try {
    const signature = JSON.stringify({
      id: current.value?.id,
      revision: current.value?.revision,
      data: data.value,
    });
    if (signature !== saveSignature.value) {
      saveSignature.value = signature;
      const stored = JSON.parse(localStorage.getItem(pendingSaveKey) || 'null');
      saveKey.value = stored?.signature === signature ? stored.key : crypto.randomUUID();
      localStorage.setItem(pendingSaveKey, JSON.stringify({ signature, key: saveKey.value }));
    }
    let r = await api(
      '/voices' + (current.value ? '/' + current.value.id : ''),
      current.value ? 'PUT' : 'POST',
      { revision: current.value?.revision, data: data.value, idempotencyKey: saveKey.value },
    );
    const creating = !current.value;
    current.value = r;
    if (creating && props.folderId && r.folderId !== props.folderId) {
      await api('/voices/' + r.id + '/metadata', 'PUT', {
        revision: r.metadataRevision,
        folderId: props.folderId,
        enabled: r.enabled,
        favorite: r.favorite,
      });
      r = await api('/voices/' + r.id);
      current.value = r;
    }
    data.value = structuredClone(r.data);
    localStorage.removeItem(pendingSaveKey);
    await draft.discard();
    emit('saved', r);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function upload(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  busy.value = true;
  try {
    const body = new FormData();
    body.set('file', file);
    const m = await api('/voice-media', 'POST', body);
    data.value.samples.push({
      media: { id: m.id, revision: m.revision },
      in: 0,
      out: m.data.duration,
      transcript: '',
      source: file.name,
      purpose: 'reference',
      listened: false,
      notes: '',
    });
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function register() {
  try {
    const m = models.value.find((m) => m.key === model.value);
    if (!m) throw new Error('选择模型');
    const r = await api('/voices/' + current.value.id + '/register', 'POST', {
      revision: current.value.revision,
      handle: {
        connection: m.connection,
        modelId: m.modelId,
        voiceId: voiceId.value,
        providerStatus: providerStatus.value,
      },
    });
    current.value = r;
    data.value = structuredClone(r.data);
    emit('saved', r);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function confirm() {
  try {
    const r = await api('/voices/' + current.value.id + '/confirm', 'POST', {
      revision: current.value.revision,
      review: { audition: audition.value, listened: listened.value, notes: notes.value },
    });
    current.value = r;
    data.value = structuredClone(r.data);
    emit('saved', r);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function refresh() {
  try {
    const r = await api('/voices/' + current.value.id);
    current.value = r;
    data.value = structuredClone(r.data);
    audition.value = r.data.audition;
    emit('saved', r);
  } catch (e: any) {
    error.value = e.message;
  }
}
async function query() {
  try {
    const r = await api('/voices/' + current.value.id + '/query', 'POST', {
      revision: current.value.revision,
    });
    error.value = '远端状态：' + r.providerStatus + '（查询不会生成试听）';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section class="panel">
    <header>
      <h3>{{ current ? '音色版本 · ' + current.revision : '新建全局音色' }}</h3>
      <button @click="emit('close')">关闭</button>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p>{{ draft.message.value }}</p>
    <div class="form-grid">
      <label>名称<input v-model="data.name" /></label
      ><label>语言<input v-model="data.language" /></label
      ><label>声音身份描述<textarea v-model="data.description" /></label
      ><label>发音规范<textarea v-model="data.pronunciation" /></label
      ><label>默认表演说明<textarea v-model="data.performance" /></label
      ><label
        >标签（逗号分隔）<input
          :value="data.tags.join(',')"
          @input="
            data.tags = ($event.target as HTMLInputElement).value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          "
      /></label>
    </div>
    <p>参考样本和克隆输入保存到全局库。成品配音请在作品素材库导入，再绑定台词。</p>
    <label>上传音频<input type="file" accept="audio/*" :disabled="busy" @change="upload" /></label>
    <fieldset v-for="(s, i) in data.samples" :key="s.media.id">
      <legend>样本 {{ Number(i) + 1 }}</legend>
      <audio
        controls
        :src="'/api/voice-media/' + s.media.id + '/file?revision=' + s.media.revision"
      />
      <div class="form-grid">
        <label
          >用途<select v-model="s.purpose">
            <option value="reference">参考样本</option>
            <option value="clone">克隆输入</option>
          </select></label
        ><label>开始秒<input type="number" step="any" v-model.number="s.in" /></label
        ><label>结束秒<input type="number" step="any" v-model.number="s.out" /></label
        ><label>对应文本<textarea v-model="s.transcript" /></label
        ><label>来源<input v-model="s.source" /></label>
      </div>
      <label><input type="checkbox" v-model="s.listened" />已播放所选区间</label
      ><label>听审结论<textarea v-model="s.notes" /></label
      ><button @click="data.samples.splice(i, 1)">移除引用</button>
    </fieldset>
    <button :disabled="busy" @click="save">保存音色版本</button>
    <p>草稿可不含样本。保存资料不会调用模型。</p>
    <template v-if="current"
      ><p>
        当前状态：{{ voiceStateLabels[current.data.state] }} ·
        {{ current.data.handle?.voiceId || '尚无远端身份' }}
      </p>
      <button @click="refresh">重新读取服务器版本</button>
      <details>
        <summary>登记预置或已有供应商音色</summary>
        <label
          >语音模型<select v-model="model">
            <option value="">选择语音模型</option>
            <option v-for="m in models" :value="m.key">{{ m.name }}</option>
          </select></label
        ><label>供应商音色 ID<input v-model="voiceId" /></label
        ><label>供应商状态<input v-model="providerStatus" /></label
        ><button @click="register">固定远端身份</button>
        <p>登记不证明音色可用，须查询并生成试听后确认。</p>
      </details>
      <button v-if="current.data.handle" @click="query">查询远端状态（不合成）</button>
      <SpeechRequest
        :key="current.id + ':clone:' + current.revision"
        :voice="current"
        operation="voice_clone"
      />
      <SpeechRequest
        v-if="current.data.handle"
        :key="current.id + ':speech:' + current.revision"
        :voice="current"
      />
      <p>试听归档后，在任务详情中听审并确认此声音身份；克隆结果已有试听时可在下方播放。</p>
      <template v-if="audition"
        ><audio
          controls
          :src="'/api/voice-media/' + audition.id + '/file?revision=' + audition.revision"
        /><label><input type="checkbox" v-model="listened" />已实际听审</label
        ><label>身份、发音及音质结论<textarea v-model="notes" /></label
        ><button @click="confirm">确认音色版本</button></template
      ></template
    >
  </section>
</template>
