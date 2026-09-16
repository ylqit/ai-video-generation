<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue';
import type { RecordDoc } from '../shared/contracts';
import { viewTypes, type DomainKind } from '../shared/domain';
import { api, assetUrl, downloadJson } from './api';
import RelationEditor from './RelationEditor.vue';
import { useDraft } from './drafts';
const uuid = crypto.randomUUID.bind(crypto);
const props = defineProps<{ projectId: string; documents: RecordDoc[] }>();
const emit = defineEmits(['refresh']);
const kinds: [DomainKind, string][] = [
  ['entity', '主体'],
  ['appearance', '外观方案'],
  ['reference_pack', '参考包'],
  ['asset_task', '图片制作任务'],
];
const kind = ref<DomainKind>('entity'),
  selected = ref<RecordDoc | null>(null),
  draft = ref<any>(null),
  error = ref(''),
  notice = ref(''),
  versionDiff = ref<any>(null),
  invalidJson = ref(false),
  busy = ref(false),
  library = ref<any[]>([]),
  groups = ref<any[]>([]),
  advanced = ref(''),
  inspected = ref(false),
  conclusion = ref(''),
  manifest = ref(''),
  files = ref<File[]>([]),
  libraryPreview = ref<any>(null);
const local = useDraft(
  () => `subject:${props.projectId}:${selected.value?.id || kind.value}`,
  () => selected.value?.revision || 0,
  draft,
);
const deliveryMap = computed(() => {
  try {
    return JSON.parse(manifest.value);
  } catch {
    return null;
  }
});
const deliveryPreviews = ref<{ name: string; url: string }[]>([]);
watch(files, () => {
  for (const p of deliveryPreviews.value) URL.revokeObjectURL(p.url);
  deliveryPreviews.value = files.value.map((f) => ({ name: f.name, url: URL.createObjectURL(f) }));
});
onBeforeUnmount(() => {
  for (const p of deliveryPreviews.value) URL.revokeObjectURL(p.url);
});
function matchDelivery(index: number, file: string) {
  const data = deliveryMap.value;
  data.assets[index].file = file;
  manifest.value = JSON.stringify(data, null, 2);
}
watch(
  draft,
  () => {
    inspected.value = false;
  },
  { deep: true, flush: 'sync' },
);
const records = computed(() => props.documents.filter((d) => d.kind === kind.value));
const entities = computed(() => props.documents.filter((d) => d.kind === 'entity'));
const images = computed(() =>
  props.documents.filter(
    (d) => d.kind === 'asset' && d.data.mediaType === 'image' && d.data.adopted,
  ),
);
const appearances = computed(() =>
  props.documents.filter(
    (d) => d.kind === 'appearance' && d.data.entity.id === draft.value?.entity?.id,
  ),
);
function refOf(d: RecordDoc) {
  return { id: d.id, revision: d.revision };
}
watch(
  () => props.documents,
  () => {
    const target = new URLSearchParams(location.hash.slice(1)).get('target');
    const d = props.documents.find((d) => d.id === target);
    if (d && kinds.some(([k]) => k === d.kind) && selected.value?.id !== d.id) {
      kind.value = d.kind as DomainKind;
      edit(d);
    }
  },
  { immediate: true },
);
async function act(fn: () => Promise<any>) {
  error.value = '';
  notice.value = '';
  busy.value = true;
  try {
    await fn();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
function edit(doc?: RecordDoc) {
  invalidJson.value = false;
  selected.value = doc || null;
  inspected.value = false;
  conclusion.value = '';
  notice.value = '';
  const entity = entities.value[0] ? refOf(entities.value[0]) : null;
  draft.value = doc
    ? JSON.parse(JSON.stringify(doc.data))
    : kind.value === 'entity'
      ? {
          name: '',
          type: 'character',
          subtype: '',
          description: '',
          fixedFeatures: [],
          allowedChanges: [],
          anchors: [],
          instances: [],
        }
      : kind.value === 'appearance'
        ? { name: '', entity, description: '', features: {} }
        : kind.value === 'reference_pack'
          ? { name: '', entity, appearance: null, views: [], relations: [], notes: '' }
          : {
              name: '',
              entity,
              appearance: null,
              references: [],
              requirements: '',
              views: [],
              relations: [],
            };
  advanced.value = JSON.stringify(draft.value, null, 2);
}
function chooseEntity(event: Event) {
  const d = entities.value.find((d) => d.id === (event.target as HTMLSelectElement).value);
  draft.value.entity = d ? refOf(d) : null;
  if ('appearance' in draft.value) draft.value.appearance = null;
}
function chooseAppearance(event: Event) {
  const d = appearances.value.find((d) => d.id === (event.target as HTMLSelectElement).value);
  draft.value.appearance = d ? refOf(d) : null;
}
function addImage(event: Event) {
  const d = images.value.find((d) => d.id === (event.target as HTMLSelectElement).value);
  if (!d) return;
  if (kind.value === 'reference_pack')
    draft.value.views.push({
      id: uuid(),
      asset: refOf(d),
      view: 'front',
      label: d.data.name,
      features: [],
      scope: 'identity',
      inheritBackground: false,
      overviewOnly: false,
    });
  else draft.value.references.push(refOf(d));
  (event.target as HTMLSelectElement).value = '';
}
async function save() {
  if (local.conflict.value) {
    error.value = '存在旧版本本机草稿，请先处理冲突';
    return;
  }
  if (invalidJson.value) {
    error.value = '请先修正 JSON 字段';
    return;
  }
  await act(async () => {
    const doc = selected.value
      ? await api(`/domain/${selected.value.id}`, 'PUT', {
          revision: selected.value.revision,
          data: draft.value,
        })
      : await api(`/projects/${props.projectId}/domain/${kind.value}`, 'POST', {
          data: draft.value,
        });
    await local.discard();
    edit(doc);
    notice.value = '草稿已保存；新版本尚未发布。';
  });
}
async function publish() {
  if (local.conflict.value) {
    error.value = '存在旧版本本机草稿，请先处理冲突';
    return;
  }
  if (!selected.value) return;
  if (invalidJson.value) {
    error.value = '请先修正 JSON 字段';
    return;
  }
  await act(async () => {
    const review = { inspected: inspected.value, conclusion: conclusion.value };
    const saved = await api(`/domain/${selected.value!.id}`, 'PUT', {
      revision: selected.value!.revision,
      data: draft.value,
    });
    selected.value = saved;
    const d = await api(`/domain/${saved.id}/publish`, 'POST', {
      revision: saved.revision,
      review,
    });
    edit(d);
    notice.value = '参考包已发布，固定图片与关系版本。';
  });
}
async function exportTask() {
  await act(async () => {
    if (JSON.stringify(draft.value) !== JSON.stringify(selected.value!.data) || invalidJson.value)
      throw new Error('请先保存当前图片制作要求，再导出固定版本');
    const p = await api(
      `/asset-tasks/${selected.value!.id}/package?revision=${selected.value!.revision}`,
    );
    downloadJson('asset-production-package.json', p);
    p.delivery.deliveryId = crypto.randomUUID();
    manifest.value = JSON.stringify(p.delivery, null, 2);
  });
}
async function delivery() {
  await act(async () => {
    const body = new FormData();
    body.set('manifest', manifest.value);
    files.value.forEach((f) => body.append('files', f));
    const d = await api(`/asset-tasks/${selected.value!.id}/delivery`, 'POST', body);
    edit(d);
    notice.value = '交付已进入素材候选区；请在资产库审核采用后组装参考包。';
  });
}
async function loadLibrary() {
  await act(async () => {
    library.value = await api('/library');
  });
}
async function publishLibrary() {
  await act(async () => {
    await api(`/projects/${props.projectId}/library`, 'POST', {
      references: [refOf(selected.value!)],
      name: draft.value.name,
    });
    library.value = await api('/library');
    notice.value = '已发布独立模板版本。';
  });
}
async function previewLibrary(item: any) {
  await act(async () => {
    libraryPreview.value = {
      item,
      bundle: await api(`/library/${item.id}/versions/${item.revision}`),
    };
  });
}
async function copyLibrary() {
  await act(async () => {
    const p = libraryPreview.value;
    const result = await api(`/projects/${props.projectId}/library/import`, 'POST', {
      id: p.item.id,
      revision: Number(p.item.revision),
    });
    notice.value = `已复制 ${result.documents.length} 条独立记录；图片及参考包需要本项目审核。`;
    libraryPreview.value = null;
  });
}
async function legacy() {
  await act(async () => {
    groups.value = await api(`/projects/${props.projectId}/legacy-asset-groups`);
  });
}
function useGroup(group: any) {
  kind.value = 'entity';
  edit();
  draft.value.name = group.entityId;
  draft.value.description = '从旧图片分组整理，请确认身份与外观，不自动合并不同年龄或服装。';
  notice.value = '主体先保存，再为各外观建立独立方案；旧资产没有被改写。';
}
</script>
<template>
  <section>
    <div class="section-head">
      <div>
        <h2>主体与参考包</h2>
        <p>稳定身份、外观版本、独立视图和图片制作交付</p>
      </div>
      <button @click="edit()">＋ 新建{{ kinds.find((k) => k[0] === kind)?.[1] }}</button>
    </div>
    <div class="actions">
      <button
        v-for="[k, label] in kinds"
        :class="{ primary: kind === k }"
        @click="
          kind = k;
          draft = null;
          selected = null;
        "
      >
        {{ label }}</button
      ><button @click="loadLibrary">模板库</button><button @click="legacy">整理旧资产</button>
    </div>
    <p class="error" role="alert" v-if="error">{{ error }}</p>
    <p>{{ local.message.value }}</p>
    <div v-if="local.conflict.value">
      <button @click="downloadJson('主体旧草稿.json', local.conflict.value)">导出旧草稿</button
      ><button @click="local.discard()">清除冲突草稿</button>
    </div>
    <p class="notice" v-if="notice">{{ notice }}</p>
    <div class="domain-columns">
      <aside class="panel">
        <button class="record-button" v-for="d in records" @click="edit(d)">
          {{ d.data.name }}
          <small
            >v{{ d.revision }} {{ d.data.published ? '已发布' : '草稿' }}
            {{ d.data.stale ? '待复核' : '' }}</small
          >
        </button>
        <p v-if="!records.length">尚未建立记录。</p>
      </aside>
      <article class="panel" v-if="draft">
        <label>名称<input v-model="draft.name" /></label>
        <template v-if="kind === 'entity'">
          <div class="form-grid">
            <label
              >主体类型<select v-model="draft.type">
                <option value="character">角色（人物、动物或幻想角色）</option>
                <option value="object">物体／产品</option>
                <option value="environment">环境</option>
                <option value="style">画风</option>
              </select></label
            ><label
              >自定义细分类<input v-model="draft.subtype" placeholder="例如：动物、陶瓷、实验器材"
            /></label>
          </div>
          <label>稳定身份描述<textarea v-model="draft.description" rows="3" /></label>
          <h4>实例可跟踪属性（项目定义）</h4>
          <div class="form-grid" v-for="(a, n) in draft.attributes || []">
            <label>属性键（英文）<input v-model="a.key" /></label
            ><label>名称<input v-model="a.label" /></label
            ><label
              >类型<select v-model="a.type">
                <option value="boolean">布尔</option>
                <option value="enum">枚举</option>
                <option value="number">数值</option>
              </select></label
            ><label v-if="a.type === 'enum'"
              >枚举值（每行一项）<textarea
                :value="a.values?.join('\n')"
                @input="
                  a.values = ($event.target as HTMLTextAreaElement).value
                    .split('\n')
                    .filter(Boolean)
                "
              /></label
            ><button @click="draft.attributes.splice(n, 1)">移除属性定义</button>
          </div>
          <button @click="(draft.attributes ||= []).push({ key: '', label: '', type: 'boolean' })">
            增加属性定义
          </button>
          <label
            >必须保持的特征（每行一项）<textarea
              :value="draft.fixedFeatures.join('\n')"
              @input="
                draft.fixedFeatures = ($event.target as HTMLTextAreaElement).value
                  .split('\n')
                  .filter(Boolean)
              "
            />
          </label>
          <label
            >允许变化的内容（每行一项）<textarea
              :value="draft.allowedChanges.join('\n')"
              @input="
                draft.allowedChanges = ($event.target as HTMLTextAreaElement).value
                  .split('\n')
                  .filter(Boolean)
              "
            />
          </label>
          <label
            >附着位置（每行一项，使用主体自身左右）<textarea
              :value="draft.anchors.join('\n')"
              @input="
                draft.anchors = ($event.target as HTMLTextAreaElement).value
                  .split('\n')
                  .filter(Boolean)
              "
              placeholder="right_handle&#10;lid_socket"
            />
          </label>
          <p>出场实例：默认创建一个。多个相同产品应分别添加实例。</p>
          <div v-for="(i, n) in draft.instances" class="ref-row">
            <input v-model="i.name" /><code>{{ i.id }}</code
            ><button @click="draft.instances.splice(n, 1)">移除</button>
          </div>
          <button @click="draft.instances.push({ id: uuid(), name: draft.name + ' · 新实例' })">
            添加实例
          </button>
        </template>
        <template v-else>
          <label
            >主体固定版本<select :value="draft.entity?.id" @change="chooseEntity">
              <option value="">选择主体</option>
              <option v-for="e in entities" :value="e.id">
                {{ e.data.name }} · v{{ e.revision }}
              </option>
            </select></label
          >
          <label v-if="kind !== 'appearance'"
            >外观方案<select :value="draft.appearance?.id || ''" @change="chooseAppearance">
              <option value="">基准身份</option>
              <option v-for="a in appearances" :value="a.id">
                {{ a.data.name }} · v{{ a.revision }}
              </option>
            </select></label
          >
          <label v-if="kind === 'appearance'"
            >完整外观方案<textarea
              v-model="draft.description"
              rows="5"
              placeholder="衣着、材质、年龄阶段、颜色及允许变化；保存完整快照"
            />
          </label>
          <template v-if="kind === 'reference_pack' || kind === 'asset_task'">
            <label
              >添加已采用图片<select @change="addImage">
                <option value="">选择固定图片版本</option>
                <option v-for="a in images" :value="a.id">
                  {{ a.data.name }} · v{{ a.revision }}
                </option>
              </select></label
            >
            <div class="reference-grid" v-if="kind === 'reference_pack'">
              <figure v-for="(v, n) in draft.views">
                <img :src="assetUrl(v.asset.id, v.asset.revision)" :alt="v.label" /><label
                  >视图<select v-model="v.view">
                    <option v-for="t in viewTypes">{{ t }}</option>
                  </select></label
                ><input v-model="v.label" placeholder="用途与部位" /><label
                  ><input type="checkbox" v-model="v.inheritBackground" />继承此图背景</label
                ><label
                  ><input type="checkbox" v-model="v.overviewOnly" />仅设计总览，不作独立视图</label
                ><button @click="draft.views.splice(n, 1)">移除视图</button>
              </figure>
            </div>
            <template v-else
              ><div class="reference-grid">
                <figure v-for="(r, n) in draft.references">
                  <img :src="assetUrl(r.id, r.revision)" alt="固定参考" /><button
                    @click="draft.references.splice(n, 1)"
                  >
                    移除参考
                  </button>
                </figure>
              </div>
              <label>图片制作要求<textarea v-model="draft.requirements" rows="4" /></label>
              <div class="ref-row" v-for="(v, n) in draft.views">
                <input v-model="v.id" placeholder="稳定视图 ID" /><select v-model="v.view">
                  <option v-for="t in viewTypes">{{ t }}</option></select
                ><input v-model="v.instruction" placeholder="本视图需要展示什么" /><button
                  @click="draft.views.splice(n, 1)"
                >
                  移除
                </button>
              </div>
              <button @click="draft.views.push({ id: uuid(), view: 'front', instruction: '' })">
                添加交付视图
              </button></template
            >
            <RelationEditor v-model="draft.relations" :documents="documents" />
          </template>
        </template>
        <div class="actions">
          <button class="primary" :disabled="busy" @click="save">保存新版本</button
          ><button v-if="selected && kind !== 'asset_task'" @click="publishLibrary">
            发布到模板库</button
          ><button
            v-if="selected"
            @click="
              act(async () => {
                downloadJson('version-history.json', await api(`/records/${selected!.id}/history`));
              })
            "
          >
            导出版本历史
          </button>
          <button
            v-if="selected && selected.revision > 1"
            @click="
              act(async () => {
                versionDiff = await api(
                  `/domain/${selected!.id}/diff?from=${selected!.revision - 1}&to=${selected!.revision}`,
                );
              })
            "
          >
            查看与上一版本差异
          </button>
        </div>
        <details v-if="versionDiff" open>
          <summary>版本差异</summary>
          <pre>{{ JSON.stringify(versionDiff.changes, null, 2) }}</pre>
        </details>
        <template v-if="selected && kind === 'reference_pack'"
          ><h3>多视图审核</h3>
          <p>检查身份、左右侧、背带、附肢、数量、归属及背景。版本发布后不会自动跟随图片更新。</p>
          <label><input type="checkbox" v-model="inspected" />我已实际查看全部视图及关系约束</label
          ><textarea v-model="conclusion" placeholder="审核结论与适用范围" /><button
            :disabled="busy || !inspected || !conclusion"
            @click="publish"
          >
            发布已审核参考包
          </button></template
        >
        <template v-if="selected && kind === 'asset_task'"
          ><button @click="exportTask">导出 Codex 图片制作包</button>
          <details>
            <summary>高级交付清单</summary>
            <textarea v-model="manifest" rows="7" />
          </details>
          <input
            type="file"
            multiple
            accept="image/*"
            @change="files = Array.from(($event.target as HTMLInputElement).files || [])"
          />
          <div v-if="deliveryMap">
            <p>任务 v{{ deliveryMap.taskRevision }} · {{ deliveryMap.deliveryId }}</p>
            <label v-for="(item, n) in deliveryMap.assets"
              >{{ item.viewId
              }}<select
                :value="item.file"
                @change="matchDelivery(Number(n), ($event.target as HTMLSelectElement).value)"
              >
                <option :value="item.file">{{ item.file }}</option>
                <option v-for="file in files" :value="file.name">{{ file.name }}</option></select
              ><span>{{ files.some((f) => f.name === item.file) ? '已匹配' : '等待文件' }}</span
              ><img
                v-if="deliveryPreviews.find((p) => p.name === item.file)"
                :src="deliveryPreviews.find((p) => p.name === item.file)?.url"
                :alt="item.viewId"
                style="max-width: 180px"
            /></label>
          </div>
          <button :disabled="!manifest || !files.length" @click="delivery">
            按上方匹配导入候选
          </button>
          <p v-for="d in draft.deliveries">
            交付 {{ d.deliveryId }} · {{ d.candidates.length }} 张候选
          </p></template
        >
        <details>
          <summary @click="advanced = JSON.stringify(draft, null, 2)">完整字段与高级编辑</summary>
          <textarea v-model="advanced" rows="14" /><button
            @click="
              () => {
                try {
                  draft = JSON.parse(advanced);
                  invalidJson = false;
                  error = '';
                } catch {
                  error = 'JSON 无效';
                  invalidJson = true;
                }
              }
            "
          >
            应用字段
          </button>
        </details>
      </article>
    </div>
    <article class="panel" v-if="library.length">
      <h3>个人模板库</h3>
      <p>复制指定版本到当前项目，各项目独立审核与演进。</p>
      <div class="ref-row" v-for="item in library">
        <span>{{ item.name }} · v{{ item.revision }}</span
        ><input type="number" min="1" v-model.number="item.revision" aria-label="模板版本" /><button
          @click="previewLibrary(item)"
        >
          查看复制内容
        </button>
      </div>
      <template v-if="libraryPreview"
        ><p>
          将复制 {{ libraryPreview.bundle.documents.length }} 条记录，重建主体、实例及图片引用。
        </p>
        <ul>
          <li v-for="d in libraryPreview.bundle.documents">
            {{ d.kind }} · {{ d.data.name }} · v{{ d.revision }}
          </li>
        </ul>
        <button @click="copyLibrary">复制进当前项目</button></template
      >
    </article>
    <article class="panel" v-if="groups.length">
      <h3>旧资产分组建议</h3>
      <div v-for="g in groups">
        <p>
          {{ g.entityId }} · {{ g.assets.length }} 张；外观：{{
            [...new Set(g.assets.map((a: any) => a.variant))].join(' / ')
          }}
        </p>
        <button @click="useGroup(g)">以此组开始整理主体</button>
      </div>
    </article>
  </section>
</template>
<style scoped>
.domain-columns {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  gap: 18px;
  margin-top: 18px;
}
.record-button {
  display: block;
  width: 100%;
  text-align: left;
  margin: 8px 0;
}
.record-button small {
  display: block;
}
.reference-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
}
.reference-grid figure {
  margin: 12px 0;
  max-width: 210px;
}
.reference-grid img {
  width: 200px;
  height: 180px;
  object-fit: contain;
  background: #182a2b;
}
code {
  font-size: 10px;
  overflow-wrap: anywhere;
}
@media (max-width: 800px) {
  .domain-columns {
    grid-template-columns: 1fr;
  }
}
</style>
