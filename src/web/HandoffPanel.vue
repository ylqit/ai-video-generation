<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, assetUrl, downloadJson } from './api';
import type { WorkspaceSnapshot } from '../shared/workspace';
const props = defineProps<{ requirement: any; snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['close', 'refresh', 'bind']);
const task = ref<any>(null),
  bundle = ref<any>(null),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  maxRevisions = ref(2),
  deliveryId = ref(crypto.randomUUID());
const selectedFiles = ref<Record<string, File>>({}),
  showReturn = ref(false),
  candidates = ref<any[]>([]);
const packageUrl = computed(() =>
  task.value
    ? `${location.origin}/api/asset-tasks/${task.value.id}/package?revision=${bundle.value?.taskRevision || task.value.revision}`
    : '',
);
const instructions = computed(() =>
  bundle.value
    ? `请完成 Studio 图片素材任务，读取固定任务包：\n${packageUrl.value}\n\n${bundle.value.instructions}\n\n交付地址：${location.origin}/api/asset-tasks/${task.value.id}/delivery\n使用任务包中的固定任务版本，以 multipart files + manifest 回填实际图片。\n只制作和交付素材，不修改项目源码、数据库结构，也不绕过 Studio 提交 H3。`
    : '',
);
async function loadTask(value: any) {
  task.value = value;
  bundle.value = await api(`/asset-tasks/${value.id}/package?revision=${value.revision}`);
  const refs = (value.data.deliveries || []).flatMap((d: any) =>
    (d.candidates || []).map((c: any) => ({
      ...c,
      late: d.stale || d.late,
      deliveryId: d.deliveryId,
    })),
  );
  candidates.value = await Promise.all(
    refs.map(async (c: any) => ({
      ...c,
      record: await api(`/records/${c.asset.id}?revision=${c.asset.revision}`),
    })),
  );
}
onMounted(async () => {
  try {
    const list = await api(
      `/creation-runs/${props.snapshot.run!.id}/asset-tasks?requirementId=${encodeURIComponent(props.requirement.id)}`,
    );
    const latest = (list.items || list).at(-1);
    if (latest) await loadTask(latest);
  } catch (e: any) {
    error.value = e.message;
  }
});
async function create() {
  busy.value = true;
  error.value = '';
  try {
    const result = await api(`/creation-runs/${props.snapshot.run!.id}/asset-tasks`, 'POST', {
      revision: props.snapshot.run!.revision,
      requirementId: props.requirement.id,
      idempotencyKey: crypto.randomUUID(),
      maxRevisions: maxRevisions.value,
    });
    await loadTask(result.task || result);
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(instructions.value);
    notice.value = '制作指令已复制，可在具备图像工具的 Codex 会话中执行。';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function deliver() {
  busy.value = true;
  error.value = '';
  try {
    const body = new FormData(),
      assets = [];
    for (const view of bundle.value.task.views) {
      const file = selectedFiles.value[view.id];
      if (!file) throw new Error('请为每个交付视图选择文件');
      body.append('files', file);
      assets.push({ viewId: view.id, file: file.name });
    }
    body.set(
      'manifest',
      JSON.stringify({
        taskId: task.value.id,
        taskRevision: bundle.value.taskRevision,
        deliveryId: deliveryId.value,
        assets,
      }),
    );
    const result = await api(`/asset-tasks/${task.value.id}/delivery`, 'POST', body);
    await loadTask(result.task || result);
    notice.value = '实际图片已回填，请审看后绑定用途。';
    showReturn.value = false;
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <section
      class="dialog wide handoff-panel"
      v-dialog-focus="() => emit('close')"
      role="dialog"
      aria-modal="true"
      aria-label="Codex 素材任务"
      @keydown.esc="emit('close')"
    >
      <header>
        <div>
          <small>CODEX HANDOFF</small>
          <h2>{{ requirement.description }}</h2>
        </div>
        <button @click="emit('close')" aria-label="关闭">×</button>
      </header>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p v-if="notice" role="status">{{ notice }}</p>
      <div class="handoff-overview">
        <div>
          <h3>素材用途</h3>
          <p>{{ requirement.purpose }} · {{ requirement.layout }}</p>
          <p>用于 {{ requirement.shotIds.length }} 个镜头。绑定用途与画面动作分别保存。</p>
          <h3>制作提示</h3>
          <p class="handoff-prompt">{{ requirement.prompt }}</p>
        </div>
        <aside>
          <span class="status-tag">{{
            task
              ? candidates.length
                ? '已收到图片候选'
                : '等待 Codex 执行 / 回填'
              : '任务尚未创建'
          }}</span>
          <p>宿主 Codex 会话使用实际可用的图像工具制作；Studio 接收固定任务版本的文件与清单。</p>
          <label v-if="!task"
            >允许追加图片修订<input
              v-model.number="maxRevisions"
              type="number"
              min="0"
              max="2" /></label
          ><button v-if="!task" class="primary" :disabled="busy" @click="create">
            建立素材任务</button
          ><template v-else
            ><button class="primary" @click="copy">复制 Codex 制作指令</button
            ><button @click="downloadJson('codex-asset-task.json', bundle)">下载任务资料</button
            ><button @click="showReturn = !showReturn">手动回填文件</button></template
          >
          <p class="muted">外部工具调用依照真实回执记录，不代表 Studio 能直接控制其计费。</p>
        </aside>
      </div>
      <div v-if="bundle?.files.length" class="reference-strip">
        <a
          v-for="file in bundle.files"
          :key="file.id"
          :href="assetUrl(file.id, file.revision)"
          target="_blank"
          ><img :src="assetUrl(file.id, file.revision)" alt="固定输入参考"
        /></a>
      </div>
      <div v-if="candidates.length" class="handoff-candidates">
        <article v-for="candidate in candidates" :key="candidate.asset.id">
          <img
            :src="assetUrl(candidate.asset.id, candidate.asset.revision)"
            :alt="candidate.record.data.name"
          />
          <h3>{{ candidate.record.data.name }}</h3>
          <p v-if="candidate.late">来自旧任务版本，仅保留追溯。</p>
          <button :disabled="candidate.late" @click="emit('bind', candidate.record)">
            审看并绑定用途
          </button>
        </article>
      </div>
      <form v-if="showReturn && bundle" @submit.prevent="deliver">
        <h3>实际图片回填</h3>
        <label>交付 ID<input v-model="deliveryId" required /></label
        ><label v-for="view in bundle.task.views" :key="view.id"
          >{{ view.label || view.id
          }}<input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            required
            @change="
              selectedFiles[view.id] = ($event.target as HTMLInputElement).files![0]
            " /></label
        ><button class="primary" :disabled="busy">上传到此任务版本</button>
      </form>
      <details v-if="bundle">
        <summary>完整交接指令</summary>
        <pre>{{ instructions }}</pre>
      </details>
    </section>
  </div>
</template>
<style scoped>
.handoff-overview {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 265px;
  gap: 30px;
}
.handoff-overview h3 {
  font-size: 13px;
  color: #676b84;
}
.handoff-overview p {
  font-size: 12px;
  color: #7f839b;
}
.handoff-prompt {
  white-space: pre-wrap;
  max-height: 340px;
  overflow: auto;
}
.handoff-overview aside {
  background: #f6f5fb;
  padding: 20px;
  border-radius: 9px;
}
.handoff-overview aside > button {
  display: block;
  width: 100%;
  margin: 10px 0;
  font-size: 11px;
}
.handoff-overview aside > p {
  font-size: 11px;
}
.handoff-candidates {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
  gap: 18px;
  margin-top: 24px;
}
.handoff-candidates img {
  width: 100%;
  height: 230px;
  object-fit: contain;
  background: #f4f5fa;
  border-radius: 7px;
}
.handoff-candidates h3 {
  font-size: 12px;
  margin-top: 10px;
}
.handoff-candidates p {
  font-size: 11px;
  color: #9a7244;
}
.handoff-panel > form {
  border-top: 1px solid var(--line);
  padding-top: 20px;
  margin-top: 20px;
}
@media (max-width: 750px) {
  .handoff-overview {
    grid-template-columns: 1fr;
    gap: 15px;
  }
  .handoff-candidates {
    grid-template-columns: 1fr;
  }
  .handoff-overview aside {
    padding: 15px;
  }
  .handoff-prompt {
    max-height: 220px;
  }
}
</style>
