<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CanvasNode, CanvasContent } from '../shared/canvas';
import type { RecordDoc } from '../shared/contracts';
import { assetUrl, serviceOffline } from './api';
import AudioWaveform from './AudioWaveform.vue';
import { nodeDefinitions, nodeMediaType, actionLabels } from '../shared/node-catalog';
const props = defineProps<{
  node: CanvasNode;
  edges: CanvasContent['edges'];
  nodes: CanvasContent['nodes'];
  assets: RecordDoc[];
  preview: any;
  busy: boolean;
}>();
const emit = defineEmits([
  'change',
  'remove',
  'prepare',
  'generate',
  'edit',
  'remove-edge',
  'operation',
  'candidate',
  'open-object',
  'models',
  'replace',
]);
const error = ref(''),
  frame = ref(0);
const asset = computed(() =>
  props.assets.find(
    (a) => a.id === props.node.asset?.id && a.revision === props.node.asset?.revision,
  ),
);
const mediaType = computed(() => asset.value?.data.mediaType || nodeMediaType(props.node.type));
const generationNode = computed(
  () => props.node.type.endsWith('_generate') && ['image', 'video'].includes(mediaType.value || ''),
);
const definition = computed(() => nodeDefinitions.find((d) => d.type === props.node.type));
const incoming = computed(() => props.edges.filter((e) => e.target === props.node.id));
function use() {
  props.node.selected = true;
  emit('change');
}
</script>
<template>
  <div class="node-inspector">
    <p v-if="error && !serviceOffline" class="workspace-notice">{{ error }}</p>
    <div class="button-row">
      <button v-if="node.asset" @click="emit('replace')">替换素材…</button
      ><button
        v-if="['entity', 'appearance', 'scene', 'shot', 'director'].includes(node.type)"
        @click="emit('open-object')"
      >
        {{ node.binding ? '编辑关联对象' : '关联业务对象' }}
      </button>
    </div>
    <p v-if="node.binding" class="field-hint">
      固定业务版本 v{{ node.binding.revision }} · 编辑写入原对象
    </p>
    <div class="node-operation-list">
      <button
        v-for="a in definition?.actions.filter(
          (a) => !['generate', 'bind'].includes(a) && !(a === 'timeline' && node.asset),
        )"
        :key="a"
        @click="emit('operation', a)"
      >
        {{ actionLabels[a] || a }}
      </button>
    </div>
    <section v-if="node.outputs?.length" class="node-candidates">
      <h3>候选与历史结果 · {{ node.outputs.length }}</h3>
      <article v-for="o in [...node.outputs].reverse().slice(0, 12)" :key="o.key">
        <img
          v-if="o.asset && o.slot === 'image'"
          :src="assetUrl(o.asset.id, o.asset.revision)"
          loading="lazy"
          alt="候选图"
        /><span>{{ o.label }}</span
        ><button @click="emit('candidate', o)">打开与选用</button>
      </article>
    </section>
    <label class="field-title">名称<input v-model="node.title" @input="emit('change')" /></label>
    <div v-if="node.asset" class="inspector-preview">
      <img
        v-if="mediaType === 'image'"
        :src="assetUrl(node.asset.id, node.asset.revision)"
        alt="选中图片"
      /><video
        v-else-if="mediaType === 'video'"
        :src="assetUrl(node.asset.id, node.asset.revision)"
        controls
        preload="metadata"
      /><AudioWaveform
        v-else
        :key="node.asset.id"
        :src="assetUrl(node.asset.id, node.asset.revision)"
      /><small
        >固定版本 v{{ node.asset.revision }} · {{ node.selected ? '已选用' : '未选用' }} ·
        质量未自动判断</small
      >
    </div>
    <label
      >{{
        node.type === 'document'
          ? '文档正文'
          : mediaType === 'video'
            ? '画面与动作'
            : '内容与制作说明'
      }}<textarea
        v-model="node.text"
        rows="6"
        @input="emit('change')"
        placeholder="描述可见内容、动作、摄影安排或原文…"
      />
    </label>
    <p v-if="generationNode" class="field-hint">
      模型、Prompt、固定输入和候选在画布节点制作托盘中编辑。
    </p>
    <details :open="incoming.length > 0">
      <summary>输入与关联 · {{ incoming.length }}</summary>
      <div v-for="e in incoming" :key="e.id" class="reference-item">
        <label v-if="e.relation === 'input'"
          >输入顺序<input type="number" min="0" v-model.number="e.order" @change="emit('change')"
        /></label>
        <p v-if="e.asset" class="field-hint">
          已固定素材 v{{ e.asset.revision }} ·
          {{
            assets.find((a) => a.id === e.asset!.id && a.revision === e.asset!.revision)?.data.name
          }}
        </p>
        <button
          v-if="
            e.asset &&
            nodes.find((n) => n.id === e.source)?.asset &&
            JSON.stringify(e.asset) !== JSON.stringify(nodes.find((n) => n.id === e.source)?.asset)
          "
          @click="
            e.asset = { ...nodes.find((n) => n.id === e.source)!.asset! };
            emit('change');
          "
        >
          比较后更新到来源当前素材</button
        ><strong
          >{{
            e.relation === 'input' ? '实际输入' : e.relation === 'result' ? '结果来源' : '组织关系'
          }}
          · {{ e.purpose || '' }}</strong
        ><label v-if="e.relation === 'input' && !['text', 'context'].includes(e.targetHandle || '')"
          >参考用途<select v-model="e.purpose" @change="emit('change')">
            <option
              v-for="[id, label] in [
                ['identity', '身份'],
                ['style', '风格'],
                ['scene', '环境'],
                ['prop', '物件'],
                ['composition', '构图'],
                ['first_frame', '首帧'],
                ['last_frame', '尾帧'],
                ['motion', '运动'],
                ['audio', '声音'],
              ]"
              :key="id"
              :value="id"
            >
              {{ label }}
            </option>
          </select></label
        ><textarea
          v-if="e.relation === 'input'"
          v-model="e.instruction"
          @input="emit('change')"
          rows="2"
          placeholder="保持什么、允许改变什么…"
        /><button @click="emit('remove-edge', e.id)">移除连接</button>
      </div>
    </details>
    <div v-if="node.asset" class="inspector-actions">
      <button class="primary" @click="use">{{ node.selected ? '保持选用' : '选用素材' }}</button
      ><button @click="emit('edit')">加入剪辑</button>
    </div>
    <button class="quiet-danger" @click="emit('remove')">从画布移除此节点</button>
  </div>
</template>
