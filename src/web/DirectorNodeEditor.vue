<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import type { CanvasNode } from '../shared/canvas';
import { directorSceneSchema, directorPose, type DirectorScene } from '../shared/director-scene';
import { createDirectorRenderer } from '../shared/director-renderer';
import { api } from './api';
const props = defineProps<{ canvas: RecordDoc; node: CanvasNode }>();
const emit = defineEmits(['refresh', 'operation', 'close']);
const scene = ref<DirectorScene>(directorSceneSchema.parse({})),
  surface = ref<HTMLCanvasElement>(),
  frame = ref(0),
  playing = ref(false),
  selected = ref('camera'),
  error = ref(''),
  dirty = ref(false),
  base = ref(0),
  note = ref('');
let renderer: ReturnType<typeof createDirectorRenderer> | undefined,
  raf = 0,
  last = 0;
onMounted(async () => {
  try {
    if (props.node.binding) {
      const data = await api(`/canvases/${props.canvas.id}/nodes/${props.node.id}/object`);
      scene.value = directorSceneSchema.parse(data.value.scene);
      base.value = data.source.revision;
    } else {
      const data = await api(`/canvases/${props.canvas.id}/nodes/${props.node.id}/director-draft`);
      scene.value = directorSceneSchema.parse(data.scene);
      note.value = data.note;
    }
    await nextTick();
    dirty.value = false;
    renderer = createDirectorRenderer(surface.value!);
    draw();
    raf = requestAnimationFrame(tick);
  } catch (e: any) {
    error.value = e.message;
  }
});
function draw() {
  try {
    renderer?.draw(scene.value, frame.value);
  } catch (e: any) {
    error.value = e.message;
  }
}
function tick(time: number) {
  if (playing.value && time - last > 1000 / 24) {
    frame.value = (frame.value + 1) % scene.value.frames;
    last = time;
  }
  raf = requestAnimationFrame(tick);
}
watch(frame, draw);
watch(
  scene,
  () => {
    dirty.value = true;
    draw();
  },
  { deep: true },
);
function add(shape: DirectorScene['objects'][number]['shape']) {
  const id = crypto.randomUUID();
  scene.value.objects.push({
    id,
    name: shape === 'person' ? '人物代理' : '场景代理',
    shape,
    color: '#8b7bd7',
    size: { x: 0.7, y: shape === 'person' ? 1.75 : 1, z: 0.7 },
    keys: [
      {
        frame: 0,
        position: { x: scene.value.objects.length * 1.5, y: 0, z: 0 },
        rotation: { x: 0, y: 0, z: 0 },
      },
    ],
  });
  selected.value = id;
}
function keys() {
  return selected.value === 'camera'
    ? scene.value.camera.keys
    : scene.value.objects.find((o) => o.id === selected.value)?.keys || [];
}
function keyframe() {
  const list = keys();
  if (!list.length) return;
  const sampled = directorPose(list, frame.value);
  if (!list.some((k) => k.frame === frame.value)) list.push({ frame: frame.value, ...sampled });
}
async function save() {
  try {
    const r = await api(`/canvases/${props.canvas.id}/nodes/${props.node.id}/object`, 'PUT', {
      canvasRevision: props.canvas.revision,
      objectRevision: base.value,
      data: { scene: scene.value },
    });
    base.value = r.object.revision;
    dirty.value = false;
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  renderer?.dispose();
});
</script>
<template>
  <section class="director-editor">
    <header>
      <div>
        <h2>{{ node.title }}</h2>
        <small>基础代理预演 · 24 fps · 不代表实际视频效果</small>
      </div>
      <button @click="emit('close')">返回画布</button>
    </header>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <p v-if="note" class="workspace-notice">{{ note }}</p>
    <div class="director-grid">
      <main>
        <canvas ref="surface" aria-label="三维导演预演" />
        <div class="button-row">
          <button @click="playing = !playing">{{ playing ? '暂停' : '播放' }}</button
          ><input type="range" min="0" :max="scene.frames - 1" v-model.number="frame" /><span
            >{{ frame }} / {{ scene.frames - 1 }} 帧</span
          >
        </div>
        <div class="button-row">
          <button @click="add('person')">＋ 人物代理</button
          ><button @click="add('box')">＋ 方块</button
          ><button @click="add('sphere')">＋ 球体</button
          ><button @click="add('cylinder')">＋ 圆柱</button>
        </div>
      </main>
      <aside>
        <label
          >对象<select v-model="selected">
            <option value="camera">摄影机</option>
            <option v-for="o in scene.objects" :key="o.id" :value="o.id">{{ o.name }}</option>
          </select></label
        ><template v-for="o in scene.objects.filter((o) => o.id === selected)" :key="o.id"
          ><label>名称<input v-model="o.name" /></label
          ><label>颜色<input type="color" v-model="o.color" /></label>
          <div class="field-pair">
            <label v-for="axis in ['x', 'y', 'z'] as const" :key="axis"
              >尺寸 {{ axis
              }}<input type="number" min="0.05" step="0.1" v-model.number="o.size[axis]"
            /></label>
          </div>
          <button
            @click="
              scene.objects = scene.objects.filter((v) => v.id !== selected);
              selected = 'camera';
            "
          >
            移除代理
          </button></template
        >
        <label v-if="selected === 'camera'"
          >焦距（毫米）<input
            type="number"
            min="10"
            max="300"
            v-model.number="scene.camera.focalLength"
        /></label>
        <div v-if="selected === 'camera'" class="field-pair">
          <label v-for="axis in ['x', 'y', 'z'] as const" :key="axis"
            >看向 {{ axis
            }}<input type="number" step="0.1" v-model.number="scene.camera.target[axis]"
          /></label>
        </div>
        <button @click="keyframe">在当前帧添加关键帧</button>
        <article
          v-for="k in keys().sort((a, b) => a.frame - b.frame)"
          :key="k.frame"
          class="keyframe-editor"
        >
          <button @click="frame = k.frame">帧 {{ k.frame }}</button
          ><button v-if="keys().length > 1" @click="keys().splice(keys().indexOf(k), 1)">
            删除
          </button>
          <div class="field-pair">
            <label v-for="axis in ['x', 'y', 'z'] as const" :key="axis"
              >位置 {{ axis }}<input type="number" step="0.1" v-model.number="k.position[axis]"
            /></label>
          </div>
          <div class="field-pair">
            <label v-for="axis in ['x', 'y', 'z'] as const" :key="axis"
              >旋转 {{ axis }}°<input type="number" v-model.number="k.rotation[axis]"
            /></label>
          </div>
        </article>
        <details>
          <summary>画布、时长与灯光</summary>
          <div class="field-pair">
            <label>宽<input type="number" step="2" v-model.number="scene.width" /></label
            ><label>高<input type="number" step="2" v-model.number="scene.height" /></label
            ><label>总帧数<input type="number" min="1" v-model.number="scene.frames" /></label>
          </div>
          <label>背景<input type="color" v-model="scene.background" /></label>
          <div class="field-pair">
            <label v-for="axis in ['x', 'y', 'z'] as const" :key="axis"
              >灯光 {{ axis
              }}<input type="number" step="0.1" v-model.number="scene.light.position[axis]"
            /></label>
          </div>
          <label
            >主光强度<input
              type="number"
              min="0"
              step="0.1"
              v-model.number="scene.light.intensity" /></label
          ><label
            >环境光<input type="number" min="0" step="0.1" v-model.number="scene.light.ambient"
          /></label>
        </details>
      </aside>
    </div>
    <footer>
      <button class="primary" @click="save">保存预演方案</button
      ><button :disabled="dirty || !node.binding" @click="emit('operation', 'previs_image')">
        输出 PNG</button
      ><button :disabled="dirty || !node.binding" @click="emit('operation', 'previs_video')">
        输出 MP4
      </button>
    </footer>
  </section>
</template>
