<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api } from './api';
import DirectorSpace from './DirectorSpace.vue';
const props = defineProps<{
  record: any;
  run: any;
  shotId?: string;
  sceneId?: string;
  context?: any;
  subjectKey?: string;
}>();
const emit = defineEmits(['close', 'saved']);
const objectKey = props.shotId || props.sceneId || props.subjectKey || 'all';
const legacyKey = `studio-draft:${props.record.id}:${props.record.revision}:${objectKey}`;
const draftKey = `studio-authoring-draft:${props.record.projectId}:${props.run.id}:${props.record.data.stage}:${objectKey}`;
const original = JSON.stringify(props.record.data.result);
let recovered: any = null;
const recoveryError = ref(''),
  recoveredRaw = ref('');
try {
  recoveredRaw.value = localStorage.getItem(draftKey) || localStorage.getItem(legacyKey) || '';
  recovered = JSON.parse(localStorage.getItem(draftKey) || 'null');
  if (!recovered && localStorage.getItem(legacyKey))
    recovered = {
      baseline: { id: props.record.id, revision: props.record.revision },
      result: JSON.parse(localStorage.getItem(legacyKey)!),
    };
  if (recovered) {
    const candidate = recovered.result;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      candidate.stage !== props.record.data.result.stage ||
      Object.entries(props.record.data.result).some(
        ([key, value]) =>
          Array.isArray(value) &&
          (!Array.isArray(candidate[key]) || candidate[key].some((item: any) => item === null)),
      )
    )
      throw new Error('草稿结构与打开的阶段不符');
  }
} catch {
  recovered = null;
  recoveryError.value = '本地草稿无法解析，当前打开固定原稿；原存储保留供恢复。';
}
const conflict = ref(
  recovered &&
    (recovered.baseline?.id !== props.record.id ||
      recovered.baseline?.revision !== props.record.revision)
    ? recovered
    : null,
);
const draft = ref<any>(
    JSON.parse(
      JSON.stringify(
        !conflict.value && recovered?.result ? recovered.result : props.record.data.result,
      ),
    ),
  ),
  error = ref(''),
  busy = ref(false),
  notice = ref(
    recoveryError.value ||
      (conflict.value
        ? '发现旧版本草稿。请比较后明确保留内容，不会覆盖当前原稿。'
        : recovered
          ? '已恢复本地未保存编辑。'
          : ''),
  );
const dirty = computed(() => JSON.stringify(draft.value) !== original);
const impact = ref<any>(null);
async function inspectImpact() {
  try {
    const contents = JSON.stringify(draft.value);
    const response = await api(`/creation-runs/${props.run.id}/results/impact`, 'POST', {
      revision: runRevision,
      baseline: { id: props.record.id, revision: props.record.revision },
      stage: draft.value.stage,
      result: draft.value,
      ...(props.shotId || props.sceneId || props.subjectKey
        ? {
            scope: {
              shotIds: props.shotId ? [props.shotId] : [],
              sceneIds: props.sceneId ? [props.sceneId] : [],
              subjectKeys: props.subjectKey ? [props.subjectKey] : [],
            },
          }
        : {}),
    });
    if (JSON.stringify(draft.value) === contents) impact.value = response;
  } catch (e: any) {
    error.value = e.message;
  }
}
const runRevision = props.run.revision;
const shots = computed(() =>
  props.shotId ? draft.value.shots.filter((s: any) => s.id === props.shotId) : draft.value.shots,
);
const scenes = computed(() =>
  props.sceneId
    ? draft.value.scenes.filter((s: any) => s.id === props.sceneId)
    : draft.value.scenes,
);
const detail = ref<any>(props.context);
const script = computed(() => detail.value?.results?.script?.data.result);
onMounted(async () => {
  if (detail.value) return;
  try {
    detail.value = await api(
      `/projects/${props.record.projectId}/workspace-records/${props.record.id}?revision=${props.record.revision}&detail=true`,
    );
  } catch (e: any) {
    error.value = e.message;
  }
});
function addState(shot: any, field: string) {
  const subject = script.value?.subjects.find(
    (s: any) => shot.visibleSubjectKeys.includes(s.key) && s.attributes.length,
  );
  if (subject)
    shot[field].push({ subjectKey: subject.key, key: subject.attributes[0].key, value: null });
  else notice.value = '请先在剧本主体中声明可用状态属性';
}
function addRelation(shot: any, field: string) {
  shot[field].push({
    objectKey: shot.visibleSubjectKeys[0],
    type: 'locatedIn',
    targetKey: shot.visibleSubjectKeys.at(-1),
    anchor: '',
  });
}
function stateValue(event: Event, s: any) {
  const input = event.target as HTMLInputElement;
  const value = input.value;
  const type = script.value?.subjects
    .find((a: any) => a.key === s.subjectKey)
    ?.attributes.find((a: any) => a.key === s.key)?.type;
  input.setCustomValidity('');
  if (
    value &&
    ((type === 'number' && !Number.isFinite(Number(value))) ||
      (type === 'boolean' && !['true', 'false'].includes(value)))
  ) {
    input.setCustomValidity(type === 'boolean' ? '布尔状态请填写 true 或 false' : '请填写有效数字');
    return;
  }
  s.value =
    value === ''
      ? null
      : type === 'number'
        ? Number(value)
        : type === 'boolean'
          ? value === 'true'
          : value;
}

const heading = computed(() =>
  props.shotId
    ? `${String(draft.value.shots.findIndex((s: any) => s.id === props.shotId) + 1).padStart(2, '0')} · ${shots.value[0]?.purpose}`
    : props.sceneId
      ? scenes.value[0]?.title
      : props.subjectKey
        ? draft.value.subjects?.find((s: any) => s.key === props.subjectKey)?.name
        : draft.value.title,
);
function addCue(shot: any, value: string) {
  if (!value) return;
  const target = JSON.parse(value);
  if (shot.cues.some((c: any) => JSON.stringify(c.target) === value)) return;
  shot.cues.push({
    id: `cue-${crypto.randomUUID().slice(0, 8)}`,
    target,
    window: null,
    afterIds: [],
  });
}
function addPerformance(shot: any, subjectKey: string) {
  if (subjectKey && !shot.performances.some((p: any) => p.subjectKey === subjectKey))
    shot.performances.push({
      id: crypto.randomUUID(),
      subjectKey,
      trigger: '',
      goal: '',
      obstacle: '',
      visible: '',
      attention: null,
      headHeading: null,
    });
}
const previousFocus = document.activeElement as HTMLElement | null;
watch(
  draft,
  () => {
    impact.value = null;
    if (conflict.value || recoveryError.value) return;
    try {
      if (dirty.value)
        localStorage.setItem(
          draftKey,
          JSON.stringify({
            baseline: { id: props.record.id, revision: props.record.revision },
            result: draft.value,
          }),
        );
      else localStorage.removeItem(draftKey);
    } catch {
      notice.value = '本地空间不足，草稿尚未持久保存，请复制保存。';
    }
  },
  { deep: true },
);
function reorder(index: number, direction: number) {
  const next = index + direction;
  if (next < 0 || next >= draft.value.shots.length) return;
  const [shot] = draft.value.shots.splice(index, 1);
  draft.value.shots.splice(next, 0, shot);
  const order = new Map(draft.value.shots.map((s: any, i: number) => [s.id, i]));
  for (const group of draft.value.groups)
    group.shotIds.sort((a: string, b: string) => Number(order.get(a)) - Number(order.get(b)));
  draft.value.groups.sort(
    (a: any, b: any) => Number(order.get(a.shotIds[0])) - Number(order.get(b.shotIds[0])),
  );
}
async function save() {
  if (props.record.data.adopted && !impact.value) {
    await inspectImpact();
    notice.value = '请检查修改影响，再提交草稿。';
    return;
  }
  if (conflict.value || recoveryError.value) {
    error.value = '请先处理草稿恢复问题，避免覆盖尚未保存的内容。';
    return;
  }
  if (props.run.data.schemaVersion !== 9) {
    error.value = '当前编辑器仅支持 V9 作者结果';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const result = await api(`/creation-runs/${props.run.id}/results`, 'POST', {
      revision: runRevision,
      stage: draft.value.stage,
      result: draft.value,
      ...(props.record.data.adopted
        ? { baseline: { id: props.record.id, revision: props.record.revision } }
        : {}),
      ...(props.record.data.adopted && (props.shotId || props.sceneId || props.subjectKey)
        ? {
            scope: {
              shotIds: props.shotId ? [props.shotId] : [],
              sceneIds: props.sceneId ? [props.sceneId] : [],
              subjectKeys: props.subjectKey ? [props.subjectKey] : [],
            },
          }
        : {}),
    });
    try {
      localStorage.removeItem(draftKey);
      localStorage.removeItem(legacyKey);
    } catch {
      notice.value = '服务端草稿已保存；本机旧草稿未清除，下次打开时请核对版本。';
    }
    emit('saved', result);
  } catch (e: any) {
    error.value =
      e.message + '。当前编辑仍保留在此窗口，可复制草稿；本机持久保存状态请查看上方提示。';
  } finally {
    busy.value = false;
  }
}
async function copyConflict() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(conflict.value.result, null, 2));
    notice.value = '旧草稿已复制，可与当前原稿比较。';
  } catch (e: any) {
    error.value = `复制失败：${e.message}`;
  }
}
function discardConflict() {
  try {
    localStorage.removeItem(draftKey);
    conflict.value = null;
    notice.value = '继续编辑当前原稿；已明确放弃旧草稿。';
  } catch (e: any) {
    error.value = `清除失败：${e.message}`;
  }
}
function discardUnreadable() {
  try {
    localStorage.removeItem(draftKey);
    localStorage.removeItem(legacyKey);
    recoveryError.value = '';
    notice.value = '已明确放弃无法解析的存储，可继续编辑当前原稿。';
  } catch (e: any) {
    error.value = `清除失败：${e.message}`;
  }
}
async function copyDraft() {
  try {
    await navigator.clipboard.writeText(JSON.stringify(draft.value, null, 2));
    notice.value = '草稿已复制';
  } catch (e: any) {
    error.value = e.message;
  }
}
onBeforeUnmount(() => previousFocus?.focus());
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form
      class="dialog authoring-editor wide"
      v-dialog-focus="() => emit('close')"
      role="dialog"
      aria-modal="true"
      aria-label="编辑创作成果"
      @submit.prevent="save"
      @keydown.esc="emit('close')"
    >
      <header>
        <div>
          <small>{{ shotId ? '本镜修订' : sceneId ? '本场修订' : '创作方案编辑' }}</small>
          <h2>{{ heading }}</h2>
        </div>
        <button type="button" @click="emit('close')" aria-label="关闭编辑">×</button>
      </header>
      <p v-if="notice" role="status">{{ notice }}</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <details v-if="recoveryError" open>
        <summary>无法解析的草稿存储</summary>
        <textarea :value="recoveredRaw" readonly aria-label="原始草稿存储" />
        <p>可先复制以上原文保留，再决定是否清除。</p>
        <button type="button" @click="discardUnreadable">清除损坏存储，继续当前原稿</button>
      </details>
      <details v-if="conflict">
        <summary>比较旧版本草稿与当前原稿</summary>
        <pre>{{ JSON.stringify(conflict.result, null, 2) }}</pre>
        <button type="button" @click="copyConflict">复制旧草稿</button
        ><button type="button" @click="discardConflict">放弃旧草稿，编辑当前版本</button>
      </details>
      <p role="status">
        {{ dirty ? '有未提交修改（本机草稿）' : '与打开的固定版本一致' }} · 提交后仍需审稿采用
      </p>
      <details v-if="record.data.adopted" open>
        <summary>修改影响</summary>
        <button type="button" @click="inspectImpact">重新核对影响</button
        ><template v-if="impact"
          ><p>字段：{{ impact.changedFields.join('、') || '无变化' }}</p>
          <p v-for="s in impact.scopes" :key="s.id">
            {{ s.name }}：{{
              s.problem || (s.affected ? '实际消费内容改变，需重新准备' : '执行内容保持')
            }}
          </p>
          <p v-for="j in impact.jobs" :key="j.id">{{ j.id }} · {{ j.state }} · {{ j.action }}</p>
          <p>{{ impact.facts }}</p></template
        >
      </details>
      <div class="editor-scroll">
        <fieldset class="editor-fields" :disabled="busy || run.data.schemaVersion !== 9">
          <template v-if="!shotId && !sceneId && !subjectKey"
            ><label>标题<input v-model="draft.title" /></label
            ><label>摘要<textarea v-model="draft.summary" rows="3" /></label
          ></template>
          <template v-if="draft.stage === 'brief'"
            ><label>目标<textarea v-model="draft.goal" rows="5" /></label
            ><label>受众<input v-model="draft.audience" /></label
            ><label v-for="(fact, i) in draft.lockedFacts" :key="fact.id"
              >固定事实 {{ Number(i) + 1 }}<textarea v-model="fact.statement" rows="2" /></label
            ><label v-for="(_, i) in draft.requirements" :key="i"
              >交付要求 {{ Number(i) + 1 }}<input v-model="draft.requirements[i]" /></label
          ></template>
          <template v-else-if="draft.stage === 'script'"
            ><section v-if="!sceneId">
              <fieldset
                v-for="subject in draft.subjects.filter(
                  (s: any) => !subjectKey || s.key === subjectKey,
                )"
                :key="subject.key"
              >
                <legend>{{ subject.name }}</legend>
                <label>主体名称<input v-model="subject.name" /></label
                ><label>身份与描述<textarea v-model="subject.description" rows="4" /></label>
              </fieldset>
            </section>
            <section v-for="scene in subjectKey ? [] : scenes" :key="scene.id">
              <h3>{{ scene.title }}</h3>
              <label>场景标题<input v-model="scene.title" /></label
              ><label>时间与空间<textarea v-model="scene.setting" rows="2" /></label
              ><label>场景叙事<textarea v-model="scene.narrative" rows="4" /></label
              ><label v-for="event in scene.events" :key="event.id"
                >事件<textarea v-model="event.description" rows="2" />
              </label>
              <fieldset v-for="line in scene.dialogue" :key="line.id">
                <legend>对白</legend>
                <label
                  >说话者<select v-model="line.speakerKey">
                    <option
                      v-for="subject in draft.subjects"
                      :key="subject.key"
                      :value="subject.key"
                    >
                      {{ subject.name }}
                    </option>
                  </select></label
                ><label>语言<input v-model="line.language" /></label
                ><label>原文<textarea v-model="line.text" rows="2" /></label
                ><label>字幕译文<textarea v-model="line.translation" rows="2" /></label>
              </fieldset>
            </section>
            <label v-if="!sceneId && !subjectKey"
              >剧本全文<textarea v-model="draft.screenplayText" rows="12" /></label
          ></template>
          <template v-else-if="draft.stage === 'direction'"
            ><label
              v-for="[key, label] in [
                ['visual', '视觉'],
                ['narrative', '叙事'],
                ['directing', '导演'],
                ['editing', '剪辑'],
                ['sound', '声音'],
                ['assetPolicy', '资产政策'],
              ]"
              :key="key"
              >{{ label }}<textarea v-model="draft[key]" rows="5" /></label
          ></template>
          <template v-else-if="draft.stage === 'director'">
            <section v-if="!shotId && !sceneId && !subjectKey">
              <h3>生成组执行关系</h3>
              <p>独立生成可保持叙事连续；连续接续需要先取得并采用上一组的片段。</p>
              <fieldset v-for="group in draft.groups" :key="group.id">
                <legend>{{ group.id }} · {{ group.shotIds.join('、') }}</legend>
                <label
                  >{{ group.id }} 接续方式<select v-model="group.transition">
                    <option value="independent">独立生成</option>
                    <option value="continuous">连续接续（依赖上一组采用）</option>
                    <option value="ellipsis">时间省略</option>
                    <option value="location_change">空间切换</option>
                    <option value="flashback">闪回</option>
                  </select></label
                >
                <label>{{ group.id }} 接续依据<textarea v-model="group.reason" rows="2" /></label>
              </fieldset>
            </section>
            <section v-for="(shot, index) in shots" :key="shot.id" class="shot-form">
              <header>
                <h3>{{ shot.purpose }}</h3>
                <div v-if="!shotId">
                  <button type="button" :disabled="index === 0" @click="reorder(Number(index), -1)">
                    上移</button
                  ><button
                    type="button"
                    :disabled="index === shots.length - 1"
                    @click="reorder(Number(index), 1)"
                  >
                    下移
                  </button>
                </div>
              </header>
              <label>镜头任务<input v-model="shot.purpose" /></label
              ><label
                >时长（帧，24 帧／秒）<input
                  v-model.number="shot.frames"
                  type="number"
                  min="1"
                  step="1" /></label
              ><label>动作<textarea v-model="shot.action" rows="4" /></label>
              <DirectorSpace
                :director="draft"
                :shot="shot"
                :basis="record"
                edit
                :edit-scene="!shotId && !subjectKey"
              />
              <div class="form-row">
                <label>景别<input v-model="shot.camera.shotSize" /></label
                ><label>机位<input v-model="shot.camera.position" /></label>
              </div>
              <label>构图<textarea v-model="shot.camera.composition" rows="2" /></label>
              <div class="form-row">
                <label
                  >摄影机运动<select v-model="shot.camera.motion">
                    <option
                      v-for="[v, l] in [
                        ['static', '固定'],
                        ['pan', '摇摄'],
                        ['tilt', '俯仰'],
                        ['dolly', '推进 / 后移'],
                        ['truck', '横移'],
                        ['pedestal', '升降'],
                        ['arc', '环绕'],
                        ['tracking', '跟随'],
                        ['zoom', '变焦'],
                      ]"
                      :key="v"
                      :value="v"
                    >
                      {{ l }}
                    </option>
                  </select></label
                ><label>运动依据<input v-model="shot.camera.reason" /></label>
              </div>
              <fieldset>
                <legend>本镜可见主体</legend>
                <label v-for="subject in script?.subjects" :key="subject.key"
                  ><input
                    v-model="shot.visibleSubjectKeys"
                    type="checkbox"
                    :value="subject.key"
                  />{{ subject.name }}</label
                >
              </fieldset>
              <fieldset v-for="placement in shot.dialogue" :key="placement.lineId">
                <legend>
                  {{
                    script?.scenes
                      .flatMap((s: any) => s.dialogue)
                      .find((l: any) => l.id === placement.lineId)?.text || placement.lineId
                  }}
                </legend>
                <select v-model="placement.delivery">
                  <option value="onscreen">画内对白</option>
                  <option value="offscreen">画外对白</option>
                  <option value="voiceover">旁白</option>
                </select>
                <template v-if="placement.mouth"
                  ><label
                    >嘴部可见性<select v-model="placement.mouth.visibility">
                      <option value="visible">可见</option>
                      <option value="occluded">被遮挡</option>
                      <option value="out_of_frame">画外</option>
                      <option value="unknown">未知，需核对</option>
                    </select></label
                  >
                  <label
                    ><input
                      type="checkbox"
                      :checked="!!placement.mouth.window"
                      @change="
                        placement.mouth.window = ($event.target as HTMLInputElement).checked
                          ? { startFrame: 0, endFrame: shot.frames }
                          : null
                      "
                    />指定嘴部可见性适用区间</label
                  >
                  <template v-if="placement.mouth.window"
                    ><label
                      >起始帧<input
                        type="number"
                        min="0"
                        :max="shot.frames - 1"
                        v-model.number="placement.mouth.window.startFrame" /></label
                    ><label
                      >结束帧（不含）<input
                        type="number"
                        min="1"
                        :max="shot.frames"
                        v-model.number="placement.mouth.window.endFrame" /></label
                  ></template>
                </template>
              </fieldset>
              <details>
                <summary>动作、对白和表演的时序</summary>
                <p>时间使用本镜起点的帧数；未指定窗口时只表达先后。实际视频仍需审看。</p>
                <select
                  :value="''"
                  @change="addCue(shot, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">选择需要安排时序的内容</option>
                  <option
                    v-for="e in shot.events"
                    :key="'e:' + e.eventId"
                    :value="JSON.stringify({ kind: 'event', eventId: e.eventId })"
                  >
                    事件 {{ e.eventId }}
                  </option>
                  <option
                    v-for="d in shot.dialogue"
                    :key="'d:' + d.lineId"
                    :value="JSON.stringify({ kind: 'dialogue', lineId: d.lineId })"
                  >
                    对白 {{ d.lineId }}
                  </option>
                  <option
                    v-for="p in shot.performances"
                    :key="'p:' + p.id"
                    :value="JSON.stringify({ kind: 'performance', performanceId: p.id })"
                  >
                    表演 {{ p.subjectKey }} · {{ p.visible }}
                  </option>
                </select>
                <fieldset v-for="(cue, i) in shot.cues" :key="cue.id">
                  <legend>{{ cue.id }} · {{ cue.target }}</legend>
                  <button
                    type="button"
                    @click="
                      cue.window = cue.window ? null : { startFrame: 0, endFrame: shot.frames }
                    "
                  >
                    {{ cue.window ? '取消具体窗口' : '指定窗口' }}</button
                  ><template v-if="cue.window"
                    ><label
                      >起帧<input
                        v-model.number="cue.window.startFrame"
                        type="number"
                        min="0" /></label
                    ><label
                      >止帧<input
                        v-model.number="cue.window.endFrame"
                        type="number"
                        min="1"
                        :max="shot.frames" /></label></template
                  ><label
                    v-for="before in shot.cues.filter((c: any) => c.id !== cue.id)"
                    :key="before.id"
                    ><input v-model="cue.afterIds" type="checkbox" :value="before.id" />在
                    {{ before.id }} 之后</label
                  ><button type="button" @click="shot.cues.splice(Number(i), 1)">移除此时序</button>
                </fieldset>
              </details>
              <fieldset v-for="(performance, i) in shot.performances" :key="i">
                <legend>{{ performance.subjectKey }} · 表演</legend>
                <button type="button" @click="shot.performances.splice(Number(i), 1)">
                  移除此表演</button
                ><label>触发<input v-model="performance.trigger" /></label
                ><label
                  >目标与阻碍<input v-model="performance.goal" /><input
                    v-model="performance.obstacle" /></label
                ><label>可见表现<textarea v-model="performance.visible" rows="3" /></label>
                <label
                  >关注对象<select
                    :value="performance.attention?.subjectKey || ''"
                    @change="
                      performance.attention = ($event.target as HTMLSelectElement).value
                        ? {
                            subjectKey: ($event.target as HTMLSelectElement).value,
                            point: null,
                            anchorId: null,
                            description: '',
                          }
                        : null
                    "
                  >
                    <option value="">尚未指定</option>
                    <option v-for="s in script?.subjects" :key="s.key" :value="s.key">
                      {{ s.name }}
                    </option>
                  </select></label
                >
                <label v-if="performance.attention"
                  >关注动作说明<input v-model="performance.attention.description"
                /></label>
                <label
                  >头部世界朝向（空白为未知）<input
                    type="number"
                    min="0"
                    max="359.99"
                    step="any"
                    :value="performance.headHeading ?? ''"
                    @input="
                      performance.headHeading =
                        ($event.target as HTMLInputElement).value === ''
                          ? null
                          : Number(($event.target as HTMLInputElement).value)
                    "
                /></label>
              </fieldset>
              <p v-if="!shot.performances.length" class="content-gap">
                尚未填写分项表演；已有动作描述仍保留。
              </p>
              <label
                >添加出场主体表演<select
                  :value="''"
                  @change="addPerformance(shot, ($event.target as HTMLSelectElement).value)"
                >
                  <option value="">选择主体</option>
                  <option
                    v-for="key in shot.visibleSubjectKeys.filter(
                      (k: string) => !shot.performances.some((p: any) => p.subjectKey === k),
                    )"
                    :key="key"
                    :value="key"
                  >
                    {{ script?.subjects.find((s: any) => s.key === key)?.name || key }}
                  </option>
                </select></label
              >
              <label>环境声<textarea v-model="shot.environmentSound" rows="2" /></label
              ><label>动作声<textarea v-model="shot.actionSound" rows="2" /></label>
              <label>声音接续<textarea v-model="shot.soundContinuation" rows="3" /></label>
              <details>
                <summary>编辑入口／出口状态与物体关系</summary>
                <section
                  v-for="[key, label] in [
                    ['entryState', '入口状态'],
                    ['exitState', '出口状态'],
                  ]"
                  :key="key"
                >
                  <h4>{{ label }}</h4>
                  <p v-if="!shot[key].length" class="content-gap">尚未声明</p>
                  <fieldset v-for="(state, n) in shot[key]" :key="n">
                    <label
                      >主体<select v-model="state.subjectKey">
                        <option v-for="s in script?.subjects" :key="s.key" :value="s.key">
                          {{ s.name }}
                        </option>
                      </select></label
                    ><label
                      >属性<select v-model="state.key">
                        <option
                          v-for="a in script?.subjects.find((s: any) => s.key === state.subjectKey)
                            ?.attributes"
                          :key="a.key"
                          :value="a.key"
                        >
                          {{ a.label }}
                        </option>
                      </select></label
                    ><label
                      >值（留空表示未声明）<input
                        :value="state.value ?? ''"
                        @input="stateValue($event, state)" /></label
                    ><button type="button" @click="shot[key].splice(Number(n), 1)">
                      移除此状态
                    </button>
                  </fieldset>
                  <button type="button" @click="addState(shot, key)">添加{{ label }}</button>
                </section>
                <section
                  v-for="[key, label] in [
                    ['entryRelations', '入口关系'],
                    ['exitRelations', '出口关系'],
                  ]"
                  :key="key"
                >
                  <h4>{{ label }}</h4>
                  <p v-if="!shot[key].length" class="content-gap">尚未声明</p>
                  <fieldset v-for="(relation, n) in shot[key]" :key="n">
                    <label
                      >对象<select v-model="relation.objectKey">
                        <option v-for="s in script?.subjects" :key="s.key" :value="s.key">
                          {{ s.name }}
                        </option>
                      </select></label
                    ><label
                      >关系<select v-model="relation.type">
                        <option value="heldBy">由其持有</option>
                        <option value="attachedTo">附着于</option>
                        <option value="containedIn">包含于</option>
                        <option value="locatedIn">位于</option>
                      </select></label
                    ><label
                      >目标<select v-model="relation.targetKey">
                        <option v-for="s in script?.subjects" :key="s.key" :value="s.key">
                          {{ s.name }}
                        </option>
                      </select></label
                    ><label>位置依据<input v-model="relation.anchor" /></label
                    ><button type="button" @click="shot[key].splice(Number(n), 1)">
                      移除此关系
                    </button>
                  </fieldset>
                  <button type="button" @click="addRelation(shot, key)">添加{{ label }}</button>
                </section>
              </details>
              <p class="muted">对白与关键事件来自剧本；需要改变内容时，请编辑相应场景。</p>
            </section></template
          >
          <template v-else-if="draft.stage === 'assets'"
            ><section v-for="item in draft.items" :key="item.id">
              <label>素材需求<input v-model="item.description" /></label
              ><label>版式<input v-model="item.layout" /></label
              ><label>制作提示<textarea v-model="item.prompt" rows="6" /></label></section
          ></template>
          <template v-else-if="draft.stage === 'editorial'"
            ><label
              >配乐政策<select v-model="draft.musicDecision">
                <option value="no_music">不使用配乐</option>
                <option value="import">导入配乐</option>
              </select></label
            ><label>声音说明<textarea v-model="draft.musicReason" rows="4" /></label>
            <fieldset v-for="line in draft.overlays" :key="line.id">
              <legend>字幕 / 图文</legend>
              <label>内容<input v-model="line.text" /></label>
              <div class="form-row">
                <label>开始帧<input v-model.number="line.startFrame" type="number" min="0" /></label
                ><label>结束帧<input v-model.number="line.endFrame" type="number" min="1" /></label>
              </div></fieldset
          ></template>
        </fieldset>
      </div>
      <footer>
        <span>{{ dirty ? '未保存修改 · 本机自动保留草稿' : '尚无修改' }}</span
        ><button type="button" @click="copyDraft">复制草稿</button
        ><button type="button" @click="emit('close')">关闭</button
        ><button class="primary" :disabled="busy || !dirty">保存新草稿</button>
      </footer>
    </form>
  </div>
</template>
