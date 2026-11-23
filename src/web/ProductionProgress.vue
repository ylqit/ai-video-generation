<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { api } from './api';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['scope', 'job', 'prepare']);
const page = ref(0),
  metrics = ref<any>(null),
  error = ref('');
const groups = computed(() =>
  (props.snapshot.results.director?.data.result.groups || [])
    .filter((g: any) => props.snapshot.scope?.data.groupIds.includes(g.id))
    .map((g: any) => {
      const jobs = props.snapshot.jobs.filter((j) => j.kind === 'generation' && j.stage === g.id);
      const issues = (props.snapshot.run?.data.issues || []).filter(
        (i: any) => i.targetId === g.id || g.shotIds.includes(i.targetId),
      );
      const ready = props.snapshot.run?.data.productionPreview?.groups.some(
        (p: any) => p.id === g.id,
      );
      return {
        ...g,
        jobs,
        issues,
        state: ready
          ? '已进入当前预览'
          : issues.length
            ? '等待处理'
            : jobs.length
              ? jobs.at(-1)!.state === 'succeeded'
                ? '候选已归档，需实际审核'
                : '已有原任务'
              : '尚未预览',
      };
    }),
);
watch(
  () => props.snapshot.run?.id,
  () => {
    page.value = 0;
    metrics.value = null;
  },
);
watch(
  [
    () => props.snapshot.run?.revision,
    () => props.snapshot.timing.adoptedFrames,
    () => props.snapshot.jobs.map((j) => `${j.id}:${j.state}`).join('|'),
  ],
  () => {
    metrics.value = null;
  },
);
async function loadMetrics() {
  const id = props.snapshot.run?.id;
  const revision = props.snapshot.run?.revision;
  if (!id) return;
  try {
    const data = await api(`/creation-runs/${id}/metrics`);
    if (id === props.snapshot.run?.id && revision === props.snapshot.run?.revision) {
      metrics.value = data;
      error.value = '';
    }
  } catch (e: any) {
    if (id === props.snapshot.run?.id) error.value = e.message;
  }
}
</script>
<template>
  <details v-if="snapshot.run" class="panel">
    <summary>生产、恢复与实际投入</summary>
    <p>
      全片计划 {{ snapshot.timing.totalFrames / 24 }} 秒 · 本次请求范围
      {{ snapshot.timing.requestedFrames / 24 }} 秒 · 已采用
      {{ (snapshot.timing.adoptedFrames / 24).toFixed(2) }} 秒。片段采用不代表整集交付。
    </p>
    <button :disabled="!snapshot.scope" @click="emit('prepare')">更新范围准备预览</button>
    <table>
      <thead>
        <tr>
          <th>生成组</th>
          <th>目前依据</th>
          <th>处理</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="g in groups.slice(page * 15, page * 15 + 15)" :key="g.id">
          <td>{{ g.id }} · {{ g.transition }}</td>
          <td>
            {{ g.state }}
            <p v-for="(i, n) in g.issues" :key="n">{{ i.message }}</p>
          </td>
          <td>
            <button @click="emit('scope', g.shotIds)">选择此组范围</button
            ><button v-for="j in g.jobs" :key="j.id" @click="emit('job', j.id)">
              {{ j.state }} · 查看原任务
            </button>
          </td>
        </tr>
      </tbody>
    </table>
    <button :disabled="!page" @click="page--">上一页生成组</button
    ><span>{{ groups.length }} 组</span
    ><button :disabled="(page + 1) * 15 >= groups.length" @click="page++">下一页生成组</button>
    <p>
      混合范围只提交预览列出的就绪组；等待实际采用的后段保留待办。恢复归档、恢复跟踪和新增生成分别处理。
    </p>
    <button @click="loadMetrics">读取实际运行指标</button>
    <p class="error" v-if="error">{{ error }}</p>
    <template v-if="metrics"
      ><p>{{ metrics.scope }}</p>
      <table>
        <tbody>
          <tr>
            <th>已创建请求 / 请求秒数</th>
            <td>{{ metrics.requested }} / {{ metrics.requestedSeconds }}</td>
          </tr>
          <tr>
            <th>独立远端任务 / 受理不明</th>
            <td>{{ metrics.remoteTaskIds }} / {{ metrics.acceptanceUnknown }}</td>
          </tr>
          <tr>
            <th>任务归档成功 / 实际帧数</th>
            <td>
              {{ metrics.archived }} / {{ metrics.actualFrames }}（另有
              {{ metrics.frameCountMissing }} 项帧数未记录）
            </td>
          </tr>
          <tr>
            <th>有效采用秒数（源区间去重）</th>
            <td>{{ (metrics.uniqueAdoptedFrames / 24).toFixed(2) }}</td>
          </tr>
          <tr>
            <th>每次请求得到的采用秒数</th>
            <td>{{ metrics.adoptedSecondsPerRequest?.toFixed(2) ?? '无请求' }}</td>
          </tr>
          <tr>
            <th>已记录受理至归档的墙钟时间</th>
            <td>
              {{ metrics.observedWallTime.samples }} 条，{{
                (metrics.observedWallTime.totalMs / 60000).toFixed(2)
              }}
              分钟；包含归档，非模型计算或计费时长
            </td>
          </tr>
          <tr>
            <th>人工审核耗时</th>
            <td>未采集，不推算</td>
          </tr>
        </tbody>
      </table></template
    >
  </details>
</template>
