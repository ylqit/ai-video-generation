<script setup lang="ts">
import { computed, ref } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import MediaPreview from './MediaPreview.vue';
const props = defineProps<{ asset: RecordDoc; alternatives: RecordDoc[] }>();
const emit = defineEmits(['close', 'use']);
const comparison = ref('');
const media = computed(() => [
  props.asset,
  ...props.alternatives.filter((a) => a.id === comparison.value),
]);
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section class="dialog media-viewer candidate-comparison">
      <header>
        <h2>{{ asset.data.name }}</h2>
        <button @click="emit('close')">关闭</button>
      </header>
      <label
        >对比固定素材<select v-model="comparison">
          <option value="">单独查看</option>
          <option v-for="a in alternatives" :key="a.id" :value="a.id">
            {{ a.data.name }} · v{{ a.revision }}
          </option>
        </select></label
      >
      <div :class="{ 'comparison-grid': comparison }">
        <figure v-for="a in media" :key="a.id">
          <MediaPreview :asset="a" :type="a.data.mediaType" />
          <figcaption>{{ a.data.name }} · 固定版本 {{ a.revision }}</figcaption>
        </figure>
      </div>
      <footer>
        <button @click="emit('use', false)">固定为素材节点</button
        ><button class="primary" @click="emit('use', true)">选用为此节点输出</button>
      </footer>
      <p>选用不会自动生成质量结论，已有下游输入保持其固定版本。</p>
    </section>
  </div>
</template>
<style scoped>
.candidate-comparison {
  width: min(1100px, 94vw);
}
.comparison-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
}
figure {
  margin: 12px 0;
  min-width: 0;
}
figcaption {
  font-size: 12px;
  color: #8d859d;
  margin-top: 8px;
}
.comparison-grid img,
.comparison-grid video {
  max-height: 52vh;
  width: 100%;
  object-fit: contain;
}
@media (max-width: 700px) {
  .comparison-grid {
    grid-template-columns: 1fr;
  }
}
</style>
