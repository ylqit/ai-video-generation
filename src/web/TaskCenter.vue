<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import { api } from './api';
import { protocolLabels } from '../shared/models';
import { taskKindLabels, taskStateLabels } from '../shared/task-labels';
import { jobStates } from '../shared/contracts';
import JobInspection from './JobInspection.vue';
const props = defineProps<{
  projectId?: string;
  projects: any[];
  version?: number;
  initialScope?: string;
}>();
const emit = defineEmits(['canvas']);
const scope = ref(props.initialScope || 'all'),
  project = ref(props.projectId || ''),
  series = ref(''),
  episode = ref(''),
  kind = ref(''),
  protocol = ref(''),
  state = ref(''),
  quality = ref(''),
  attention = ref(false),
  group = ref('batch'),
  offset = ref(0),
  page = ref<any>({ items: [], total: 0 }),
  records = ref<any[]>([]),
  error = ref(''),
  inspected = ref('');
const kinds = taskKindLabels,
  states = taskStateLabels;
const grouped = computed(() => {
  const map = new Map<string, any[]>();
  for (const j of page.value.items) {
    const key =
      group.value === 'batch'
        ? j.batchId || '独立任务'
        : group.value === 'object'
          ? j.episodeId || j.projectId || '全局音色'
          : '全部';
    map.set(key, [...(map.get(key) || []), j]);
  }
  return [...map].map(([key, items]) => ({ key, items }));
});
let ticket = 0;
async function load() {
  const seq = ++ticket;
  try {
    const q = new URLSearchParams({
      scope: scope.value,
      ...(scope.value === 'project' ? { projectId: project.value } : {}),
      seriesId: series.value,
      episodeId: episode.value,
      kind: kind.value,
      protocol: protocol.value,
      state: state.value,
      quality: quality.value,
      attention: attention.value ? '1' : '0',
      offset: String(offset.value),
      limit: '25',
    });
    const r = await api('/tasks?' + q);
    if (seq !== ticket) return;
    page.value = r;
    error.value = '';
    if (offset.value >= r.total && offset.value > 0) {
      offset.value = Math.max(0, Math.floor((r.total - 1) / 25) * 25);
      await load();
    }
  } catch (e: any) {
    if (seq === ticket) error.value = e.message;
  }
}
watch([scope, project, series, episode, kind, protocol, state, quality, attention], () => {
  offset.value = 0;
  void load();
});
let scopeTicket = 0;
watch(
  [scope, project],
  async () => {
    const seq = ++scopeTicket,
      projectId = project.value;
    series.value = '';
    episode.value = '';
    records.value = [];
    if (scope.value === 'project' && project.value) {
      try {
        const parts = await Promise.all(
          ['series', 'episode'].map(async (kind) => {
            const items: any[] = [];
            while (true) {
              const p = await api(
                '/task-scopes?' +
                  new URLSearchParams({
                    projectId,
                    kind,
                    limit: '100',
                    offset: String(items.length),
                  }),
              );
              if (seq !== scopeTicket) return [];
              items.push(...p.items);
              if (!p.items.length || items.length >= p.total) return items;
            }
          }),
        );
        if (seq === scopeTicket) records.value = parts.flat();
      } catch (e: any) {
        error.value = e.message;
      }
    }
  },
  { immediate: true },
);
watch(() => props.version, load, { immediate: true });
async function cancel(id: string) {
  try {
    await api('/jobs/' + id + '/cancel', 'POST');
    await load();
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section class="global-page task-center">
    <header>
      <h1>任务中心</h1>
      <p>查看执行进展、选用结果和下一步操作。未审看不属于任务异常。</p>
    </header>
    <div class="form-grid task-filters">
      <label
        >范围<select v-model="scope">
          <option value="all">全部任务</option>
          <option value="workspace">全局音色</option>
          <option value="project">指定作品</option>
        </select></label
      ><label v-if="scope === 'project'"
        >作品<select v-model="project">
          <option value="">请选择</option>
          <option v-for="p in projects" :value="p.id">{{ p.data.title }}</option>
        </select></label
      ><label v-if="scope === 'project'"
        >系列<select v-model="series">
          <option value="">全部系列</option>
          <option v-for="r in records.filter((r) => r.kind === 'series')" :value="r.id">
            {{ r.data.title }}
          </option>
        </select></label
      ><label v-if="scope === 'project'"
        >分集<select v-model="episode">
          <option value="">全部分集</option>
          <option
            v-for="r in records.filter(
              (r) => r.kind === 'episode' && (!series || r.data.seriesId === series),
            )"
            :value="r.id"
          >
            {{ r.data.title }}
          </option>
        </select></label
      >
      <label
        >任务类型<select v-model="kind">
          <option value="">全部类型</option>
          <option v-for="(name, id) in kinds" :value="id">{{ name }}</option>
        </select></label
      ><label
        >供应商／协议<select v-model="protocol">
          <option value="">全部协议</option>
          <option v-for="(name, id) in protocolLabels" :value="id">{{ name }}</option>
        </select></label
      ><label
        >执行状态<select v-model="state">
          <option value="">全部状态</option>
          <option v-for="s in jobStates" :value="s">{{ states[s] || s }}</option>
        </select></label
      ><label
        >作品状态<select v-model="quality">
          <option value="">全部选用状态</option>
          <option value="unreviewed">尚未采用</option>
          <option value="adopted">已选用</option>
          <option value="needs_review">依据需复核</option>
        </select></label
      ><label
        >分组<select v-model="group">
          <option value="batch">按批次</option>
          <option value="object">按制作对象</option>
          <option value="none">平铺</option>
        </select></label
      ><label><input type="checkbox" v-model="attention" />只看需处理</label>
    </div>
    <p v-if="error" class="error">{{ error }}</p>
    <button @click="load">刷新</button>
    <p v-if="!page.items.length">当前筛选没有任务。</p>
    <details open v-for="g in grouped" :key="g.key">
      <summary>
        {{
          g.key === '独立任务' || g.key === '全部'
            ? g.key
            : g.items[0].title.split('／').slice(0, 2).join('／')
        }}
        · 本页 {{ g.items.length }} 项
      </summary>
      <article class="panel" v-for="j in g.items" :key="j.id">
        <h3>{{ j.title }}</h3>
        <p>
          {{ j.kindLabel }} · {{ j.model || '原执行链' }}
          <span v-if="j.voice">· {{ j.voice }} v{{ j.voiceRevision }}</span>
        </p>
        <p>
          <strong>{{ j.stage }}</strong> · {{ j.qualityLabel }} ·
          {{ j.elapsedSeconds === null ? '历史耗时未记录' : `任务历时 ${j.elapsedSeconds} 秒` }} ·
          最近更新 {{ new Date(j.updatedAt).toLocaleString() }}
        </p>
        <p v-if="j.holdReason">等待原因：{{ j.holdReason }}</p>
        <p v-if="j.error" class="error">{{ j.error }}</p>
        <button v-if="j.canvasId" @click="emit('canvas', j)">回到画布</button
        ><button @click="inspected = j.id">查看结果与下一步</button
        ><button v-if="j.actions.includes('cancel')" @click="cancel(j.id)">取消排队</button>
      </article>
    </details>
    <div class="pagination">
      <button
        :disabled="offset === 0"
        @click="
          offset -= 25;
          load();
        "
      >
        上一页</button
      ><span
        >{{ page.total ? offset + 1 : 0 }}–{{ Math.min(offset + 25, page.total) }} /
        {{ page.total }}</span
      ><button
        :disabled="offset + 25 >= page.total"
        @click="
          offset += 25;
          load();
        "
      >
        下一页
      </button>
    </div>
    <div v-if="inspected" class="modal-backdrop" @click.self="inspected = ''">
      <section class="dialog wide">
        <header>
          <h2>任务详情</h2>
          <button @click="inspected = ''">关闭</button>
        </header>
        <JobInspection :job-id="inspected" :documents="[]" @refresh="load" />
      </section>
    </div>
  </section>
</template>
