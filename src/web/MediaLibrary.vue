<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { api, assetUrl } from './api';
import ContentPreview from './ContentPreview.vue';
const props = defineProps<{ project: RecordDoc; version: number; pick?: boolean }>();
const emit = defineEmits(['pick', 'workspace']);
const items = ref<any[]>([]),
  view = ref('core'),
  counts = ref<any>({}),
  clearedCount = ref(0),
  cleanup = ref<any>(null),
  previewCandidates = ref<any[]>([]),
  total = ref(0),
  offset = ref(0),
  type = ref(''),
  preview = ref<any>(null),
  error = ref(''),
  busy = ref(false),
  showImport = ref(false);
const files = ref<File[]>([]),
  category = ref('reference'),
  name = ref(''),
  purpose = ref('');
let ticket = 0;
async function load() {
  const seq = ++ticket;
  try {
    const page = await api(
      `/projects/${props.project.id}/media-library?view=${view.value}&offset=${offset.value}&limit=36${type.value ? '&mediaType=' + type.value : ''}`,
    );
    if (seq !== ticket) return;
    items.value = page.items.map((item: any) => ({
      ...item.asset,
      role: item.role,
      cleared: item.cleared,
      candidate: item.candidate,
      label: item.label,
    }));
    counts.value = page.counts;
    clearedCount.value = page.clearedCount;
    total.value = page.total;
  } catch (e: any) {
    if (seq === ticket) error.value = e.message;
  }
}
async function upload() {
  busy.value = true;
  error.value = '';
  try {
    const body = new FormData();
    for (const file of files.value) body.append('files', file);
    body.set('category', category.value);
    body.set('name', name.value);
    body.set('prompt', purpose.value);
    await api(`/projects/${props.project.id}/assets`, 'POST', body);
    showImport.value = false;
    files.value = [];
    offset.value = 0;
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
watch(
  () => [props.project.id, props.version, offset.value, type.value, view.value],
  () => void load(),
  { immediate: true },
);
onBeforeUnmount(() => ticket++);
async function open(asset: any) {
  if (asset.cleared) {
    error.value = '文件已清理，可点击恢复文件';
    return;
  }
  previewCandidates.value = asset.candidate
    ? items.value.filter((i) => i.candidate).map((i) => i.candidate)
    : [];
  preview.value = asset;
}
async function restore(asset: any) {
  busy.value = true;
  try {
    await api(`/assets/${asset.id}/restore`, 'POST', { revision: asset.revision });
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function inspectCleanup() {
  try {
    cleanup.value = await api(`/projects/${props.project.id}/media-cleanup`);
  } catch (e: any) {
    error.value = e.message;
  }
}
async function clean() {
  busy.value = true;
  try {
    const result = await api(`/projects/${props.project.id}/media-cleanup`, 'POST', {
      digest: cleanup.value.digest,
      batchId: crypto.randomUUID(),
    });
    cleanup.value = { ...cleanup.value, result };
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="global-page media-library">
    <header class="page-heading">
      <div>
        <h1>素材库</h1>
        <p>
          {{ project.data.title }} · {{ counts.reference || 0 }} 份参考 ·
          {{ counts.candidate || 0 }} 个候选 · {{ counts.export || 0 }} 个审看导出
        </p>
      </div>
      <div class="toolbar">
        <select v-model="view" @change="offset = 0" aria-label="素材用途">
          <option value="core">核心内容</option>
          <option value="reference">参考与导入</option>
          <option value="candidate">视频候选</option>
          <option value="export">审看／交付</option>
          <option value="attachment">过程附件</option>
          <option value="cleared">已清理记录（{{ clearedCount }}）</option>
        </select>
        <button v-if="!pick" @click="inspectCleanup">清理中间文件</button>
        <select v-model="type" @change="offset = 0" aria-label="素材类型">
          <option value="">全部类型</option>
          <option value="image">图片</option>
          <option value="video">视频</option>
          <option value="audio">音频</option></select
        ><button class="primary" @click="showImport = true">＋ 导入素材</button>
      </div>
    </header>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div class="media-grid">
      <article v-for="asset in items" :key="asset.id" class="media-card">
        <button class="media-card-preview" :aria-label="'预览 ' + asset.label" @click="open(asset)">
          <img
            v-if="!asset.cleared && asset.data.mediaType === 'image'"
            :src="assetUrl(asset.id, asset.revision)"
            :alt="asset.data.name"
            loading="lazy"
          /><video
            v-else-if="!asset.cleared && asset.data.mediaType === 'video'"
            :src="assetUrl(asset.id, asset.revision)"
            muted
            preload="metadata"
          /><span v-else class="audio-art">{{ asset.cleared ? '已清理' : '♫' }}</span>
        </button>
        <h3>{{ asset.label }}</h3>
        <p>
          {{ { image: '图片', video: '视频', audio: '音频' }[asset.data.mediaType as string] }} ·
          {{
            {
              reference: '参考与导入',
              candidate: '视频候选',
              export: '审看／交付',
              attachment: '过程附件',
            }[asset.role as string]
          }}
          <span v-if="asset.data.duration">· {{ Number(asset.data.duration).toFixed(2) }} 秒</span>
        </p>
        <button v-if="asset.cleared" :disabled="busy" @click="restore(asset)">恢复文件</button
        ><button v-else-if="pick" @click="emit('pick', asset)">选择此版本</button
        ><button v-else @click="open(asset)">预览</button>
      </article>
    </div>
    <div v-if="!items.length" class="empty-state">
      <h2>当前分类没有内容</h2>
      <p>可以切换用途与类型筛选，或导入新的素材。</p>
    </div>
    <div class="pagination">
      <button :disabled="offset === 0" @click="offset -= 36">上一页</button
      ><span>{{ total ? offset + 1 : 0 }}–{{ Math.min(offset + 36, total) }} / {{ total }}</span
      ><button :disabled="offset + 36 >= total" @click="offset += 36">下一页</button>
    </div>
    <ContentPreview
      v-if="preview"
      :record="preview"
      :candidates="previewCandidates"
      :initial-candidate="preview.candidate?.id"
      @close="preview = null"
      @bind="pick ? emit('pick', $event) : emit('workspace', { action: 'bind', value: $event })"
      @discuss="emit('workspace', { action: 'discuss', value: $event })"
      @inspect="emit('workspace', { action: 'inspect', value: $event })"
      @review="emit('workspace', { action: 'review', value: $event })"
      @review-edit="emit('workspace', { action: 'reviewEdit', value: $event })"
    />
    <div v-if="cleanup" class="modal-backdrop">
      <section class="dialog wide" v-dialog-focus role="dialog" aria-label="清理中间文件">
        <header>
          <h2>清理中间文件</h2>
          <button @click="cleanup = null">×</button>
        </header>
        <template v-if="!cleanup.result"
          ><p>
            {{ cleanup.candidates.length }} 个可重建文件 ·
            {{ (cleanup.bytes / 1024 / 1024).toFixed(2) }} MiB。执行前独立备份并重新检查引用。
          </p>
          <p>原片、参考、审看版及已有引用证据保留。</p>
          <details>
            <summary>可清理文件</summary>
            <p v-for="f in cleanup.candidates" :key="f.id">{{ f.name }}</p>
          </details>
          <details>
            <summary>受保护文件 {{ cleanup.protected.length }}</summary>
            <p v-for="f in cleanup.protected" :key="f.id">
              {{ f.name }} · {{ f.reasons.join('、') }}
            </p>
          </details>
          <footer>
            <button @click="cleanup = null">关闭</button
            ><button class="primary" :disabled="busy || !cleanup.candidates.length" @click="clean">
              备份并清理 {{ cleanup.candidates.length }} 个文件
            </button>
          </footer></template
        ><template v-else
          ><p>
            活动目录已释放
            {{ (cleanup.result.releasedBytes / 1024 / 1024).toFixed(2) }} MiB；新增独立备份
            {{ (cleanup.result.backupBytesAdded / 1024 / 1024).toFixed(2) }} MiB。
          </p>
          <p
            v-for="f in cleanup.result.files.filter((f: any) => f.status === 'failed')"
            :key="f.id"
          >
            {{ f.name }}：{{ f.error }}
          </p>
          <p>需要恢复时，在“已清理记录”操作。</p></template
        >
      </section>
    </div>
    <div v-if="showImport" class="modal-backdrop" @click.self="showImport = false">
      <form class="dialog" @submit.prevent="upload">
        <header>
          <h2>导入真实素材</h2>
          <button type="button" @click="showImport = false">×</button>
        </header>
        <label
          >文件<input
            type="file"
            multiple
            accept="image/*,video/*,audio/*"
            @change="files = Array.from(($event.target as HTMLInputElement).files || [])"
            required /></label
        ><label>名称（多文件可留空）<input v-model="name" /></label
        ><label
          >用途<select v-model="category">
            <option value="reference">图片 / 通用参考</option>
            <option value="dialogue">对白音频</option>
            <option value="music">音乐</option>
            <option value="sound_effect">音效</option>
            <option value="voice_reference">声音参考</option>
            <option value="source_video">视频素材</option>
          </select></label
        ><label>来源或用途说明<textarea v-model="purpose" rows="3" /></label>
        <footer>
          <button type="button" @click="showImport = false">取消</button
          ><button class="primary" :disabled="busy || !files.length">
            导入 {{ files.length || '' }} 个文件
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>
