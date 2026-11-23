<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { api, serviceOffline } from './api';
import { modelKinds, type ModelKind } from '../shared/model-catalog';
import { protocolLabels, type ModelProtocol } from '../shared/models';
import ModelConnectionEditor from './ModelConnectionEditor.vue';
const emit = defineEmits(['changed']);
const catalog = ref<any>({ offers: [], models: [] }),
  connections = ref<any[]>([]),
  legacy = ref<any>(null);
const tab = ref<ModelKind>('video'),
  area = ref('models'),
  wizard = ref(false),
  family = ref(''),
  protocol = ref(''),
  connectionId = ref('');
const draft = ref<any>(null),
  error = ref(''),
  notice = ref(''),
  busy = ref(false);
const offers = computed(() => catalog.value.offers.filter((o: any) => o.kind === tab.value));
const families = computed(() => [
  ...new Map<string, any>(offers.value.map((o: any) => [o.family, o])).values(),
]);
const protocols = computed(() => offers.value.filter((o: any) => o.family === family.value));
const compatible = computed(() =>
  connections.value.filter((c) => c.data.protocol === protocol.value),
);
const models = computed(() => catalog.value.models.filter((m: any) => m.kind === tab.value));
async function load() {
  try {
    const [c, d] = await Promise.all([api('/model-catalog'), api('/model-connections')]);
    catalog.value = c;
    connections.value = d.connections;
    legacy.value = d.legacyComfy;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
function begin() {
  wizard.value = true;
  family.value = families.value[0]?.family || '';
  chooseFamily();
}
function chooseFamily() {
  protocol.value = protocols.value[0]?.protocol || '';
  connectionId.value = '';
}
function configure() {
  const offer = offers.value.find((o: any) => o.protocol === protocol.value);
  if (!offer) return;
  const c = connections.value.find((c) => c.id === connectionId.value);
  const model = {
    id: offer.modelId,
    name: offer.modelId || offer.name,
    preset: offer.preset,
    enabled: false,
  };
  if (c) {
    if (offer.modelId && c.data.models.some((m: any) => m.id === offer.modelId)) {
      error.value = '此连接已登记该模型，请编辑现有条目。';
      return;
    }
    const data = JSON.parse(JSON.stringify(c.data));
    data.models.push(model);
    draft.value = { id: c.id, revision: c.revision, data };
  } else {
    const instanceId =
      offer.protocol === 'comfy-h3' ? legacy.value?.instanceId || crypto.randomUUID() : undefined;
    draft.value = {
      revision: 0,
      data: {
        name: offer.name,
        protocol: offer.protocol,
        baseUrl: instanceId ? legacy.value?.baseUrl || offer.baseUrl : offer.baseUrl,
        credential: null,
        enabled: false,
        compatible: false,
        concurrency: 1,
        capacityGroup: instanceId ? 'comfy:' + instanceId : 'connection:' + crypto.randomUUID(),
        ...(instanceId ? { instanceId } : {}),
        models: [model],
      },
    };
  }
  wizard.value = false;
}
function edit(c: any) {
  draft.value = { id: c.id, revision: c.revision, data: JSON.parse(JSON.stringify(c.data)) };
}
async function toggle(c: any, modelId?: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const data = JSON.parse(JSON.stringify(c.data));
    if (modelId) {
      const m = data.models.find((m: any) => m.id === modelId);
      m.enabled = m.enabled === false;
    } else data.enabled = !data.enabled;
    await api('/model-connections/' + c.id, 'PUT', {
      revision: c.revision,
      data,
      idempotencyKey: crypto.randomUUID(),
    });
    await load();
    emit('changed');
    notice.value = '已发布新版本；项目和任务仍固定原选择。';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function probe(c: any) {
  if (busy.value) return;
  busy.value = true;
  try {
    const r = await api('/model-connections/' + c.id + '/probe', 'POST', { revision: c.revision });
    notice.value = r.message || '只读检查完成，未生成媒体';
    await load();
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function saved() {
  draft.value = null;
  await load();
  emit('changed');
  notice.value = '模型与连接已保存，请在项目内选择固定版本。';
}
onMounted(load);
watch(serviceOffline, (offline, wasOffline) => {
  if (!offline && wasOffline) void load();
});
</script>
<template>
  <section class="panel model-library">
    <div class="toolbar">
      <h2>模型与连接</h2>
      <button @click="area = 'models'" :class="{ active: area === 'models' }">模型库</button
      ><button @click="area = 'connections'" :class="{ active: area === 'connections' }">
        连接管理
      </button>
    </div>
    <p>模型按用途选择，画风在作品呈现方向中设置。配置与检查连接不会生成媒体。</p>
    <p v-if="error && !serviceOffline" class="error" role="alert">
      {{ error }} <button @click="load">重新连接</button>
    </p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <template v-if="area === 'models'">
      <div class="toolbar" role="tablist" aria-label="模型类型">
        <button
          v-for="(name, kind) in modelKinds"
          :key="kind"
          role="tab"
          :aria-selected="tab === kind"
          :class="{ active: tab === kind }"
          @click="
            tab = kind;
            wizard = false;
          "
        >
          {{ name }} · {{ catalog.models.filter((m: any) => m.kind === kind).length }}
        </button>
        <button class="primary" @click="begin">新建模型</button>
      </div>
      <form v-if="wizard" class="model-card" @submit.prevent="configure">
        <h3>新建{{ modelKinds[tab] }}</h3>
        <label
          >模型类型<select v-model="tab" @change="begin">
            <option v-for="(name, kind) in modelKinds" :value="kind">{{ name }}</option>
          </select></label
        >
        <label
          >模型家族<select v-model="family" @change="chooseFamily">
            <option v-for="f in families" :value="f.family">{{ f.name }}</option>
          </select></label
        >
        <label
          >接入方式<select v-model="protocol" @change="connectionId = ''">
            <option v-for="p in protocols" :value="p.protocol">
              {{ protocolLabels[p.protocol as ModelProtocol] }}
            </option>
          </select></label
        >
        <label
          >连接<select v-model="connectionId">
            <option value="">新建连接</option>
            <option v-for="c in compatible" :value="c.id">{{ c.data.name }}</option>
          </select></label
        >
        <p>只列出已实现的适配能力。下一步填写账号可用的准确型号或部署 ID。</p>
        <button>下一步：模型与凭据</button>
      </form>
      <p v-if="!models.length && !wizard">
        尚未配置{{ modelKinds[tab] }}。从“新建模型”选择家族与接入方式。
      </p>
      <div class="model-grid">
        <article v-for="m in models" :key="m.connection.id + m.id" class="model-card">
          <span class="status-tag">{{ m.familyName }}</span>
          <h3>{{ m.name }}</h3>
          <code>{{ m.id }}</code>
          <p>
            {{ protocolLabels[m.protocol as ModelProtocol] }} · {{ m.connection.name }} v{{
              m.connection.revision
            }}
          </p>
          <p>
            {{ m.capabilities.modes.join(' / ') }} ·
            {{ m.available ? '可选择' : m.enabled ? '连接未启用' : '模型未启用' }}
          </p>
          <details>
            <summary>Prompt 方案与能力依据</summary>
            <p v-for="p in m.promptProfiles" :key="p.id">
              {{ p.id }} · {{ p.modes.join(' / ') }}<br />{{ p.sections.join(' → ') }}
            </p>
            <p>能力按适配方案声明；{{ m.probe?.status || '尚未检查连接' }}。</p>
            <p>
              本版本请求 {{ m.executionEvidence.attempts }} 次，完成
              {{ m.executionEvidence.completed }} 次；作品质量另行审核。
            </p>
          </details>
          <div class="toolbar">
            <button @click="edit(connections.find((c) => c.id === m.connection.id))">编辑</button
            ><button
              :disabled="busy"
              @click="
                toggle(
                  connections.find((c) => c.id === m.connection.id),
                  m.id,
                )
              "
            >
              {{ m.enabled ? '停用模型' : '启用模型' }}
            </button>
          </div>
        </article>
      </div>
    </template>
    <div v-else class="model-grid">
      <article v-for="c in connections" :key="c.id" class="model-card">
        <h3>{{ c.data.name }}</h3>
        <p>{{ protocolLabels[c.data.protocol as ModelProtocol] }} · v{{ c.revision }}</p>
        <p>{{ c.data.enabled ? '已启用' : '已停用' }} · {{ c.data.models.length }} 个模型</p>
        <div class="toolbar">
          <button @click="edit(c)">编辑连接</button
          ><button :disabled="busy" @click="probe(c)">检查连接</button
          ><button :disabled="busy" @click="toggle(c)">
            {{ c.data.enabled ? '停用连接' : '启用连接' }}
          </button>
        </div>
      </article>
    </div>
    <details v-if="draft" open>
      <summary>保存前核对：能力与 Prompt 方案</summary>
      <template
        v-for="offer in catalog.offers.filter((o: any) => o.protocol === draft.data.protocol)"
        ><p>{{ offer.name }} · {{ offer.capabilities.modes.join(' / ') }}</p>
        <p v-for="p in offer.promptProfiles">{{ p.id }} · {{ p.sections.join(' → ') }}</p></template
      >
      <p>文字中的运动要求不等于运动条件输入；实际模式与素材用途在制作预览中再次核对。</p>
    </details>
    <ModelConnectionEditor
      v-if="draft"
      :key="(draft.id || draft.data.protocol) + ':' + draft.revision"
      :initial="draft"
      @saved="saved"
      @close="draft = null"
    />
  </section>
</template>
<style scoped>
.toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin: 12px 0;
}
.toolbar h2 {
  margin-right: auto;
}
.active {
  color: var(--primary, #5346e5);
  border-color: currentColor;
}
.model-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 12px;
  margin-top: 16px;
}
.model-card {
  border: 1px solid var(--border, #ddd);
  border-radius: 12px;
  padding: 18px;
  background: var(--surface, #fff);
  min-width: 0;
}
code {
  overflow-wrap: anywhere;
}
.model-card label {
  display: block;
  margin: 12px 0;
}
.model-card select {
  width: 100%;
}
</style>
