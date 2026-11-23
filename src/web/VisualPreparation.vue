<script setup lang="ts">
import { computed, ref } from 'vue';
import ReferenceDerivation from './ReferenceDerivation.vue';
const derivation = ref<any>(null);
import { referenceCoverage } from '../shared/reference-coverage';
import { referenceStartGroup, type WorkspaceSnapshot } from '../shared/workspace';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['handoff', 'bind', 'shot']);
const showOutside = ref(false),
  query = ref(''),
  page = ref(0);
const rows = computed(() =>
  props.snapshot.requirements.filter(
    (r) =>
      r.mediaType === 'image' &&
      (showOutside.value || r.inScope) &&
      `${r.subjectKey} ${r.description} ${r.shotIds?.join(' ')}`
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const coverage = computed(() => {
  const director = props.snapshot.results.director?.data.result;
  if (!director) return [];
  return referenceCoverage(
    director,
    props.snapshot.requirements,
    props.snapshot.run?.data.bindings,
  ).filter((c) => !props.snapshot.scope || props.snapshot.scope.data.shotIds.includes(c.shotId));
});
const purposes: Record<string, string> = {
  identity: '身份',
  appearance: '外观',
  environment: '环境',
  composition: '构图',
  action_start: '动作起点',
  action_end: '动作终点',
  motion: '运动',
  style: '画风',
};
</script>
<template>
  <details class="panel" open>
    <summary><strong>视觉参考覆盖</strong> · {{ rows.length }} 项</summary>
    <p>
      身份参考不默认复制持物、背景或动作；首帧 Guide
      与文本参考槽分别连接。图中未来事件和隐含状态仍需实际审图。
    </p>
    <p v-if="snapshot.results.direction">
      当前固定视觉方向：{{ snapshot.results.direction.data.result.visual }}
    </p>
    <div class="toolbar">
      <label>查找主体、描述或镜头<input v-model="query" @input="page = 0" /></label
      ><label><input type="checkbox" v-model="showOutside" @change="page = 0" />显示范围外</label>
    </div>
    <table>
      <thead>
        <tr>
          <th>需求与对象</th>
          <th>用途与范围</th>
          <th>固定依据与状态</th>
          <th>处理</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows.slice(page * 20, (page + 1) * 20)" :key="r.id">
          <td>
            {{ r.description }}<small>{{ r.subjectKey }}</small>
          </td>
          <td>
            {{ purposes[r.purpose] || r.purpose }} · {{ r.inScope ? '当前范围' : '范围外' }}
            <p v-for="id in r.shotIds" :key="id">
              <button @click="emit('shot', id)">{{ id }}</button>
            </p>
            <p>保持：{{ r.preserve?.join('；') || '未声明' }}</p>
            <p>允许：{{ r.allow?.join('；') || '未声明' }}</p>
          </td>
          <td>
            <template v-if="r.binding"
              >{{ r.binding.asset.id }} v{{ r.binding.asset.revision }}
              <p>
                {{
                  r.binding.groupStart
                    ? `首帧：${r.binding.groupStart.groupId}`
                    : '普通参考，未指定首帧'
                }}
              </p></template
            ><span v-else>未绑定</span>
            <p
              v-for="i in snapshot.context?.issues.filter((i) => i.requirementId === r.id)"
              :key="i.code"
              class="warning"
            >
              {{ i.message }}
            </p>
            <small
              v-if="referenceStartGroup(r, snapshot.results.director?.data.result.groups || [])"
              >可显式审看为组首帧</small
            >
          </td>
          <td>
            <button @click="emit('handoff', r)">生成／编辑图片任务</button
            ><button @click="emit('bind', r)">复用／上传与审看</button
            ><button @click="derivation = r">选帧／裁剪</button>
          </td>
        </tr>
      </tbody>
    </table>
    <button :disabled="page === 0" @click="page--">上一页</button
    ><span>第 {{ page + 1 }} / {{ Math.max(1, Math.ceil(rows.length / 20)) }} 页</span
    ><button :disabled="(page + 1) * 20 >= rows.length" @click="page++">下一页</button>
    <ReferenceDerivation
      v-if="derivation"
      :key="derivation.id"
      :project-id="snapshot.project.id"
      :requirement="derivation"
      @close="derivation = null"
      @ready="
        emit('bind', { ...derivation, candidateAsset: $event });
        derivation = null;
      "
    />
    <details v-if="coverage.length">
      <summary>当前交互覆盖 · {{ coverage.length }}</summary>
      <p v-for="c in coverage" :key="`${c.shotId}:${c.interactionId}`">
        {{ c.shotId }} / {{ c.interactionId }}：{{
          c.status === 'inspected_reference'
            ? '参考已审，动作仍待生成后审核'
            : c.status === 'missing_reference'
              ? '缺少明确交互参考需求'
              : '等待实际审图'
        }}
      </p>
    </details>
  </details>
</template>
<style scoped>
small {
  display: block;
  color: #667;
  overflow-wrap: anywhere;
}
td {
  vertical-align: top;
}
table {
  width: 100%;
}
</style>
