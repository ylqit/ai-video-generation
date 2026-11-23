<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkspaceSnapshot, WorkspaceIssue } from '../shared/workspace';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits<{ open: [issue: WorkspaceIssue] }>();
const gate = ref('prepare'),
  outside = ref(false);
const labels = { authoring: '创作', prepare: '准备与预览', adopt: '实际采用', deliver: '正式交付' };
const issues = computed(() =>
  (props.snapshot.context?.issues || []).filter(
    (i) => i.gate === gate.value && (outside.value || i.inScope),
  ),
);
const blocking = computed(
  () => issues.value.filter((i) => i.inScope && i.severity === 'blocking').length,
);
</script>
<template>
  <details class="panel production-guide" open>
    <summary><strong>当前制作待办</strong> · {{ blocking }} 项当前关口阻断</summary>
    <p v-if="snapshot.context?.selectionRequired" role="status">
      请明确选择{{
        snapshot.context.selectionRequired === 'series'
          ? '系列'
          : snapshot.context.selectionRequired === 'episode'
            ? '分集'
            : '创作版本'
      }}；尚未替你选择其他作品。
    </p>
    <p v-if="snapshot.context?.profile">
      固定配置 {{ snapshot.context.profile.id }} · v{{ snapshot.context.profile.revision }}
    </p>
    <div class="toolbar">
      <label
        >检查阶段<select v-model="gate">
          <option v-for="(label, key) in labels" :key="key" :value="key">{{ label }}</option>
        </select></label
      >
      <label><input type="checkbox" v-model="outside" />显示范围外待办</label>
    </div>
    <p v-if="!issues.length">当前没有记录到该阶段待办；提交前仍需生成预览核对实际输入。</p>
    <ul>
      <li v-for="(issue, index) in issues" :key="`${issue.code}:${index}`">
        <strong>{{
          !issue.inScope
            ? '范围外'
            : issue.severity === 'blocking'
              ? '需处理'
              : issue.severity === 'review'
                ? '待核对'
                : '提示'
        }}</strong>
        {{ issue.message }} <small v-if="issue.field">{{ issue.field }}</small>
        <button @click="emit('open', issue)">定位处理</button>
      </li>
    </ul>
  </details>
</template>
<style scoped>
.production-guide {
  margin: 8px 16px;
  max-height: 280px;
  overflow: auto;
}
li {
  margin: 10px 0;
}
small {
  overflow-wrap: anywhere;
  color: #667;
}
</style>
