<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import { useWorkbenchTransfers } from './useWorkbenchTransfers';
import ImportProgress from './ImportProgress.vue';
import NodeProductionTray from './NodeProductionTray.vue';
import { useNodeWorkbench } from './useNodeWorkbench';
import { nodeDefinitions } from '../shared/node-catalog';
import type { RecordDoc } from '../shared/contracts';
import { serviceOffline } from './api';
import CanvasViewport from './CanvasViewport.vue';
import CanvasInspector from './CanvasInspector.vue';
import CanvasContentView from './CanvasContentView.vue';
import CanvasEdit from './CanvasEdit.vue';
import CanvasFloatingAgent from './CanvasFloatingAgent.vue';
import CanvasTaskDock from './CanvasTaskDock.vue';
import CanvasResources from './CanvasResources.vue';
import NodeOperationEditor from './NodeOperationEditor.vue';
import ImageEditDraft from './ImageEditDraft.vue';
const DirectorNodeEditor = defineAsyncComponent(() => import('./DirectorNodeEditor.vue'));
import NodeAnalysisResult from './NodeAnalysisResult.vue';
import CanvasCandidateViewer from './CanvasCandidateViewer.vue';
import CanvasConflictDialog from './CanvasConflictDialog.vue';
const JobInspection = defineAsyncComponent(() => import('./JobInspection.vue'));
const props = defineProps<{
  project: RecordDoc;
  version: number;
  initialAction?: { action: string; value: any } | null;
  openCanvas?: { id: string; nodeId?: string; key: number };
}>();
const emit = defineEmits(['projects']);
const workbench = useNodeWorkbench(props);
const {
  current,
  draft,
  snapshot,
  dirty,
  conflict,
  comparison,
  compare,
  resolveComparison,
  changed,
  save,
  remove,
  duplicate,
  copySelection,
  paste,
  history,
  arrange,
  group,
  canvases,
  selected,
  selection,
  view,
  drawer,
  shelf,
  search,
  showAgent,
  busy,
  error,
  notice,
  focusKey,
  newCanvas,
  name,
  episodeId,
  episodes,
  records,
  connection,
  purpose,
  relation,
  preview,
  operation,
  imageAction,
  replacement,
  candidate,
  result,
  inspectedJob,
  conversion,
  pendingClip,
  rewriteRange,
  modelKey,
  node,
  assets,
  selectedAsset,
  searchResults,
  action,
  refresh,
  locate,
  addNode,
  switchCanvas,
  createCanvas,
  move,
  link,
  prepare,
  generate,
  operate,
  uploaded,
  bind,
  chooseAsset,
  openCandidate,
  pinCandidate,
  editDraft,
  openSeries,
  migrate,
} = workbench;
const inspector = ref(false);
const {
  imports,
  showImports,
  agentAdditions,
  importFiles,
  retryImport,
  extractCurrentFrame,
  saveReferences,
  addReferences,
  locateReference,
  bindReferences,
} = useWorkbenchTransfers(props.project.id, workbench);
</script>
<template>
  <div class="creative-workspace node-workbench">
    <header class="work-bar">
      <div class="work-identity">
        <button @click="emit('projects')" title="作品列表">‹</button
        ><strong>{{ project.data.title }}</strong
        ><select
          :value="current?.id"
          :disabled="busy"
          aria-label="当前画布"
          @change="switchCanvas(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="c in canvases" :key="c.id" :value="c.id">
            {{ c.data.title }}
          </option></select
        ><button @click="newCanvas = true" title="新建画布">＋</button>
      </div>
      <nav class="view-tabs">
        <button
          v-for="[id, label] in [
            ['canvas', '画布'],
            ['documents', '文档'],
            ['shots', '分镜'],
            ['edit', '剪辑'],
          ]"
          :key="id"
          :class="{ active: view === id }"
          @click="view = id"
        >
          {{ label }}
        </button>
      </nav>
      <input
        v-model="search"
        class="canvas-search"
        type="search"
        placeholder="查找节点…"
        aria-label="搜索画布节点"
      /><button @click="showAgent = !showAgent">✧ 助手</button
      ><button :disabled="!node" @click="inspector = !inspector">属性</button
      ><button :disabled="busy || !dirty" @click="action(save)">
        {{ dirty ? '保存' : '已保存' }}
      </button>
      <button v-if="dirty" :disabled="busy" @click="action(compare)">比较版本</button>
    </header>
    <div v-if="searchResults.length" class="canvas-search-results">
      <button
        v-for="n in searchResults"
        :key="n.id"
        @click="
          locate(n.id);
          search = '';
        "
      >
        {{ n.title }}
      </button>
    </div>
    <p v-if="error && !serviceOffline" class="inline-error" role="alert">
      {{ error }} <button @click="error = ''">关闭</button>
    </p>
    <p v-if="current?.data.version === 1" class="workspace-notice">
      此画布仍使用旧节点结构。<button @click="migrate()">预览转换</button>
    </p>
    <p v-if="conflict" class="workspace-notice">{{ conflict }}</p>
    <div v-if="draft && current" class="workbench-body">
      <aside class="node-shelf" :class="{ collapsed: !shelf }">
        <label class="attachment-button" title="导入到画布"
          >↑<input
            type="file"
            multiple
            accept="image/*,video/*,audio/*,.txt,.md"
            @change="
              importFiles(Array.from(($event.target as HTMLInputElement).files || []), {
                kind: 'canvas',
              });
              ($event.target as HTMLInputElement).value = '';
            "
        /></label>
        <button @click="shelf = !shelf" :title="shelf ? '收起工具栏' : '展开工具栏'">☰</button
        ><template v-if="shelf"
          ><p class="eyebrow">作品资源</p>
          <button
            @click="
              drawer = 'assets';
              replacement = false;
            "
          >
            ▧ 素材与上传</button
          ><button @click="drawer = 'objects'">♙ 人物与资料</button
          ><button @click="action(openSeries)">⌑ 系列与分集</button
          ><button @click="drawer = 'tasks'">≡ 作品任务</button
          ><button @click="drawer = 'models'">◇ 模型与额度</button>
          <p class="eyebrow">添加制作节点</p>
          <details
            v-for="[category, label] in [
              ['content', '内容设计'],
              ['media', '媒体素材'],
              ['production', '生成与处理'],
              ['organization', '画布组织'],
            ]"
            :key="category"
            open
          >
            <summary>{{ label }}</summary>
            <button
              v-for="d in nodeDefinitions.filter((d) => d.category === category)"
              :key="d.type"
              @click="addNode(d.type)"
            >
              {{ d.icon }} {{ d.label }}
            </button>
          </details></template
        >
      </aside>
      <CanvasViewport
        v-if="view === 'canvas'"
        :key="current.id"
        :content="draft"
        :selected="selected"
        :selected-ids="selection"
        :focus-key="focusKey"
        @select="selected = $event"
        @reference="addReferences"
        @upload="importFiles($event.files, { kind: 'canvas', position: $event.position })"
        @range="
          (id, range) => {
            draft!.nodes.find((n) => n.id === id)!.range = range;
            changed();
          }
        "
        @frame="extractCurrentFrame"
        @selection="selection = $event"
        @move="move"
        @connect="connection = $event"
        @agent="showAgent = true"
        @add="addNode"
        @arrange="arrange(selection)"
        @undo="history('undo')"
        @redo="history('redo')"
        @duplicate="selection = duplicate(selection)"
        @copy="copySelection(selection)"
        @paste="selection = paste()"
        @remove="
          remove(selection);
          selected = '';
        "
        @group="group(selection)"
        @collapse="
          draft.nodes.find((n) => n.id === $event)!.collapsed = !draft.nodes.find(
            (n) => n.id === $event,
          )!.collapsed;
          changed();
        "
        @action="operate"
        @viewport="
          draft.viewport = $event;
          changed(false);
        "
        ><template #tray="{ node: trayNode }"
          ><NodeProductionTray
            v-if="['image_generate', 'video_generate'].includes(trayNode.type)"
            :key="trayNode.id + modelKey"
            :node="trayNode"
            :canvas-id="current.id"
            :project-id="project.id"
            :nodes="draft.nodes"
            :edges="draft.edges"
            :preview="preview"
            :busy="busy"
            :jobs="snapshot.jobs || []"
            @change="
              changed();
              preview = null;
            "
            @prepare="prepare"
            @generate="generate"
            @models="drawer = 'models'"
            @candidate="openCandidate"
            @reference="bindReferences"
            @upload="
              (files, purpose) =>
                importFiles(files, { kind: 'reference', nodeId: trayNode.id, purpose })
            "
            @remove-edge="
              draft.edges = draft.edges.filter((e) => e.id !== $event);
              changed();
              preview = null;
            "
          />
          <div v-else-if="['note', 'document'].includes(trayNode.type)">
            <label>正文<textarea v-model="trayNode.text" rows="5" @input="changed()" /></label
            ><button @click="addReferences([trayNode.id])">加入助手</button>
          </div></template
        ></CanvasViewport
      >
      <CanvasContentView
        v-else-if="view === 'documents' || view === 'shots'"
        :key="current.id"
        :content="draft"
        :view="view"
        @add="addNode"
        @change="changed"
        @select="selected = $event"
        @rewrite="
          async (r) => {
            await operate(r.nodeId, 'rewrite');
            rewriteRange = r;
          }
        "
      />
      <CanvasEdit
        v-else-if="view === 'edit'"
        :key="current.id"
        :canvas="current"
        :content="draft"
        :snapshot="snapshot"
        :dirty="dirty"
        :pending-clip="pendingClip"
        @clip-added="pendingClip = ''"
        @save-canvas="action(save)"
        @refresh="refresh"
      />
      <DirectorNodeEditor
        v-else-if="view === 'director' && node"
        :key="node.id"
        :canvas="current"
        :node="node"
        @refresh="refresh"
        @close="view = 'canvas'"
        @operation="operate(node!.id, $event)"
      />
      <aside
        v-if="inspector && node && ['canvas', 'documents', 'shots'].includes(view)"
        class="inspector-rail"
      >
        <button class="inspector-close" @click="inspector = false">收起属性 ×</button
        ><CanvasInspector
          :key="node.id + modelKey"
          :node="node"
          :edges="draft.edges"
          :nodes="draft.nodes"
          :assets="assets"
          :preview="preview"
          :busy="busy"
          @change="changed"
          @remove="
            remove([selected]);
            selected = '';
          "
          @prepare="prepare"
          @generate="generate"
          @edit="operate(node!.id, 'timeline')"
          @remove-edge="
            draft.edges = draft.edges.filter((e) => e.id !== $event);
            changed();
          "
          @operation="operate(node!.id, $event)"
          @candidate="openCandidate"
          @open-object="
            action(async () => {
              await save();
              if (node!.type === 'director') view = 'director';
              else drawer = 'objects';
            })
          "
          @models="drawer = 'models'"
          @replace="
            replacement = true;
            drawer = 'assets';
          "
        />
      </aside>
    </div>
    <CanvasTaskDock
      :jobs="snapshot.jobs || []"
      :nodes="draft?.nodes || []"
      :message="dirty ? '● 有未保存内容' : notice || '● 内容已保存'"
      @inspect="inspectedJob = $event"
      @all="drawer = 'tasks'"
    />
    <CanvasFloatingAgent
      v-if="showAgent && current"
      :key="current.id"
      :canvas="current"
      :run="snapshot.assistant"
      :selected-ids="selection"
      :additions="agentAdditions"
      :save-references="saveReferences"
      :busy="busy"
      :version="version"
      @refresh="refresh"
      @close="showAgent = false"
      @locate="locateReference"
      @attach="importFiles($event, { kind: 'assistant' })"
    />
    <ImportProgress
      v-if="showImports"
      :items="imports.items.value"
      @retry="retryImport"
      @close="showImports = false"
    />
    <CanvasResources
      v-if="drawer && current"
      :drawer="drawer"
      :current="current"
      :project="project"
      :version="version"
      :node="node"
      :records="records"
      @close="drawer = ''"
      @select="chooseAsset"
      @uploaded="uploaded"
      @refresh="refresh"
      @bind="bind"
      @locate="locateReference({ canvas: { id: $event.canvasId }, nodeId: $event.nodeId })"
      @series-refresh="action(openSeries)"
    />
    <div v-if="operation && current && node" class="modal-backdrop" @click.self="operation = ''">
      <NodeOperationEditor
        class="dialog"
        :key="node.id + operation"
        :canvas="current"
        :node="node"
        :action="operation"
        :text-range="rewriteRange"
        :assets="assets"
        @close="operation = ''"
        @submitted="refresh"
        @model-settings="
          operation = '';
          drawer = 'models';
        "
      />
    </div>
    <div v-if="imageAction && selectedAsset" class="modal-backdrop">
      <ImageEditDraft
        class="dialog"
        :asset="selectedAsset"
        :action="imageAction"
        @close="imageAction = ''"
        @create="editDraft"
      />
    </div>
    <div v-if="result && current" class="modal-backdrop">
      <NodeAnalysisResult
        class="dialog"
        :record="result"
        :canvas="current"
        @close="result = null"
        @refresh="refresh"
      />
    </div>
    <div v-if="inspectedJob" class="modal-backdrop" @click.self="inspectedJob = ''">
      <section class="dialog">
        <button @click="inspectedJob = ''">关闭任务详情</button
        ><JobInspection :job-id="inspectedJob" :documents="assets" @refresh="refresh" />
      </section>
    </div>
    <CanvasCandidateViewer
      v-if="candidate"
      :asset="candidate.asset"
      :alternatives="
        assets.filter(
          (a: any) =>
            a.data.mediaType === candidate.asset.data.mediaType && a.id !== candidate.asset.id,
        )
      "
      @close="candidate = null"
      @use="pinCandidate($event)"
    />
    <div v-if="connection" class="modal-backdrop">
      <form class="dialog compact-dialog" @submit.prevent="link">
        <h2>连接职责</h2>
        <p>{{ connection.sourceHandle }} → {{ connection.targetHandle }}</p>
        <label
          >关联类型<select v-model="relation">
            <option value="input">实际制作输入</option>
            <option value="organize">组织关系</option>
          </select></label
        ><label
          v-if="relation === 'input' && !['text', 'context'].includes(connection.targetHandle)"
          >参考用途<select v-model="purpose">
            <option
              v-for="[id, label] in [
                ['identity', '身份'],
                ['style', '风格'],
                ['scene', '环境'],
                ['prop', '物件'],
                ['composition', '构图'],
                ['first_frame', '首帧'],
                ['last_frame', '尾帧'],
                ['motion', '运动'],
                ['audio', '声音'],
              ]"
              :key="id"
              :value="id"
            >
              {{ label }}
            </option>
          </select></label
        >
        <footer>
          <button type="button" @click="connection = null">取消</button
          ><button class="primary">连接</button>
        </footer>
      </form>
    </div>
    <div v-if="newCanvas" class="modal-backdrop">
      <form class="dialog compact-dialog" @submit.prevent="createCanvas">
        <h2>新建画布</h2>
        <label>名称<input v-model="name" required /></label
        ><label
          >所属分集<select v-model="episodeId">
            <option value="">独立试作／作品公共内容</option>
            <option v-for="e in episodes" :key="e.id" :value="e.id">{{ e.title }}</option>
          </select></label
        >
        <footer>
          <button type="button" @click="newCanvas = false">取消</button
          ><button class="primary">创建</button>
        </footer>
      </form>
    </div>
    <div v-if="conversion" class="modal-backdrop">
      <section class="dialog">
        <h2>转换画布 v2</h2>
        <p>
          {{ conversion.changes.length }} 个生成节点将按用途拆分；旧节点
          ID、素材、任务和文档保持可追溯。
        </p>
        <pre>{{ conversion.changes }}</pre>
        <button @click="conversion = null">取消</button
        ><button class="primary" @click="migrate(true)">应用转换</button>
      </section>
    </div>
    <CanvasConflictDialog
      v-if="comparison"
      :comparison="comparison"
      :draft="draft"
      @close="comparison = null"
      @resolve="
        (value) =>
          action(async () => {
            resolveComparison(value);
            error = '';
          })
      "
    />
  </div>
</template>
