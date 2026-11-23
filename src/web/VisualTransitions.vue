<script setup lang="ts">
import { computed } from 'vue';
import type { EditDecisionList } from '../shared/contracts';
import { edlSchema, timelineMap } from '../shared/edit-timeline';
import { editTimeline } from '../shared/timeline-editing';
import { ref } from 'vue';
const error = ref('');
const edl = defineModel<EditDecisionList>({ required: true });
const map = computed(() => timelineMap(edl.value));
const issues = computed(() => {
  const r = edlSchema.safeParse(edl.value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}：${i.message}`);
});
function upgrade() {
  edl.value = {
    ...edl.value,
    schemaVersion: 3,
    clips: edl.value.clips.map((c) => ({ ...c, id: c.id || crypto.randomUUID() })),
  };
}
function transition(i: number, frames: number) {
  try {
    edl.value = editTimeline(edl.value, { action: 'transition', index: i, frames }, []).edl;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <details class="panel">
    <summary>画面转场 · {{ map.frames }} 帧 / {{ (map.frames / 24).toFixed(3) }} 秒</summary>
    <p v-if="error" class="inline-error">{{ error }}</p>
    <p>
      叠化会扣除重叠帧数。画面淡入淡出保留原区间；对白、外部音轨和字幕保持当前时间坐标，请按改变后的接点校对。声音先入或延续可在独立音轨设置开始位置和裁剪。
    </p>
    <button v-if="edl.schemaVersion !== 3" @click="upgrade">
      创建 EDL v3 转场草稿（保留旧保存版本）
    </button>
    <template v-else>
      <div v-for="(entry, i) in map.clips" :key="entry.clip.id" class="transition-row">
        <strong>片段 {{ i + 1 }} · {{ entry.startFrame }}–{{ entry.endFrame }}</strong>
        <label v-if="i"
          >进入方式<select
            :value="entry.clip.transition ? 'dissolve' : 'cut'"
            @change="transition(i, ($event.target as HTMLSelectElement).value === 'cut' ? 0 : 12)"
          >
            <option value="cut">硬切</option>
            <option value="dissolve">叠化</option>
          </select></label
        >
        <label v-if="entry.clip.transition"
          >重叠帧<input
            type="number"
            min="1"
            step="1"
            :value="entry.clip.transition.frames"
            @input="transition(i, ($event.target as HTMLInputElement).valueAsNumber)"
        /></label>
        <label
          >画面淡入帧<input
            type="number"
            min="0"
            step="1"
            v-model.number="entry.clip.visualFadeInFrames"
        /></label>
        <label
          >画面淡出帧<input
            type="number"
            min="0"
            step="1"
            v-model.number="entry.clip.visualFadeOutFrames"
        /></label>
        <button
          v-if="entry.clip.transition && entry.clip.transition.fromClipId !== edl.clips[i - 1]?.id"
          @click="transition(i, 0)"
        >
          移除已失配的转场
        </button>
      </div>
      <p class="error" v-for="issue in issues" :key="issue">{{ issue }}</p>
    </template>
  </details>
</template>
<style scoped>
.transition-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
  padding: 12px 0;
  border-bottom: 1px solid #ddd;
}
label {
  display: grid;
  gap: 4px;
}
input {
  width: 95px;
}
</style>
