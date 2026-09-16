<script setup lang="ts">
import { computed } from 'vue';
import type { RecordDoc } from '../shared/contracts';
const model = defineModel<any[]>({ required: true });
const props = defineProps<{ documents: RecordDoc[]; regions?: { id: string; name: string }[] }>();
const instances = computed(() =>
  props.documents
    .filter((d) => d.kind === 'entity')
    .flatMap((e) =>
      e.data.instances.map((i: any) => ({
        ...i,
        anchors: e.data.anchors,
        label: `${e.data.name} · ${i.name}`,
      })),
    ),
);
</script>
<template>
  <div class="relation-editor">
    <p>持物与附着位置使用主体自身方向。</p>
    <div class="panel" v-for="(r, n) in model" :key="n">
      <label
        >物体实例<select v-model="r.objectId">
          <option value="">请选择</option>
          <option v-for="i in instances" :value="i.id">{{ i.label }}</option>
        </select></label
      >
      <label
        >关系<select v-model="r.type">
          <option value="heldBy">持有</option>
          <option value="attachedTo">附着</option>
          <option value="containedIn">装在容器内</option>
          <option value="locatedIn">位于区域</option>
        </select></label
      >
      <label
        >目标<select v-model="r.targetId">
          <option value="">请选择</option>
          <template v-if="r.type === 'locatedIn'"
            ><option v-for="a in regions" :value="a.id">{{ a.name }}</option></template
          ><template v-else
            ><option v-for="i in instances" :value="i.id">{{ i.label }}</option></template
          >
        </select></label
      >
      <label
        >附着点<select v-model="r.anchor">
          <option value="">不指定</option>
          <option v-for="a in instances.find((i) => i.id === r.targetId)?.anchors || []" :value="a">
            {{ a }}
          </option>
        </select></label
      >
      <label>数量<input type="number" min="1" v-model.number="r.quantity" /></label
      ><label>最多数量<input type="number" min="1" v-model.number="r.maxQuantity" /></label>
      <label><input type="checkbox" v-model="r.confirmed" />关系已确认</label
      ><button @click="model.splice(n, 1)">移除关系</button>
    </div>
    <button
      @click="
        model.push({
          objectId: '',
          type: 'heldBy',
          targetId: '',
          anchor: '',
          quantity: 1,
          maxQuantity: 1,
          confirmed: false,
        })
      "
    >
      添加关系
    </button>
  </div>
</template>
