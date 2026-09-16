<script setup lang="ts">
import { computed, ref, defineAsyncComponent } from 'vue';
import { previsExamples } from '../shared/previs-examples';
const SpatialPreview = defineAsyncComponent(() => import('./SpatialPreview.vue'));
const exampleId = ref('');
import type { RecordDoc } from '../shared/contracts';
import { api, assetUrl } from './api';
import { useDraft } from './drafts';
import RecordPicker from './RecordPicker.vue';
const props = defineProps<{ projectId: string; documents: RecordDoc[] }>();
const emit = defineEmits(['refresh']);
const selected = ref<RecordDoc | null>(null),
  draft = ref<any>(null),
  error = ref(''),
  tool = ref('region'),
  active = ref('');
const local = useDraft(
  () => `layout:${props.projectId}:${selected.value?.id || 'new'}`,
  () => selected.value?.revision || 0,
  draft,
);
const extraRecords = ref<RecordDoc[]>([]),
  referenceKind = ref('layout');
const availableRecords = computed(() => [
  ...props.documents,
  ...extraRecords.value.filter((d) => !props.documents.some((p) => p.id === d.id)),
]);
async function includeRecord(item: any) {
  if (!item) return;
  try {
    const d = await api<RecordDoc>(`/records/${item.id}/versions/${item.revision}`);
    extraRecords.value = extraRecords.value.filter((r) => r.id !== d.id).concat(d);
    if (d.kind === 'layout') edit(d);
  } catch (e: any) {
    error.value = e.message;
  }
}
const layouts = computed(() => availableRecords.value.filter((d) => d.kind === 'layout')),
  environments = computed(() =>
    availableRecords.value.filter((d) => d.kind === 'entity' && d.data.type === 'environment'),
  );
function edit(d?: RecordDoc) {
  selected.value = d || null;
  draft.value = d
    ? JSON.parse(JSON.stringify(d.data))
    : {
        name: '新场景布局',
        environment: environments.value[0]
          ? { id: environments.value[0].id, revision: environments.value[0].revision }
          : null,
        image: null,
        regions: [],
        markers: [],
        cameras: [],
      };
}
function place(event: MouseEvent) {
  if (!draft.value) return;
  const box = (event.currentTarget as SVGElement).getBoundingClientRect();
  const x = Math.min(0.99, Math.max(0, (event.clientX - box.left) / box.width)),
    y = Math.min(0.99, Math.max(0, (event.clientY - box.top) / box.height));
  const id = crypto.randomUUID();
  if (tool.value === 'region')
    draft.value.regions.push({
      id,
      name: '区域',
      x,
      y,
      width: Math.min(0.2, 1 - x),
      height: Math.min(0.2, 1 - y),
    });
  else if (tool.value === 'camera')
    draft.value.cameras.push({ id, name: '机位', position: { x, y }, heading: 0, framing: '全景' });
  else
    draft.value.markers.push({
      id,
      name: tool.value === 'entrance' ? '出入口' : '固定物体',
      kind: tool.value,
      position: { x, y },
    });
  active.value = id;
}
async function save() {
  error.value = '';
  try {
    const d = selected.value
      ? await api(`/domain/${selected.value.id}`, 'PUT', {
          revision: selected.value.revision,
          data: draft.value,
        })
      : await api(`/projects/${props.projectId}/domain/layout`, 'POST', { data: draft.value });
    edit(d);
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
async function publishLibrary() {
  try {
    await api(`/projects/${props.projectId}/library`, 'POST', {
      name: draft.value.name,
      references: [{ id: selected.value!.id, revision: selected.value!.revision }],
    });
    error.value = '已发布到个人模板库';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section>
    <div class="section-head">
      <div>
        <h2>场景布局与机位</h2>
        <p>二维规划：原点左上，x 向右、y 向下；朝向 0° 向上，顺时针旋转。坐标不代表屏幕左右。</p>
      </div>
      <button @click="edit()">新建布局</button>
    </div>
    <details>
      <summary>通用空间示例（只读，不写入项目）</summary>
      <select v-model="exampleId">
        <option value="">选择示例</option>
        <option v-for="e in previsExamples" :value="e.id">{{ e.name }}</option></select
      ><SpatialPreview
        v-if="exampleId"
        :key="exampleId"
        :spec="previsExamples.find((e) => e.id === exampleId)!.spec"
      />
    </details>
    <p class="error" v-if="error">{{ error }}</p>
    <details>
      <summary>搜索全部布局、环境与底图</summary>
      <select v-model="referenceKind">
        <option value="layout">布局</option>
        <option value="entity">主体</option>
        <option value="asset">底图素材</option>
      </select>
      <RecordPicker
        :project-id="projectId"
        :kind="referenceKind"
        label="查找并加入当前列表"
        @select="includeRecord"
      />
    </details>
    <div class="actions">
      <button v-for="d in layouts" @click="edit(d)">{{ d.data.name }} · v{{ d.revision }}</button>
    </div>
    <article class="panel" v-if="draft">
      <p v-if="local.conflict.value" class="warning">
        服务端版本已变化，旧草稿已保留，请重新打开版本并核对。
      </p>
      <button v-if="!draft.space" @click="draft.space = { width: 10, depth: 10, height: 3 }">
        配置实际尺度（请按场景修正）
      </button>
      <div class="form-grid" v-if="draft.space">
        <label>宽度（米）<input type="number" step=".1" v-model.number="draft.space.width" /></label
        ><label
          >深度（米）<input type="number" step=".1" v-model.number="draft.space.depth" /></label
        ><label
          >高度（米）<input type="number" step=".1" v-model.number="draft.space.height"
        /></label>
      </div>
      <h4>墙体、门与区域连接</h4>
      <button
        @click="
          draft.barriers ||= [];
          draft.barriers.push({
            id: 'barrier-' + Date.now(),
            name: '新墙体',
            kind: 'wall',
            start: { x: 0.2, y: 0.5 },
            end: { x: 0.8, y: 0.5 },
            height: 2.5,
            thickness: 0.15,
            open: false,
            regions: [],
          });
        "
      >
        增加墙或门
      </button>
      <article v-for="(b, n) in draft.barriers || []">
        <div class="form-grid">
          <input v-model="b.name" placeholder="名称" /><select v-model="b.kind">
            <option value="wall">墙体</option>
            <option value="door">门</option></select
          ><label>起点 x<input type="number" step=".01" v-model.number="b.start.x" /></label
          ><label>起点 y<input type="number" step=".01" v-model.number="b.start.y" /></label
          ><label>终点 x<input type="number" step=".01" v-model.number="b.end.x" /></label
          ><label>终点 y<input type="number" step=".01" v-model.number="b.end.y" /></label
          ><label>高<input type="number" step=".1" v-model.number="b.height" /></label
          ><label>厚<input type="number" step=".05" v-model.number="b.thickness" /></label
          ><label><input type="checkbox" v-model="b.open" />默认开启</label
          ><select multiple v-model="b.regions">
            <option v-for="r in draft.regions" :value="r.id">{{ r.name }}</option>
          </select>
        </div>
        <button @click="draft.barriers.splice(n, 1)">删除</button>
      </article>
      <h4>机位镜头参数</h4>
      <article v-for="c in draft.cameras">
        <p>{{ c.name }}</p>
        <button v-if="!c.optics" @click="c.optics = { height: 1.6, pitch: 0, fov: 50 }">
          配置三维机位
        </button>
        <div class="form-grid" v-if="c.optics">
          <label>高度（米）<input type="number" step=".1" v-model.number="c.optics.height" /></label
          ><label>俯仰角<input type="number" v-model.number="c.optics.pitch" /></label
          ><label>垂直视场角<input type="number" v-model.number="c.optics.fov" /></label>
        </div>
      </article>
      <div class="form-grid">
        <label>名称<input v-model="draft.name" /></label
        ><label
          >环境主体<select
            :value="draft.environment?.id"
            @change="
              (event) => {
                const e = environments.find(
                  (e) => e.id === (event.target as HTMLSelectElement).value,
                );
                draft.environment = e ? { id: e.id, revision: e.revision } : null;
              }
            "
          >
            <option value="">选择环境</option>
            <option v-for="e in environments" :value="e.id">
              {{ e.data.name }} · v{{ e.revision }}
            </option>
          </select></label
        ><label
          >点击画布添加<select v-model="tool">
            <option value="region">区域</option>
            <option value="entrance">出入口</option>
            <option value="fixed_object">固定物体</option>
            <option value="camera">机位</option>
          </select></label
        ><label
          >布局底图<select
            :value="draft.image?.id || ''"
            @change="
              (event) => {
                const a = availableRecords.find(
                  (d) => d.id === (event.target as HTMLSelectElement).value,
                );
                draft.image = a ? { id: a.id, revision: a.revision } : null;
              }
            "
          >
            <option value="">无底图</option>
            <option
              v-for="a in availableRecords.filter(
                (d) => d.kind === 'asset' && d.data.mediaType === 'image',
              )"
              :value="a.id"
            >
              {{ a.data.name }}
            </option>
          </select></label
        >
      </div>
      <svg viewBox="0 0 1000 1000" role="img" aria-label="二维布局点击编辑画布" @click="place">
        <defs>
          <pattern id="layout-grid" width="50" height="50" patternUnits="userSpaceOnUse">
            <path d="M 50 0 L 0 0 0 50" fill="none" stroke="#33514d" />
          </pattern>
        </defs>
        <rect width="1000" height="1000" fill="url(#layout-grid)" />
        <image
          v-if="draft.image"
          :href="assetUrl(draft.image.id, draft.image.revision)"
          width="1000"
          height="1000"
          opacity=".3"
        />
        <g v-for="r in draft.regions" @click.stop="active = r.id">
          <rect
            :x="r.x * 1000"
            :y="r.y * 1000"
            :width="r.width * 1000"
            :height="r.height * 1000"
            fill="#52baa044"
            :stroke="active === r.id ? '#fff' : '#62c6af'"
          />
          <text :x="r.x * 1000 + 8" :y="r.y * 1000 + 28">{{ r.name }}</text>
        </g>
        <g v-for="b in draft.barriers || []">
          <line
            :x1="b.start.x * 1000"
            :y1="b.start.y * 1000"
            :x2="b.end.x * 1000"
            :y2="b.end.y * 1000"
            :stroke="b.kind === 'door' ? '#ffc775' : '#b2becb'"
            :stroke-dasharray="b.open ? '12 8' : undefined"
            stroke-width="8"
          />
          <text :x="b.start.x * 1000" :y="b.start.y * 1000 - 12">{{ b.name }}</text>
        </g>
        <g v-for="m in draft.markers" @click.stop="active = m.id">
          <circle :cx="m.position.x * 1000" :cy="m.position.y * 1000" r="12" fill="#ffc775" />
          <text :x="m.position.x * 1000 + 15" :y="m.position.y * 1000">{{ m.name }}</text>
        </g>
        <g
          v-for="c in draft.cameras"
          @click.stop="active = c.id"
          :transform="`translate(${c.position.x * 1000},${c.position.y * 1000})`"
        >
          <path d="M -14 10 L 0 -28 L 14 10 Z" fill="#87bcff" :transform="`rotate(${c.heading})`" />
          <text x="20" y="10">{{ c.name }} {{ c.heading }}°</text>
        </g>
      </svg>
      <h3>区域尺寸</h3>
      <div v-for="(r, n) in draft.regions" class="ref-row">
        <input v-model="r.name" aria-label="区域名称" /><label
          >x<input type="number" min="0" max="1" step=".01" v-model.number="r.x" /></label
        ><label>y<input type="number" min="0" max="1" step=".01" v-model.number="r.y" /></label
        ><label
          >宽<input type="number" min=".01" max="1" step=".01" v-model.number="r.width" /></label
        ><label
          >高<input type="number" min=".01" max="1" step=".01" v-model.number="r.height" /></label
        ><button @click="draft.regions.splice(n, 1)">移除</button>
      </div>
      <h3>标记与机位</h3>
      <div v-for="collection in [draft.markers, draft.cameras]">
        <div class="ref-row" v-for="(m, n) in collection">
          <input v-model="m.name" aria-label="标记名称" /><label
            >x<input
              type="number"
              min="0"
              max="1"
              step=".01"
              v-model.number="m.position.x" /></label
          ><label
            >y<input
              type="number"
              min="0"
              max="1"
              step=".01"
              v-model.number="m.position.y" /></label
          ><label v-if="'heading' in m"
            >机位朝向<input type="number" min="0" max="359" v-model.number="m.heading" /></label
          ><input v-if="'framing' in m" v-model="m.framing" placeholder="景别与构图" /><button
            @click="collection.splice(n, 1)"
          >
            移除
          </button>
        </div>
      </div>
      <div class="actions">
        <p v-if="draft.creationSource">
          此布局是导演结果的固定投影。请在分镜内容的导演编辑中调整场景
          {{ draft.creationSource.sceneDesignId }}，再重新准备制作。
        </p>
        <button class="primary" @click="save" :disabled="!!draft.creationSource">
          保存布局版本</button
        ><button v-if="selected" @click="publishLibrary">发布到模板库</button>
      </div>
      <p>布局辅助检查出入口、运动方向和轴线；实际遮挡与画面需要候选审核。</p>
    </article>
  </section>
</template>
<style scoped>
svg {
  width: 100%;
  max-width: 650px;
  display: block;
  background: #142523;
  cursor: crosshair;
  border: 1px solid #45655e;
  margin: 20px auto;
}
text {
  fill: #f0f8f4;
  font-size: 23px;
}
.ref-row input[type='number'] {
  max-width: 90px;
}
</style>
