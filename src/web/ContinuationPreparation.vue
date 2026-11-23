<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { incomingV2Schema } from '../shared/shot-semantics';
import { api } from './api';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['refresh']);
const groupId = ref(''),
  draft = ref<any>(null),
  choices = ref<any[]>([]),
  selected = ref<any>(null),
  kind = ref('segment_selection'),
  offset = ref(0),
  total = ref(0),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  result = ref<any>(null);
const scope = computed(() => props.snapshot.scope);
const groups = computed(() =>
  (props.snapshot.results.director?.data.result.groups || []).filter((g: any) =>
    scope.value?.data.groupIds.includes(g.id),
  ),
);
let ticket = 0;
watch([groupId, () => scope.value?.revision], () => {
  const saved = scope.value?.data.continuations?.[groupId.value];
  draft.value = saved
    ? JSON.parse(JSON.stringify(saved))
    : {
        version: 2,
        mode: 'continue',
        cut: 'angle',
        reason: '',
        sources: [],
        awaiting: [],
        decisions: [],
        relationDecisions: [],
        actionDecisions: [],
      };
});
watch(groupId, () => {
  result.value = selected.value = null;
  error.value = notice.value = '';
});
async function loadSources() {
  const current = ++ticket;
  try {
    const page = await api(
      `/projects/${props.snapshot.project.id}/records?kind=${kind.value}&limit=30&offset=${offset.value}`,
    );
    if (current !== ticket) return;
    choices.value = page.items;
    total.value = page.total;
  } catch (e: any) {
    if (current === ticket) error.value = e.message;
  }
}
watch([kind, offset, () => props.snapshot.project.id], loadSources, { immediate: true });
function chooseSource(record: any) {
  selected.value = record;
  if (!draft.value.sources.some((s: any) => (s.selection || s.canon).id === record.id))
    draft.value.sources.push({
      id: `source-${record.id}`,
      [record.kind === 'continuity' ? 'canon' : 'selection']: {
        id: record.id,
        revision: record.revision,
      },
      boundary: 'end',
    });
}
const selectedSource = computed(
  () =>
    selected.value &&
    draft.value?.sources.find((s: any) => (s.selection || s.canon).id === selected.value.id),
);
const observed = computed(() =>
  !selectedSource.value
    ? null
    : selected.value?.kind === 'continuity'
      ? {
          facts: selected.value.data.attributes || [],
          actions: selected.value.data.unfinishedActions || [],
          relationObjectIds: selected.value.data.relations?.map((r: any) => r.objectId) || [],
        }
      : selected.value?.data.boundary?.[selectedSource.value.boundary || 'end'],
);
const planned = computed(() => {
  const group = groups.value.find((g: any) => g.id === groupId.value);
  const first = props.snapshot.results.director?.data.result.shots.find(
    (s: any) => s.id === group?.shotIds[0],
  );
  const entities = props.snapshot.run?.data.mappings || {};
  return (first?.entryState || []).map((f: any) => ({
    instanceId: entities[f.subjectKey]?.instanceId,
    subjectKey: f.subjectKey,
    key: f.key,
    value: f.value,
  }));
});
function inheritFact(fact: any) {
  if (
    !selectedSource.value ||
    draft.value.decisions.some((d: any) => d.instanceId === fact.instanceId && d.key === fact.key)
  )
    return;
  draft.value.decisions.push({
    instanceId: fact.instanceId,
    key: fact.key,
    decision: 'inherit',
    sourceId: selectedSource.value.id,
    reason: '',
  });
}
async function save() {
  if (busy.value) return;
  const target = groupId.value,
    contents = JSON.stringify(draft.value);
  busy.value = true;
  try {
    error.value = '';
    const current = scope.value!;
    const incoming = incomingV2Schema.parse(draft.value);
    const response = await api(`/creation-scopes/${current.id}`, 'PUT', {
      revision: current.revision,
      runRevision: props.snapshot.run!.revision,
      name: current.data.name,
      mode: current.data.mode,
      shotIds: current.data.shotIds,
      groupIds: current.data.groupIds,
      output: current.data.output,
      executionText: current.data.executionText,
      continuations: { ...current.data.continuations, [target]: incoming },
    });
    emit('refresh');
    if (target !== groupId.value || contents !== JSON.stringify(draft.value)) return;
    notice.value = '固定接续选择已保存，尚未创建生成任务。';
    const preview = await api(`/creation-scopes/${response.scope.id}/preview`, 'POST', {
      revision: response.scope.revision,
      runRevision: response.run.revision,
    });
    if (target === groupId.value) result.value = preview;
    emit('refresh');
  } catch (e: any) {
    if (target === groupId.value) error.value = e.message;
    emit('refresh');
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details v-if="scope && snapshot.context?.series" class="panel">
    <summary>按实际采用准备后段</summary>
    <p>
      选择固定来源及真正消费的属性、关系和动作；计划结果不作为实际来源。保存后由原预览逐项核对。
    </p>
    <fieldset :disabled="busy" class="continuation-controls">
      <label
        >当前生成组<select v-model="groupId">
          <option value="">请选择</option>
          <option v-for="g in groups" :key="g.id" :value="g.id">
            {{ g.id }} · {{ g.transition }}
          </option>
        </select></label
      >
      <template v-if="groupId && draft">
        <div class="form-grid">
          <label
            >接续模式<select v-model="draft.mode">
              <option value="continue">接续实际结果</option>
              <option value="historical">历史片段</option>
              <option value="independent">独立展示</option>
            </select></label
          ><label
            >剪辑关系<select v-model="draft.cut">
              <option
                v-for="[id, label] in [
                  ['action', '同一动作'],
                  ['angle', '同场换机位'],
                  ['ellipsis', '时间省略'],
                  ['location_change', '地点切换'],
                  ['flashback', '闪回'],
                  ['independent', '独立展示'],
                ]"
                :key="id"
                :value="id"
              >
                {{ label }}
              </option>
            </select></label
          ><label>决定与变化理由<textarea v-model="draft.reason" /></label>
        </div>
        <label
          >来源类别<select v-model="kind" @change="offset = 0">
            <option value="segment_selection">实际采用</option>
            <option value="continuity">确认事实</option>
          </select></label
        >
        <div class="toolbar">
          <button v-for="c in choices" :key="c.id" @click="chooseSource(c)">
            {{ c.data.segmentId || c.data.episodeNumber || c.id }} · v{{ c.revision }}
            {{ c.data.stale ? '待复核' : '' }}
          </button>
        </div>
        <button :disabled="offset === 0" @click="offset -= 30">上一页来源</button
        ><span>共 {{ total }} 项</span
        ><button :disabled="offset + 30 >= total" @click="offset += 30">下一页来源</button>
        <p v-for="(s, i) in draft.sources" :key="s.id">
          {{ s.id }} · {{ s.selection || s.canon
          }}<select v-model="s.boundary">
            <option value="end">结束边界</option>
            <option value="start">开始边界</option></select
          ><button @click="draft.sources.splice(i, 1)">移除来源</button>
        </p>
        <div v-if="observed">
          <strong>当前来源实际观察</strong>
          <p v-for="f in observed.facts" :key="`${f.instanceId}:${f.key}`">
            {{ f.instanceId }}.{{ f.key }}：{{
              f.status === 'known' ? JSON.stringify(f.value) : '未知'
            }}
            <button @click="inheritFact(f)">使用此属性</button>
          </p>
          <button
            v-for="id in [...new Set(observed.relationObjectIds || [])]"
            :key="String(id)"
            @click="
              draft.relationDecisions.push({
                objectId: id,
                decision: 'inherit',
                sourceId: selectedSource.id,
                reason: '',
              })
            "
          >
            继承关系 {{ id }}</button
          ><button
            v-for="a in observed.actions || []"
            :key="a.id"
            @click="
              draft.actionDecisions.push({
                instanceId: a.instanceId,
                actionId: a.id,
                decision: 'inherit',
                sourceId: selectedSource.id,
                reason: '',
              })
            "
          >
            接续 {{ a.id }} · {{ a.phase }} {{ a.unfinished ? '未完成' : '' }}
          </button>
        </div>
        <details>
          <summary>当前入口计划（不是实际观察）</summary>
          <p>下列入口属性可逐项添加决定；完整必查项仍由预览根据前提、长期属性和未完成动作派生。</p>
          <p v-for="f in planned" :key="`${f.instanceId}:${f.key}`">
            {{ f.instanceId || f.subjectKey }}.{{ f.key }} = {{ f.value }}
            <button
              :disabled="!f.instanceId"
              @click="
                draft.decisions.push({
                  instanceId: f.instanceId,
                  key: f.key,
                  decision: 'adjust',
                  value: f.value,
                  reason: '',
                })
              "
            >
              说明入口变化
            </button>
            <small v-if="!f.instanceId">先预览范围，以确定固定实例映射</small>
          </p>
        </details>
        <template
          v-for="[key, label] in [
            ['decisions', '属性'],
            ['relationDecisions', '关系'],
            ['actionDecisions', '动作'],
          ]"
          :key="key"
          ><h4>{{ label }}决定</h4>
          <div v-for="(d, i) in draft[key]" :key="i" class="form-grid">
            <span>{{ d.instanceId }} {{ d.key || d.objectId || d.actionId }}</span
            ><select v-model="d.sourceId">
              <option value="">选择来源</option>
              <option v-for="s in draft.sources" :key="s.id" :value="s.id">
                {{ s.id }}
              </option></select
            ><select v-model="d.decision">
              <option value="inherit">继承</option>
              <option value="adjust">调整</option>
              <option value="reset">重设</option>
              <option value="not_applicable">不适用</option></select
            ><label v-if="key === 'decisions' && ['adjust', 'reset'].includes(d.decision)"
              >目标值（JSON）<input
                :value="JSON.stringify(d.value ?? null)"
                @change="
                  (e) => {
                    try {
                      d.value = JSON.parse((e.target as HTMLInputElement).value);
                      error = '';
                    } catch {
                      error = '请输入有效的布尔、数值或字符串 JSON';
                    }
                  }
                " /></label
            ><label v-if="key === 'actionDecisions' && d.decision !== 'inherit'"
              >阶段<input v-model="d.phase" /></label
            ><label>理由<input v-model="d.reason" /></label
            ><button @click="draft[key].splice(i, 1)">移除</button>
          </div></template
        >
        <button @click="save">{{ busy ? '正在核对固定来源' : '固定来源并检查接续' }}</button>
      </template>
      <p class="error" v-if="error">{{ error }}</p>
      <p>{{ notice }}</p>
      <p v-for="(i, n) in result?.issues || []" :key="n">{{ i.message }}</p>
      <p v-if="result?.preview?.digest">接续预览已就绪；实际动作仍需生成后审核。</p>
    </fieldset>
  </details>
</template>
<style scoped>
.continuation-controls {
  border: 0;
  padding: 0;
  min-width: 0;
}
</style>
