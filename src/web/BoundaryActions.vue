<script setup lang="ts">
defineProps<{ rows: any[] }>();
const crypto = globalThis.crypto;
</script>
<template>
  <div>
    <div class="panel" v-for="(a, i) in rows">
      <div class="form-grid">
        <label>稳定动作 ID<input v-model="a.id" /></label
        ><label>主体实例 ID<input v-model="a.instanceId" /></label
        ><label>动作阶段（系列定义取值）<input v-model="a.phase" /></label
        ><label>运动方向<input v-model="a.direction" /></label
        ><label>关注对象／视线<input v-model="a.attention" /></label
        ><label>下一步允许动作<input v-model="a.next" /></label
        ><label><input type="checkbox" v-model="a.unfinished" />边界处尚未完成</label>
      </div>
      <button @click="rows.splice(i, 1)">移除动作项</button>
    </div>
    <button
      @click="
        rows.push({
          id: crypto.randomUUID(),
          instanceId: '',
          phase: '',
          direction: '',
          attention: '',
          next: '',
          unfinished: false,
        })
      "
    >
      添加动作阶段
    </button>
  </div>
</template>
