<script setup lang="ts">
import { computed, ref } from 'vue';
import { taskKindLabels, taskStateLabels } from '../shared/task-labels';
import type { CanvasNode } from '../shared/canvas';
const props = defineProps<{ jobs: any[]; nodes: CanvasNode[]; message: string }>();
const emit = defineEmits(['inspect', 'all']);
const expanded = ref(false);
const active = computed(
  () => props.jobs.filter((j) => !['succeeded', 'failed', 'cancelled'].includes(j.state)).length,
);
const recent = computed(() =>
  [...props.jobs].sort((a, b) => b.createdAt - a.createdAt).slice(0, 12),
);
</script>
<template>
  <footer class="task-dock">
    <span>{{ message }}</span>
    <button @click="emit('all')">全部任务</button>
    <button
      :aria-expanded="expanded"
      aria-controls="canvas-task-list"
      @click="expanded = !expanded"
    >
      {{ active }} 项执行中 · 任务 {{ expanded ? '⌄' : '⌃' }}
    </button>
    <div v-if="expanded" id="canvas-task-list" class="dock-jobs">
      <p v-if="!jobs.length">没有任务。添加生成节点或向 Agent 描述目标。</p>
      <div v-for="j in recent" :key="j.id">
        <span>{{
          nodes.find((n) => n.id === j.nodeId)?.title || taskKindLabels[j.kind] || j.kind
        }}</span>
        <span>{{ taskStateLabels[j.state] || j.state }}</span>
        <small>{{ j.error || j.holdReason }}</small>
        <button @click="emit('inspect', j.id)">详情与结果</button>
      </div>
    </div>
  </footer>
</template>
