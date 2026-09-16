<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api } from './api';
const props = defineProps<{
  rows: any[];
  instances: any[];
  documents: any[];
  conditions?: boolean;
  observations?: boolean;
  single?: boolean;
}>();
const emit = defineEmits(['change']);
const loaded = ref<any[]>([]),
  error = ref('');
watch(
  () => props.instances.map((i) => `${i.entity.id}:${i.entity.revision}`).join(','),
  async (_value, _old, onCleanup) => {
    let active = true;
    onCleanup(() => {
      active = false;
    });
    error.value = '';
    loaded.value = [];
    try {
      const records = await Promise.all(
        props.instances.map(
          (i) =>
            props.documents.find((d) => d.id === i.entity.id && d.revision === i.entity.revision) ||
            api(`/records/${i.entity.id}/versions/${i.entity.revision}`),
        ),
      );
      if (active) loaded.value = records;
    } catch (e: any) {
      if (active) error.value = e.message;
    }
  },
  { immediate: true },
);
const definitions = computed(() =>
  props.instances.flatMap((i) =>
    (
      loaded.value.find((d) => d.id === i.entity.id && d.revision === i.entity.revision)?.data
        .attributes || []
    ).map((a: any) => ({ ...a, instanceId: i.instanceId })),
  ),
);
function definition(row: any) {
  return definitions.value.find((d: any) => d.instanceId === row.instanceId && d.key === row.key);
}
function reset(row: any) {
  const d = definition(row);
  row.value = props.conditions
    ? d?.type === 'boolean'
      ? false
      : d?.type === 'number'
        ? 0
        : d?.values?.[0] || ''
    : null;
  if (!props.conditions) row.status = 'unknown';
  emit('change');
}
function known(row: any) {
  if (row.status === 'unknown') row.value = null;
  else {
    const d = definition(row);
    row.value = d?.type === 'boolean' ? false : d?.type === 'number' ? 0 : d?.values?.[0] || '';
  }
  emit('change');
}
function add() {
  const d = definitions.value[0];
  const row: any = {
    instanceId: d?.instanceId || '',
    key: d?.key || '',
    value: null,
    ...(props.conditions ? { operator: 'eq' } : { status: 'unknown' }),
    ...(props.observations
      ? { id: crypto.randomUUID(), startFrame: 0, endFrame: 1, inspection: 'frame', notes: '' }
      : {}),
  };
  reset(row);
  props.rows.push(row);
  emit('change');
}
</script>
<template>
  <div @input="emit('change')" @change="emit('change')">
    <p class="error" v-if="error">属性定义读取失败：{{ error }}</p>
    <p v-if="!definitions.length" class="muted">
      先在主体中定义要跟踪的属性；没有相关状态的镜头可留空。
    </p>
    <div class="panel" v-for="(row, n) in rows" :key="row.id || n">
      <div class="form-grid">
        <label
          >实例<select
            v-model="row.instanceId"
            @change="
              row.key = '';
              reset(row);
            "
          >
            <option v-for="i in instances" :value="i.instanceId">{{ i.instanceId }}</option>
          </select></label
        >
        <label
          >属性<select v-model="row.key" @change="reset(row)">
            <option value="">选择属性</option>
            <option
              v-for="d in definitions.filter((d: any) => d.instanceId === row.instanceId)"
              :value="d.key"
            >
              {{ d.label }} · {{ d.type }}
            </option>
          </select></label
        >
        <label v-if="conditions"
          >比较<select v-model="row.operator">
            <option value="eq">等于</option>
            <option value="ne">不等于</option>
            <option v-if="definition(row)?.type === 'number'" value="gte">大于等于</option>
            <option v-if="definition(row)?.type === 'number'" value="lte">小于等于</option>
          </select></label
        >
        <label v-else
          >确认状态<select v-model="row.status" @change="known(row)">
            <option value="unknown">未知</option>
            <option value="known">明确值</option>
          </select></label
        >
        <label v-if="conditions || row.status === 'known'"
          >值
          <select v-if="definition(row)?.type === 'boolean'" v-model="row.value">
            <option :value="false">false</option>
            <option :value="true">true</option>
          </select>
          <input
            v-else-if="definition(row)?.type === 'number'"
            type="number"
            v-model.number="row.value"
          />
          <select v-else v-model="row.value">
            <option v-for="v in definition(row)?.values || []" :value="v">{{ v }}</option>
          </select>
        </label>
        <template v-if="observations"
          ><label>观察起帧<input type="number" min="0" v-model.number="row.startFrame" /></label
          ><label
            >观察出帧（不含）<input type="number" min="1" v-model.number="row.endFrame" /></label
          ><label
            >实际审核方式<select v-model="row.inspection">
              <option value="frame">单帧观察</option>
              <option value="motion">区间运动审核</option>
              <option value="audio">实际听审</option>
            </select></label
          ><label>观察依据<textarea v-model="row.notes" /></label
        ></template>
      </div>
      <button
        v-if="!single"
        @click="
          rows.splice(n, 1);
          emit('change');
        "
      >
        移除属性
      </button>
    </div>
    <button v-if="!single" :disabled="!definitions.length" @click="add">
      增加{{ observations ? '实际观察' : conditions ? '条件' : '状态属性' }}
    </button>
  </div>
</template>
