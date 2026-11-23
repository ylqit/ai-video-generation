<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, assetUrl } from './api';
import type { ContextReference } from '../shared/workbench-context';
import { contextReferenceKey } from '../shared/workbench-context';
import MediaPreview from './MediaPreview.vue';
const props = defineProps<{
  canvasId: string;
  references: ContextReference[];
  preview: any;
  nodes: any[];
}>();
const emit = defineEmits(['update', 'inspect', 'locate']);
const expanded = ref(-1);
const details = ref<Record<string, any>>({}),
  error = ref('');
async function read(r: ContextReference, offset = 0) {
  try {
    details.value[contextReferenceKey(r)] = await api(
      '/canvases/' + props.canvasId + '/context-detail',
      'POST',
      { reference: r, offset },
    );
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
watch(
  () => props.references,
  (refs) => {
    for (const r of refs) if (!details.value[contextReferenceKey(r)]) void read(r);
  },
  { deep: true, immediate: true },
);
function item(r: ContextReference) {
  return (
    details.value[contextReferenceKey(r)] ||
    props.preview?.items.find(
      (i: any) => contextReferenceKey(i.reference) === contextReferenceKey(r),
    )
  );
}
function title(r: ContextReference) {
  return (
    item(r)?.title ||
    ('nodeId' in r ? props.nodes.find((n) => n.id === r.nodeId)?.title || r.nodeId : r.object.id)
  );
}
function update(i: number, fields: any) {
  emit(
    'update',
    props.references.map((r, n) => (n === i ? { ...r, ...fields } : r)),
  );
}
function selection(i: number, event: Event) {
  const el = event.target as HTMLTextAreaElement;
  if (el.selectionEnd <= el.selectionStart) return;
  const offset = item(props.references[i])?.textOffset ?? props.references[i].textRange?.start ?? 0;
  update(i, {
    textRange: {
      start: offset + el.selectionStart,
      end: offset + el.selectionEnd,
      expected: el.value.slice(el.selectionStart, el.selectionEnd),
    },
  });
}
function open(i: number) {
  expanded.value = expanded.value === i ? -1 : i;
  if (expanded.value >= 0 && !item(props.references[i])) void read(props.references[i]);
}
</script>
<template>
  <div class="reference-chips">
    <p v-if="error" class="inline-error">{{ error }}</p>
    <article v-for="(r, i) in references" :key="i">
      <button type="button" @click="open(i)">
        <img
          v-if="item(r)?.media?.type === 'image'"
          :src="assetUrl(item(r).media.id, item(r).media.revision)"
          alt="引用图片"
          loading="lazy"
          style="width: 32px; height: 32px; object-fit: cover; vertical-align: middle"
        />
        @{{ title(r) }} · v{{ 'canvas' in r ? r.canvas.revision : r.object.revision }}</button
      ><button
        type="button"
        :aria-label="'移除引用 ' + title(r)"
        @click="
          emit(
            'update',
            references.filter((_, n) => n !== i),
          )
        "
      >
        ×
      </button>
      <div v-if="expanded === i" class="reference-detail">
        <button v-if="'nodeId' in r" type="button" @click="emit('locate', r)">定位来源节点</button>
        <template v-if="item(r)?.media"
          ><MediaPreview
            :asset="item(r).media"
            :type="item(r).media.type"
            :range="r.range"
            @range="update(i, { range: $event })"
          />
          <label v-if="item(r).media.type === 'image'"
            >图片读取方式<select
              :value="r.imageHandling"
              @change="update(i, { imageHandling: ($event.target as HTMLSelectElement).value })"
            >
              <option value="image">将图片实际传入模型</option>
              <option value="metadata">只引用信息，不读取图片</option>
            </select></label
          >
          <div v-else class="reference-range">
            <label
              >起点（秒）<input
                type="number"
                min="0"
                step="0.001"
                :value="r.range?.in || 0"
                @change="
                  update(i, {
                    range: {
                      in: Number(($event.target as HTMLInputElement).value),
                      out: r.range?.out || item(r).media.duration,
                    },
                  })
                " /></label
            ><label
              >终点（秒）<input
                type="number"
                min="0"
                step="0.001"
                :value="r.range?.out || item(r).media.duration"
                @change="
                  update(i, {
                    range: {
                      in: r.range?.in || 0,
                      out: Number(($event.target as HTMLInputElement).value),
                    },
                  })
                "
            /></label>
          </div>
        </template>
        <template v-if="item(r)?.text"
          ><small>选中文字后松开鼠标，固定该选区；正文保持不变。</small
          ><textarea
            readonly
            :value="item(r).text"
            rows="5"
            aria-label="引用正文选区"
            @mouseup="selection(i, $event)"
          />
          <div v-if="item(r).textLength > 6000" class="button-row">
            <button
              type="button"
              :disabled="!item(r).textOffset"
              @click="read(r, Math.max(0, item(r).textOffset - 6000))"
            >
              上一段正文
            </button>
            <small
              >{{ item(r).textOffset }}–{{
                Math.min(item(r).textOffset + 6000, item(r).textLength)
              }}
              / {{ item(r).textLength }} 字符</small
            >
            <button
              type="button"
              :disabled="item(r).textOffset + 6000 >= item(r).textLength"
              @click="read(r, item(r).textOffset + 6000)"
            >
              下一段正文
            </button>
          </div>
        </template>
        <p v-if="r.textRange" class="field-hint">
          已固定字符 {{ r.textRange.start }}–{{ r.textRange.end }}：{{ r.textRange.expected }}
        </p>
        <button
          v-if="r.range || r.textRange"
          type="button"
          @click="update(i, { range: undefined, textRange: undefined })"
        >
          恢复整个对象
        </button>
      </div>
    </article>
  </div>
</template>
