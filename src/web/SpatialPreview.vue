<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { api } from './api';
import { sampleShot, worldPoint, spatialAssessment, spatialAnchor } from '../shared/spatial';
import type { ShotExecutionSpec } from '../shared/directing';
import type * as Three from 'three';
const props = defineProps<{
  spec: ShotExecutionSpec;
  episodeId?: string;
  authoringId?: string;
  revision?: number;
  width?: number;
  height?: number;
}>();
const emit = defineEmits(['saved']);
const canvas = ref<HTMLCanvasElement>(),
  frame = ref(0),
  playing = ref(false),
  view = ref('camera'),
  error = ref(''),
  notice = ref(''),
  saving = ref(false),
  orbit = ref({ heading: 35, elevation: 45, distance: 1.5 }),
  aspectChoice = ref('portrait');
const width = computed(() => props.width || (aspectChoice.value === 'portrait' ? 576 : 1024)),
  height = computed(() => props.height || (aspectChoice.value === 'portrait' ? 1024 : 576));
const assessment = computed(() => spatialAssessment(props.spec, width.value / height.value));
const checks = computed(() => assessment.value.issues);
const measurements = computed(() => {
  const current = sampleShot(props.spec, frame.value),
    next = sampleShot(props.spec, frame.value + 1);
  return current.instances
    .filter((i: any) => i.position)
    .map((i: any) => {
      const p = next.instances.find((v: any) => v.instanceId === i.instanceId)?.position;
      return {
        id: i.instanceId,
        ...i.position,
        speed: p ? Math.hypot(p.x - i.position.x, p.z - i.position.z) * 24 : 0,
      };
    });
});
let THREE: typeof Three,
  renderer: Three.WebGLRenderer | undefined,
  scene: Three.Scene,
  camera: Three.PerspectiveCamera;
let timer = 0,
  disposed = false,
  last = 0;
function releaseScene() {
  scene?.traverse((o: any) => {
    o.geometry?.dispose();
    if (o.material)
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
  scene?.clear();
}
function draw() {
  if (!renderer || disposed) return;
  releaseScene();
  const sample = sampleShot(props.spec, frame.value),
    space = props.spec.layout?.data.space || { width: 10, depth: 10, height: 3 };
  const box = (
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    color: string,
    rotation = 0,
  ) => {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshBasicMaterial({ color, wireframe: false }),
    );
    mesh.position.set(x, y, z);
    mesh.rotation.y = rotation;
    scene.add(mesh);
    return mesh;
  };
  box(space.width, 0.05, space.depth, space.width / 2, -0.03, space.depth / 2, '#293b45');
  const grid = new THREE.GridHelper(Math.max(space.width, space.depth), 10, '#58747e', '#42555e');
  grid.position.set(space.width / 2, 0, space.depth / 2);
  scene.add(grid);
  for (const m of props.spec.layout?.data.markers || [])
    if (m.kind === 'fixed_object') {
      const p = worldPoint(m.position, space);
      box(0.6, 0.8, 0.6, p.x, 0.4, p.z, '#627e83');
    }
  for (const b of sample.barriers) {
    if (b.open) continue;
    const a = worldPoint(b.start, space),
      end = worldPoint(b.end, space),
      length = Math.hypot(end.x - a.x, end.z - a.z);
    box(
      length,
      b.height,
      b.thickness,
      (a.x + end.x) / 2,
      b.height / 2,
      (a.z + end.z) / 2,
      b.kind === 'door' ? '#d2b274' : '#667583',
      -Math.atan2(end.z - a.z, end.x - a.x),
    );
  }
  for (const i of sample.instances) {
    if (!i.position) continue;
    const p = i.proxy,
      r = Math.max(0.05, Math.min(p.width, p.depth) / 2);
    const geometry =
      p.shape === 'capsule'
        ? new THREE.CapsuleGeometry(r, Math.max(0.01, p.height - 2 * r), 4, 8)
        : p.shape === 'cylinder'
          ? new THREE.CylinderGeometry(r, r, p.height, 12)
          : new THREE.BoxGeometry(p.width, p.height, p.depth);
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: p.color }));
    mesh.position.set(i.position.x, p.height / 2, i.position.z);
    mesh.rotation.y = (-i.pose.heading * Math.PI) / 180;
    scene.add(mesh);
    const dir = new THREE.Vector3(
      Math.sin((i.pose.heading * Math.PI) / 180),
      0,
      -Math.cos((i.pose.heading * Math.PI) / 180),
    );
    scene.add(
      new THREE.ArrowHelper(
        dir,
        new THREE.Vector3(i.position.x, p.height, i.position.z),
        0.7,
        '#ffce6b',
      ),
    );
    const performance = props.spec.directing?.performance.find(
      (v) => v.instanceId === i.instanceId,
    );
    if (performance?.headHeading !== undefined) {
      const yaw = (performance.headHeading * Math.PI) / 180;
      scene.add(
        new THREE.ArrowHelper(
          new THREE.Vector3(Math.sin(yaw), 0, -Math.cos(yaw)),
          new THREE.Vector3(i.position.x, p.height, i.position.z),
          0.5,
          '#87bcff',
        ),
      );
    }
    const attention = performance?.attention;
    const other = sample.instances.find((v: any) => v.instanceId === attention?.instanceId);
    const target = attention?.anchorId
      ? spatialAnchor(props.spec, sample, attention.anchorId)?.position
      : attention?.point
        ? worldPoint(attention.point, space)
        : other?.position
          ? { ...other.position, y: other.proxy.height / 2 }
          : null;
    if (target)
      scene.add(
        new THREE.ArrowHelper(
          new THREE.Vector3(
            target.x - i.position.x,
            target.y - p.height,
            target.z - i.position.z,
          ).normalize(),
          new THREE.Vector3(i.position.x, p.height, i.position.z),
          1.2,
          '#86e8b1',
        ),
      );
  }
  camera.aspect = width.value / height.value;
  if (view.value === 'camera' && sample.camera) {
    const c = sample.camera,
      p = worldPoint({ ...c.position, height: c.height }, space),
      yaw = (c.heading * Math.PI) / 180,
      pitch = (c.pitch * Math.PI) / 180;
    camera.position.set(p.x, p.y, p.z);
    camera.fov = c.fov;
    camera.lookAt(
      p.x + Math.sin(yaw) * Math.cos(pitch),
      p.y + Math.sin(pitch),
      p.z - Math.cos(yaw) * Math.cos(pitch),
    );
  } else {
    camera.fov = 50;
    const yaw = (orbit.value.heading * Math.PI) / 180,
      elevation = (orbit.value.elevation * Math.PI) / 180;
    const distance = Math.max(space.width, space.depth) * orbit.value.distance;
    camera.position.set(
      space.width / 2 + Math.sin(yaw) * Math.cos(elevation) * distance,
      Math.sin(elevation) * distance,
      space.depth / 2 + Math.cos(yaw) * Math.cos(elevation) * distance,
    );
    camera.lookAt(space.width / 2, 0, space.depth / 2);
  }
  camera.updateProjectionMatrix();
  renderer.setSize(width.value, height.value, false);
  renderer.render(scene, camera);
}
function animate(now: number) {
  if (disposed) return;
  if (playing.value && now - last >= 1000 / 24) {
    frame.value = (frame.value + Math.floor((now - last) / (1000 / 24))) % props.spec.frames;
    last = now;
  }
  if (!playing.value) last = now;
  timer = requestAnimationFrame(animate);
}
async function save() {
  error.value = '';
  notice.value = '';
  playing.value = false;
  saving.value = true;
  const capturedFrame = frame.value;
  try {
    if (
      (!props.authoringId && !props.episodeId) ||
      !props.revision ||
      !renderer ||
      view.value !== 'camera' ||
      !sampleShot(props.spec, frame.value).camera
    )
      throw new Error('请先保存分镜并选择实际机位');
    const params = new URLSearchParams({
      revision: String(props.revision),
      frame: String(frame.value),
      width: String(width.value),
      height: String(height.value),
    });
    const endpoint = props.authoringId
      ? `/authoring-results/${props.authoringId}/shots/${props.spec.shotId}`
      : `/episodes/${props.episodeId}/shots/${props.spec.shotId}`;
    const prepared = await api<any>(`${endpoint}/previs?${params}`);
    if (JSON.stringify(prepared.manifest.spec) !== JSON.stringify(props.spec))
      throw new Error('编辑内容与固定版本不同，请先保存分镜');
    if (frame.value !== capturedFrame) throw new Error('预演帧已改变，请重新导出');
    draw();
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.value!.toBlob(
        (v) => (v ? resolve(v) : reject(new Error('PNG 导出失败'))),
        'image/png',
      ),
    );
    const data = new FormData();
    params.forEach((v, k) => data.set(k, v));
    data.set('digest', prepared.digest);
    data.set('file', blob, 'previs.png');
    await api(`${endpoint}/previs-image`, 'POST', data);
    notice.value = '构图参考已进入候选素材，尚未采用或用于生成。';
    emit('saved');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    saving.value = false;
  }
}
watch(() => [props.spec, frame.value, view.value, width.value, height.value, orbit.value], draw, {
  deep: true,
});
onMounted(async () => {
  try {
    THREE = await import('three');
    if (disposed) return;
    const context = canvas.value?.getContext('webgl2', { preserveDrawingBuffer: true });
    if (!context) throw new Error('WebGL 2 不可用；二维布局仍可编辑');
    renderer = new THREE.WebGLRenderer({
      canvas: canvas.value,
      context,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    scene = new THREE.Scene();
    scene.background = new THREE.Color('#101820');
    camera = new THREE.PerspectiveCamera(50, 9 / 16, 0.01, 10000);
    draw();
    timer = requestAnimationFrame(animate);
  } catch (e: any) {
    error.value = e.message;
  }
});
onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(timer);
  releaseScene();
  renderer?.dispose();
  renderer?.forceContextLoss();
});
</script>
<template>
  <section class="previs-panel">
    <h4>空间与机位预演</h4>
    <p class="muted">
      {{ sampleShot(spec, frame).measured ? '按配置尺度预演' : '示意尺度；不证明实际距离或速度' }} ·
      代理几何不代表正式外观或真实动作。
    </p>
    <p>
      {{
        (
          {
            not_applicable: '不适用',
            not_run: '未执行',
            schematic: '示意布局',
            incomplete: '检查数据不完整',
            checked: '已执行代理检查',
          } as any
        )[assessment.status]
      }}
      · {{ assessment.reason }}
    </p>
    <p v-for="item in assessment.missing" :key="item">待补充：{{ item }}</p>
    <p class="error" v-if="error">{{ error }}</p>
    <p v-if="notice">{{ notice }}</p>
    <div class="actions">
      <select v-model="view">
        <option value="camera">拍摄机位</option>
        <option value="overview">自由观察视角</option></select
      ><button @click="playing = !playing">{{ playing ? '暂停' : '播放' }}</button
      ><select v-if="!props.width" v-model="aspectChoice" aria-label="预演画幅" :disabled="saving">
        <option value="portrait">9:16 竖屏</option>
        <option value="landscape">16:9 横屏</option></select
      ><button
        @click="save"
        :disabled="saving || (!episodeId && !authoringId) || view !== 'camera'"
      >
        {{ saving ? '正在保存' : '保存构图参考' }}
      </button>
    </div>
    <div v-if="view === 'overview'" class="form-grid">
      <label>观察方向<input type="range" min="0" max="360" v-model.number="orbit.heading" /></label>
      <label
        >观察俯角<input type="range" min="5" max="89" v-model.number="orbit.elevation"
      /></label>
      <label
        >观察距离<input type="range" min=".3" max="3" step=".1" v-model.number="orbit.distance"
      /></label>
    </div>
    <canvas ref="canvas" :style="{ aspectRatio: `${width}/${height}` }" />
    <label
      >帧 {{ frame }} / {{ spec.frames - 1 }} · {{ (frame / 24).toFixed(3) }} 秒<input
        type="range"
        v-model.number="frame"
        :min="0"
        :max="spec.frames - 1"
        step="1"
        :disabled="saving"
    /></label>
    <ul v-if="sampleShot(spec, frame).measured">
      <li v-for="m in measurements">
        {{ m.id }} · X {{ m.x.toFixed(2) }} m / Z {{ m.z.toFixed(2) }} m ·
        {{ m.speed.toFixed(2) }} m/s（线性路径）
      </li>
    </ul>
    <details v-if="checks.length">
      <summary>拍摄机位检查：{{ checks.length }} 项空间风险（按当前画幅）</summary>
      <p v-for="issue in checks" :key="issue.code" class="warning">
        {{ issue.code }} · {{ issue.message }}
      </p>
    </details>
    <p v-if="!spec.camera && !spec.directing?.camera.keys.length">
      未配置拍摄机位；当前只显示空间总览。
    </p>
  </section>
</template>
<style scoped>
.previs-panel canvas {
  width: 100%;
  max-height: 480px;
  object-fit: contain;
  background: #101820;
}
.previs-panel input[type='range'] {
  width: 100%;
}
</style>
