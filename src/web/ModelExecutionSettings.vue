<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, serviceOffline } from './api';
import { modelAllowanceSchema, type ExecutionSelection } from '../shared/models';
const props = defineProps<{ projectId: string; initialOwnerId?: string; refreshKey?: number }>();
const emit = defineEmits(['changed']);
const ownerId = ref(''),
  owners = ref<any[]>([]),
  groups = ref<any[]>([]),
  connections = ref<any[]>([]),
  profiles = ref<any[]>([]);
const revision = ref(0),
  slots = ref<Record<string, ExecutionSelection>>({}),
  allowance = ref(modelAllowanceSchema.parse({})),
  usage = ref<any>({});
const error = ref(''),
  notice = ref(''),
  busy = ref(false),
  slot = ref('video'),
  modelKey = ref('');
let ticket = 0;
const choices = computed(() =>
  connections.value.flatMap((c) =>
    c.models.map((m: any) => ({
      key: `${c.id}:${c.revision}:${m.id}`,
      connection: c,
      model: m,
      capabilities: m.capabilities,
    })),
  ),
);
const slotOptions = computed(() => [
  { id: 'text', name: '文字创作默认' },
  { id: 'text:discussion', name: '讨论' },
  { id: 'text:assistant', name: '有界制作助手' },
  { id: 'text:brief', name: '总体构思' },
  { id: 'text:direction', name: '制作方向' },
  { id: 'text:assets', name: '素材规划' },
  { id: 'text:script', name: '剧本' },
  { id: 'text:director', name: '导演' },
  { id: 'image', name: '图片生成／编辑' },
  { id: 'video', name: '视频默认' },
  { id: 'speech', name: '语音合成默认' },
  { id: 'lipsync', name: '独立口型默认' },
  ...groups.value.map((g) => ({ id: 'video:' + g.id, name: '生成组 · ' + (g.title || g.id) })),
]);
const available = computed(() =>
  choices.value.filter(
    (c) =>
      slot.value.startsWith(
        c.connection.data.protocol === 'sync-lipsync' ? 'lipsync' : c.capabilities.kind,
      ) &&
      c.connection.currentlyEnabled &&
      c.model.enabled !== false,
  ),
);
function choice(selection: ExecutionSelection) {
  return choices.value.find(
    (c) =>
      c.key === `${selection.connection.id}:${selection.connection.revision}:${selection.modelId}`,
  );
}
async function load(preserveDraft = false) {
  const own = ownerId.value,
    project = props.projectId,
    current = ++ticket;
  error.value = '';
  try {
    const [data, catalog] = await Promise.all([
      api(`/projects/${project}/model-config?ownerId=${own}`),
      api('/model-connections'),
    ]);
    const all = [...catalog.connections];
    for (const connection of data.pinnedConnections) {
      if (!all.some((c) => c.id === connection.id && c.revision === connection.revision))
        all.push(await api(`/model-connections/${connection.id}/versions/${connection.revision}`));
    }
    if (current !== ticket || project !== props.projectId || own !== ownerId.value) return;
    owners.value = data.owners;
    groups.value = data.segments;
    connections.value = all;
    profiles.value = catalog.promptProfiles;
    if (!preserveDraft) {
      revision.value = data.config?.revision || 0;
      slots.value = data.config?.data.slots || {};
      allowance.value = modelAllowanceSchema.parse(data.config?.data.allowance || {});
    }
    usage.value = data.usage;
    modelKey.value = '';
  } catch (e: any) {
    if (current === ticket) error.value = e.message;
  }
}
watch(
  () => [props.projectId, props.initialOwnerId],
  () => {
    ownerId.value = props.initialOwnerId || props.projectId;
  },
  { immediate: true },
);
watch(ownerId, () => load(), { immediate: true });
watch(
  () => props.refreshKey,
  () => load(true),
);
function add() {
  const selected = available.value.find((c) => c.key === modelKey.value);
  if (!selected) return;
  slots.value[slot.value] = {
    connection: { id: selected.connection.id, revision: selected.connection.revision },
    modelId: selected.model.id,
    mode: 'authored',
    promptProfile: 'automatic',
    parameters: {},
  };
}
function permit(c: any, checked: boolean) {
  allowance.value.connections = allowance.value.connections.filter(
    (r) => r.id !== c.id || r.revision !== c.revision,
  );
  if (checked) allowance.value.connections.push({ id: c.id, revision: c.revision });
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  const own = ownerId.value,
    project = props.projectId;
  try {
    const cleanSlots = JSON.parse(JSON.stringify(slots.value));
    for (const s of Object.values(cleanSlots) as ExecutionSelection[])
      for (const [key, value] of Object.entries(s.parameters))
        if (value === '') delete (s.parameters as any)[key];
    const data = {
      version: 1,
      slots: cleanSlots,
      ...(own === project ? { allowance: allowance.value } : {}),
    };
    const result = await api(`/projects/${project}/model-config?ownerId=${own}`, 'PUT', {
      revision: revision.value,
      data,
    });
    if (own === ownerId.value && project === props.projectId) {
      revision.value = result.revision;
      notice.value = '执行选择已固定。现有任务保持原输入；新任务需重新预览。';
    }
    emit('changed');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="model-selection">
    <h3>制作使用的模型</h3>
    <p>项目默认 → 系列覆盖 → 分集及生成组覆盖。未设置的用途继续继承；已有任务固定原版本。</p>
    <p v-if="error && !serviceOffline" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <label
      >设置范围<select v-model="ownerId" :disabled="busy">
        <option v-for="o in owners" :key="o.id" :value="o.id">
          {{ o.kind }} · {{ o.name || o.id }}
        </option>
      </select></label
    >
    <form @submit.prevent="save">
      <div class="form-row">
        <label
          >用途<select v-model="slot" @change="modelKey = ''">
            <option v-for="s in slotOptions" :value="s.id">{{ s.name }}</option>
          </select></label
        >
        <label
          >模型及连接版本<select v-model="modelKey">
            <option value="">选择已启用模型</option>
            <option v-for="c in available" :key="c.key" :value="c.key">
              {{ c.model.name }} · {{ c.connection.data.name }} v{{ c.connection.revision }}
            </option>
          </select></label
        ><button type="button" :disabled="!modelKey" @click="add">应用到此用途</button>
      </div>
      <article v-for="(selected, key) in slots" :key="key">
        <strong
          >{{ slotOptions.find((s) => s.id === key)?.name || key }} · {{ selected.modelId }}</strong
        >
        <p>
          {{ choice(selected)?.connection.data.name || selected.connection.id }} · 固定 v{{
            selected.connection.revision
          }}
        </p>
        <button type="button" @click="delete slots[key]">移除此覆盖，恢复继承</button>
        <template v-if="choice(selected)?.capabilities.kind === 'video'">
          <label
            >生成模式<select v-model="selected.mode">
              <option value="authored">依据已审核分镜的模式</option>
              <option v-for="m in choice(selected)?.capabilities.modes" :value="m">{{ m }}</option>
            </select></label
          >
          <label
            >Prompt 方案<select v-model="selected.promptProfile">
              <option value="automatic">匹配模式并在预览中固定版本</option>
              <option
                v-for="p in profiles.filter((p) => p.family === choice(selected)?.model.preset)"
                :value="p.id"
              >
                {{ p.id }}
              </option>
            </select></label
          >
          <p>显式模式须与已采用参考用途一致；切换时重新预检，不自动改写动作或删除参考。</p>
        </template>
        <div class="form-row">
          <template v-if="choice(selected)?.connection.data.protocol === 'comfy-h3'"
            ><label
              >宽<input
                v-model.number="selected.parameters.width"
                type="number"
                min="128"
                max="1344"
                step="32" /></label
            ><label
              >高<input
                v-model.number="selected.parameters.height"
                type="number"
                min="128"
                max="1344"
                step="32" /></label
            ><label
              >步数<input
                v-model.number="selected.parameters.steps"
                type="number"
                min="1"
                max="50" /></label
          ></template>
          <label v-if="choice(selected)?.capabilities.resolutions"
            >分辨率<select v-model="selected.parameters.resolution">
              <option :value="undefined">适配器默认</option>
              <option v-for="v in choice(selected)?.capabilities.resolutions">{{ v }}</option>
            </select></label
          >
          <label v-if="choice(selected)?.capabilities.ratios"
            >画面比例<select v-model="selected.parameters.ratio">
              <option :value="undefined">适配器默认</option>
              <option v-for="v in choice(selected)?.capabilities.ratios">{{ v }}</option>
            </select></label
          >
          <label
            v-if="
              choice(selected)?.capabilities.kind === 'text' &&
              choice(selected)?.connection.data.protocol !== 'codex'
            "
            >最大输出 token<input
              v-model.number="selected.parameters.maxOutputTokens"
              type="number"
              min="1"
              max="100000"
          /></label>
          <template v-if="choice(selected)?.capabilities.kind === 'image'"
            ><label
              >尺寸<select v-model="selected.parameters.size">
                <option :value="undefined">默认 1024×1024</option>
                <option v-for="v in choice(selected)?.capabilities.sizes">{{ v }}</option>
              </select></label
            ><label
              >质量<select v-model="selected.parameters.quality">
                <option :value="undefined">自动</option>
                <option v-for="v in choice(selected)?.capabilities.qualities">{{ v }}</option>
              </select></label
            ><label
              >候选张数<input
                v-model.number="selected.parameters.n"
                type="number"
                min="1"
                max="4" /></label
          ></template>
        </div>
      </article>
      <fieldset v-if="ownerId === projectId">
        <legend>此项目允许执行的连接与累计额度</legend>
        <label><input type="checkbox" v-model="allowance.enabled" />启用明确额度内的模型请求</label>
        <label v-for="c in connections" :key="`${c.id}:${c.revision}`"
          ><input
            type="checkbox"
            :checked="allowance.connections.some((r) => r.id === c.id && r.revision === c.revision)"
            @change="permit(c, ($event.target as HTMLInputElement).checked)"
          />{{ c.data.name }} v{{ c.revision }}</label
        >
        <div class="form-row">
          <label
            >文字请求<input
              v-model.number="allowance.maxTextRequests"
              type="number"
              min="0" /></label
          ><label
            >图片请求<input
              v-model.number="allowance.maxImageRequests"
              type="number"
              min="0" /></label
          ><label
            >图片总张数<input v-model.number="allowance.maxImages" type="number" min="0" /></label
          ><label
            >视频请求<input
              v-model.number="allowance.maxVideoRequests"
              type="number"
              min="0" /></label
          ><label
            >视频请求秒数<input v-model.number="allowance.maxVideoSeconds" type="number" min="0"
          /></label>
        </div>
        <p>
          已记录：文字 {{ usage.textRequests || 0 }} 次，图片 {{ usage.imageRequests || 0 }} 次 /
          {{ usage.images || 0 }} 张，视频 {{ usage.videoRequests || 0 }} 次 /
          {{ usage.videoSeconds || 0 }} 秒。受理不明与失败不自动返还；此处不代表费用账单。
        </p>
      </fieldset>
      <button class="primary" :disabled="busy">保存固定选择与额度</button
      ><button type="button" :disabled="busy" @click="load()">重新读取</button>
    </form>
  </section>
</template>
<style scoped>
.model-selection {
  padding: 1rem;
  border: 1px solid var(--border, #d9d9df);
  border-radius: 8px;
}
article,
fieldset {
  margin: 1rem 0;
  padding: 0.8rem;
  border: 1px solid var(--border, #d9d9df);
}
label {
  display: block;
  margin: 0.5rem 0;
}
select {
  max-width: 100%;
}
.form-row {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}
input[type='number'] {
  width: 110px;
}
</style>
