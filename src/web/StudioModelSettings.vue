<script setup lang="ts">
import { ref } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import ModelConnections from './ModelConnections.vue';
import ModelExecutionSettings from './ModelExecutionSettings.vue';
import SpeechBudget from './SpeechBudget.vue';
const props = defineProps<{ project?: RecordDoc }>();
const tab = ref('models');
</script>
<template>
  <section class="settings-workspace">
    <header class="page-heading">
      <div>
        <p class="eyebrow">WORKSPACE SETTINGS</p>
        <h1>设置</h1>
        <p>全局连接与模型在这里管理；作品固定使用自己的选择和用量。</p>
      </div>
    </header>
    <div class="settings-grid">
      <nav aria-label="设置分类">
        <button :class="{ active: tab === 'models' }" @click="tab = 'models'">模型库与连接</button
        ><button :class="{ active: tab === 'execution' }" @click="tab = 'execution'">
          作品模型与额度</button
        ><button :class="{ active: tab === 'speech' }" @click="tab = 'speech'">声音执行额度</button
        ><a href="/design/node-workbench/index.html" target="_blank">功能与交互概览 ↗</a>
      </nav>
      <main>
        <ModelConnections v-if="tab === 'models'" /><template v-else-if="tab === 'execution'"
          ><h2>{{ project?.data.title || '选择作品' }} · 制作配置</h2>
          <ModelExecutionSettings v-if="project" :project-id="project.id" />
          <p v-else>从作品列表选择作品后，可设置它使用的模型与额度。</p></template
        ><template v-else
          ><h2>声音执行额度</h2>
          <SpeechBudget :project-id="project?.id"
        /></template>
      </main>
    </div>
  </section>
</template>
