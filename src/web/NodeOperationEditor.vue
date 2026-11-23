<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { api, assetUrl } from './api';
import { actionLabels } from '../shared/node-catalog';
import type { RecordDoc } from '../shared/contracts';
import AudioWaveform from './AudioWaveform.vue';
import type { CanvasNode } from '../shared/canvas';
const props = defineProps<{
  canvas: RecordDoc;
  node: CanvasNode;
  action: string;
  assets: RecordDoc[];
  textRange?: any;
}>();
const emit = defineEmits(['close', 'submitted', 'model-settings']);
const request = ref<any>({}),
  models = ref<any[]>([]),
  model = ref(''),
  voices = ref<any[]>([]),
  voice = ref(''),
  selectedImages = ref<string[]>([]),
  sourceId = ref(props.node.asset ? props.node.asset.id + ':' + props.node.asset.revision : ''),
  videoId = ref(''),
  audioId = ref(''),
  preview = ref<any>(null),
  error = ref(''),
  busy = ref(false),
  key = ref(crypto.randomUUID());
const videoPlayer = ref<HTMLVideoElement>();
const sourceFps = computed(() => {
  const rate = source.value?.data.streams
    ?.find((s: any) => s.type === 'video')
    ?.frameRate?.split('/')
    .map(Number);
  return rate?.[1] ? rate[0] / rate[1] : 24;
});
const source = computed(() => props.assets.find((a) => a.id + ':' + a.revision === sourceId.value));
const remote = computed(() =>
  ['text_generate', 'rewrite', 'vision', 'transcribe', 'synthesize', 'lipsync'].includes(
    props.action,
  ),
);
const refFor = (id: string) => {
  const a = props.assets.find((a) => a.id + ':' + a.revision === id);
  return a ? { id: a.id, revision: a.revision } : undefined;
};
const modelOptions = computed(() =>
  models.value.filter((m) =>
    props.action === 'lipsync'
      ? m.protocol === 'sync-lipsync'
      : props.action === 'transcribe'
        ? m.protocol === 'tencent-asr'
        : props.action === 'synthesize'
          ? m.capabilities.operations?.includes('synthesize')
          : m.capabilities.kind === 'text' &&
            (props.action !== 'vision' || m.capabilities.imageInput),
  ),
);
onMounted(async () => {
  try {
    const incoming = props.canvas.data.edges
      .filter((e: any) => e.target === props.node.id && e.relation === 'input')
      .map((e: any) => {
        const node = props.canvas.data.nodes.find((n: any) => n.id === e.source);
        return { ...node, asset: e.asset || node?.asset };
      });
    if (!sourceId.value && incoming.length === 1)
      sourceId.value = incoming[0]?.asset
        ? incoming[0].asset.id + ':' + incoming[0].asset.revision
        : '';
    const videoInput = incoming.find(
      (n: any) => props.assets.find((a) => a.id === n?.asset?.id)?.data.mediaType === 'video',
    )?.asset;
    const audioInput = incoming.find(
      (n: any) => props.assets.find((a) => a.id === n?.asset?.id)?.data.mediaType === 'audio',
    )?.asset;
    videoId.value = videoInput ? videoInput.id + ':' + videoInput.revision : '';
    audioId.value = audioInput ? audioInput.id + ':' + audioInput.revision : '';
    const a = source.value;
    request.value = {
      start: props.node.range?.in || 0,
      end: props.node.range?.out || a?.data.duration || 1,
      frame: 'first',
      box: { x: 0, y: 0, width: a?.data.width || 100, height: a?.data.height || 100 },
      rows: 2,
      columns: 2,
      rate: 1,
      threshold: 0.3,
      maxShots: 24,
      instruction: props.node.text || '',
      speaker: '旁白',
      text: props.node.text || '',
      faceX: 0,
      faceY: 0,
      faceFrame: 0,
    };
    if (remote.value) {
      const catalog = await api('/model-connections');
      models.value = catalog.connections
        .filter((c: any) => c.currentlyEnabled)
        .flatMap((c: any) =>
          c.models
            .filter((m: any) => m.enabled !== false)
            .map((m: any) => ({
              ...m,
              key: c.id + ':' + m.id,
              protocol: c.data.protocol,
              label: m.name + ' · ' + c.data.name,
              selection: {
                connection: { id: c.id, revision: c.revision },
                modelId: m.id,
                mode: 'authored',
                promptProfile: 'automatic',
                parameters: {},
              },
            })),
        );
    }
    if (props.action === 'synthesize') voices.value = (await api('/voices?limit=100')).items;
  } catch (e: any) {
    error.value = e.message;
  }
});
watch(
  [request, model, voice, selectedImages, sourceId, videoId, audioId],
  () => {
    preview.value = null;
    key.value = crypto.randomUUID();
  },
  { deep: true },
);
watch(sourceId, () => {
  const a = source.value;
  if (a) {
    request.value.end = a.data.duration || 1;
    request.value.start = 0;
    request.value.box = { x: 0, y: 0, width: a.data.width || 100, height: a.data.height || 100 };
  }
});
function payload() {
  const r = request.value,
    m = models.value.find((m) => m.key === model.value)?.selection,
    action = props.action;
  if (['text_generate', 'rewrite', 'vision'].includes(action))
    return {
      model: m,
      instruction: r.instruction,
      images: selectedImages.value.map(refFor),
      ...(action === 'rewrite' && props.textRange
        ? {
            textRange: {
              start: props.textRange.start,
              end: props.textRange.end,
              expected: props.textRange.expected,
            },
          }
        : {}),
    };
  if (action === 'transcribe')
    return {
      model: m,
      source: refFor(sourceId.value),
      start: r.start,
      end: r.end,
      diarization: !!r.diarization,
    };
  if (action === 'synthesize') {
    const v = voices.value.find((v) => v.id === voice.value);
    return {
      selection: m,
      voice: v ? { id: v.id, revision: v.revision } : undefined,
      text: r.text,
      speaker: r.speaker,
      performance: { instructions: r.instruction || '' },
    };
  }
  if (action === 'lipsync')
    return {
      selection: m,
      video: refFor(videoId.value),
      audio: refFor(audioId.value),
      range: { inFrame: Math.round(r.start * 24), outFrame: Math.round(r.end * 24) },
      face: { frame: r.faceFrame, x: r.faceX, y: r.faceY, instanceId: r.speaker },
      originalAudio: 'replace',
      singleSpeaker: true,
    };
  if (action.startsWith('previs_')) return { frame: Number(r.frame) || 0 };
  const base = { source: refFor(sourceId.value) };
  if (['crop', 'mark'].includes(action)) return { ...base, box: r.box };
  if (action === 'grid') return { ...base, rows: r.rows, columns: r.columns };
  if (action === 'frame') return { ...base, frame: r.frame };
  return {
    ...base,
    start: r.start,
    end: r.end,
    ...(action === 'speed' ? { rate: r.rate } : {}),
    ...(action === 'analyze' ? { threshold: r.threshold, maxShots: r.maxShots } : {}),
  };
}
async function prepare() {
  busy.value = true;
  error.value = '';
  try {
    const operation = { action: props.action, request: payload() };
    preview.value = {
      operation,
      ...(await api(
        `/canvases/${props.canvas.id}/nodes/${props.node.id}/operation-preview`,
        'POST',
        operation,
      )),
    };
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function submit() {
  if (!preview.value) return;
  busy.value = true;
  error.value = '';
  try {
    const job = await api(
      `/canvases/${props.canvas.id}/nodes/${props.node.id}/operation-run`,
      'POST',
      {
        operation: preview.value.operation,
        digest: preview.value.digest,
        idempotencyKey: key.value,
      },
    );
    emit('submitted', job);
    emit('close');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
let origin: { x: number; y: number } | null = null;
function point(e: PointerEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  return {
    x: Math.max(
      0,
      Math.min(
        (source.value?.data.width || 1) - 1,
        Math.round(((e.clientX - rect.left) / rect.width) * source.value!.data.width),
      ),
    ),
    y: Math.max(
      0,
      Math.min(
        (source.value?.data.height || 1) - 1,
        Math.round(((e.clientY - rect.top) / rect.height) * source.value!.data.height),
      ),
    ),
  };
}
function boxStart(e: PointerEvent) {
  origin = point(e);
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function boxMove(e: PointerEvent) {
  if (!origin) return;
  const p = point(e);
  request.value.box = {
    x: Math.min(p.x, origin.x),
    y: Math.min(p.y, origin.y),
    width: Math.max(1, Math.abs(p.x - origin.x)),
    height: Math.max(1, Math.abs(p.y - origin.y)),
  };
}
</script>
<template>
  <section class="node-operation-editor">
    <header>
      <h2>{{ actionLabels[action] || action }} · {{ node.title }}</h2>
      <button @click="emit('close')">关闭</button>
    </header>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <label v-if="remote"
      >制作模型<select v-model="model">
        <option value="">选择兼容模型</option>
        <option v-for="m in modelOptions" :key="m.key" :value="m.key">{{ m.label }}</option>
      </select></label
    ><button v-if="remote && !modelOptions.length" @click="emit('model-settings')">
      配置可用模型
    </button>
    <label
      v-if="
        ![
          'text_generate',
          'rewrite',
          'vision',
          'synthesize',
          'lipsync',
          'previs_image',
          'previs_video',
        ].includes(action)
      "
      >源素材<select v-model="sourceId">
        <option value="">选择固定素材</option>
        <option v-for="a in assets" :key="a.id + ':' + a.revision" :value="a.id + ':' + a.revision">
          {{ a.data.name }} · v{{ a.revision }}
        </option>
      </select></label
    >
    <AudioWaveform
      v-if="source?.data.mediaType === 'audio'"
      :src="assetUrl(source.id, source.revision)"
    />
    <div v-if="source?.data.mediaType === 'video'">
      <video
        ref="videoPlayer"
        :src="assetUrl(source.id, source.revision)"
        controls
        preload="metadata"
        style="max-width: 100%; max-height: 260px"
      /><button
        v-if="action === 'frame'"
        @click="
          request.frame = Math.min(
            (source.data.frameCount || Infinity) - 1,
            Math.round((videoPlayer?.currentTime || 0) * sourceFps),
          )
        "
      >
        使用当前播放帧
      </button>
    </div>
    <blockquote v-if="textRange">{{ textRange.expected }}</blockquote>
    <div
      v-if="source?.data.mediaType === 'image'"
      class="image-region"
      @pointerdown="boxStart"
      @pointermove="boxMove"
      @pointerup="origin = null"
    >
      <img :src="assetUrl(source.id, source.revision)" draggable="false" /><span
        v-if="request.box && ['crop', 'mark'].includes(action)"
        :style="{
          left: (request.box.x / source.data.width) * 100 + '%',
          top: (request.box.y / source.data.height) * 100 + '%',
          width: (request.box.width / source.data.width) * 100 + '%',
          height: (request.box.height / source.data.height) * 100 + '%',
        }"
      />
    </div>
    <div v-if="['crop', 'mark'].includes(action) && request.box" class="field-pair">
      <label v-for="name in ['x', 'y', 'width', 'height']" :key="name"
        >{{ name }}<input type="number" min="0" v-model.number="request.box[name]"
      /></label>
    </div>
    <div v-if="action === 'grid'" class="field-pair">
      <label>行数<input type="number" min="1" max="12" v-model.number="request.rows" /></label
      ><label>列数<input type="number" min="1" max="12" v-model.number="request.columns" /></label>
    </div>
    <template v-if="action === 'frame'"
      ><label
        >画面位置<select v-model="request.frame">
          <option value="first">第一帧</option>
          <option value="last">最后一帧</option>
          <option :value="0">指定源帧</option>
        </select></label
      ><input
        v-if="typeof request.frame === 'number'"
        type="number"
        min="0"
        v-model.number="request.frame"
    /></template>
    <div
      v-if="
        ['trim', 'extract_audio', 'separate', 'analyze', 'speed', 'transcribe', 'lipsync'].includes(
          action,
        )
      "
      class="field-pair"
    >
      <label
        >源开始秒<input type="number" min="0" step="0.001" v-model.number="request.start" /></label
      ><label
        >源结束秒<input type="number" min="0" step="0.001" v-model.number="request.end"
      /></label>
    </div>
    <label v-if="action === 'speed'"
      >显式播放速度<input
        type="number"
        min="0.25"
        max="4"
        step="0.05"
        v-model.number="request.rate"
    /></label>
    <div v-if="action === 'analyze'" class="field-pair">
      <label
        >画面变化阈值<input
          type="number"
          min="0.01"
          max="0.99"
          step="0.01"
          v-model.number="request.threshold" /></label
      ><label
        >最多输出镜头<input type="number" min="1" max="100" v-model.number="request.maxShots"
      /></label>
    </div>
    <fieldset v-if="action === 'vision'">
      <legend>明确选定采样帧</legend>
      <label
        v-for="a in assets.filter((a) => a.data.mediaType === 'image')"
        :key="a.id + ':' + a.revision"
        class="check-label"
        ><input type="checkbox" v-model="selectedImages" :value="a.id + ':' + a.revision" />{{
          a.data.name
        }}</label
      >
      <p>只分析这些图片；不代表完整观看视频或听审。</p>
    </fieldset>
    <label v-if="['text_generate', 'rewrite', 'vision'].includes(action)"
      >创作或分析要求<textarea v-model="request.instruction" rows="6" />
    </label>
    <label v-if="action === 'transcribe'" class="check-label"
      ><input
        type="checkbox"
        v-model="request.diarization"
      />识别说话人编号（不自动关联角色）</label
    >
    <template v-if="action === 'synthesize'"
      ><label
        >全局音色<select v-model="voice">
          <option value="">选择音色固定版本</option>
          <option v-for="v in voices" :key="v.id" :value="v.id">
            {{ v.data?.name || v.name }} · v{{ v.revision }}
          </option>
        </select></label
      ><label>台词原文<textarea v-model="request.text" rows="5" /></label
      ><label>表演说明<textarea v-model="request.instruction" rows="2" /></label
    ></template>
    <template v-if="action === 'lipsync'"
      ><label
        >视频<select v-model="videoId">
          <option value="">选择视频</option>
          <option
            v-for="a in assets.filter((a) => a.data.mediaType === 'video')"
            :key="a.id + ':' + a.revision"
            :value="a.id + ':' + a.revision"
          >
            {{ a.data.name }}
          </option>
        </select></label
      ><label
        >替换音频<select v-model="audioId">
          <option value="">选择音频</option>
          <option
            v-for="a in assets.filter((a) => a.data.mediaType === 'audio')"
            :key="a.id + ':' + a.revision"
            :value="a.id + ':' + a.revision"
          >
            {{ a.data.name }}
          </option>
        </select></label
      >
      <div class="field-pair">
        <label v-for="name in ['faceFrame', 'faceX', 'faceY']" :key="name"
          >{{ name }}<input type="number" min="0" v-model.number="request[name]"
        /></label>
      </div>
      <p>原片声音替换为该音频；短音频补静音，不循环或加速。</p></template
    >
    <label v-if="['synthesize', 'lipsync'].includes(action)"
      >说话目标<input v-model="request.speaker"
    /></label>
    <label v-if="action === 'previs_image'"
      >输出帧号<input type="number" min="0" v-model.number="request.frame"
    /></label>
    <section v-if="preview" class="execution-preview">
      <strong>固定输入已准备</strong>
      <p v-for="w in preview.warnings" :key="w">{{ w }}</p>
      <pre>{{ preview.usage }}</pre>
      <details>
        <summary>来源与请求详情</summary>
        <pre>{{ preview.input }}</pre>
      </details>
    </section>
    <footer>
      <button :disabled="busy" @click="prepare">查看执行输入</button
      ><button class="primary" :disabled="busy || !preview" @click="submit">
        {{ remote ? '提交模型任务' : '开始本地处理' }}
      </button>
    </footer>
  </section>
</template>
