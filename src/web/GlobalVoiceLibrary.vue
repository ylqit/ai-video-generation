<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from './api';
import GlobalVoiceEditor from './GlobalVoiceEditor.vue';
import VoiceFolderPicker from './VoiceFolderPicker.vue';
import SpeechBudget from './SpeechBudget.vue';
import { voiceStateLabels } from '../shared/speech';
const props = defineProps<{ version?: number }>();
const trail = ref<any[]>([]),
  folders = ref<any[]>([]),
  page = ref<any>({ items: [], total: 0 }),
  offset = ref(0),
  search = ref(''),
  favorite = ref(false),
  error = ref(''),
  editor = ref<any>(undefined),
  folderForm = ref<any>(null);
let ticket = 0;
async function load() {
  const seq = ++ticket;
  try {
    const parentId = trail.value.at(-1)?.id || '';
    const [f, p] = await Promise.all([
      api('/voice-folders?' + new URLSearchParams({ parentId })),
      api(
        '/voices?' +
          new URLSearchParams({
            ...(search.value ? {} : { folderId: parentId }),
            search: search.value,
            favorite: favorite.value ? '1' : '0',
            offset: String(offset.value),
            limit: '25',
          }),
      ),
    ]);
    if (seq !== ticket) return;
    folders.value = f;
    page.value = p;
    error.value = '';
  } catch (e: any) {
    if (seq === ticket) error.value = e.message;
  }
}
function open(index: number, folder?: any) {
  trail.value = trail.value.slice(0, index);
  if (folder) trail.value.push(folder);
  offset.value = 0;
  void load();
}
async function saveFolder() {
  try {
    const f = folderForm.value;
    await api('/voice-folders' + (f.id ? '/' + f.id : ''), f.id ? 'PUT' : 'POST', {
      name: f.name,
      parentId: f.parentId,
      revision: f.revision,
    });
    folderForm.value = null;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function removeFolder(f: any) {
  try {
    await api('/voice-folders/' + f.id, 'DELETE', { revision: f.revision });
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function metadata(v: any, patch: any) {
  try {
    await api('/voices/' + v.id + '/metadata', 'PUT', {
      revision: v.metadataRevision,
      folderId: v.folderId,
      enabled: v.enabled,
      favorite: v.favorite,
      ...patch,
    });
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
watch(() => props.version, load, { immediate: true });
</script>
<template>
  <section class="global-page">
    <header class="page-heading">
      <div>
        <h1>全局音色库</h1>
        <p>声音身份在这里复用；作品固定选用版本，台词与配音候选归作品。</p>
      </div>
      <button @click="editor = null">＋ 新建音色</button>
    </header>
    <SpeechBudget />
    <p class="error" v-if="error">{{ error }}</p>
    <div class="form-grid">
      <label
        >搜索名称、语言和标签<input
          v-model="search"
          @change="
            offset = 0;
            load();
          " /></label
      ><label
        ><input
          type="checkbox"
          v-model="favorite"
          @change="
            offset = 0;
            load();
          "
        />只看收藏</label
      >
    </div>
    <nav aria-label="目录面包屑">
      <button @click="open(0)">根目录</button
      ><button v-for="(f, i) in trail" @click="open(i + 1)">{{ f.name }} /</button>
    </nav>
    <button @click="folderForm = { name: '', parentId: trail.at(-1)?.id || null, revision: 0 }">
      新建子目录
    </button>
    <div v-for="f in folders" :key="f.id" class="panel">
      <button @click="open(trail.length, f)">▸ {{ f.name }}</button
      ><button @click="folderForm = { ...f, parentId: f.parent_id }">重命名／移动</button
      ><button @click="removeFolder(f)">删除空目录</button>
    </div>
    <form v-if="folderForm" class="panel" @submit.prevent="saveFolder">
      <label>目录名称<input v-model="folderForm.name" required /></label
      ><VoiceFolderPicker
        :value="folderForm.parentId"
        label="移动到"
        @select="folderForm.parentId = $event"
      /><button>保存目录</button><button type="button" @click="folderForm = null">取消</button>
    </form>
    <article v-for="v in page.items" :key="v.id" class="panel">
      <h3>
        {{ v.data.name }} <small>v{{ v.revision }} · {{ voiceStateLabels[v.data.state] }}</small>
      </h3>
      <p>
        {{ v.data.language }} · {{ v.data.tags.join(' · ') }} ·
        {{ v.data.handle?.protocol || '未登记供应商' }}
      </p>
      <p>{{ v.data.description }}</p>
      <p v-if="v.activity && !['succeeded', 'failed', 'cancelled'].includes(v.activity.state)">
        复刻任务：{{
          (
            {
              queued: '待复刻',
              preparing: '准备样本',
              submitting: '提交中',
              unknown: '受理待核对',
              submitted: '远端处理中',
              running: '远端处理中',
              archiving: '归档中',
            } as any
          )[v.activity.state]
        }}
        · {{ v.activity.id }}
      </p>
      <p v-if="v.availability && v.availability.state !== 'ready'" class="warning">
        远端音色需核对：{{ v.availability.providerStatus }}，当前不接受新合成请求。
      </p>
      <audio
        v-if="v.data.audition"
        controls
        :src="
          '/api/voice-media/' + v.data.audition.id + '/file?revision=' + v.data.audition.revision
        "
      />
      <div>
        <button @click="editor = v">编辑／试听／复刻</button
        ><button @click="metadata(v, { favorite: !v.favorite })">
          {{ v.favorite ? '取消收藏' : '收藏' }}</button
        ><button @click="metadata(v, { enabled: !v.enabled })">
          {{ v.enabled ? '停用新请求' : '启用新请求' }}</button
        ><VoiceFolderPicker
          :value="v.folderId"
          label="移动音色"
          @select="metadata(v, { folderId: $event })"
        />
      </div>
    </article>
    <p v-if="!page.items.length">当前范围没有音色，可先保存草稿或登记已有供应商音色。</p>
    <div class="pagination">
      <button
        :disabled="offset === 0"
        @click="
          offset -= 25;
          load();
        "
      >
        上一页</button
      ><span
        >{{ page.total ? offset + 1 : 0 }}–{{ Math.min(offset + 25, page.total) }} /
        {{ page.total }}</span
      ><button
        :disabled="offset + 25 >= page.total"
        @click="
          offset += 25;
          load();
        "
      >
        下一页
      </button>
    </div>
    <GlobalVoiceEditor
      v-if="editor !== undefined"
      :key="editor?.id || 'new'"
      :initial="editor"
      :folder-id="trail.at(-1)?.id || null"
      @saved="load()"
      @close="editor = undefined"
    />
  </section>
</template>
