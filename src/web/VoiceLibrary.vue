<script setup lang="ts">
import { ref } from 'vue';
import RecordPicker from './RecordPicker.vue';
import ContractField from './ContractField.vue';
import ProjectVoices from './ProjectVoices.vue';
import { api, assetUrl } from './api';
const structuredClone = globalThis.structuredClone;
let editorVersion = 0;
const props = defineProps<{ projectId: string; documents: any[] }>(),
  emit = defineEmits(['refresh']);
const error = ref(''),
  current = ref<any>(null),
  draft = ref<any>({
    version: 1,
    name: '',
    entity: null,
    language: 'zh-CN',
    pronunciation: '',
    timbre: '',
    performance: '',
    samples: [],
  });
const conversion = ref<any>(null),
  converted = ref('');
async function previewConversion() {
  try {
    conversion.value = await api(
      '/voice-profiles/' + current.value.id + '/conversion-preview',
      'POST',
      { revision: current.value.revision },
    );
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function convert() {
  try {
    const v = await api('/voice-profiles/' + conversion.value.source.id + '/convert', 'POST', {
      revision: conversion.value.source.revision,
      confirmed: true,
    });
    converted.value = `已建立全局草稿 ${v.data.name} v${v.revision}；样本保留原听审来源，尚未登记远端音色。请到素材库继续设置。`;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
const take = ref<any>({
  version: 1,
  episode: null,
  shotId: '',
  lineId: '',
  instanceId: '',
  voice: null,
  asset: null,
  in: 0,
  out: 1,
  actualText: '',
  source: 'imported',
  listened: false,
  voiceMatch: false,
  conclusion: '',
});
function createVoice() {
  editorVersion++;
  current.value = null;
  draft.value = {
    version: 1,
    name: '',
    entity: null,
    language: 'zh-CN',
    pronunciation: '',
    timbre: '',
    performance: '',
    samples: [],
  };
  error.value = '';
}
async function save() {
  const owner = current.value?.id,
    version = editorVersion;
  try {
    const saved = current.value
      ? await api(`/domain/${current.value.id}`, 'PUT', {
          revision: current.value.revision,
          data: draft.value,
        })
      : await api(`/projects/${props.projectId}/domain/voice_profile`, 'POST', {
          data: draft.value,
        });
    emit('refresh');
    if (current.value?.id !== owner || version !== editorVersion) return;
    current.value = saved;
    draft.value = structuredClone(saved.data);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function publish() {
  const owner = current.value?.id,
    version = editorVersion;
  try {
    if (!current.value) throw new Error('先保存声音版本');
    if (JSON.stringify(draft.value) !== JSON.stringify(current.value.data))
      throw new Error('请先保存当前声音草稿');
    const saved = await api(`/domain/${current.value.id}/publish`, 'POST', {
      revision: current.value.revision,
      review: { inspected: true, conclusion: '已听审所列参考区间与声音规范' },
    });
    emit('refresh');
    if (current.value?.id !== owner || version !== editorVersion) return;
    current.value = saved;
    draft.value = structuredClone(saved.data);
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function saveTake() {
  try {
    await api(`/projects/${props.projectId}/dialogue-takes`, 'POST', { data: take.value });
    emit('refresh');
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function selectVoice(r: any) {
  const version = ++editorVersion;
  try {
    const loaded = await api(`/records/${r.id}/versions/${r.revision}`);
    if (version !== editorVersion) return;
    if (loaded.data.version !== 1) throw new Error('新版应用请在上方人物与声音中管理');
    current.value = loaded;
    draft.value = structuredClone(loaded.data);
    error.value = '';
  } catch (e: any) {
    if (version === editorVersion) error.value = e.message;
  }
}
</script>
<template>
  <ProjectVoices :project-id="projectId" :documents="documents" @refresh="emit('refresh')" />
  <details class="panel">
    <summary>旧声音资料、转换与导入对白采用</summary>
    <h3>旧项目声音资料</h3>
    <button @click="createVoice">新建声音配置</button>
    <p>固定参考音色、发音与表演规范。H3 文字请求不能保证锁定音色，参考音频当前用于制作和听审。</p>
    <p class="error">{{ error }}</p>
    <RecordPicker
      :project-id="projectId"
      kind="voice_profile"
      label="编辑声音版本"
      @select="selectVoice"
    />
    <div class="form-grid">
      <label>名称<input v-model="draft.name" /></label
      ><label>语言<input v-model="draft.language" /></label
      ><label>音色<textarea v-model="draft.timbre" /></label
      ><label>发音要求<textarea v-model="draft.pronunciation" /></label
      ><label>表演规范<textarea v-model="draft.performance" /></label>
    </div>
    <RecordPicker
      :project-id="projectId"
      kind="entity"
      label="声音所属主体"
      @select="(r) => (draft.entity = { id: r.id, revision: r.revision })"
    />
    <p>{{ draft.entity }}</p>
    <button v-if="current" @click="previewConversion">预览转换到全局音色库</button>
    <div v-if="conversion">
      <p v-for="c in conversion.changes">{{ c }}</p>
      <p>参考区间按原固定素材复制，旧资料与对白采用保持原版本；不会生成或上传到供应商。</p>
      <button @click="convert">确认建立全局草稿</button>
    </div>
    <p v-if="converted">{{ converted }}</p>
    <RecordPicker
      :project-id="projectId"
      kind="asset"
      label="添加声音参考素材"
      @select="
        (r) =>
          draft.samples.push({
            asset: { id: r.id, revision: r.revision },
            in: 0,
            out: 1,
            inspected: false,
            notes: '',
          })
      "
    />
    <div class="panel" v-for="(s, i) in draft.samples">
      <audio controls :src="assetUrl(s.asset.id, s.asset.revision)" /><label
        >入点秒<input type="number" step="0.0416666667" v-model.number="s.in" /></label
      ><label>出点秒<input type="number" step="0.0416666667" v-model.number="s.out" /></label
      ><label><input type="checkbox" v-model="s.inspected" />已实际听审此区间</label
      ><label>听审依据<textarea v-model="s.notes" /></label
      ><button @click="draft.samples.splice(i, 1)">移除参考</button>
    </div>
    <button @click="save">保存声音版本</button><button @click="publish">发布已听审声音</button>
    <h4>对白素材采用</h4>
    <p>素材先通过资产库导入并采用；这里绑定稳定台词与实际听审。画内口型在装配中另审。</p>
    <ContractField label="对白采用草稿" v-model="take" /><button @click="saveTake">
      保存对白采用
    </button>
    <p v-for="d in documents.filter((d) => d.kind === 'dialogue_take')">
      {{ d.data.lineId }} · {{ d.data.actualText }} · {{ d.data.voice.id }} v{{
        d.data.voice.revision
      }}
    </p>
  </details>
</template>
