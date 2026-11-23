<script setup lang="ts">
import { ref, watch, onMounted } from 'vue';
import { api, assetUrl } from './api';
import RecordPicker from './RecordPicker.vue';
const props = defineProps<{ projectId: string; documents: any[] }>();
const models = ref<any[]>([]),
  model = ref(''),
  take = ref<any>(null),
  video = ref<any>(null),
  range = ref({ inFrame: 0, outFrame: 24 }),
  face = ref({ frame: 0, x: 0, y: 0, instanceId: '', inspected: false }),
  single = ref(false),
  preview = ref<any>(null),
  request = ref<any>(null),
  error = ref(''),
  key = ref(''),
  job = ref(''),
  busy = ref(false);
const player = ref<HTMLVideoElement | null>(null),
  takeRecord = ref<any>(null);
onMounted(async () => {
  try {
    const c = await api('/model-catalog');
    models.value = c.models.filter((m: any) => m.protocol === 'sync-lipsync' && m.available);
  } catch (e: any) {
    error.value = e.message;
  }
});
watch(
  [model, take, video, range, face, single],
  () => {
    preview.value = null;
    job.value = '';
  },
  { deep: true },
);
async function selectTake(r: any) {
  try {
    take.value = r;
    takeRecord.value = null;
    const d = await api('/records/' + r.id + '/versions/' + r.revision);
    if (take.value?.id !== r.id || take.value?.revision !== r.revision) return;
    takeRecord.value = d;
    face.value.instanceId = d.data.instanceId;
    face.value.inspected = false;
  } catch (e: any) {
    error.value = e.message;
  }
}
async function prepare() {
  preview.value = null;
  request.value = null;
  try {
    const m = models.value.find((m) => m.connection.id + ':' + m.id === model.value);
    if (!m) throw new Error('先在模型库配置可用的 Sync 口型模型');
    const r = {
      selection: {
        connection: { id: m.connection.id, revision: m.connection.revision },
        modelId: m.id,
      },
      video: video.value,
      take: take.value,
      range: range.value,
      face: face.value,
      singleSpeaker: single.value,
      originalAudio: 'replace',
    };
    const fixed = JSON.parse(JSON.stringify(r));
    const result = await api('/projects/' + props.projectId + '/lipsync/preview', 'POST', fixed);
    request.value = fixed;
    preview.value = result;
    key.value = crypto.randomUUID();
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function submit() {
  if (busy.value || !preview.value) return;
  busy.value = true;
  try {
    const j = await api('/projects/' + props.projectId + '/lipsync/submit', 'POST', {
      request: request.value,
      digest: preview.value.digest,
      idempotencyKey: key.value,
      approved: true,
    });
    job.value = j.id;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details class="panel">
    <summary>独立口型处理</summary>
    <p>
      固定视频与已听审对白；本次仅处理一个明确说话者，使用静音填充，不循环、倒放或变速补画面。原片声音替换，其他环境声在独立音轨中组织。
    </p>
    <p v-if="error" class="error">{{ error }}</p>
    <label
      >口型模型<select v-model="model">
        <option value="">选择 Sync 模型</option>
        <option
          v-for="m in models"
          :key="m.connection.id + ':' + m.id"
          :value="m.connection.id + ':' + m.id"
        >
          {{ m.name }} · {{ m.connection.name }} v{{ m.connection.revision }}
        </option>
      </select></label
    ><RecordPicker
      :project-id="projectId"
      kind="asset"
      label="固定原视频"
      @select="video = { id: $event.id, revision: $event.revision }"
    /><RecordPicker
      :project-id="projectId"
      kind="dialogue_take"
      label="选用对白"
      @select="selectTake({ id: $event.id, revision: $event.revision })"
    />
    <p>视频 {{ video }} · 对白 {{ take }}</p>
    <template v-if="video"
      ><video
        ref="player"
        controls
        :src="assetUrl(video.id, video.revision)"
        style="max-width: 100%; max-height: 360px"
      /><button
        @click="
          face.frame = Math.floor((player?.currentTime || 0) * 24);
          face.inspected = false;
        "
      >
        使用当前播放帧作为识别帧
      </button>
      <p>
        坐标按源视频像素填写；此处不自动识别人脸。确认所选帧和处理区间之后再勾选观察结论。
      </p></template
    >
    <template v-if="takeRecord"
      ><audio controls :src="assetUrl(takeRecord.data.asset.id, takeRecord.data.asset.revision)" />
      <p>已采用音频范围：{{ takeRecord.data.in }}–{{ takeRecord.data.out }} 秒</p></template
    >
    <div class="form-grid">
      <label>开始源帧<input type="number" v-model.number="range.inFrame" /></label
      ><label>结束源帧（不含）<input type="number" v-model.number="range.outFrame" /></label
      ><label>识别源帧<input type="number" v-model.number="face.frame" /></label
      ><label>脸部像素 X<input type="number" v-model.number="face.x" /></label
      ><label>脸部像素 Y<input type="number" v-model.number="face.y" /></label>
    </div>
    <label
      ><input
        type="checkbox"
        v-model="face.inspected"
      />已查看目标帧，脸部可见且坐标属于说话者</label
    ><label><input type="checkbox" v-model="single" />本处理区间仅有一个目标说话者</label
    ><button @click="prepare">查看口型准备预览</button
    ><template v-if="preview"
      ><p>
        处理 {{ preview.usage.seconds }} 秒，静音填充
        {{ preview.input.silencePaddingSeconds }} 秒；费用待供应商核定。
      </p>
      <p v-for="w in preview.warnings">{{ w }}</p>
      <details>
        <summary>固定输入与时间映射</summary>
        <pre>{{ JSON.stringify(preview, null, 2) }}</pre>
      </details>
      <button :disabled="busy || !!job" @click="submit">确认此输入并创建口型任务</button></template
    >
    <p v-if="job">任务 {{ job }}，结果可直接选用；原视频的观察结论不会自动继承。</p>
  </details>
</template>
