<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { api, downloadJson } from './api';
import RecordPicker from './RecordPicker.vue';
import ContractField from './ContractField.vue';
import VoiceLibrary from './VoiceLibrary.vue';
import { useDraft } from './drafts';
const props = defineProps<{ projectId: string; documents: any[] }>(),
  emit = defineEmits(['refresh']);
const seriesId = ref(''),
  draft = ref<any>(null),
  base = ref(0),
  preview = ref<any>(null),
  progress = ref<any>(null),
  error = ref(''),
  newTitle = ref('');
const series = computed(() => props.documents.filter((d) => d.kind === 'series'));
const selected = computed(() => series.value.find((d) => d.id === seriesId.value));
const profiles = computed(() =>
  props.documents.filter(
    (d) =>
      d.kind === 'creation_profile' && d.data.rulesVersion === 'director-v7' && d.data.published,
  ),
);
const facts = computed(() =>
  props.documents.filter((d) => d.kind === 'continuity' && d.data.seriesId === seriesId.value),
);
watch(
  [() => props.projectId, seriesId, () => selected.value?.id],
  () => {
    base.value = selected.value?.revision || 0;
    draft.value = JSON.parse(
      JSON.stringify(
        selected.value?.data.production || {
          version: 1,
          profile: null,
          targetEpisodes: 20,
          runtime: { targetFrames: 28800, toleranceFrames: 0 },
          slots: [],
          sharedReferences: [],
          voices: [],
          chronology: { mode: 'standalone' },
          information: [],
          actionDefinitions: [],
          characterBeats: [],
          authoredEvents: [],
        },
      ),
    );
    preview.value = progress.value = null;
    if (selected.value?.data.production) void loadProgress();
  },
  { immediate: true },
);
const local = useDraft(
  () => `series-production:${props.projectId}:${seriesId.value}`,
  () => base.value,
  draft,
);
watch(draft, () => (preview.value = null), { deep: true });
async function loadProgress() {
  const id = seriesId.value;
  try {
    const result = await api(`/series/${id}/progress`);
    if (id !== seriesId.value) return;
    progress.value = result;
  } catch (e: any) {
    error.value = e.message;
  }
}
async function create() {
  try {
    const d = await api(`/projects/${props.projectId}/series`, 'POST', { title: newTitle.value });
    emit('refresh');
    seriesId.value = d.id;
  } catch (e: any) {
    error.value = e.message;
  }
}
async function prepare() {
  const id = seriesId.value,
    contents = JSON.stringify(draft.value);
  try {
    if (base.value !== selected.value?.revision)
      throw new Error('系列已有新版本，请导出草稿比较后重新打开');
    const result = await api(`/series/${id}/plan/preview`, 'POST', {
      data: draft.value,
    });
    if (id !== seriesId.value || contents !== JSON.stringify(draft.value)) return;
    preview.value = result;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function apply() {
  const id = seriesId.value;
  try {
    const d = await api(`/series/${seriesId.value}/plan/apply`, 'POST', {
      ...preview.value,
      revision: base.value,
      idempotencyKey: `series-${preview.value.digest}`,
    });
    emit('refresh');
    if (id !== seriesId.value) return;
    await local.discard();
    if (id !== seriesId.value) return;
    base.value = d.revision;
    draft.value = d.data.production;
    emit('refresh');
    await loadProgress();
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function createEpisode(slot: any) {
  const id = seriesId.value;
  try {
    await api(`/projects/${props.projectId}/episodes`, 'POST', {
      seriesId: seriesId.value,
      slotId: slot.id,
      title: slot.title,
    });
    emit('refresh');
    const d = await api(`/records/${id}/history`);
    const current = await api(`/records/${id}/versions/${d.at(-1).revision}`);
    if (id !== seriesId.value) return;
    base.value = current.revision;
    draft.value = current.data.production;
    await loadProgress();
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section class="panel">
    <h2>系列制作与整季规划</h2>
    <p>一部作品或一季使用一个系列。目标时长包含片头、片尾和回顾，正片时长单独统计。</p>
    <div class="form-grid">
      <label
        >目标系列<select v-model="seriesId">
          <option value="">明确选择系列</option>
          <option v-for="s in series" :value="s.id">{{ s.data.title }} · v{{ s.revision }}</option>
        </select></label
      ><label>新增作品／季名称<input v-model="newTitle" /></label
      ><button @click="create">建立系列</button>
    </div>
    <p class="error" v-if="error">{{ error }}</p>
    <p>{{ local.message.value }}</p>
    <template v-if="selected && draft" :key="seriesId"
      ><div class="form-grid">
        <label
          >固定创作配置<select
            :value="draft.profile?.id || ''"
            @change="
              draft.profile = (() => {
                const p = profiles.find((v) => v.id === ($event.target as HTMLSelectElement).value);
                return p ? { id: p.id, revision: p.revision } : null;
              })()
            "
          >
            <option value="">选择已发布 V7 配置</option>
            <option v-for="p in profiles" :value="p.id">
              {{ p.data.name }} · v{{ p.revision }}
            </option>
          </select></label
        ><label
          >目标集数<input
            aria-label="目标集数"
            v-model.number="draft.targetEpisodes"
            type="number"
            min="1" /></label
        ><label
          >默认单集分钟<input
            aria-label="默认单集分钟"
            type="number"
            step="0.1"
            min="0.1"
            :value="draft.runtime.targetFrames / 1440"
            @input="
              draft.runtime.targetFrames = Math.round(
                Number(($event.target as HTMLInputElement).value) * 1440,
              )
            " /></label
        ><label
          >允许偏差（帧，0 为精确）<input
            v-model.number="draft.runtime.toleranceFrames"
            type="number"
            min="0"
        /></label>
      </div>
      <label
        >时间线关系<select
          v-model="draft.chronology.mode"
          @change="delete draft.chronology.fromCanon"
        >
          <option value="standalone">独立起点</option>
          <option value="continuation">同 IP 续作</option>
          <option value="branch">外传／历史分支</option>
        </select></label
      ><RecordPicker
        v-if="draft.chronology.mode !== 'standalone'"
        :project-id="projectId"
        kind="continuity"
        label="固定前作 Canon"
        @select="(r) => (draft.chronology.fromCanon = { id: r.id, revision: r.revision })"
      />
      <p v-if="draft.chronology.fromCanon">{{ draft.chronology.fromCanon }}</p>
      <table>
        <thead>
          <tr>
            <th>规划条目</th>
            <th>剧情任务</th>
            <th>时长覆盖</th>
            <th>制作进度</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="slot in draft.slots" :key="slot.id">
            <td>
              <input v-model="slot.title" /><small>{{ slot.id }}</small
              ><label><input type="checkbox" v-model="slot.active" />计入当前计划</label>
            </td>
            <td>
              <label>核心问题<input v-model="slot.question" /></label
              ><label>冲突<input v-model="slot.conflict" /></label
              ><label>选择<input v-model="slot.choice" /></label
              ><label>结果<input v-model="slot.outcome" /></label
              ><ContractField label="遗留问题" v-model="slot.openQuestions" />
            </td>
            <td>
              <button v-if="!slot.runtime" @click="slot.runtime = { ...draft.runtime }">
                本集覆盖</button
              ><template v-else
                ><label
                  >分钟<input
                    type="number"
                    step="0.1"
                    :value="slot.runtime.targetFrames / 1440"
                    @input="
                      slot.runtime.targetFrames = Math.round(
                        Number(($event.target as HTMLInputElement).value) * 1440,
                      )
                    " /></label
                ><label
                  >允许偏差帧<input
                    type="number"
                    v-model.number="slot.runtime.toleranceFrames" /></label
                ><button @click="delete slot.runtime">使用系列默认</button></template
              >
            </td>
            <td>
              <p>
                {{
                  progress?.slots.find((s: any) => s.id === slot.id)?.delivered
                    ? '已交付'
                    : slot.episodeId
                      ? '已关联分集'
                      : '仅规划'
                }}
              </p>
              <button
                v-if="
                  !slot.episodeId &&
                  slot.active &&
                  selected.data.production?.slots.some((s: any) => s.id === slot.id)
                "
                @click="createEpisode(slot)"
              >
                建立本集草稿
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <ContractField label="动作定义与有限阶段" v-model="draft.actionDefinitions" />
      <ContractField label="共享资料固定版本" v-model="draft.sharedReferences" /><ContractField
        label="系列声音绑定（实例与 profile 版本）"
        v-model="draft.voices"
      /><ContractField
        label="铺垫、误导、揭示与回收条目"
        v-model="draft.information"
      /><ContractField label="人物变化节点" v-model="draft.characterBeats" /><ContractField
        label="明确的画外剧情事实"
        v-model="draft.authoredEvents"
      />
      <button @click="prepare">预览集数与时长影响</button
      ><button @click="downloadJson('系列制作草稿.json', draft)">导出草稿</button>

      <div v-if="preview" class="panel">
        <p v-for="b in preview.episodeBindings" class="warning">
          将把已有分集 {{ b.episode.id }} v{{ b.episode.revision }} 关联至
          {{ b.slotId }}，镜头和事实需重新审核；旧执行与媒体保留。
        </p>
        <p>
          计划 {{ preview.data.targetEpisodes }} 集；{{
            preview.impacts.filter((i: any) => i.changed).length
          }}
          项需要调整。建立规划不会创建分集或生成任务。
        </p>
        <table>
          <tr v-for="i in preview.impacts.filter((i: any) => i.changed)">
            <td>{{ i.slotId }}</td>
            <td>{{ i.active ? '有效' : '历史保留' }}</td>
            <td>{{ i.runtime.targetFrames }} 帧</td>
            <td>{{ i.delivered ? '已有历史交付' : '' }}</td>
          </tr>
        </table>
        <button @click="apply">确认应用当前计划</button>
      </div>
      <p v-if="progress">
        正式交付 {{ progress.delivered }} / {{ progress.targetEpisodes }} 集；{{
          progress.complete ? '当前计划已完成' : '制作中'
        }}
      </p>
      <h3>计划与实际信息进度</h3>
      <table v-if="progress">
        <thead>
          <tr>
            <th>分集</th>
            <th>成功生成候选</th>
            <th>已采用秒数</th>
            <th>接点通过</th>
            <th>场景通过</th>
            <th>对白素材</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in progress.slots.filter((s: any) => s.episodeId)" :key="s.id">
            <td>
              {{ s.title }}
              <p v-if="s.assemblyProblem" class="warning">{{ s.assemblyProblem }}</p>
            </td>
            <td>{{ s.generated }}</td>
            <td>{{ (s.adoptedFrames / 24).toFixed(2) }}</td>
            <td>{{ s.joins.passed }} / {{ s.joins.total }}</td>
            <td>{{ s.scenes.passed }} / {{ s.scenes.total }}</td>
            <td>
              {{ s.dialogueTakes }} · {{ s.soundReviewed ? '装配声音已审' : '装配声音未通过' }}
            </td>
          </tr>
        </tbody>
      </table>
      <table>
        <tr v-for="i in progress?.information || []">
          <td>{{ i.statement }}（{{ i.kind }}）</td>
          <td>计划 {{ i.milestones.length }} 个节点</td>
          <td>成片证据 {{ i.actual.length }} 项</td>
          <td>
            <span v-for="a in i.actual">{{ a.stage }} · {{ a.slotId }}；</span>
          </td>
        </tr>
      </table>
      <h3>本系列事实与角色认知</h3>
      <p>计划的回收与实际成片证据分开保存。前集待复核会阻止正式接续。</p>
      <article class="panel" v-for="c in facts">
        <strong
          >第 {{ c.data.episodeNumber }} 集 Canon v{{ c.revision }} ·
          {{
            c.data.stale || progress?.facts?.find((f: any) => f.id === c.id)?.problems.length
              ? '待复核'
              : c.data.confirmed
                ? '已确认'
                : '未确认'
          }}</strong
        >
        <table>
          <tr v-for="f in c.data.facts">
            <td>{{ f.kind }}</td>
            <td>{{ f.text }}</td>
            <td>{{ f.source?.kind || '来源待核实' }}</td>
            <td>{{ f.effective?.slotId }}</td>
          </tr>
        </table>
      </article>
    </template>
  </section>
  <VoiceLibrary :project-id="projectId" :documents="documents" @refresh="emit('refresh')" />
</template>
