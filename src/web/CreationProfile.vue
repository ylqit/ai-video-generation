<script setup lang="ts">
import { ref, watch, computed } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { creationPresets } from '../shared/workbench';
import { api, downloadJson } from './api';
import CreativeModules from './CreativeModules.vue';
import { useDraft } from './drafts';
const props = defineProps<{ projectId: string; projectMode?: string; documents: RecordDoc[] }>();
const emit = defineEmits(['refresh']);
const selectedId = ref('');
const profiles = computed(() =>
  props.documents.filter((d) => d.kind === 'creation_profile' && !d.data.archived),
);
const current = computed(
  () =>
    profiles.value.find((d) => d.id === selectedId.value) ||
    (profiles.value.length === 1 && !selectedId.value ? profiles.value[0] : undefined),
);
const draft = ref<any>({}),
  revision = ref(0),
  error = ref('');
watch(
  [() => props.projectId, () => current.value?.id],
  () => {
    draft.value = JSON.parse(JSON.stringify(current.value?.data || newProfile(creationPresets[3])));
    revision.value = current.value?.revision || 0;
  },
  { immediate: true },
);
const brief = ref<any>(null);
watch(
  draft,
  () => {
    brief.value = null;
  },
  { deep: true },
);
function newProfile(preset: any) {
  return {
    ...preset,
    rulesVersion: props.projectMode === 'series' ? 'director-v7' : 'director-v6',
    targetSeconds: undefined,
    composition: {
      moduleRefs: [],
      overrides: { visual: '', world: '', narrative: '', direction: '', mixedMedia: '' },
      exceptions: [],
      artBible: { characters: '', environments: '', props: '', effects: '' },
      artEntries: [],
    },
  };
}
async function previewBrief() {
  try {
    if (!current.value || JSON.stringify(draft.value) !== JSON.stringify(current.value.data))
      throw new Error('先保存配置草稿，再预览固定版本');
    brief.value = await api(`/projects/${props.projectId}/creative-brief/preview`, 'POST', {
      profile: { id: current.value.id, revision: current.value.revision },
    });
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function approveBrief() {
  const owner = `${props.projectId}:${selectedId.value}`;
  try {
    if (!brief.value || brief.value.profile.revision !== current.value?.revision)
      throw new Error('请先预览当前版本');
    const published = await api(`/domain/${current.value!.id}/publish`, 'POST', {
      revision: current.value!.revision,
      review: { inspected: true, conclusion: '用户审核组合规则与美术规范；模型效果另行验证' },
    });
    emit('refresh');
    if (owner !== `${props.projectId}:${selectedId.value}`) return;
    await local.discard();
    if (owner !== `${props.projectId}:${selectedId.value}`) return;
    draft.value = structuredClone(published.data);
    revision.value = published.revision;
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
const local = useDraft(
  () => `profile:${props.projectId}:${current.value?.id || selectedId.value || 'new'}`,
  () => revision.value,
  draft,
);
function choosePreset(preset: any) {
  draft.value = newProfile(preset);
}
async function save() {
  const owner = `${props.projectId}:${selectedId.value}`;
  try {
    if ((current.value?.revision || 0) !== revision.value)
      throw new Error('配置已有新版本。当前编辑仍基于旧版本，请先导出草稿，再重新打开比较。');
    const d = await api(`/projects/${props.projectId}/creation-profile`, 'POST', {
      id: current.value?.id,
      revision: revision.value || undefined,
      data: draft.value,
    });
    emit('refresh');
    if (owner !== `${props.projectId}:${selectedId.value}`) return;
    await local.discard();
    if (owner !== `${props.projectId}:${selectedId.value}`) return;
    selectedId.value = d.id;
    draft.value = structuredClone(d.data);
    revision.value = d.revision;
    emit('refresh');
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function publish() {
  try {
    if (!current.value || JSON.stringify(draft.value) !== JSON.stringify(current.value.data))
      throw new Error('先保存配置，再发布库版本');
    await api(`/projects/${props.projectId}/library`, 'POST', {
      name: draft.value.name,
      references: [{ id: current.value.id, revision: current.value.revision }],
    });
    error.value = '已发布到模板库';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <article class="panel">
    <h3>制作配置</h3>
    <label
      >编辑配置<select v-model="selectedId">
        <option value="new">新建独立配置</option>
        <option v-for="p in profiles" :value="p.id">{{ p.data.name }} · v{{ p.revision }}</option>
      </select></label
    >

    <div class="actions">
      <button v-for="preset in creationPresets" @click="choosePreset(preset)">
        {{ preset.name }}
      </button>
    </div>
    <p>制作方法与稳定美术规范按项目需要配置；本次镜头动作在导演计划中编辑。</p>
    <CreativeModules
      v-if="draft.composition"
      :project-id="projectId"
      :documents="documents"
      :composition="draft.composition"
      @refresh="emit('refresh')"
    />
    <p v-if="local.message.value">{{ local.message.value }}</p>
    <div v-if="local.conflict.value">
      <button @click="downloadJson('配置旧草稿.json', local.conflict.value)">导出旧草稿</button
      ><button @click="local.discard()">清除冲突草稿</button>
    </div>
    <p class="error" v-if="error">{{ error }}</p>
    <p class="warning" v-if="(current?.revision || 0) !== revision">
      服务端已有新版本，保存会阻止覆盖。请导出当前草稿后重新打开。
    </p>
    <button @click="downloadJson('创作配置草稿.json', draft)">导出当前草稿</button>
    <div class="form-grid">
      <label>配置名称<input v-model="draft.name" /></label
      ><label
        >目标时长（秒，可选制作约束）<input
          type="number"
          min="1"
          :value="draft.targetSeconds"
          @input="
            draft.targetSeconds = ($event.target as HTMLInputElement).value
              ? Number(($event.target as HTMLInputElement).value)
              : undefined
          " /></label
      ><label>内容目标<textarea v-model="draft.goal"></textarea></label
      ><label>面向受众<input v-model="draft.audience" /></label
      ><label v-if="!draft.composition">视觉要求<textarea v-model="draft.visual"></textarea></label
      ><label v-if="!draft.composition">摄影要求<textarea v-model="draft.camera"></textarea></label
      ><label v-if="!draft.composition">节奏<textarea v-model="draft.pacing"></textarea></label
      ><label>声音要求<textarea v-model="draft.sound"></textarea></label
      ><label>宽度<input type="number" step="32" v-model.number="draft.width" /></label
      ><label>高度<input type="number" step="32" v-model.number="draft.height" /></label
      ><label>采样步数<input type="number" min="1" max="50" v-model.number="draft.steps" /></label
      ><label>参考策略<textarea v-model="draft.referenceStrategy"></textarea></label
      ><label
        >审核提醒（每行一条）<textarea
          :value="draft.reviewReminders?.join('\n')"
          @input="
            draft.reviewReminders = ($event.target as HTMLTextAreaElement).value
              .split('\n')
              .filter(Boolean)
          "
        ></textarea>
      </label>
    </div>
    <button class="primary" :disabled="!!local.conflict.value" @click="save">保存配置版本</button
    ><button @click="publish">发布到模板库</button>
    <template v-if="draft.composition"
      ><button @click="previewBrief">组合预览</button
      ><button :disabled="!brief" @click="approveBrief">审核并发布制作规范</button>
      <div v-if="brief">
        <p v-for="c in brief.checks" class="warning">{{ c.code }}：{{ c.message }}</p>
        <p>摘要 {{ brief.digest }}</p>
        <p v-for="m in brief.modules">
          {{ m.data.category }}：{{ m.data.name }} · {{ m.ref.revision }}
        </p>
        <p v-for="d in brief.decisions">{{ d.field }}：{{ d.reason }}</p>
      </div>
    </template>
  </article>
</template>
