<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, assetUrl } from './api';
import type { RecordDoc } from '../shared/contracts';
import { useWorkbenchImports } from './useWorkbenchImports';
import ImportProgress from './ImportProgress.vue';
import MediaPreview from './MediaPreview.vue';
const props = defineProps<{
  projects: RecordDoc[];
  version: number;
  projectId?: string;
  choosing?: boolean;
  canvasId?: string;
}>();
const emit = defineEmits(['project', 'select', 'uploaded', 'refresh']);
const project = ref(props.projectId || ''),
  type = ref(''),
  search = ref(''),
  items = ref<any[]>([]),
  total = ref(0),
  offset = ref(0),
  error = ref(''),
  preview = ref<any>(null);
const imports = ref<ReturnType<typeof useWorkbenchImports> | null>(null),
  showImports = ref(false);
watch(project, (value) => (imports.value = value ? useWorkbenchImports(value) : null), {
  immediate: true,
});
async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  if (!input.files?.length || !project.value) return;
  try {
    showImports.value = true;
    const receipts = await imports.value!.add(
      Array.from(input.files),
      props.canvasId ? { kind: 'canvas', canvasId: props.canvasId } : { kind: 'library' },
    );
    const added = await Promise.all(
      receipts.map((r) => api('/records/' + r.object.id + '/versions/' + r.object.revision)),
    );
    await load();
    if (props.choosing && !props.canvasId) emit('uploaded', added);
    emit('refresh');
    input.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function select() {
  const a = await api(`/records/${preview.value.id}/versions/${preview.value.revision}`);
  emit('select', a);
  preview.value = null;
}
async function load() {
  try {
    const q = new URLSearchParams({
      projectId: project.value,
      mediaType: type.value,
      q: search.value,
      offset: String(offset.value),
    });
    const r = await api('/media-index?' + q);
    error.value = '';
    items.value = r.items;
    total.value = r.total;
  } catch (e: any) {
    error.value = e.message;
  }
}
watch(
  () => [project.value, type.value, search.value],
  () => {
    offset.value = 0;
    void load();
  },
);
watch(() => [offset.value, props.version], load, { immediate: true });
</script>
<template>
  <section class="global-media">
    <div class="library-toolbar">
      <label v-if="project" class="button"
        >上传素材<input
          type="file"
          multiple
          accept="image/*,video/*,audio/*"
          hidden
          @change="upload"
      /></label>
      <input
        type="search"
        v-model="search"
        placeholder="搜索素材名称"
        aria-label="搜索素材名称"
      /><select v-model="project" aria-label="作品范围">
        <option v-if="!choosing" value="">全部作品</option>
        <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.data.title }}</option>
      </select>
      <nav class="view-tabs">
        <button
          v-for="[id, label] in [
            ['', '全部'],
            ['image', '图片'],
            ['video', '视频'],
            ['audio', '音频'],
          ]"
          :key="id"
          :class="{ active: type === id }"
          @click="type = id"
        >
          {{ label }}
        </button>
      </nav>
    </div>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <ImportProgress
      v-if="showImports && imports"
      :items="imports.items"
      @retry="imports.reconcile($event).then(load)"
      @close="showImports = false"
    />
    <div v-if="!items.length" class="page-empty">
      <span>▧</span>
      <h2>把参考和灵感带进作品</h2>
      <p>
        在作品画布上传素材、选取视频帧或生成候选，这里会统一收录。音色可在独立的全局音色库复用。
      </p>
    </div>
    <div class="media-card-grid">
      <button v-for="a in items" :key="a.id" class="media-card" @click="preview = a">
        <MediaPreview :asset="a" :type="a.mediaType" compact />
        <strong>{{ a.name }}</strong
        ><small>{{ a.projectName }} · v{{ a.revision }}</small>
      </button>
    </div>
    <footer class="list-pagination">
      <span>{{ total }} 项素材</span
      ><button :disabled="!offset" @click="offset = Math.max(0, offset - 36)">上一页</button
      ><button :disabled="offset + 36 >= total" @click="offset += 36">下一页</button>
    </footer>
    <div v-if="preview" class="modal-backdrop" @click.self="preview = null">
      <section class="dialog media-viewer">
        <header>
          <h2>{{ preview.name }}</h2>
          <button @click="preview = null">关闭</button>
        </header>
        <MediaPreview :asset="preview" :type="preview.mediaType" />
        <footer>
          <button class="primary" @click="select">
            {{ choosing ? '使用此固定版本' : '带入所属作品画布' }}
          </button>
          <small>素材版本固定；未自动作质量判断。</small
          ><button
            v-if="!choosing"
            @click="
              emit('project', preview.projectId);
              preview = null;
            "
          >
            进入所属作品
          </button>
        </footer>
      </section>
    </div>
  </section>
</template>
