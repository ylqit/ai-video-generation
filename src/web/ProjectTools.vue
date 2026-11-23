<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { api } from './api';
import SeriesProduction from './SeriesProduction.vue';
import CreationProfile from './CreationProfile.vue';
import SubjectStudio from './SubjectStudio.vue';
import LayoutStudio from './LayoutStudio.vue';
import Timeline from './Timeline.vue';
import VoiceLibrary from './VoiceLibrary.vue';

const props = defineProps<{
  project: RecordDoc;
  episodeId?: string;
  initial?: string;
  version: number;
}>();
const emit = defineEmits(['refresh']);
const tab = ref(props.initial || (props.project.data.mode === 'series' ? 'series' : 'profile'));
const records = ref<RecordDoc[]>([]),
  episode = ref<RecordDoc | null>(null),
  error = ref(''),
  loading = ref(false);
let ticket = 0;
async function load() {
  const seq = ++ticket;
  loading.value = true;
  try {
    const kinds =
      tab.value === 'voices'
        ? ['entity', 'voice_profile', 'dialogue_take']
        : tab.value === 'formal'
          ? ['asset', 'edl']
          : tab.value === 'series'
            ? ['series', 'creation_profile', 'continuity', 'entity', 'voice_profile', 'episode']
            : tab.value === 'profile'
              ? ['creation_profile', 'creative_module', 'entity']
              : tab.value === 'subjects'
                ? ['entity', 'appearance', 'reference_pack', 'asset_task']
                : ['layout', 'entity'];
    const groups = await Promise.all(
      kinds.map(async (kind) => {
        const items: RecordDoc[] = [];
        let offset = 0;
        while (true) {
          const page = await api(
            `/projects/${props.project.id}/records?kind=${kind}&limit=100&offset=${offset}`,
          );
          if (seq !== ticket) return [];
          items.push(...page.items);
          offset += page.items.length;
          if (offset >= page.total || !page.items.length) return items;
        }
      }),
    );
    const current = props.episodeId ? await api(`/records/${props.episodeId}`) : null;
    if (seq !== ticket) return;
    records.value = groups.flat();
    if (tab.value === 'voices' && current) records.value.push(current);
    episode.value = current;
    error.value = '';
  } catch (e: any) {
    if (seq === ticket) error.value = e.message;
  } finally {
    if (seq === ticket) loading.value = false;
  }
}
watch([tab, () => props.version], load, { immediate: true });
onBeforeUnmount(() => ticket++);
async function refresh() {
  emit('refresh');
  await load();
}
</script>
<template>
  <div class="project-tools">
    <nav class="view-tabs" aria-label="项目精细设置">
      <button
        v-if="project.data.mode === 'series'"
        :class="{ active: tab === 'series' }"
        @click="tab = 'series'"
      >
        分集与系列事实
      </button>
      <button :class="{ active: tab === 'profile' }" @click="tab = 'profile'">
        制作配置与方法
      </button>
      <button :class="{ active: tab === 'subjects' }" @click="tab = 'subjects'">
        主体与参考包
      </button>
      <button :class="{ active: tab === 'space' }" @click="tab = 'space'">空间编辑</button>
      <button :class="{ active: tab === 'voices' }" @click="tab = 'voices'">人物与声音</button>
      <button v-if="episodeId" :class="{ active: tab === 'formal' }" @click="tab = 'formal'">
        正式装配
      </button>
    </nav>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="loading && !records.length">正在读取相关内容…</p>
    <VoiceLibrary
      v-if="tab === 'voices'"
      :project-id="project.id"
      :documents="records"
      @refresh="refresh"
    />
    <SeriesProduction
      v-if="tab === 'series'"
      :project-id="project.id"
      :documents="records"
      @refresh="refresh"
    />
    <CreationProfile
      v-else-if="tab === 'profile'"
      :project-id="project.id"
      :project-mode="project.data.mode"
      :documents="records"
      @refresh="refresh"
    />
    <SubjectStudio
      v-else-if="tab === 'subjects'"
      :project-id="project.id"
      :documents="records"
      @refresh="refresh"
    />
    <LayoutStudio
      v-else-if="tab === 'space'"
      :project-id="project.id"
      :documents="records"
      @refresh="refresh"
    />
    <template v-else-if="tab === 'formal' && episode">
      <p>正式装配使用已采用媒体。候选审看编辑及其导出不会自动成为正式片段。</p>
      <Timeline
        :key="episode.id"
        :episode="episode"
        :assets="records.filter((d) => d.kind === 'asset')"
        :saved="records.find((d) => d.kind === 'edl' && d.data.episodeId === episode!.id)"
        @refresh="refresh"
      />
    </template>
  </div>
</template>
<style scoped>
.project-tools > nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 16px;
}
.project-tools :deep(.panel) {
  margin: 0;
}
</style>
