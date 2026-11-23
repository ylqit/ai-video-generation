<script setup lang="ts">
import { defineAsyncComponent } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import type { CanvasNode } from '../shared/canvas';
import GlobalMediaLibrary from './GlobalMediaLibrary.vue';
import CanvasObjectPanel from './CanvasObjectPanel.vue';
const ModelConnections = defineAsyncComponent(() => import('./ModelConnections.vue'));
const ModelExecutionSettings = defineAsyncComponent(() => import('./ModelExecutionSettings.vue'));
const SpeechBudget = defineAsyncComponent(() => import('./SpeechBudget.vue'));
const TaskCenter = defineAsyncComponent(() => import('./TaskCenter.vue'));
const SeriesProduction = defineAsyncComponent(() => import('./SeriesProduction.vue'));
defineProps<{
  drawer: string;
  current: RecordDoc;
  project: RecordDoc;
  version: number;
  node?: CanvasNode;
  records: RecordDoc[];
}>();
const emit = defineEmits([
  'close',
  'select',
  'uploaded',
  'refresh',
  'bind',
  'locate',
  'series-refresh',
]);
const titles: Record<string, string> = {
  assets: '作品素材',
  objects: '业务资料',
  tasks: '作品任务',
  models: '模型与额度',
  series: '系列与分集',
};
</script>
<template>
  <aside class="workbench-drawer">
    <header>
      <h2>{{ titles[drawer] }}</h2>
      <button @click="emit('close')">关闭</button>
    </header>
    <GlobalMediaLibrary
      v-if="drawer === 'assets'"
      :canvas-id="current.id"
      :projects="[project]"
      :version="version"
      :project-id="project.id"
      choosing
      @select="emit('select', $event)"
      @uploaded="emit('uploaded', $event)"
      @refresh="emit('refresh')"
    />
    <CanvasObjectPanel
      v-if="drawer === 'objects'"
      :project-id="project.id"
      :canvas="current"
      :node="node"
      @bind="emit('bind', $event)"
      @refresh="emit('refresh')"
      @close="emit('close')"
    />
    <TaskCenter
      v-if="drawer === 'tasks'"
      :projects="[project]"
      :project-id="project.id"
      initial-scope="project"
      :version="version"
      @canvas="
        emit('locate', $event);
        emit('close');
      "
    />
    <template v-if="drawer === 'models'"
      ><details open>
        <summary>模型库与连接</summary>
        <ModelConnections />
      </details>
      <details>
        <summary>本作品执行范围与额度</summary>
        <ModelExecutionSettings :project-id="project.id" /><SpeechBudget
          :project-id="project.id"
        /></details
    ></template>
    <SeriesProduction
      v-if="drawer === 'series'"
      :project-id="project.id"
      :documents="records"
      @refresh="emit('series-refresh')"
    />
  </aside>
</template>
