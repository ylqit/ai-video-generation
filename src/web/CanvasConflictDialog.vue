<script setup lang="ts">
import { downloadJson } from './api';
defineProps<{ comparison: any; draft: any }>();
const emit = defineEmits(['close', 'resolve']);
</script>
<template>
  <div class="modal-backdrop">
    <section class="dialog">
      <header>
        <h2>比较服务器版本</h2>
        <button @click="emit('close')">关闭</button>
      </header>
      <p>
        以下是本机尚未保存的修改。服务器当前为 v{{
          comparison.latest.canvas.revision
        }}；未修改的字段保持服务器内容。
      </p>
      <article v-for="(r, i) in comparison.rows" :key="i">
        <strong>{{ r.target }} · {{ r.id || '画布' }} · {{ r.action }}</strong>
        <div class="comparison-columns">
          <div>
            本机
            <pre>{{ JSON.stringify(r.local, null, 2) }}</pre>
          </div>
          <div>
            服务器
            <pre>{{ JSON.stringify(r.server, null, 2) }}</pre>
          </div>
        </div>
      </article>
      <p v-if="!comparison.rows.length">没有未保存的内容差异。</p>
      <footer>
        <button @click="downloadJson('canvas-local-draft.json', draft)">下载本机草稿</button
        ><button @click="emit('resolve', false)">采用服务器内容</button
        ><button class="primary" @click="emit('resolve', true)">保留上述本机修改</button>
      </footer>
      <p>选择后仍需保存。若服务器再次变化，保存时会重新检查。</p>
    </section>
  </div>
</template>
<style scoped>
.comparison-columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.comparison-columns > div {
  min-width: 0;
}
pre {
  max-height: 200px;
  overflow: auto;
  white-space: pre-wrap;
}
article {
  margin: 16px 0;
}
@media (max-width: 650px) {
  .comparison-columns {
    grid-template-columns: 1fr;
  }
}
</style>
