<script setup lang="ts">
import ContractField from './ContractField.vue';
const model = defineModel<any>({ required: true });
</script>
<template>
  <div class="adaptation-intent">
    <label
      >内容处理方式<select v-model="model.mode">
        <option value="original">从需求原创</option>
        <option value="faithful_adaptation">忠实改编固定来源</option>
        <option value="local_revision">局部修订已采用剧本</option>
      </select></label
    >
    <label
      >创作方法<select
        :value="model.method || 'general'"
        @change="model.method = ($event.target as HTMLSelectElement).value"
      >
        <option value="general">通用影像表达</option>
        <option value="short_drama">短剧：目标、冲突、可见变化与分集承接</option>
      </select></label
    >
    <p v-if="model.method === 'short_drama'">
      关注开场吸引力与结尾承接，反转仅在故事需要时使用；没有固定开场秒数或每集反转要求。
    </p>
    <details>
      <summary>保留范围与改编取舍</summary>
      <ContractField label="必须保留的事实、关系、事件与结局" v-model="model.preserve" />
      <ContractField label="允许改变的表达、组织与对白" v-model="model.allow" />
      <ContractField label="待确认的改动" v-model="model.pending" />
      <ContractField
        label="来源事件的改编决策（原文／方案／理由／是否批准）"
        v-model="model.decisions"
      />
      <p>呈现调整不应改变剧情事实。未批准的剧情变更只作为提案，不进入已确认故事。</p>
    </details>
  </div>
</template>
