<script setup lang="ts">
import { computed } from 'vue';
import { Handle, Position } from '@vue-flow/core';
import type { CanvasNode } from '../shared/canvas';
import { nodeDefinitions, nodeMediaType, actionLabels } from '../shared/node-catalog';
import { assetUrl } from './api';
import MediaPreview from './MediaPreview.vue';
const props = defineProps<{ node: CanvasNode; checked?: boolean; compact?: boolean }>();
const emit = defineEmits(['action', 'collapse', 'check', 'range', 'frame']);
const definition = computed(() => nodeDefinitions.find((d) => d.type === props.node.type));
const type = computed(
  () =>
    props.node.outputs?.find((o) => o.asset?.id === props.node.asset?.id)?.slot ||
    nodeMediaType(props.node.type),
);
</script>
<template>
  <article class="creation-node node-card" :class="{ 'node-group': node.type === 'group' }">
    <Handle
      v-for="(port, i) in definition?.inputs"
      :key="port.id"
      :id="port.id"
      type="target"
      :position="Position.Left"
      :style="{ top: 56 + i * 22 + 'px' }"
      :title="port.label + '：' + port.accepts.join(' / ')"
    />
    <header>
      <input
        class="nodrag"
        type="checkbox"
        :checked="checked"
        :aria-label="'勾选 ' + node.title"
        @pointerdown.stop
        @click.stop
        @change="emit('check')"
      />
      <span>{{ definition?.icon || '◇' }}</span
      ><strong>{{ node.title }}</strong
      ><small>{{ definition?.label }}</small>
    </header>
    <div v-if="node.asset" class="node-visual">
      <MediaPreview
        :asset="node.asset"
        :type="type || 'video'"
        :compact="compact"
        :range="node.range"
        @range="emit('range', $event)"
        @frame="emit('frame', $event)"
      />
    </div>
    <p v-else class="node-body">
      {{
        node.text?.slice(0, 120) ||
        (node.binding
          ? '已关联业务对象 · 固定版本 v' + node.binding.revision
          : node.type === 'group'
            ? '组织相关节点；折叠不会改变实际输入'
            : '选中后添加内容或连接输入')
      }}
    </p>
    <footer>
      <small>{{
        node.outputs?.length
          ? node.outputs.length + ' 个历史结果'
          : node.asset
            ? '固定素材 v' + node.asset.revision
            : '可编辑'
      }}</small
      ><button v-if="node.type === 'group'" class="nodrag" @click="emit('collapse')">
        {{ node.collapsed ? '展开' : '折叠' }}
      </button>
    </footer>
    <div v-if="!compact" class="node-quick-actions nodrag">
      <button
        v-for="action in definition?.actions.slice(0, 3)"
        :key="action"
        @click.stop="emit('action', action)"
      >
        {{ actionLabels[action] || action }}
      </button>
      <details v-if="(definition?.actions.length || 0) > 3" class="node-more-actions" @click.stop>
        <summary>更多</summary>
        <button
          v-for="action in definition?.actions.slice(3)"
          :key="action"
          @click.stop="emit('action', action)"
        >
          {{ actionLabels[action] || action }}
        </button>
      </details>
    </div>
    <div v-if="!compact" class="node-tray nodrag nowheel" @keydown.stop @pointerdown.stop>
      <slot name="tray" />
    </div>
    <Handle
      v-for="(port, i) in definition?.outputs"
      :key="port.id"
      :id="port.id"
      type="source"
      :position="Position.Right"
      :style="{ top: 56 + i * 22 + 'px' }"
      :title="port.label"
    />
  </article>
</template>
