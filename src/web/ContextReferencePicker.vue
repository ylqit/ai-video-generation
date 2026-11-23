<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api, assetUrl } from './api';
import { contextReferenceKey, type ContextReference } from '../shared/workbench-context';
const props = defineProps<{ projectId: string; canvasId: string; selected: ContextReference[] }>();
const emit = defineEmits<{ add: [refs: ContextReference[]]; close: [] }>();
const scope = ref('nodes'),
  canvas = ref(props.canvasId),
  search = ref(''),
  offset = ref(0),
  items = ref<any[]>([]),
  total = ref(0),
  error = ref(''),
  canvases = ref<any[]>([]),
  chosen = ref<ContextReference[]>([]);
const selectedKeys = computed(
  () => new Set([...props.selected, ...chosen.value].map(contextReferenceKey)),
);
let sequence = 0;
async function load() {
  const ticket = ++sequence;
  try {
    const r = await api(
      `/projects/${props.projectId}/context-sources?` +
        new URLSearchParams({
          scope: scope.value,
          canvasId: canvas.value,
          search: search.value,
          offset: String(offset.value),
          limit: '24',
        }),
    );
    if (ticket !== sequence) return;
    items.value = r.items;
    total.value = r.total;
    error.value = '';
  } catch (e: any) {
    if (ticket === sequence) error.value = e.message;
  }
}
watch(
  [scope, canvas, search],
  () => {
    offset.value = 0;
    load();
  },
  { immediate: true },
);
watch(offset, load);
api(`/projects/${props.projectId}/context-sources?scope=canvases&limit=50`)
  .then((r) => (canvases.value = r.items))
  .catch((e) => (error.value = e.message));
async function outputs(item: any, offset: number) {
  try {
    const c = item.reference.canvas;
    const r = await api(
      `/projects/${props.projectId}/context-sources?` +
        new URLSearchParams({
          scope: 'outputs',
          canvasId: c.id,
          revision: String(c.revision),
          nodeId: item.reference.nodeId,
          offset: String(offset),
          limit: '8',
        }),
    );
    item.outputs = r.items;
    item.outputOffset = offset;
  } catch (e: any) {
    error.value = e.message;
  }
}
function toggle(r: ContextReference) {
  const key = contextReferenceKey(r);
  if (props.selected.some((v) => contextReferenceKey(v) === key)) return;
  chosen.value = chosen.value.some((v) => contextReferenceKey(v) === key)
    ? chosen.value.filter((v) => contextReferenceKey(v) !== key)
    : [...chosen.value, r];
}
</script>
<template>
  <section class="context-picker" aria-label="选择助手引用">
    <header>
      <strong>添加读取依据</strong><button type="button" @click="emit('close')">关闭</button>
    </header>
    <p class="field-hint">选择具体内容或历史候选。引用不会授予修改权限。</p>
    <div class="button-row">
      <select v-model="scope" aria-label="引用来源">
        <option value="nodes">画布节点与输出</option>
        <option value="assets">作品素材</option>
        <option value="documents">作品文档</option></select
      ><select v-if="scope === 'nodes'" v-model="canvas" aria-label="引用画布">
        <option v-for="c in canvases" :key="c.id" :value="c.id">{{ c.title }}</option></select
      ><input v-model="search" type="search" placeholder="搜索名称" />
    </div>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div class="context-source-list">
      <article v-for="item in items" :key="item.id || item.reference.nodeId">
        <label class="reference-option"
          ><input
            type="checkbox"
            :checked="selectedKeys.has(contextReferenceKey(item.reference))"
            @change="toggle(item.reference)"
          /><img
            v-if="item.asset && (item.type === 'image' || item.type === 'image_generate')"
            :src="assetUrl(item.asset.id, item.asset.revision)"
            loading="lazy"
            alt="引用缩略图"
          /><span
            >{{ item.title
            }}<small
              >{{ item.type }} · 固定 v{{
                item.reference.canvas?.revision || item.reference.object?.revision
              }}</small
            ></span
          ></label
        >
        <details v-if="item.outputs?.length">
          <summary>{{ item.outputCount }} 个具体输出</summary>
          <label v-for="output in item.outputs" :key="output.key" class="reference-option"
            ><input
              type="checkbox"
              :checked="selectedKeys.has(contextReferenceKey(output.reference))"
              @change="toggle(output.reference)"
            /><img
              v-if="output.type === 'image' && output.asset"
              :src="assetUrl(output.asset.id, output.asset.revision)"
              loading="lazy"
              alt="候选"
            /><span>{{ output.title }} · {{ output.type }}</span></label
          >
          <div class="button-row">
            <button
              type="button"
              :disabled="!item.outputOffset"
              @click="outputs(item, (item.outputOffset || 0) - 8)"
            >
              上一组候选</button
            ><small
              >{{ (item.outputOffset || 0) + 1 }}–{{
                Math.min((item.outputOffset || 0) + 8, item.outputCount)
              }}</small
            ><button
              type="button"
              :disabled="(item.outputOffset || 0) + 8 >= item.outputCount"
              @click="outputs(item, (item.outputOffset || 0) + 8)"
            >
              下一组候选
            </button>
          </div>
        </details>
      </article>
    </div>
    <footer class="button-row">
      <button type="button" :disabled="offset === 0" @click="offset -= 24">上一页</button
      ><small>{{ offset + 1 }}–{{ Math.min(offset + 24, total) }} / {{ total }}</small
      ><button type="button" :disabled="offset + 24 >= total" @click="offset += 24">下一页</button
      ><button
        type="button"
        class="primary"
        :disabled="!chosen.length || selected.length + chosen.length > 20"
        @click="
          emit('add', chosen);
          emit('close');
        "
      >
        添加 {{ chosen.length }} 项
      </button>
    </footer>
  </section>
</template>
