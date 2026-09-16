<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Job, RecordDoc } from '../shared/contracts';
import { reviewDimensions } from '../shared/domain';
import { api, assetUrl } from './api';
import ObservedEvidence from './ObservedEvidence.vue';
import { soundRequirements } from '../shared/shot-semantics';
const props = defineProps<{ job: Job; documents: RecordDoc[] }>();
const emit = defineEmits(['refresh']);
const universal = computed(
  () =>
    !!draft.value?.evaluation ||
    props.job.input.prepared?.shotSpecs?.some((s: any) => s.version >= 2),
);
const inspectionJob = computed(() =>
  draft.value?.evaluation
    ? {
        ...props.job,
        input: {
          ...props.job.input,
          prepared: { ...props.job.input.prepared, shotSpecs: draft.value.evaluation.shotSpecs },
          planning: { records: draft.value.evaluation.records },
        },
      }
    : props.job,
);
const video = computed(() => props.documents.find((d) => d.id === props.job.output.videoAssetId));
const episode = computed(() => props.documents.find((d) => d.id === props.job.episodeId));
const currentReview = computed(() =>
  props.documents
    .filter((d) => d.kind === 'generation_review' && d.data.jobId === props.job.id)
    .at(-1),
);
const selection = computed(() =>
  props.documents.find(
    (d) =>
      d.kind === 'segment_selection' &&
      d.parentId === props.job.episodeId &&
      d.data.segmentId === props.job.input.segment?.id,
  ),
);
const player = ref<HTMLVideoElement | null>(null),
  draft = ref<any>(null),
  error = ref(''),
  notice = ref(''),
  busy = ref(false),
  frame = ref(0),
  coverage = ref<any[]>([]);
const startFrame = computed({
  get: () => Math.round(draft.value.in * 24),
  set: (v: number) => {
    draft.value.in = v / 24;
  },
});
const endFrame = computed({
  get: () => Math.round(draft.value.out * 24),
  set: (v: number) => {
    draft.value.out = v / 24;
  },
});
function cueChecklist(specs: any[]) {
  return specs.flatMap((s: any) =>
    (s.directing.cues || []).map((c: any) => ({
      shotId: s.shotId,
      cueId: c.id,
      inspection: c.target.kind === 'dialogue' ? 'audio' : 'motion',
      status: 'unreviewed',
      startFrame: 0,
      endFrame: 2,
      notes: '',
    })),
  );
}
function edit() {
  const v = video.value;
  if (!v) return;
  draft.value = currentReview.value
    ? JSON.parse(JSON.stringify(currentReview.value.data))
    : {
        jobId: props.job.id,
        video: { id: v.id, revision: v.revision },
        in: 0,
        out: v.data.duration,
        dimensions: Object.fromEntries(reviewDimensions.map((d) => [d, 'unreviewed'])),
        issues: [],
        notes: '',
        inspected: false,
      };
  draft.value.eventEvidence ||= (props.job.input.prepared?.shotSpecs || []).flatMap((s: any) =>
    (s.directing?.events || []).map((e: any) => ({
      eventId: e.id,
      shotId: s.shotId,
      inspection: e.inspection,
      status: 'unreviewed',
      startFrame: 0,
      endFrame: 1,
      notes: '',
      ...(universal.value ? { observed: 'unknown' } : {}),
    })),
  );
  draft.value.cueEvidence ||= cueChecklist(inspectionJob.value.input.prepared?.shotSpecs || []);
  draft.value.interactionEvidence ||= (inspectionJob.value.input.prepared?.shotSpecs || []).flatMap(
    (s: any) =>
      (s.directing?.interactions || []).map((i: any) => ({
        shotId: s.shotId,
        interactionId: i.id,
        inspection: 'motion',
        status: 'unreviewed',
        startFrame: 0,
        endFrame: 1,
        notes: '',
      })),
  );
  if (universal.value) {
    draft.value.observations ||= [];
    draft.value.relationObservations ||= [];
    draft.value.audioEvidence ||= inspectionJob.value.input.prepared.shotSpecs.flatMap((s: any) =>
      soundRequirements(s.directing).map((r) => ({
        shotId: s.shotId,
        requirementId: r.id,
        inspection: 'audio',
        status: 'unreviewed',
        startFrame: 0,
        endFrame: 1,
        speakerId: '',
        text: '',
        notes: '',
      })),
    );
    draft.value.spliceEvidence ||= props.job.input.segment.repair
      ? ['before', 'after'].flatMap((side) =>
          ['motion', 'audio'].map((inspection) => ({
            side,
            inspection,
            status: 'unreviewed',
            sourceSelection: props.job.input.segment.repair.sourceSelection,
            notes: '',
          })),
        )
      : [];
    draft.value.out = Math.round(draft.value.out * 24) / 24;
  }
  coverage.value = (props.job.input.segment.shotIds || []).map(
    (id: string, n: number, ids: string[]) => ({
      shotId: id,
      in: universal.value
        ? Math.round((n * v.data.frameCount) / ids.length) / 24
        : (n * v.data.duration) / ids.length,
      out: universal.value
        ? Math.round(((n + 1) * v.data.frameCount) / ids.length) / 24
        : ((n + 1) * v.data.duration) / ids.length,
    }),
  );
}
async function enableObserved() {
  await act(async () => {
    if (!episode.value) throw new Error('请载入本任务分集');
    const basis = { id: episode.value.id, revision: episode.value.revision };
    const evaluation = await api(`/projects/${props.job.projectId}/review-basis/preview`, 'POST', {
      jobId: props.job.id,
      episode: basis,
    });
    draft.value.evaluation = evaluation;
    draft.value.observationBasis = basis;
    draft.value.cueEvidence = cueChecklist(evaluation.shotSpecs);
    draft.value.observations = [];
    draft.value.relationObservations = [];
    draft.value.eventEvidence = evaluation.shotSpecs.flatMap((s: any) =>
      s.directing.events.map((e: any) => ({
        eventId: e.id,
        shotId: s.shotId,
        inspection: e.inspection,
        status: 'unreviewed',
        observed: 'unknown',
        startFrame: 0,
        endFrame: 1,
        notes: '',
      })),
    );
    draft.value.audioEvidence = evaluation.shotSpecs.flatMap((s: any) =>
      soundRequirements(s.directing).map((r) => ({
        shotId: s.shotId,
        requirementId: r.id,
        inspection: 'audio',
        status: 'unreviewed',
        startFrame: 0,
        endFrame: 1,
        speakerId: '',
        text: '',
        notes: '',
      })),
    );
    draft.value.spliceEvidence = [];
    draft.value.dimensions = Object.fromEntries(reviewDimensions.map((d) => [d, 'unreviewed']));
    draft.value.inspected = false;
    draft.value.out = Math.round(draft.value.out * 24) / 24;
    draft.value.in = Math.round(draft.value.in * 24) / 24;
    coverage.value.forEach((c) => {
      c.in = Math.round(c.in * 24) / 24;
      c.out = Math.round(c.out * 24) / 24;
    });
  });
}
async function act(fn: () => Promise<any>) {
  busy.value = true;
  error.value = '';
  try {
    await fn();
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function evidence() {
  await act(async () => {
    const a = await api(`/assets/${video.value!.id}/evidence`, 'POST', {
      revision: video.value!.revision,
      frameIndex: frame.value,
    });
    draft.value.issues.push({
      category: 'props',
      severity: 'warning',
      description: '',
      frameIndex: frame.value,
      evidence: { id: a.id, revision: a.revision },
    });
    draft.value.dimensions.props = 'issues';
  });
}
async function save() {
  await act(async () => {
    const saved = await api(`/projects/${props.job.projectId}/reviews`, 'POST', {
      data: draft.value,
      id: currentReview.value?.id,
      revision: currentReview.value?.revision,
    });
    draft.value = JSON.parse(JSON.stringify(saved.data));
    notice.value = '候选审核已保存，尚未确认剧情状态。';
  });
}
async function select() {
  await act(async () => {
    if (!currentReview.value || !video.value || !episode.value) throw new Error('请先保存候选审核');
    if (JSON.stringify(draft.value) !== JSON.stringify(currentReview.value.data))
      throw new Error('候选审核有未保存修改，请先保存再采用');
    await api(`/projects/${props.job.projectId}/selections`, 'POST', {
      revision: selection.value?.revision,
      data: {
        episode: { id: episode.value.id, revision: episode.value.revision },
        segmentId: props.job.input.segment.id,
        jobId: props.job.id,
        video: { id: video.value.id, revision: video.value.revision },
        review: { id: currentReview.value.id, revision: currentReview.value.revision },
        in: draft.value.in,
        out: draft.value.out,
        volume: 1,
        coverage: coverage.value,
      },
    });
    notice.value = '片段选择已保存；可在剪辑成片中装配。剧情状态仍需单独确认。';
  });
}
</script>
<template>
  <details v-if="job.state === 'succeeded' && job.kind === 'generation' && video" class="panel">
    <summary
      @click="
        () => {
          if (!draft) edit();
        }
      "
    >
      候选审核与片段采用 {{ selection?.data.jobId === job.id ? '· 当前选择' : '' }}
    </summary>
    <template v-if="draft"
      ><p class="error" role="alert" v-if="error">{{ error }}</p>
      <p v-if="notice">{{ notice }}</p>
      <button v-if="!universal" @click="enableObserved">以当前已审核镜头建立生成后观察草稿</button>
      <p v-if="draft.evaluation" class="warning">
        这些要求是生成后显式选定的审核依据。原任务输入和 Prompt
        保持历史记录；模型当时没有收到这份新契约。
      </p>
      <video
        ref="player"
        controls
        :src="assetUrl(video.id, video.revision)"
        @timeupdate="
          frame = Math.min(
            (video.data.frameCount || Infinity) - 1,
            Math.floor((player?.currentTime || 0) * 24),
          )
        "
      />
      <div v-if="universal" class="form-grid">
        <label
          >审核／采用入帧<input
            type="number"
            min="0"
            :max="video.data.frameCount - 1"
            step="1"
            v-model.number="startFrame"
        /></label>
        <label
          >审核／采用出帧（不包含）<input
            type="number"
            min="1"
            :max="video.data.frameCount"
            step="1"
            v-model.number="endFrame"
        /></label>
        <p>
          源媒体共 {{ video.data.frameCount }} 帧；采用 [{{ startFrame }}, {{ endFrame }})，{{
            ((endFrame - startFrame) / 24).toFixed(3)
          }}
          秒。
        </p>
      </div>
      <div v-else class="form-grid">
        <label
          >审核／采用入点<input
            type="number"
            min="0"
            step=".0416667"
            v-model.number="draft.in" /></label
        ><label
          >审核／采用出点<input type="number" step=".0416667" v-model.number="draft.out"
        /></label>
      </div>
      <div class="form-grid">
        <label v-for="d in reviewDimensions"
          >{{ d
          }}<select v-model="draft.dimensions[d]">
            <option value="unreviewed">未检查</option>
            <option value="pass">通过</option>
            <option value="issues">有问题</option>
            <option value="not_applicable">不适用</option>
          </select></label
        >
      </div>
      <div class="actions">
        <label
          >精确证据帧<input
            type="number"
            min="0"
            :max="video.data.frameCount - 1"
            v-model.number="frame" /></label
        ><button :disabled="busy" @click="evidence">提取当前帧并记录问题</button>
      </div>
      <article class="issue" v-for="(i, n) in draft.issues">
        <img
          v-if="i.evidence"
          :src="assetUrl(i.evidence.id, i.evidence.revision)"
          :alt="'证据帧 ' + i.frameIndex"
        />
        <div>
          <p>第 {{ i.frameIndex }} 帧 · {{ (i.frameIndex / 24).toFixed(3) }} 秒</p>
          <label
            >关联镜头<select
              v-model="i.shotId"
              @change="
                delete i.interactionId;
                delete i.eventId;
                delete i.lineId;
              "
            >
              <option :value="undefined">整段问题</option>
              <option
                v-for="s in inspectionJob.input.prepared?.shotSpecs || []"
                :key="s.shotId"
                :value="s.shotId"
              >
                {{ s.shotId }}
              </option>
            </select></label
          >
          <label v-if="i.shotId"
            >关联交互<select v-model="i.interactionId">
              <option :value="undefined">未指定</option>
              <option
                v-for="interaction in inspectionJob.input.prepared?.shotSpecs.find(
                  (s: any) => s.shotId === i.shotId,
                )?.directing?.interactions || []"
                :key="interaction.id"
                :value="interaction.id"
              >
                {{ interaction.id }} · {{ interaction.action }}
              </option>
            </select></label
          >
          <label v-if="i.shotId"
            >关联事件<select v-model="i.eventId">
              <option :value="undefined">未指定</option>
              <option
                v-for="event in inspectionJob.input.prepared?.shotSpecs.find(
                  (s: any) => s.shotId === i.shotId,
                )?.directing?.events || []"
                :key="event.id"
                :value="event.id"
              >
                {{ event.id }} · {{ event.description }}
              </option>
            </select></label
          >
          <label v-if="i.shotId"
            >关联对白<select v-model="i.lineId">
              <option :value="undefined">未指定</option>
              <option
                v-for="line in inspectionJob.input.prepared?.shotSpecs.find(
                  (s: any) => s.shotId === i.shotId,
                )?.directing?.sound?.dialogue || []"
                :key="line.id"
                :value="line.id"
              >
                {{ line.id }} · {{ line.text }}
              </option>
            </select></label
          >
          <select v-model="i.category">
            <option v-for="d in reviewDimensions">{{ d }}</option></select
          ><select v-model="i.severity">
            <option value="note">记录</option>
            <option value="warning">可接受问题</option>
            <option value="blocking">阻断采用</option></select
          ><textarea
            v-model="i.description"
            placeholder="实际观察到的问题，不直接写成剧情事实"
          /><button @click="draft.issues.splice(n, 1)">移除问题</button>
        </div>
      </article>
      <h4 v-if="draft.cueEvidence?.length">动作、对白与表演时序</h4>
      <p v-if="draft.cueEvidence?.length">
        逐项核对实际源帧区间与先后关系。窗口是文字要求，需以成片确认。
      </p>
      <article v-for="cue in draft.cueEvidence || []" :key="cue.shotId + cue.cueId">
        <strong
          >{{ cue.shotId }} · {{ cue.cueId }} ·
          {{ cue.inspection === 'audio' ? '听审' : '运动审看' }}</strong
        ><label>源起帧<input v-model.number="cue.startFrame" type="number" min="0" /></label
        ><label>源止帧<input v-model.number="cue.endFrame" type="number" min="1" /></label
        ><select v-model="cue.status">
          <option value="unreviewed">待审</option>
          <option value="pass">符合</option>
          <option value="issues">存在问题</option></select
        ><textarea v-model="cue.notes" placeholder="实际观察与时序结论" />
      </article>
      <h4 v-if="draft.eventEvidence?.length">预期事件与实际源帧证据</h4>
      <article v-for="e in draft.eventEvidence || []">
        <p>
          {{ e.shotId }} ·
          {{
            inspectionJob.input.prepared?.shotSpecs
              ?.find((s: any) => s.shotId === e.shotId)
              ?.directing?.events.find((v: any) => v.id === e.eventId)?.description
          }}
        </p>
        <div class="form-grid">
          <label v-if="universal"
            >实际观察<select v-model="e.observed">
              <option value="unknown">无法确认</option>
              <option value="occurred">事件发生／持续成立</option>
              <option value="absent">已检查整个区间，禁止事件未发生</option>
            </select></label
          >
          <label
            >结论<select v-model="e.status">
              <option value="unreviewed">未检查</option>
              <option value="pass">通过</option>
              <option value="issues">有问题</option>
            </select></label
          ><label>实际开始源帧<input type="number" v-model.number="e.startFrame" /></label
          ><label>实际结束源帧（不包含）<input type="number" v-model.number="e.endFrame" /></label
          ><label>证据说明<input v-model="e.notes" /></label>
        </div>
        <p>
          {{
            e.inspection === 'audio'
              ? '需实际播放听审'
              : e.inspection === 'motion'
                ? '需连续播放检查，不能仅凭单帧'
                : '可根据单帧检查'
          }}
        </p>
        <button
          @click="
            e.startFrame = frame;
            e.endFrame = frame + 1;
          "
        >
          标记当前源帧（动作事件请另填完整区间）
        </button>
      </article>
      <section v-if="draft.interactionEvidence?.length">
        <h4>交互的实际动作检查</h4>
        <div v-for="e in draft.interactionEvidence" :key="e.shotId + e.interactionId">
          <p>{{ e.shotId }} / {{ e.interactionId }} · 需连续观看</p>
          <label>开始源帧<input type="number" v-model.number="e.startFrame" /></label
          ><label>结束源帧（不含）<input type="number" v-model.number="e.endFrame" /></label
          ><select v-model="e.status">
            <option value="unreviewed">未检查</option>
            <option value="pass">实际动作符合</option>
            <option value="issues">存在问题</option></select
          ><textarea v-model="e.notes" placeholder="实际操作面、接触与动作结果" />
        </div>
      </section>
      <ObservedEvidence v-if="universal" :draft="draft" :job="inspectionJob" />
      <label>审核说明<textarea v-model="draft.notes" /></label
      ><label
        ><input
          type="checkbox"
          v-model="draft.inspected"
        />已实际查看此区间，完成上方分项检查</label
      ><button :disabled="busy || !draft.inspected" @click="save">保存候选审核</button>
      <h4>片段选择</h4>
      <details v-if="selection?.data.boundary">
        <summary>已采用版本的实际边界及观察来源</summary>
        <pre>{{ selection.data.boundary }}</pre>
      </details>
      <p>
        先在资产库采用视频；所用区间必须由审核完整覆盖。多镜头区间按顺序连续覆盖，修改后重新审核。
      </p>
      <div v-for="c in coverage" class="panel">
        <template v-if="universal">
          <strong>{{ c.shotId }}</strong>
          <label
            >镜头入帧<input
              type="number"
              min="0"
              step="1"
              :value="Math.round(c.in * 24)"
              @input="c.in = Number(($event.target as HTMLInputElement).value) / 24"
          /></label>
          <button @click="c.in = frame / 24">用当前源帧作入点</button>
          <label
            >镜头出帧（不包含）<input
              type="number"
              min="1"
              :max="video.data.frameCount"
              step="1"
              :value="Math.round(c.out * 24)"
              @input="c.out = Number(($event.target as HTMLInputElement).value) / 24"
          /></label>
          <button @click="c.out = (frame + 1) / 24">包含当前源帧作为末帧</button>
          <input
            aria-label="镜头出帧滑块"
            type="range"
            :min="Math.round(c.in * 24) + 1"
            :max="video.data.frameCount"
            step="1"
            :value="Math.round(c.out * 24)"
            @input="c.out = Number(($event.target as HTMLInputElement).value) / 24"
          />
        </template>
        <template v-else>
          <strong>{{ c.shotId }}</strong
          ><label
            >入点（秒）<input type="number" step="0.0416667" min="0" v-model.number="c.in" /></label
          ><button @click="c.in = player?.currentTime || 0">用当前播放位置作入点</button
          ><label>出点（秒）<input type="number" step="0.0416667" v-model.number="c.out" /></label
          ><button @click="c.out = player?.currentTime || 0">用当前播放位置作出点</button
          ><input
            aria-label="镜头出点滑块"
            type="range"
            :min="c.in"
            :max="video?.data.duration || 5"
            step="0.0416667"
            v-model.number="c.out"
          />
        </template>
      </div>
      <button class="primary" :disabled="busy || !currentReview" @click="select">
        确认片段选择
      </button></template
    >
  </details>
</template>
<style scoped>
video {
  width: 100%;
  max-width: 760px;
}
.issue {
  display: flex;
  gap: 16px;
  margin: 16px 0;
}
.issue img {
  width: 200px;
  object-fit: contain;
}
.issue > div {
  flex: 1;
}
</style>
