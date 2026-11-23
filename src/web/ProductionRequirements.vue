<script setup lang="ts">
import type { WorkspaceSnapshot } from '../shared/workspace';
import { computed, ref } from 'vue';
import { api } from './api';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['refresh']);
const basis = computed(() => props.snapshot.productionRequirements);
const editing = ref<any>(null),
  base = ref(0),
  error = ref(''),
  busy = ref(false);
const episode = computed(() =>
  props.snapshot.episodes.find((e) => e.id === basis.value?.current.episode.id),
);
function edit() {
  base.value = episode.value!.revision;
  editing.value = JSON.parse(JSON.stringify(episode.value!.data.seriesProduction));
  error.value = '';
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  try {
    await api(`/episodes/${episode.value!.id}/requirements`, 'PUT', {
      revision: base.value,
      data: editing.value,
    });
    editing.value = null;
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
const duration = (p: any) =>
  p.runtime
    ? `${p.runtime.targetFrames / 24} 秒，允许偏差 ${p.runtime.toleranceFrames / 24} 秒`
    : p.duration.mode === 'derive'
      ? '按内容推导'
      : `${p.duration.seconds} 秒`;
</script>
<template>
  <section v-if="basis" class="panel">
    <h3>本集制作要求</h3>
    <p>
      {{ duration(basis.current) }} · {{ basis.current.canvas.width }} ×
      {{ basis.current.canvas.height }} ·
      {{
        basis.current.canvas.mismatch === 'letterbox' ? '不同画幅明确留边' : '生成与交付画幅须一致'
      }}
    </p>
    <small
      >时长来源：{{ basis.current.origins.duration }}；画布来源：{{
        basis.current.origins.canvas
      }}。修改规格请到系列规划，更新后修订创作依据。</small
    >
    <p
      v-if="
        basis.fixed &&
        JSON.stringify(basis.fixed.duration) !== JSON.stringify(basis.current.duration)
      "
      class="warning"
    >
      当前创作固定为 {{ duration(basis.fixed) }}；新计划已变化，需要修订。
    </p>
    <p v-for="w in basis.fixed?.warnings" class="warning">{{ w }}</p>
    <p :class="basis.predecessor.hypothetical ? 'warning' : ''">
      {{
        basis.predecessor.hypothetical
          ? '假设稿 · 前集事实尚未确认'
          : basis.predecessor.status === 'independent'
            ? '独立单元 · 不继承前集动态状态'
            : basis.predecessor.status === 'confirmed'
              ? '直接前置事实已确认'
              : '系列起点'
      }}
      {{ basis.predecessor.waiting || basis.predecessor.reason }}
    </p>
    <button v-if="episode?.data.seriesProduction" @click="edit">设置本集明确覆盖</button>
    <div v-if="editing" class="form-grid">
      <p>只改变本集要求，保存后需要比较并修订当前创作依据；已导出历史保留。</p>
      <button v-if="!editing.runtime" @click="editing.runtime = { ...basis.current.runtime }">
        覆盖本集时长
      </button>
      <template v-if="editing.runtime">
        <label
          >本集秒数<input
            type="number"
            min="1"
            :value="editing.runtime.targetFrames / 24"
            @input="
              editing.runtime.targetFrames = Math.round(
                Number(($event.target as HTMLInputElement).value) * 24,
              )
            "
        /></label>
        <label
          >允许偏差帧数<input
            type="number"
            min="0"
            v-model.number="editing.runtime.toleranceFrames"
        /></label>
        <button @click="delete editing.runtime">恢复继承规划时长</button>
      </template>
      <button v-if="!editing.canvas" @click="editing.canvas = { ...basis.current.canvas }">
        覆盖本集画布
      </button>
      <template v-if="editing.canvas">
        <label
          >本集画布宽<input type="number" step="2" v-model.number="editing.canvas.width"
        /></label>
        <label
          >本集画布高<input type="number" step="2" v-model.number="editing.canvas.height"
        /></label>
        <label
          >不同生成画幅<select v-model="editing.canvas.mismatch">
            <option value="require_match">重新准备一致构图</option>
            <option value="letterbox">明确等比留边</option>
          </select></label
        >
        <button @click="delete editing.canvas">恢复继承画布</button>
      </template>
      <button
        v-if="!editing.factDependency"
        @click="editing.factDependency = { mode: 'previous', reason: '' }"
      >
        覆盖本集剧情依赖
      </button>
      <template v-if="editing.factDependency">
        <select v-model="editing.factDependency.mode">
          <option value="previous">读取直接前集事实</option>
          <option value="independent">独立单元</option>
        </select>
        <label>依赖决定的理由<input v-model="editing.factDependency.reason" /></label>
        <button @click="delete editing.factDependency">恢复继承系列关系</button>
      </template>
      <p v-if="error" class="error">{{ error }}</p>
      <button :disabled="busy" @click="save">保存本集要求</button
      ><button @click="editing = null">取消编辑</button>
    </div>
  </section>
</template>
