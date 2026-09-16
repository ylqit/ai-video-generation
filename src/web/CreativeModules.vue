<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { moduleCategories } from '../shared/creative-modules';
import type { RecordDoc } from '../shared/contracts';
import { api } from './api';
import { useDraft } from './drafts';
import RecordPicker from './RecordPicker.vue';
const crypto = globalThis.crypto;
const props = defineProps<{ projectId: string; documents: RecordDoc[]; composition: any }>();
const emit = defineEmits(['refresh']);
const catalog = ref<any[]>([]),
  error = ref(''),
  edit = ref<any>(null),
  editing = ref<RecordDoc | null>(null);
const modules = computed(() =>
  props.documents.filter((d) => d.kind === 'creative_module' && !d.data.archived),
);
const local = useDraft(
  () => `module:${props.projectId}:${editing.value?.id || 'new'}`,
  () => editing.value?.revision || 0,
  edit,
);
const labels: Record<string, string> = {
  visual: '视觉风格',
  world: '故事世界',
  narrative: '叙事方法',
  direction: '导演表现',
};
onMounted(async () => {
  try {
    catalog.value = await api('/creative-modules');
  } catch (e: any) {
    error.value = e.message;
  }
});
watch(
  () => props.projectId,
  () => {
    edit.value = null;
    editing.value = null;
    error.value = '';
  },
);
async function importModule(m: any) {
  try {
    await api(`/projects/${props.projectId}/creative-modules/import`, 'POST', {
      key: m.key,
      catalogVersion: m.catalogVersion,
    });
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
function choose(m: RecordDoc, checked: boolean) {
  const refs = props.composition.moduleRefs.filter((r: any) => r.id !== m.id);
  if (checked) refs.push({ id: m.id, revision: m.revision });
  props.composition.moduleRefs = refs;
}
function open(m: RecordDoc) {
  editing.value = m;
  edit.value = JSON.parse(JSON.stringify(m.data));
}
async function save() {
  try {
    await api(`/domain/${editing.value!.id}`, 'PUT', {
      revision: editing.value!.revision,
      data: edit.value,
    });
    await local.discard();
    edit.value = null;
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
async function publish(m: RecordDoc) {
  try {
    await api(`/domain/${m.id}/publish`, 'POST', {
      revision: m.revision,
      review: { inspected: true, conclusion: '用户通过模块规则表单审核；视频表现仍待实际验证' },
    });
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  }
}
const split = (value: string) =>
  value
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
</script>
<template>
  <section>
    <h3>可组合创作模块</h3>
    <p>
      内置方法复制到项目后独立编辑。先审核模块，再选择固定版本保存制作规范；升级不会替换旧任务。
    </p>
    <p class="error" v-if="error">{{ error }}</p>
    <article v-for="category in moduleCategories" class="panel">
      <h4>{{ labels[category] }}</h4>
      <div class="actions">
        <button
          v-for="m in catalog.filter((m) => m.data.category === category)"
          @click="importModule(m)"
        >
          复制 {{ m.data.name }}
        </button>
      </div>
      <div v-for="m in modules.filter((m) => m.data.category === category)">
        <label
          ><input
            type="checkbox"
            :checked="composition.moduleRefs.some((r: any) => r.id === m.id)"
            @change="choose(m, ($event.target as HTMLInputElement).checked)"
          />{{ m.data.name }} · 最新 v{{ m.revision }} ·
          {{ m.data.published ? '已发布' : '待审核' }}</label
        >
        <span v-if="composition.moduleRefs.some((r: any) => r.id === m.id)">
          本配置固定 v{{ composition.moduleRefs.find((r: any) => r.id === m.id)?.revision }}
        </span>
        <button
          v-if="composition.moduleRefs.some((r: any) => r.id === m.id && r.revision !== m.revision)"
          @click="choose(m, true)"
        >
          改用最新版本（需重新预览）
        </button>
        <button @click="open(m)">编辑规则</button
        ><button :disabled="m.data.published" @click="publish(m)">审核并发布</button>
      </div>
    </article>
    <div class="panel" v-if="edit">
      <h4>项目模块版本：{{ edit.name }}</h4>
      <p>{{ local.message.value }}</p>
      <p v-if="local.conflict.value" class="error">服务端版本变化，请重新打开模块并处理旧草稿。</p>
      <label>名称<input v-model="edit.name" /></label
      ><label>职责<textarea v-model="edit.responsibility"></textarea></label
      ><label>范围<textarea v-model="edit.scope"></textarea></label>
      <div class="form-grid">
        <label v-for="(_v, key) in edit.spec"
          >{{ key }}
          <textarea
            v-if="Array.isArray(edit.spec[key])"
            :value="edit.spec[key].join('\n')"
            @input="edit.spec[key] = split(($event.target as HTMLTextAreaElement).value)"
          ></textarea>
          <select v-else-if="key === 'representation'" v-model="edit.spec[key]">
            <option
              v-for="v in [
                'anime_2d',
                'hand_drawn',
                'stylized_3d',
                'realistic_cg',
                'live_action',
                'mixed',
                'custom',
              ]"
            >
              {{ v }}
            </option>
          </select>
          <textarea v-else v-model="edit.spec[key]"></textarea>
        </label>
      </div>
      <label v-for="(_v, stage) in edit.stageRules"
        >{{ stage }} 阶段规则（每行一条）<textarea
          :value="edit.stageRules[stage].join('\n')"
          @input="edit.stageRules[stage] = split(($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </label>
      <label v-for="key in ['references', 'checks', 'limitations']"
        >{{ key }}（每行一条）<textarea
          :value="edit[key].join('\n')"
          @input="edit[key] = split(($event.target as HTMLTextAreaElement).value)"
        ></textarea>
      </label>
      <div v-for="example in edit.examples">
        <label>正例<textarea v-model="example.good"></textarea></label
        ><label>反例<textarea v-model="example.bad"></textarea></label
        ><label>原因<textarea v-model="example.reason"></textarea></label>
      </div>
      <details>
        <summary>来源和许可</summary>
        <p v-for="source in edit.sources">
          {{ source.title }} · {{ source.location }} · {{ source.license }} · {{ source.note }}
        </p>
      </details>
      <button :disabled="!!local.conflict.value" @click="save">保存待审核新版本</button
      ><button @click="edit = null">关闭</button>
    </div>
    <div class="form-grid">
      <label v-for="category in moduleCategories"
        >{{ labels[category] }}项目覆盖<textarea
          v-model="composition.overrides[category]"
        ></textarea>
      </label>
      <label
        >有意混合媒介：说明人物、背景、效果各层及融合方式<textarea
          v-model="composition.overrides.mixedMedia"
        ></textarea>
      </label>
      <label v-for="key in ['characters', 'environments', 'props', 'effects']"
        >{{ composition.artEntries ? '旧美术原文（仅供转换）' : '美术规范' }} {{ key
        }}<textarea v-model="composition.artBible[key]"></textarea>
      </label>
    </div>
    <template v-if="composition.artEntries">
      <h4>当前镜头可选入的稳定美术条目</h4>
      <article class="panel" v-for="(entry, n) in composition.artEntries" :key="entry.id">
        <div class="form-grid">
          <label
            >目标类型<select v-model="entry.target.kind">
              <option v-for="v in ['global', 'instance', 'entity', 'effect']">{{ v }}</option>
            </select></label
          ><label v-if="entry.target.kind !== 'global'"
            >目标 ID<input v-model="entry.target.id" /></label
          ><label
            >方面<select v-model="entry.aspect">
              <option
                v-for="v in [
                  'style',
                  'identity',
                  'appearance',
                  'environment',
                  'material',
                  'effect',
                ]"
              >
                {{ v }}
              </option>
            </select></label
          >
          <label>稳定要求（英文）<textarea v-model="entry.text" /></label
          ><label>分集 ID（可选）<input v-model="entry.scope.episodeId" /></label
          ><label>场景 ID（可选）<input v-model="entry.scope.sceneId" /></label
          ><label
            >镜头 ID（每行一个，空为范围内全部）<textarea
              :value="entry.scope.shotIds.join('\n')"
              @input="entry.scope.shotIds = split(($event.target as HTMLTextAreaElement).value)"
            />
          </label>
        </div>
        <div v-for="(c, k) in entry.when" class="form-grid">
          <label>条件实例<input v-model="c.instanceId" /></label
          ><label>条件属性<input v-model="c.key" /></label
          ><label
            >值类型<select
              :value="typeof c.value"
              @change="
                c.value =
                  ($event.target as HTMLSelectElement).value === 'boolean'
                    ? false
                    : ($event.target as HTMLSelectElement).value === 'number'
                      ? 0
                      : ''
              "
            >
              <option value="boolean">布尔</option>
              <option value="number">数值</option>
              <option value="string">枚举</option>
            </select></label
          ><label
            >值<select v-if="typeof c.value === 'boolean'" v-model="c.value">
              <option :value="false">false</option>
              <option :value="true">true</option></select
            ><input
              v-else-if="typeof c.value === 'number'"
              type="number"
              v-model.number="c.value" /><input v-else v-model="c.value" /></label
          ><button @click="entry.when.splice(k, 1)">移除条件</button>
        </div>
        <button @click="entry.when.push({ instanceId: '', key: '', value: false })">
          增加适用状态条件</button
        ><button @click="composition.artEntries.splice(n, 1)">移除条目</button>
      </article>
      <button
        @click="
          composition.artEntries.push({
            id: crypto.randomUUID(),
            target: { kind: 'global', id: '' },
            aspect: 'style',
            text: '',
            stable: true,
            scope: { shotIds: [] },
            when: [],
          })
        "
      >
        增加稳定美术条目
      </button>
      <h4>审核后的视觉参考规范（可选）</h4>
      <RecordPicker
        :project-id="projectId"
        kind="asset"
        @select="
          (item: any) => {
            if (item)
              composition.visualReference = {
                asset: { id: item.id, revision: item.revision },
                description: '',
                reviewed: false,
              };
          }
        "
      />
      <div v-if="composition.visualReference">
        <p>{{ composition.visualReference.asset }}</p>
        <label
          >从图片采用的视觉规范（英文）<textarea
            v-model="composition.visualReference.description"
          /></label
        ><label
          ><input
            type="checkbox"
            v-model="composition.visualReference.reviewed"
          />已检查图片内容和用途</label
        ><button @click="delete composition.visualReference">移除视觉参考规范</button>
      </div>
    </template>
    <h4>明确范围的例外</h4>
    <div v-for="(e, index) in composition.exceptions" class="panel">
      <label
        >分集<select v-model="e.scope.episodeId">
          <option v-for="ep in documents.filter((d) => d.kind === 'episode')" :value="ep.id">
            {{ ep.data.title }}
          </option>
        </select></label
      >
      <label>场景 ID（留空覆盖本分集）<input v-model="e.scope.sceneId" /></label
      ><label>原因<input v-model="e.reason" /></label>
      <label v-for="key in ['visual', 'world', 'narrative', 'direction', 'mixedMedia']"
        >{{ key }}<textarea v-model="e.overrides[key]"></textarea>
      </label>
      <button @click="composition.exceptions.splice(index, 1)">移除例外</button>
    </div>
    <button
      @click="
        composition.exceptions.push({
          scope: {},
          reason: '',
          overrides: { visual: '', world: '', narrative: '', direction: '', mixedMedia: '' },
        })
      "
    >
      新增分集 / 场景例外
    </button>
  </section>
</template>
