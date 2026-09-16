<script setup lang="ts">
import { computed, defineAsyncComponent, ref } from 'vue';
import { authoringPrevis } from '../shared/staging-projection';
import { spatialAssessment } from '../shared/spatial';
import type { DirectorResult, AuthoringShot } from '../shared/creation';
const SpatialPreview = defineAsyncComponent(() => import('./SpatialPreview.vue'));
const props = defineProps<{
  director: DirectorResult;
  shot: AuthoringShot;
  basis: { id: string; revision: number };
  edit?: boolean;
  editScene?: boolean;
}>();
const open = ref(false),
  error = ref('');
const design = computed(() =>
  props.director.sceneDesigns?.find((d) => d.sceneId === props.shot.sceneId),
);
const preview = computed(() => {
  try {
    return { spec: authoringPrevis(props.director, props.shot.id, props.basis), error: '' };
  } catch (e: any) {
    return { spec: null, error: e.message };
  }
});
const assessment = computed(() =>
  preview.value.spec ? spatialAssessment(preview.value.spec) : null,
);
const poses = computed(() => {
  const d = preview.value.spec?.directing;
  return d && d.version !== 1 ? d.staging?.entry || [] : [];
});
function changeJson(event: Event, owner: any, key: string) {
  const target = event.target as HTMLTextAreaElement;
  try {
    owner[key] = JSON.parse(target.value);
    target.setCustomValidity('');
    error.value = '';
  } catch {
    target.setCustomValidity('请输入有效 JSON');
    error.value = '结构未保存到草稿，请修正 JSON';
  }
}
</script>
<template>
  <section class="director-space" v-if="director.contractRevision === 2">
    <h4>观察与空间依据</h4>
    <template v-if="edit">
      <label
        v-for="[key, label] in [
          ['audienceFocus', '观察重点'],
          ['informationChange', '新信息'],
          ['cutReason', '切点理由'],
          ['visibleSpace', '本镜可见空间'],
          ['visualTreatment', '本镜视觉处理'],
        ]"
        :key="key"
        >{{ label }}<textarea v-model="(shot as any)[key]" rows="2" />
      </label>
    </template>
    <dl v-else>
      <dt>观察重点</dt>
      <dd>{{ shot.audienceFocus }}</dd>
      <dt>新信息</dt>
      <dd>{{ shot.informationChange }}</dd>
      <dt>切点理由</dt>
      <dd>{{ shot.cutReason }}</dd>
      <dt>可见空间</dt>
      <dd>{{ shot.visibleSpace }}</dd>
    </dl>
    <p v-if="design?.applicability === 'not_applicable'">空间预演不适用：{{ design.reason }}</p>
    <template v-else>
      <p>
        {{ design?.scale === 'measured' ? '有尺寸依据的布局' : '示意布局' }} · {{ design?.reason }}
      </p>
      <p v-if="assessment">
        {{ assessment.reason
        }}<span v-if="assessment.missing.length">
          · 数据缺口 {{ assessment.missing.join('、') }}</span
        >
      </p>
      <p v-if="preview.error" class="error">{{ preview.error }}</p>
      <svg
        v-if="design"
        viewBox="-40 -40 1080 1080"
        role="img"
        :aria-label="`${shot.id} 的二维调度图`"
      >
        <rect x="0" y="0" width="1000" height="1000" fill="#f5f7fb" stroke="#b7bace" />
        <rect
          v-for="r in design.regions"
          :key="r.id"
          :x="r.x * 1000"
          :y="r.y * 1000"
          :width="r.width * 1000"
          :height="r.height * 1000"
          fill="none"
          stroke="#b7bace"
        />
        <line
          v-for="b in design.barriers"
          :key="b.id"
          :x1="b.start.x * 1000"
          :y1="b.start.y * 1000"
          :x2="b.end.x * 1000"
          :y2="b.end.y * 1000"
          :stroke="b.kind === 'door' ? '#b17b24' : '#566074'"
          :stroke-dasharray="b.open ? '10 10' : ''"
          stroke-width="8"
        />
        <g
          v-for="p in poses.filter((p) => p.position)"
          :key="p.instanceId"
          :transform="`translate(${p.position!.x * 1000} ${p.position!.y * 1000})`"
        >
          <circle r="18" fill="#6354ce" />
          <path
            v-if="p.heading !== null"
            d="M0 0 L0 -55 L-8 -40 M0 -55 L8 -40"
            :transform="`rotate(${p.heading})`"
            fill="none"
            stroke="#6354ce"
            stroke-width="5"
          />
          <text x="25" y="8">{{ p.instanceId }}</text>
        </g>
        <g
          v-for="c in design.cameras"
          :key="c.id"
          :transform="`translate(${c.position.x * 1000} ${c.position.y * 1000})`"
        >
          <path d="M-15 0 L0 -50 L15 0 Z" :transform="`rotate(${c.heading})`" fill="#198275" />
          <text x="25" y="8">{{ c.name }}</text>
        </g>
      </svg>
      <button type="button" @click="open = !open">
        {{ open ? '关闭三维预演' : '打开三维预演' }}
      </button>
      <SpatialPreview
        v-if="open && preview.spec"
        :spec="preview.spec"
        :authoring-id="edit ? undefined : basis.id"
        :revision="basis.revision"
        :width="1024"
        :height="576"
      />
    </template>
    <p v-for="p in shot.performances" :key="p.id">
      {{ p.subjectKey }} 关注
      {{ p.attention?.subjectKey || (p.attention?.point ? '空间点' : '尚未指定') }} ·
      {{ p.attention?.description }} · 头部方向 {{ p.headHeading ?? '未知' }}
    </p>
    <p v-for="i in shot.interactions" :key="i.id">
      {{ i.actorKey }} → {{ i.targetKey }} / {{ i.anchorId || '未指定锚点' }}：{{
        i.precondition
      }}
      → {{ i.action }} → {{ i.result }}
    </p>
    <details v-if="edit">
      <summary>编辑调度与交互结构</summary>
      <p>位置以场景归一化坐标表示，未知值保留 null。保存仍校验完整导演基线及本次可写范围。</p>
      <label
        >镜头调度<textarea
          :value="JSON.stringify(shot.staging, null, 2)"
          rows="12"
          @change="changeJson($event, shot, 'staging')"
        /></label
      ><label
        >交互<textarea
          :value="JSON.stringify(shot.interactions, null, 2)"
          rows="10"
          @change="changeJson($event, shot, 'interactions')"
        /></label
      ><label
        >表演与空间关注点<textarea
          :value="JSON.stringify(shot.performances, null, 2)"
          rows="10"
          @change="changeJson($event, shot, 'performances')"
        />
      </label>
    </details>
    <details v-if="edit && editScene && design">
      <summary>编辑共享场景、锚点与机位</summary>
      <label
        v-for="key in ['cameras', 'anchors', 'regions', 'barriers', 'proxies', 'space']"
        :key="key"
        >{{ key
        }}<textarea
          :value="JSON.stringify((design as any)[key], null, 2)"
          rows="6"
          @change="changeJson($event, design, key)"
        /></label
      ><label
        >尺度<select v-model="design.scale">
          <option value="schematic">示意</option>
          <option value="measured">有尺寸依据</option>
        </select></label
      >
    </details>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>
<style scoped>
svg {
  display: block;
  max-width: 560px;
  width: 100%;
  max-height: 340px;
}
text {
  font-size: 24px;
}
label {
  display: block;
}
textarea {
  width: 100%;
  box-sizing: border-box;
}
.director-space {
  margin-block: 1rem;
  padding: 1rem;
  border: 1px solid #d8dce8;
  border-radius: 8px;
}
</style>
