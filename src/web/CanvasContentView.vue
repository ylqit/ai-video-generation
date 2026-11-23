<script setup lang="ts">
import type { CanvasContent } from '../shared/canvas';
import { assetUrl } from './api';
import CanvasDocumentEditor from './CanvasDocumentEditor.vue';
import { nodeMediaType } from '../shared/node-catalog';
defineProps<{ content: CanvasContent; view: string }>();
const emit = defineEmits(['add', 'select', 'change', 'rewrite']);
</script>
<template>
  <main v-if="view === 'documents'" class="document-stage">
    <header>
      <h2>文档与剧本</h2>
      <button @click="emit('add', 'document')">新建文档</button>
    </header>
    <CanvasDocumentEditor
      v-for="n in content.nodes.filter((n) => ['document', 'note'].includes(n.type))"
      :key="n.id"
      :node="n"
      @change="emit('change')"
      @select="emit('select', $event)"
      @rewrite="emit('rewrite', $event)"
    />
  </main>
  <main v-else class="shot-grid-stage">
    <header>
      <h2>分镜与候选</h2>
      <button @click="emit('add', 'shot')">新镜头</button>
    </header>
    <div class="shot-card-grid">
      <button
        v-for="n in content.nodes.filter((n) =>
          ['shot', 'video', 'image', 'video_generate', 'image_generate'].includes(n.type),
        )"
        :key="n.id"
        @click="emit('select', n.id)"
      >
        <img
          v-if="n.asset && nodeMediaType(n.type) === 'image'"
          :src="assetUrl(n.asset.id, n.asset.revision)"
          alt=""
          loading="lazy"
        /><video v-else-if="n.asset" :src="assetUrl(n.asset.id, n.asset.revision)" preload="none" />
        <div v-else class="shot-placeholder">
          {{ nodeMediaType(n.type) === 'video' ? '▷' : '▧' }}
        </div>
        <strong>{{ n.title }}</strong>
        <p>{{ n.text.slice(0, 100) }}</p>
        <small>{{ n.selected ? '已选用' : n.asset ? '候选可用' : '待制作' }}</small>
      </button>
    </div>
  </main>
</template>
