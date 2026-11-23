<script setup lang="ts">
import { computed, ref } from 'vue';
const browserCrypto = globalThis.crypto;
const props = defineProps<{ plan: any; progress: any }>();
const query = ref(''),
  kind = ref('all'),
  page = ref(0);
const labels: Record<string, string> = {
  world_fact: '世界事实',
  character_knowledge: '角色认知',
  character_belief: '角色误解／相信',
  audience_knowledge: '观众认知',
};
const purposes: Record<string, string> = {
  plant: '铺垫',
  mislead: '误导',
  reveal: '揭示',
  payoff: '回收',
};
const rows = computed(() =>
  props.plan.information.filter(
    (i: any) =>
      (kind.value === 'all' || i.kind === kind.value) &&
      `${i.id} ${i.statement} ${i.instanceIds.join(' ')}`.includes(query.value),
  ),
);
function addInformation() {
  props.plan.information.push({
    id: `info-${browserCrypto.randomUUID()}`,
    kind: 'world_fact',
    statement: '',
    instanceIds: [],
    afterIds: [],
    conflictsWith: [],
    milestones: [],
  });
  kind.value = 'all';
  query.value = '';
  page.value = Math.floor((props.plan.information.length - 1) / 10);
}
function removeInformation(item: any) {
  if (
    props.plan.information.some(
      (i: any) => i.afterIds.includes(item.id) || i.conflictsWith.includes(item.id),
    ) ||
    props.progress?.information.find((i: any) => i.id === item.id)?.actual.length
  )
    return;
  props.plan.information.splice(props.plan.information.indexOf(item), 1);
}
</script>
<template>
  <details class="panel" open>
    <summary><strong>整季信息与人物变化</strong></summary>
    <p>
      先安排剧情节点，再由实际采用证据确认呈现。角色相信的内容与世界事实分别维护，后集计划不会自动成为前集发生的事实。
    </p>
    <div class="toolbar">
      <label>查找信息<input v-model="query" @input="page = 0" /></label
      ><label
        >类别<select v-model="kind" @change="page = 0">
          <option value="all">全部</option>
          <option v-for="(label, id) in labels" :key="id" :value="id">{{ label }}</option>
        </select></label
      ><button @click="addInformation">添加信息条目</button>
    </div>
    <article class="panel" v-for="item in rows.slice(page * 10, page * 10 + 10)" :key="item.id">
      <small>稳定条目 {{ item.id }}</small>
      <label
        >信息类别<select v-model="item.kind">
          <option v-for="(label, id) in labels" :key="id" :value="id">{{ label }}</option>
        </select></label
      >
      <label>陈述<textarea v-model="item.statement" /></label>
      <label
        >关联实例 ID（逗号分隔）<input
          :value="item.instanceIds.join(', ')"
          @change="
            item.instanceIds = ($event.target as HTMLInputElement).value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean)
          "
      /></label>
      <div class="form-grid">
        <label
          >必须在这些信息之后<select multiple v-model="item.afterIds">
            <option
              v-for="i in plan.information.filter((i: any) => i.id !== item.id)"
              :key="i.id"
              :value="i.id"
            >
              {{ i.statement || i.id }}
            </option>
          </select></label
        ><label
          >相互矛盾的认知<select multiple v-model="item.conflictsWith">
            <option
              v-for="i in plan.information.filter((i: any) => i.id !== item.id)"
              :key="i.id"
              :value="i.id"
            >
              {{ i.statement || i.id }}
            </option>
          </select></label
        >
      </div>
      <div class="form-grid" v-for="(milestone, n) in item.milestones" :key="n">
        <label
          >规划分集<select v-model="milestone.slotId">
            <option v-for="s in plan.slots" :key="s.id" :value="s.id">
              {{ s.title }} {{ s.active ? '' : '（历史保留）' }}
            </option>
          </select></label
        ><label
          >叙事用途<select v-model="milestone.purpose">
            <option v-for="(label, id) in purposes" :key="id" :value="id">{{ label }}</option>
          </select></label
        ><label>如何呈现<input v-model="milestone.description" /></label
        ><button @click="item.milestones.splice(n, 1)">移除计划节点</button>
      </div>
      <button
        :disabled="!plan.slots.length"
        @click="
          item.milestones.push({ slotId: plan.slots[0].id, purpose: 'plant', description: '' })
        "
      >
        添加分集节点
      </button>
      <p>
        实际成片证据：{{
          progress?.information.find((i: any) => i.id === item.id)?.actual.length || 0
        }}
        项
      </p>
      <button
        :disabled="
          plan.information.some(
            (i: any) => i.afterIds.includes(item.id) || i.conflictsWith.includes(item.id),
          ) || !!progress?.information.find((i: any) => i.id === item.id)?.actual.length
        "
        @click="removeInformation(item)"
      >
        删除未被引用的计划条目
      </button>
    </article>
    <button :disabled="page === 0" @click="page--">上一页信息</button
    ><span>{{ rows.length }} 项 · 第 {{ page + 1 }} 页</span
    ><button :disabled="(page + 1) * 10 >= rows.length" @click="page++">下一页信息</button>
    <details>
      <summary>人物变化节点（{{ plan.characterBeats.length }}）</summary>
      <article v-for="(beat, n) in plan.characterBeats" :key="beat.id" class="panel">
        <small>{{ beat.id }}</small
        ><label>实例 ID<input v-model="beat.instanceId" /></label
        ><label
          >规划分集<select v-model="beat.slotId">
            <option v-for="s in plan.slots" :key="s.id" :value="s.id">{{ s.title }}</option>
          </select></label
        ><label>变化前提<textarea v-model="beat.prerequisite" /></label
        ><label>选择与变化<textarea v-model="beat.change" /></label
        ><label>后果<textarea v-model="beat.consequence" /></label
        ><button @click="plan.characterBeats.splice(n, 1)">移除变化节点</button>
      </article>
      <button
        :disabled="!plan.slots.length"
        @click="
          plan.characterBeats.push({
            id: browserCrypto.randomUUID(),
            instanceId: '',
            slotId: plan.slots[0].id,
            prerequisite: '',
            change: '',
            consequence: '',
          })
        "
      >
        添加人物变化
      </button>
    </details>
    <details>
      <summary>画外剧情条目（{{ plan.authoredEvents.length }}）</summary>
      <p>可见动作的结果仍需媒体证据；这些条目仅表达明确发生在画外的剧情事实。</p>
      <article v-for="(event, n) in plan.authoredEvents" :key="event.id" class="panel">
        <small>{{ event.id }}</small
        ><label
          >分集<select v-model="event.slotId">
            <option v-for="s in plan.slots" :key="s.id" :value="s.id">{{ s.title }}</option>
          </select></label
        ><label>陈述<textarea v-model="event.statement" @input="event.approved = false" /></label
        ><label
          ><input
            type="checkbox"
            v-model="event.offscreen"
            @change="event.approved = false"
          />明确发生在画外</label
        ><label><input type="checkbox" v-model="event.approved" />已审阅该剧情条目</label
        ><button :disabled="event.approved" @click="plan.authoredEvents.splice(n, 1)">
          移除未审条目
        </button>
      </article>
      <button
        :disabled="!plan.slots.length"
        @click="
          plan.authoredEvents.push({
            id: browserCrypto.randomUUID(),
            slotId: plan.slots[0].id,
            statement: '',
            offscreen: true,
            approved: false,
          })
        "
      >
        添加画外条目
      </button>
    </details>
  </details>
</template>
