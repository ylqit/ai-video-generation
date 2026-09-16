<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api, assetUrl } from './api';
import { assemblyDimensions } from '../shared/series';
import RecordPicker from './RecordPicker.vue';
import ContractField from './ContractField.vue';
const props = defineProps<{
    edlId: string;
    episode: any;
    prepareOnly?: boolean;
    fixedExport?: { id: string; revision: number };
  }>(),
  emit = defineEmits(['refresh', 'play', 'prepared']);
const snapshot = ref<any>(null),
  scope = ref<any>(null),
  review = ref<any>(null),
  exportAsset = ref<any>(null),
  canon = ref<any>(null),
  preview = ref<any>(null),
  error = ref(''),
  notice = ref('');
const page = ref(0),
  filter = ref('all');
const filteredScopes = computed(() =>
  (snapshot.value?.scopes || []).filter(
    (s: any) =>
      filter.value === 'all' || (filter.value === 'pending' ? !s.passed : s.scope === filter.value),
  ),
);
const visibleScopes = computed(() =>
  filteredScopes.value.slice(page.value * 20, (page.value + 1) * 20),
);
watch(filter, () => {
  page.value = 0;
});
const labels: Record<string, string> = {
  identity: '身份与外观',
  state: '属性与持物',
  action: '动作阶段',
  space: '视线与空间',
  dialogue: '对白与说话者',
  sound: '声音接续',
  narrative: '时间与叙事',
};
watch([() => props.edlId, () => props.episode.revision], load, { immediate: true });
async function load() {
  try {
    if (props.fixedExport) exportAsset.value = props.fixedExport;
    snapshot.value = await api(`/edls/${props.edlId}/assembly`);
    const chain = await api(`/episodes/${props.episode.id}/series-facts`);
    if (!canon.value || canon.value.episode.id !== props.episode.id)
      canon.value = {
        schemaVersion: 3,
        episode: snapshot.value.episode,
        previous: chain.canon ? { id: chain.canon.id, revision: chain.canon.revision } : null,
        instances: chain.canon?.data.instances || [],
        states: [],
        relations: chain.canon?.data.relations || [],
        relationSources: [],
        attributes: chain.canon?.data.attributes || [],
        unfinishedActions: chain.canon?.data.unfinishedActions || [],
        facts: [],
        openLoops: [],
        correctionReason: '',
      };
    preview.value = null;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
function choose(s: any) {
  scope.value = s;
  const w = s.window || s;
  review.value = {
    version: 1,
    edl: snapshot.value.edl,
    scope: s.scope,
    key: s.key,
    digest: s.digest,
    startFrame: w.startFrame,
    endFrame: w.endFrame,
    dimensions: Object.fromEntries(assemblyDimensions.map((d) => [d, 'unreviewed'])),
    reasons: {},
    watched: false,
    listened: false,
    conclusion: '',
  };
}
async function saveReview() {
  try {
    await api('/assembly-reviews', 'POST', {
      data: { ...review.value, ...(exportAsset.value ? { exportAsset: exportAsset.value } : {}) },
    });
    notice.value = '审核记录已固定';
    await load();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
async function prepare() {
  try {
    preview.value = await api(`/edls/${props.edlId}/release/preview`, 'POST', {
      exportAsset: exportAsset.value,
      canon: canon.value,
    });
    emit('prepared', {
      canon: canon.value,
      exportAsset: exportAsset.value,
      preview: preview.value,
    });
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function confirm() {
  try {
    const result = await api(`/edls/${props.edlId}/release/confirm`, 'POST', {
      exportAsset: exportAsset.value,
      canon: canon.value,
      digest: preview.value.digest,
      idempotencyKey: `release-${preview.value.digest}`,
    });
    notice.value = `交付 ${result.id} 已与 Canon 同时固定`;
    preview.value = null;
    emit('refresh');
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section class="panel">
    <h3>接点、场景与正式交付</h3>
    <p>单段采用后可继续装配。实际接点、场景及整集观看通过后，才可确认交付与本集事实。</p>
    <button @click="load">核对当前时间线</button>
    <p class="error" v-if="error">{{ error }}</p>
    <p>{{ notice }}</p>
    <template v-if="snapshot"
      ><p>
        实际 {{ snapshot.frames }} 帧 · 正片 {{ snapshot.storyFrames }} 帧 · 目标
        {{ snapshot.runtime.targetFrames }} ± {{ snapshot.runtime.toleranceFrames }} 帧 · 差额
        {{ snapshot.differenceFrames }} 帧
      </p>
      <details v-if="snapshot.blockers.length">
        <summary>交付前待处理 {{ snapshot.blockers.length }} 项</summary>
        <p class="warning" v-for="b in snapshot.blockers">{{ b }}</p>
      </details>
      <label
        >审核范围筛选<select v-model="filter">
          <option value="all">全部范围</option>
          <option value="pending">未通过</option>
          <option value="join">接点</option>
          <option value="scene">场景</option>
          <option value="episode">整集</option>
        </select></label
      >
      <p>
        {{ filteredScopes.length }} 项 · 第 {{ page + 1 }} /
        {{ Math.max(1, Math.ceil(filteredScopes.length / 20)) }} 页
      </p>
      <button :disabled="page === 0" @click="page--">上一页</button
      ><button :disabled="(page + 1) * 20 >= filteredScopes.length" @click="page++">下一页</button>
      <table>
        <thead>
          <tr>
            <th>范围</th>
            <th>帧区间</th>
            <th>当前有效审核</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in visibleScopes" :key="s.key">
            <td>
              <button @click="choose(s)">{{ s.scope }} · {{ s.key }}</button>
            </td>
            <td>[{{ s.startFrame }}, {{ s.endFrame }})</td>
            <td>{{ s.passed ? '通过' : s.review ? '存在问题或未审项' : '未审核／已过期' }}</td>
          </tr>
        </tbody>
      </table></template
    >
    <div v-if="review" class="panel">
      <h4>{{ review.scope }} · {{ review.key }}</h4>
      <button @click="emit('play', { startFrame: review.startFrame, endFrame: review.endFrame })">
        播放已保存时间线的审核区间
      </button>
      <div class="form-grid">
        <label>审核起帧<input type="number" v-model.number="review.startFrame" /></label
        ><label>审核出帧<input type="number" v-model.number="review.endFrame" /></label>
      </div>
      <table>
        <tr v-for="d in assemblyDimensions">
          <td>{{ labels[d] }}</td>
          <td>
            <select v-model="review.dimensions[d]">
              <option value="unreviewed">未审核</option>
              <option value="pass">通过</option>
              <option value="issues">存在问题</option>
              <option value="not_applicable">不适用</option>
            </select>
          </td>
          <td><input v-model="review.reasons[d]" placeholder="问题证据或不适用理由" /></td>
        </tr>
      </table>
      <label><input type="checkbox" v-model="review.watched" />实际看过相关区间</label
      ><label><input type="checkbox" v-model="review.listened" />实际听过生效声音</label
      ><label>审核结论<textarea v-model="review.conclusion" /></label
      ><button @click="saveReview">固定装配审核</button>
    </div>
    <RecordPicker
      v-if="!fixedExport"
      :project-id="episode.projectId"
      kind="asset"
      label="实际审核版导出媒体"
      @select="
        (r) => {
          exportAsset = { id: r.id, revision: r.revision };
          preview = null;
        }
      "
    /><video
      v-if="exportAsset"
      controls
      :src="assetUrl(exportAsset.id, exportAsset.revision)"
      style="max-width: 100%"
    />
    <p>整集审核必须完整观看上述固定导出。选择素材不会自动标记看审或听审。</p>
    <ContractField v-if="canon" label="本集 Canon 变化及证据（V3）" v-model="canon" /><button
      @click="prepare"
    >
      预览交付与事实确认
    </button>
    <div v-if="preview">
      <p>
        将固定 {{ preview.frames }} 帧交付、{{ preview.reviews.length }} 条装配审核与
        Canon。所有输入将再次核对。
      </p>
      <button v-if="!prepareOnly" @click="confirm">确认正式交付与 Canon</button>
      <p v-else>事实方案已就绪，请在创作会话确认当前实际成片后提交。</p>
    </div>
  </section>
</template>
