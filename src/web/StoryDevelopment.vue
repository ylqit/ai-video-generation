<script setup lang="ts">
import type { WorkspaceSnapshot } from '../shared/workspace';
import ProductionRequirements from './ProductionRequirements.vue';
import SubjectMapping from './SubjectMapping.vue';
import SourceAdaptation from './SourceAdaptation.vue';
defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['edit', 'preview', 'discuss', 'refresh']);
</script>
<template>
  <section class="panel story-development">
    <h2>剧本与画面表达</h2>
    <ProductionRequirements :snapshot="snapshot" @refresh="emit('refresh')" />
    <SourceAdaptation
      :project-id="snapshot.project.id"
      @reference="(r) => emit('discuss', { record: r, title: '固定来源索引' })"
    />
    <SubjectMapping
      v-if="snapshot.run && snapshot.productionRequirements?.current.series"
      :run-id="snapshot.run.id"
      :revision="snapshot.run.revision"
      @refresh="emit('refresh')"
    />
    <p>
      需求创作可以补足未锁定内容；忠实改编保留关键因果；局部修订先选择具体场景。保存前可比较改动与受影响镜头。
    </p>
    <div class="actions">
      <button
        v-if="snapshot.results.brief"
        @click="emit('edit', { record: snapshot.results.brief })"
      >
        从需求创作 · 调整简报
      </button>
      <button
        v-if="snapshot.results.script"
        @click="emit('edit', { record: snapshot.results.script })"
      >
        忠实改编 · 编辑剧本
      </button>
      <button
        v-if="snapshot.results.script"
        @click="emit('discuss', { record: snapshot.results.script, title: '剧本影视表达适配' })"
      >
        交给助手讨论／修订
      </button>
    </div>
    <p v-if="!snapshot.storyCoverage?.length">剧本采用后显示来源、事件和镜头之间的对应关系。</p>
    <div class="coverage-list">
      <article v-for="e in snapshot.storyCoverage" :key="e.sceneId + e.eventId">
        <header>
          <strong>{{ e.sceneTitle }}</strong
          ><span>{{
            e.status === 'observed'
              ? '采用区间有事件证据'
              : e.status === 'planned'
                ? '已安排 · 实际呈现待确认'
                : '尚未安排镜头'
          }}</span>
        </header>
        <p>{{ e.description }}</p>
        <small v-for="s in e.sources" :key="s.id">来源事实 {{ s.id }}：{{ s.statement }}</small>
        <div class="actions">
          <button
            v-for="s in e.shots"
            :key="s.id"
            @click="emit('edit', { record: snapshot.results.director, shotId: s.id })"
          >
            {{ s.id }} · {{ s.phase }} · {{ s.purpose }}
          </button>
          <button @click="emit('edit', { record: snapshot.results.script, sceneId: e.sceneId })">
            局部修订本场
          </button>
        </div>
        <details v-if="e.evidence.length">
          <summary>采用与实际观察依据</summary>
          <p v-for="v in e.evidence" :key="v.review.id + v.shotId">
            {{ v.shotId }} · 源帧 [{{ v.startFrame }}, {{ v.endFrame }}) · {{ v.inspection
            }}<button @click="emit('preview', { asset: v.video })">打开媒体</button>
          </p>
        </details>
      </article>
    </div>
    <small>事件证据不等于整场或整集已经通过。未采用候选、Prompt 和计划不能证明实际发生。</small>
  </section>
</template>
<style scoped>
.coverage-list {
  max-height: 440px;
  overflow: auto;
}
article {
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}
header,
.actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
header {
  justify-content: space-between;
}
small {
  display: block;
  color: var(--muted);
}
</style>
