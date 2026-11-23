<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { api, assetUrl } from './api';
const props = defineProps<{ projectId: string; requirement: any }>();
const emit = defineEmits(['ready', 'close']);
const items = ref<any[]>([]),
  sourceId = ref(''),
  result = ref<any>(null),
  frameIndex = ref(0);
const crop = ref({ x: 0, y: 0, width: 128, height: 128 }),
  busy = ref(false),
  error = ref(''),
  offset = ref(0),
  total = ref(0);
const source = computed(() => items.value.find((a) => a.id === sourceId.value));
async function load() {
  try {
    const list = await api(
      `/projects/${props.projectId}/records?kind=asset&limit=50&offset=${offset.value}`,
    );
    items.value.push(...list.items);
    total.value = list.total;
    offset.value += list.items.length;
  } catch (e: any) {
    error.value = e.message;
  }
}
async function derive() {
  if (!source.value || busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const a = source.value;
    result.value = await api(
      `/assets/${a.id}/${a.data.mediaType === 'video' ? 'evidence' : 'crop'}`,
      'POST',
      {
        revision: a.revision,
        ...(a.data.mediaType === 'video' ? { frameIndex: frameIndex.value } : crop.value),
      },
    );
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function useFrameForCrop() {
  items.value.push(result.value);
  sourceId.value = result.value.id;
  crop.value = { x: 0, y: 0, width: result.value.data.width, height: result.value.data.height };
  result.value = null;
}
onMounted(load);
</script>
<template>
  <section class="panel">
    <h3>选帧／裁剪 · {{ requirement.description }}</h3>
    <p>
      固定源媒体与帧号，派生结果仍需实际审图。选帧提供静态参考，不代表接入运动控制或确认剧情事实。
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <label
      >源素材<select v-model="sourceId" @change="result = null">
        <option value="">选择图片或视频</option>
        <option
          v-for="a in items.filter((a) => ['image', 'video'].includes(a.data.mediaType))"
          :key="a.id"
          :value="a.id"
        >
          {{ a.data.name || a.id }} · v{{ a.revision }}
        </option>
      </select></label
    >
    <button v-if="offset < total" @click="load">加载更多素材</button>
    <template v-if="source">
      <video
        v-if="source.data.mediaType === 'video'"
        :src="assetUrl(source.id, source.revision)"
        controls
        preload="metadata"
      />
      <img v-else :src="assetUrl(source.id, source.revision)" alt="固定源图" />
      <label v-if="source.data.mediaType === 'video'"
        >源帧号（从 0 开始）<input
          v-model.number="frameIndex"
          type="number"
          min="0"
          :max="source.data.frameCount - 1"
      /></label>
      <div v-else class="crop-inputs">
        <label v-for="(_, k) in crop" :key="k"
          >{{ k
          }}<input v-model.number="crop[k]" type="number" :min="k === 'x' || k === 'y' ? 0 : 1"
        /></label>
      </div>
      <button :disabled="busy" @click="derive">
        {{ source.data.mediaType === 'video' ? '提取固定帧' : '建立裁剪候选' }}
      </button>
    </template>
    <div v-if="result">
      <img :src="assetUrl(result.id, result.revision)" alt="派生候选，尚未审看" />
      <p>用途：{{ requirement.purpose }} · 尚未审看</p>
      <button @click="emit('ready', result)">进入审看与绑定</button
      ><button @click="useFrameForCrop">继续裁剪此图</button>
    </div>
    <button @click="emit('close')">关闭</button>
  </section>
</template>
<style scoped>
img,
video {
  display: block;
  max-width: 100%;
  max-height: 280px;
  margin: 10px 0;
}
label {
  display: block;
  margin: 8px 0;
}
.crop-inputs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.crop-inputs input {
  width: 90px;
}
</style>
