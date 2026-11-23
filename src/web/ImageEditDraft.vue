<script setup lang="ts">
import { ref } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { assetUrl } from './api';
import { actionLabels } from '../shared/node-catalog';
const props = defineProps<{ asset: RecordDoc; action: string }>(),
  emit = defineEmits(['create', 'close']);
const instruction = ref(''),
  azimuth = ref(0),
  elevation = ref(0),
  strength = ref(1),
  box = ref({ x: 0, y: 0, width: props.asset.data.width, height: props.asset.data.height });
let start: { x: number; y: number } | null = null;
function point(e: PointerEvent) {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.round(
      Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * props.asset.data.width,
    ),
    y: Math.round(
      Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)) * props.asset.data.height,
    ),
  };
}
function down(e: PointerEvent) {
  start = point(e);
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function move(e: PointerEvent) {
  if (!start) return;
  const p = point(e);
  box.value = {
    x: Math.min(start.x, p.x),
    y: Math.min(start.y, p.y),
    width: Math.max(1, Math.abs(p.x - start.x)),
    height: Math.max(1, Math.abs(p.y - start.y)),
  };
}
function create() {
  emit('create', {
    version: 1,
    action: props.action,
    source: { id: props.asset.id, revision: props.asset.revision },
    instruction: instruction.value,
    box: props.action === 'inpaint' ? box.value : undefined,
    azimuth: azimuth.value,
    elevation: elevation.value,
    strength: strength.value,
  });
}
</script>
<template>
  <section class="node-operation-editor">
    <header>
      <h2>{{ actionLabels[action] }} · 编辑请求</h2>
      <button @click="emit('close')">关闭</button>
    </header>
    <div class="image-region" @pointerdown="down" @pointermove="move" @pointerup="start = null">
      <img :src="assetUrl(asset.id, asset.revision)" draggable="false" /><span
        v-if="action === 'inpaint'"
        :style="{
          left: (box.x / asset.data.width) * 100 + '%',
          top: (box.y / asset.data.height) * 100 + '%',
          width: (box.width / asset.data.width) * 100 + '%',
          height: (box.height / asset.data.height) * 100 + '%',
        }"
      />
    </div>
    <p v-if="action === 'inpaint'">
      拖动框选区域。原图、绿色引导图、模型原始响应与局部合成结果分别保留；区域外使用原图像素。
    </p>
    <p v-else>这些控制转成图片编辑要求，不是精确三维重建。</p>
    <div v-if="action !== 'inpaint'" class="field-pair">
      <label
        >水平角度<input type="range" min="-180" max="180" v-model.number="azimuth" />{{
          azimuth
        }}°</label
      ><label
        >俯仰角度<input type="range" min="-90" max="90" v-model.number="elevation" />{{
          elevation
        }}°</label
      ><label v-if="action === 'relight'"
        >光照强度<input type="range" min="0" max="2" step="0.1" v-model.number="strength" />{{
          strength
        }}</label
      >
    </div>
    <label
      >期望变化及保留要求<textarea
        v-model="instruction"
        rows="4"
        placeholder="例如：只替换框选区域内的破损模型，保持人物与背景…"
      /></label
    ><button class="primary" :disabled="!instruction.trim()" @click="create">建立编辑节点</button
    ><small>此操作只建立制作草稿；选择模型并预览后再提交。</small>
  </section>
</template>
