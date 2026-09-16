<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { api } from './api';
import { WorkspaceData } from './workspace-data';
import WorkStudio from './WorkStudio.vue';
import MediaLibrary from './MediaLibrary.vue';
import JobInspection from './JobInspection.vue';
import StudioSettings from './StudioSettings.vue';
provide('workspaceData', new WorkspaceData());
const navigation = [
  ['projects', '项目', '▦'],
  ['assets', '素材库', '▧'],
  ['jobs', '任务', '≡'],
  ['settings', '设置', '⚙'],
];
const section = ref('projects'),
  projectId = ref(localStorage.getItem('studio-project') || '');
const workspaceAction = ref<{ action: string; value: any } | null>(null);
const projects = ref<RecordDoc[]>([]),
  projectTotal = ref(0),
  update = ref(0);
const project = computed(() => projects.value.find((p) => p.id === projectId.value));
const showProjects = ref(false),
  create = ref(false),
  error = ref(''),
  busy = ref(false),
  connected = ref(false);
const form = ref({ title: '', mode: 'short' as 'short' | 'series', brief: '' });
const jobs = ref<any>({ items: [], total: 0 }),
  jobOffset = ref(0),
  jobState = ref(''),
  inspectedJob = ref('');
let events: EventSource | undefined,
  refreshTimer: ReturnType<typeof setTimeout> | undefined,
  ticket = 0;
async function loadProjects(more = false) {
  const page = await api(`/project-index?offset=${more ? projects.value.length : 0}&limit=50`);
  projects.value = more ? [...projects.value, ...page.items] : page.items;
  projectTotal.value = page.total;
  if (!projectId.value && projects.value.length) choose(projects.value[0].id);
  else if (projectId.value && !projects.value.some((p) => p.id === projectId.value)) {
    try {
      const p = await api('/records/' + projectId.value);
      if (p.kind === 'project') projects.value.push(p);
      else choose(projects.value[0]?.id || '');
    } catch {
      choose(projects.value[0]?.id || '');
    }
  }
}
function choose(id: string) {
  projectId.value = id;
  localStorage.setItem('studio-project', id);
  section.value = 'projects';
  showProjects.value = false;
  history.replaceState(null, '', '#' + new URLSearchParams({ project: id, view: 'canvas' }));
}
async function loadJobs() {
  const seq = ++ticket;
  const page = await api(
    '/jobs?' +
      new URLSearchParams({
        projectId: projectId.value,
        state: jobState.value,
        offset: String(jobOffset.value),
        limit: '25',
        summary: '1',
      }),
  );
  if (seq === ticket) jobs.value = page;
}
async function openSection(id: string) {
  section.value = id;
  try {
    if (id === 'jobs') await loadJobs();
  } catch (e: any) {
    error.value = e.message;
  }
}
async function createProject() {
  busy.value = true;
  error.value = '';
  try {
    const p = await api('/projects', 'POST', form.value);
    await loadProjects();
    choose(p.id);
    create.value = false;
    form.value = { title: '', mode: 'short', brief: '' };
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  const route = new URLSearchParams(location.hash.slice(1));
  if (route.get('project')) projectId.value = route.get('project')!;
  try {
    await loadProjects();
    const runtime = await api('/runtime');
    events = new EventSource('/api/events?after=' + runtime.eventCursor);
    events.onopen = () => {
      connected.value = true;
      update.value++;
    };
    events.onerror = () => {
      connected.value = false;
    };
    const changed = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        update.value++;
        if (section.value === 'jobs') void loadJobs().catch((e) => (error.value = e.message));
      }, 350);
    };
    events.onmessage = changed;
    for (const name of ['record', 'job', 'state']) events.addEventListener(name, changed);
  } catch (e: any) {
    error.value = e.message;
  }
});
onBeforeUnmount(() => {
  events?.close();
  clearTimeout(refreshTimer);
  ticket++;
});
</script>

<template>
  <div class="studio-shell">
    <nav class="global-nav" aria-label="全局导航">
      <button class="studio-brand" @click="showProjects = !showProjects" title="选择项目">
        S<span>Studio</span>
      </button>
      <div class="global-links">
        <button
          v-for="[id, label, icon] in navigation"
          :key="id"
          :class="{ active: section === id }"
          :aria-current="section === id ? 'page' : undefined"
          @click="openSection(id)"
        >
          <span aria-hidden="true">{{ icon }}</span
          ><span>{{ label }}</span>
        </button>
      </div>
      <button class="project-switch" @click="showProjects = !showProjects">
        {{ project?.data.title || '选择作品' }} <span>⌄</span>
      </button>
      <span
        class="connection-dot"
        :class="{ offline: !connected }"
        :title="connected ? '状态同步已连接' : '状态连接恢复中'"
      ></span>
    </nav>
    <div v-if="error" class="toast error" role="alert">
      {{ error }}<button @click="error = ''" aria-label="关闭错误">×</button>
    </div>
    <section v-if="showProjects || !project" class="project-home">
      <header>
        <div>
          <p class="eyebrow">YOUR STORIES</p>
          <h1>创作中的作品</h1>
        </div>
        <button class="primary" @click="create = true">＋ 新建项目</button>
      </header>
      <div class="project-grid">
        <button v-for="p in projects" :key="p.id" class="project-card" @click="choose(p.id)">
          <span class="project-art">{{ p.data.mode === 'series' ? '▤' : '▷' }}</span
          ><strong>{{ p.data.title }}</strong
          ><span>{{ p.data.mode === 'series' ? '系列作品' : '短片' }}</span>
          <p>{{ p.data.brief?.slice(0, 140) }}</p>
          <span>进入工作台 →</span>
        </button>
      </div>
      <button v-if="projects.length < projectTotal" @click="loadProjects(true)">
        加载更多项目
      </button>
    </section>
    <WorkStudio
      v-else-if="section === 'projects'"
      :key="project.id"
      :project="project"
      :version="update"
      :initial-action="workspaceAction"
      @action-opened="workspaceAction = null"
      @projects="showProjects = true"
    />
    <MediaLibrary
      v-else-if="section === 'assets'"
      :key="project.id"
      :project="project"
      :version="update"
      @workspace="
        workspaceAction = $event;
        section = 'projects';
      "
    />
    <section v-else-if="section === 'jobs'" class="global-page">
      <header class="page-heading">
        <div>
          <h1>任务</h1>
          <p>生成、归档和导出共用生产任务记录。</p>
        </div>
        <select
          v-model="jobState"
          @change="
            jobOffset = 0;
            loadJobs();
          "
          aria-label="筛选任务状态"
        >
          <option value="">全部状态</option>
          <option value="succeeded">已完成</option>
          <option value="running">执行中</option>
          <option value="unknown">受理待核对</option>
          <option value="failed">异常</option>
          <option value="queued">排队中</option>
        </select>
      </header>
      <div class="job-list">
        <button
          v-for="job in jobs.items"
          :key="job.id"
          class="job-row"
          @click="inspectedJob = job.id"
        >
          <span class="file-glyph">{{
            job.kind === 'generation' ? '▷' : job.kind === 'export' ? '↗' : '✎'
          }}</span
          ><span
            ><strong>{{ job.title || job.kind }}</strong
            ><small>{{ new Date(job.createdAt).toLocaleString() }}</small></span
          ><span class="status-tag">{{ job.state }}</span
          ><span>详情 →</span>
        </button>
      </div>
      <div class="pagination">
        <button
          :disabled="jobOffset === 0"
          @click="
            jobOffset -= 25;
            loadJobs();
          "
        >
          上一页</button
        ><span
          >{{ jobOffset + 1 }}–{{ Math.min(jobOffset + 25, jobs.total) }} / {{ jobs.total }}</span
        ><button
          :disabled="jobOffset + 25 >= jobs.total"
          @click="
            jobOffset += 25;
            loadJobs();
          "
        >
          下一页
        </button>
      </div>
    </section>
    <StudioSettings v-else-if="section === 'settings'" :project="project" />
    <div v-if="create" class="modal-backdrop" @click.self="create = false">
      <form class="dialog" v-dialog-focus="() => (create = false)" @submit.prevent="createProject">
        <header>
          <h2>新建作品</h2>
          <button type="button" @click="create = false" aria-label="关闭">×</button>
        </header>
        <label>作品名称<input v-model="form.title" required maxlength="160" autofocus /></label
        ><label
          >项目类型<select v-model="form.mode">
            <option value="short">短片 · 直接进入作品</option>
            <option value="series">系列 · 按分集制作</option>
          </select></label
        ><label
          >创作目标<textarea
            v-model="form.brief"
            rows="6"
            placeholder="描述想讲的故事、交付要求或已有资料…"
          />
        </label>
        <footer>
          <button type="button" @click="create = false">取消</button
          ><button class="primary" :disabled="busy">创建作品</button>
        </footer>
      </form>
    </div>
    <div v-if="inspectedJob" class="modal-backdrop" @click.self="inspectedJob = ''">
      <section class="dialog wide" v-dialog-focus="() => (inspectedJob = '')">
        <header>
          <h2>任务详情</h2>
          <button @click="inspectedJob = ''" aria-label="关闭">×</button>
        </header>
        <JobInspection :job-id="inspectedJob" :documents="[]" @refresh="loadJobs" />
      </section>
    </div>
  </div>
</template>
