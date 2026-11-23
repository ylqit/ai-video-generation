<script setup lang="ts">
import { ref, watch } from 'vue';
import { api } from './api';
import type { RecordDoc } from '../shared/contracts';
import type { CanvasNode } from '../shared/canvas';
import ContractField from './ContractField.vue';
const props = defineProps<{ projectId: string; canvas: RecordDoc; node?: CanvasNode }>();
const emit = defineEmits(['bind', 'refresh', 'close']);
const kind = ref(
    props.node?.type === 'appearance'
      ? 'appearance'
      : props.node?.type === 'shot'
        ? 'episode'
        : 'entity',
  ),
  q = ref(''),
  offset = ref(0),
  items = ref<any[]>([]),
  more = ref(false),
  object = ref<any>(null),
  data = ref<any>(null),
  error = ref(''),
  create = ref(false),
  name = ref(''),
  description = ref(''),
  type = ref('character');
async function load() {
  try {
    const r = await api(
      `/projects/${props.projectId}/objects?` +
        new URLSearchParams({ kind: kind.value, q: q.value, offset: String(offset.value) }),
    );
    items.value = r.items;
    more.value = r.hasMore;
  } catch (e: any) {
    error.value = e.message;
  }
}
async function choose(item: any) {
  try {
    object.value = await api(`/records/${item.id}/versions/${item.revision}`);
    data.value = JSON.parse(
      JSON.stringify(
        item.shotId
          ? object.value.data.shots.find((s: any) => s.id === item.shotId)
          : object.value.data,
      ),
    );
  } catch (e: any) {
    error.value = e.message;
  }
}
async function createEntity() {
  try {
    const d = await api(`/projects/${props.projectId}/domain/entity`, 'POST', {
      data: { name: name.value, type: type.value, description: description.value },
    });
    emit('bind', { id: d.id, revision: d.revision });
    create.value = false;
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function save() {
  try {
    if (!props.node) throw new Error('请选择引用此对象的节点');
    await api(`/canvases/${props.canvas.id}/nodes/${props.node.id}/object`, 'PUT', {
      canvasRevision: props.canvas.revision,
      objectRevision: object.value.revision,
      data: data.value,
    });
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
watch([kind, q], () => {
  offset.value = 0;
  void load();
});
watch(offset, load);
watch(
  () => props.node?.binding,
  async (ref) => {
    if (ref) await choose(ref);
    else object.value = null;
  },
  { immediate: true },
);
void load();
</script>
<template>
  <section class="canvas-object-panel">
    <header>
      <h3>人物、场景与业务资料</h3>
      <button @click="emit('close')">关闭</button>
    </header>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <div class="field-pair">
      <select v-model="kind">
        <option value="entity">人物／物件／环境</option>
        <option value="appearance">外观版本</option>
        <option value="reference_pack">参考包</option>
        <option value="episode">分集与镜头</option>
        <option value="creation_profile">视觉规范</option>
        <option value="layout">空间布局</option>
        <option value="chapter">剧本文档</option></select
      ><input v-model="q" placeholder="搜索名称" />
    </div>
    <button @click="create = !create">新建人物／物件</button>
    <form v-if="create" @submit.prevent="createEntity">
      <label>名称<input v-model="name" required /></label
      ><select v-model="type">
        <option value="character">人物／动物</option>
        <option value="object">物件／产品</option>
        <option value="environment">环境</option>
        <option value="style">视觉方向</option></select
      ><label>稳定外形与设计<textarea v-model="description" /></label
      ><button class="primary">创建并引用</button>
    </form>
    <div class="object-list">
      <button v-for="item in items" :key="item.id" @click="choose(item)">
        {{ item.title || item.name || item.kind }} <small>v{{ item.revision }}</small>
      </button>
    </div>
    <div class="button-row">
      <button :disabled="offset === 0" @click="offset = Math.max(0, offset - 40)">上一页</button
      ><button :disabled="!more" @click="offset += 40">下一页</button>
    </div>
    <section v-if="object">
      <h3>{{ object.data.name || object.data.title }}</h3>
      <template v-if="object.kind === 'episode'"
        ><template v-if="node?.binding?.id === object.id && node?.binding?.shotId"
          ><h4>当前镜头 {{ node?.binding?.shotId }}</h4>
          <label>动作正文<textarea v-model="data.prompt" rows="4" /></label
          ><ContractField v-model="data.directing" label="导演、表演与声音" /><ContractField
            v-model="data.state"
            label="实例与当前状态"
          /><button @click="save">保存镜头原始资料</button></template
        >
        <p>选择明确镜头；不按名称猜测身份。</p>
        <button
          v-for="shot in object.data.shots"
          :key="shot.id"
          @click="emit('bind', { id: object.id, revision: object.revision, shotId: shot.id })"
        >
          {{ shot.id }} · {{ shot.purpose || shot.description || shot.prompt?.slice(0, 70) }}
        </button></template
      ><template v-else
        ><button
          class="primary"
          @click="emit('bind', { id: object.id, revision: object.revision })"
        >
          引用此固定版本</button
        ><template v-if="node?.binding?.id === object.id"
          ><label v-if="'name' in data">名称<input v-model="data.name" /></label
          ><label v-if="'description' in data"
            >描述<textarea v-model="data.description" rows="5" /></label
          ><label v-if="Array.isArray(data.fixedFeatures)"
            >稳定特征<textarea
              :value="data.fixedFeatures.join('\n')"
              @input="
                data.fixedFeatures = ($event.target as HTMLTextAreaElement).value
                  .split('\n')
                  .filter(Boolean)
              "
            /></label
          ><ContractField v-model="data" label="完整对象字段" /><button @click="save">
            保存到原业务对象
          </button></template
        ></template
      >
    </section>
  </section>
</template>
