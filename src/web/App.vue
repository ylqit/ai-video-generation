<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, provide, ref, defineAsyncComponent } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { api, serviceOffline } from './api';
import { WorkspaceData } from './workspace-data';
import CanvasWorkspace from './CanvasWorkspace.vue';
const StudioModelSettings = defineAsyncComponent(() => import('./StudioModelSettings.vue'));
import GlobalMediaLibrary from './GlobalMediaLibrary.vue';
import TaskCenter from './TaskCenter.vue';
const GlobalVoiceLibrary = defineAsyncComponent(() => import('./GlobalVoiceLibrary.vue'));
provide('workspaceData', new WorkspaceData());
const navigation = [
  ['projects', '作品', '▦'],
  ['assets', '素材库', '▧'],
  ['jobs', '任务', '≡'],
  ['settings', '设置', '⚙'],
];
const section = ref('projects'),
  projectId = ref('');
const canvasTarget = ref<{ id: string; nodeId?: string; key: number }>();
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
const assetTab = ref('all');
const projectSearch = ref(''),
  startMode = ref('blank');
const filteredProjects = computed(() =>
  projects.value.filter((p) => p.data.title.includes(projectSearch.value)),
);
let events: EventSource | undefined, refreshTimer: ReturnType<typeof setTimeout> | undefined;
async function loadProjects(more = false) {
  const page = await api(`/project-index?offset=${more ? projects.value.length : 0}&limit=50`);
  projects.value = more ? [...projects.value, ...page.items] : page.items;
  projectTotal.value = page.total;
  if (projectId.value && !projects.value.some((p) => p.id === projectId.value)) {
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
function openSection(id: string) {
  section.value = id;
  showProjects.value = id === 'projects';
}
async function createProject() {
  busy.value = true;
  error.value = '';
  try {
    const p = await api('/projects', 'POST', form.value);
    if (startMode.value !== 'blank' && form.value.brief.trim()) {
      const c = await api(`/projects/${p.id}/canvases`, 'POST', {
        version: 2,
        title: '创作起点',
        episodeId: null,
        nodes: [],
        edges: [],
      });
      await api('/canvases/' + c.id, 'PUT', {
        revision: c.revision,
        data: {
          ...c.data,
          nodes: [
            {
              id: crypto.randomUUID(),
              type: 'document',
              title: startMode.value === 'import' ? '原始材料' : '创作目标',
              x: 80,
              y: 80,
              text: form.value.brief,
              selected: false,
            },
          ],
        },
      });
    }
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
async function reconnect() {
  try {
    events?.close();
    connected.value = false;
    await loadProjects();
    error.value = '';
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
      }, 350);
    };
    events.onmessage = changed;
    for (const name of ['record', 'job', 'state']) events.addEventListener(name, changed);
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(() => {
  const route = new URLSearchParams(location.hash.slice(1));
  if (route.get('project')) projectId.value = route.get('project')!;
  void reconnect();
});
onBeforeUnmount(() => {
  events?.close();
  clearTimeout(refreshTimer);
});
</script>

<template>
  <div class="studio-shell">
    <div v-if="serviceOffline" class="error" role="alert">
      Studio 后台暂不可达，恢复连接后可继续当前编辑。<button @click="reconnect()">
        检查并重新连接
      </button>
    </div>
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
      <button v-if="!connected" class="reconnect-button" @click="reconnect">重新连接</button>
      <span
        class="connection-dot"
        :class="{ offline: !connected }"
        :title="connected ? '状态同步已连接' : '状态连接恢复中'"
      ></span>
    </nav>
    <div v-if="error && !serviceOffline" class="toast error" role="alert">
      {{ error }}<button @click="error = ''" aria-label="关闭错误">×</button>
    </div>
    <section v-if="showProjects || (!project && section === 'projects')" class="project-home">
      <header>
        <div>
          <p class="eyebrow">YOUR STORIES</p>
          <h1>创作中的作品</h1>
        </div>
        <button class="primary" @click="create = true">＋ 新建项目</button>
      </header>
      <div class="home-toolbar">
        <input
          type="search"
          v-model="projectSearch"
          placeholder="搜索作品"
          aria-label="搜索作品"
        /><span>{{ projectTotal }} 部作品</span>
      </div>
      <div v-if="!filteredProjects.length" class="page-empty">
        <span>◇</span>
        <h2>给想法一个开始</h2>
        <p>从空白画布、一个创意或已有材料开始。短片与多集系列都可以逐步构建。</p>
        <button class="primary" @click="create = true">新建作品</button>
      </div>
      <div class="project-grid">
        <button
          v-for="p in filteredProjects"
          :key="p.id"
          class="project-card"
          @click="choose(p.id)"
        >
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
    <CanvasWorkspace
      v-else-if="section === 'projects' && project"
      :key="project.id"
      :project="project"
      :version="update"
      :open-canvas="canvasTarget"
      :initial-action="workspaceAction"
      @projects="showProjects = true"
    />
    <section v-else-if="section === 'assets'" class="asset-library-shell">
      <header class="page-heading">
        <div>
          <p class="eyebrow">YOUR RESOURCES</p>
          <h1>素材库</h1>
          <p>查找作品素材，复用声音身份。选用记录与质量观察分别保存。</p>
        </div>
      </header>
      <nav class="view-tabs" aria-label="素材库范围">
        <button :class="{ active: assetTab === 'all' }" @click="assetTab = 'all'">全部素材</button>
        <button :class="{ active: assetTab === 'voices' }" @click="assetTab = 'voices'">
          全局音色</button
        ><button
          v-if="project"
          :class="{ active: assetTab === 'project' }"
          @click="assetTab = 'project'"
        >
          本作品素材
        </button>
      </nav>
      <GlobalMediaLibrary
        v-if="assetTab === 'all'"
        :projects="projects"
        :version="update"
        @project="choose"
        @select="
          workspaceAction = { action: 'bind', value: $event };
          choose($event.projectId);
        "
      />
      <GlobalVoiceLibrary v-else-if="assetTab === 'voices'" :version="update" /><GlobalMediaLibrary
        v-else-if="project"
        :key="project.id"
        :projects="projects"
        :project-id="project.id"
        :version="update"
        @project="choose"
        @select="
          workspaceAction = { action: 'bind', value: $event };
          choose($event.projectId);
        "
      />
    </section>
    <TaskCenter
      v-else-if="section === 'jobs'"
      :project-id="projectId"
      :projects="projects"
      :version="update"
      @canvas="
        canvasTarget = { id: $event.canvasId, nodeId: $event.canvasNodeId, key: Date.now() };
        choose($event.projectId);
      "
    />
    <StudioModelSettings v-else-if="section === 'settings'" :project="project" />
    <div v-if="create" class="modal-backdrop" @click.self="create = false">
      <form class="dialog" v-dialog-focus="() => (create = false)" @submit.prevent="createProject">
        <header>
          <h2>新建作品</h2>
          <button type="button" @click="create = false" aria-label="关闭">×</button>
        </header>
        <div class="start-options">
          <button
            v-for="[id, label] in [
              ['blank', '空白画布'],
              ['idea', '创意起步'],
              ['import', '导入材料'],
            ]"
            :key="id"
            type="button"
            :class="{ active: startMode === id }"
            @click="startMode = id"
          >
            {{ label }}
          </button>
        </div>
        <label>作品名称<input v-model="form.title" required maxlength="160" autofocus /></label
        ><label
          >项目类型<select v-model="form.mode">
            <option value="short">短片 · 直接进入作品</option>
            <option value="series">系列 · 按分集制作</option>
          </select></label
        ><label
          >{{ startMode === 'import' ? '原始材料' : '创作目标（可选）'
          }}<textarea
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
  </div>
</template>
