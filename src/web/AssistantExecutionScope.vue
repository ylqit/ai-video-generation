<script setup lang="ts">
const props = defineProps<{ value: any; models: any[]; selectedIds: string[] }>();
const emit = defineEmits(['change']);
const permissions: Record<string, string> = {
  write: '编辑内容',
  generate: '媒体生成',
  select: '选用候选',
  edit: '编辑时间线',
  export: '导出',
  extract: '抽帧',
  derive: '本地媒体加工',
  analyze: '视觉分析/转写',
};
const budgets: Record<string, string> = {
  maxSteps: '决策步数',
  imageRequests: '图片请求',
  images: '图片张数',
  videoRequests: '视频请求',
  videoSeconds: '视频秒数',
  speechRequests: '配音请求',
  speechCharacters: '配音字符',
  lipSyncRequests: '口型请求',
  lipSyncSeconds: '口型秒数',
  analysisRequests: '分析请求',
  analysisImages: '实际读图总张次',
  transcriptionRequests: '转写请求',
  transcriptionSeconds: '转写秒数',
};
function update(field: string, value: any) {
  emit('change', { ...props.value, [field]: value });
}
function toggle(field: string, key: string) {
  const values = props.value[field] || [];
  update(field, values.includes(key) ? values.filter((v: string) => v !== key) : [...values, key]);
}
</script>
<template>
  <details class="execution-scope">
    <summary>
      执行范围与用量 ·
      {{
        value.writeScope === 'new'
          ? '只新增内容'
          : value.writeScope === 'selected'
            ? '勾选节点'
            : '当前画布'
      }}
    </summary>
    <label
      >允许修改<select
        aria-label="允许修改"
        :value="value.writeScope"
        @change="update('writeScope', ($event.target as HTMLSelectElement).value)"
      >
        <option value="new">只新增内容，不修改现有节点</option>
        <option value="selected">当前勾选的 {{ selectedIds.length }} 个节点及新建内容</option>
        <option value="canvas">当前画布内全部内容</option>
      </select></label
    >
    <div class="scope-checks">
      <label v-for="(label, id) in permissions" :key="id"
        ><input
          type="checkbox"
          :checked="value.permissions.includes(id)"
          @change="toggle('permissions', id)"
        />{{ label }}</label
      >
    </div>
    <p class="field-hint">可用模型（本轮固定版本，生成和分析也计入下方次数）</p>
    <label v-for="m in models" :key="m.key" class="check-label"
      ><input
        type="checkbox"
        :checked="value.modelKeys.includes(m.key)"
        @change="toggle('modelKeys', m.key)"
      />{{ m.label }} · {{ m.kind }}</label
    >
    <div class="scope-budgets">
      <label v-for="(label, id) in budgets" :key="id"
        >{{ label
        }}<input
          type="number"
          :min="id === 'maxSteps' ? 1 : 0"
          :max="id === 'maxSteps' ? 100 : undefined"
          :value="value.budget[id] || 0"
          @input="
            update('budget', {
              ...value.budget,
              [id]: Number(($event.target as HTMLInputElement).value),
            })
          "
      /></label>
    </div>
  </details>
</template>
