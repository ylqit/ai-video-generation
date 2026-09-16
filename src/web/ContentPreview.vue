<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { api, assetUrl } from './api';
import AuthoringRead from './AuthoringRead.vue';
const props = defineProps<{
  record: any;
  candidates?: any[];
  initialCandidate?: string;
  focus?: { type: string; id: string } | null;
}>();
const emit = defineEmits([
  'close',
  'discuss',
  'edit',
  'handoff',
  'bind',
  'reviewEdit',
  'review',
  'inspect',
  'candidate',
]);
const dialog = ref<HTMLElement>(),
  selected = ref(props.initialCandidate || props.candidates?.[0]?.id || ''),
  compare = ref('');
const context = ref<any>(null),
  objectFocus = ref(props.focus || null);
const record = ref(props.record),
  history = ref<any[]>([]),
  error = ref(''),
  detail = ref(false),
  zoom = ref(1);
const candidateDetails = ref<Record<string, any>>({});
const candidate = computed(
  () =>
    candidateDetails.value[selected.value] ||
    props.candidates?.find((c) => c.id === selected.value),
);
const second = computed(
  () =>
    candidateDetails.value[compare.value] || props.candidates?.find((c) => c.id === compare.value),
);
watch(
  () => [selected.value, compare.value],
  async (ids) => {
    for (const id of ids) {
      const summary = props.candidates?.find((c) => c.id === id);
      if (!summary?.detailPending || candidateDetails.value[id]) continue;
      try {
        candidateDetails.value[id] = await api(
          `/projects/${summary.video?.projectId || props.record.projectId}/candidates/${id}`,
        );
      } catch (e: any) {
        error.value = e.message;
      }
    }
  },
  { immediate: true },
);
const asset = computed(
  () => candidate.value?.video || (record.value?.kind === 'asset' ? record.value : null),
);
const storageStatus = ref('available');
watch(
  asset,
  async (value) => {
    storageStatus.value = 'available';
    if (!value) return;
    try {
      const result = await api(`/assets/${value.id}/storage?revision=${value.revision}`);
      if (asset.value?.id === value.id && asset.value?.revision === value.revision)
        storageStatus.value = result.status;
    } catch (e: any) {
      error.value = e.message;
    }
  },
  { immediate: true },
);
async function restoreCurrentAsset() {
  if (!asset.value) return;
  try {
    await api(`/assets/${asset.value.id}/restore`, 'POST', { revision: asset.value.revision });
    storageStatus.value = 'available';
  } catch (e: any) {
    error.value = e.message;
  }
}
const body = computed(() => record.value?.data?.result || record.value?.data || {});
const title = computed(() =>
  candidate.value
    ? `${candidate.value.label} · 候选审看`
    : objectFocus.value?.type === 'shot'
      ? `${String(body.value.shots?.findIndex((s: any) => s.id === objectFocus.value?.id) + 1).padStart(2, '0')} · ${body.value.shots?.find((s: any) => s.id === objectFocus.value?.id)?.purpose || '镜头引用缺失'}`
      : objectFocus.value?.type === 'scene'
        ? body.value.scenes?.find((s: any) => s.id === objectFocus.value?.id)?.title ||
          '场景引用缺失'
        : objectFocus.value?.type === 'subject'
          ? body.value.subjects?.find((s: any) => s.key === objectFocus.value?.id)?.name ||
            '主体引用缺失'
          : body.value.title || body.value.name || record.value?.title || '内容预览',
);
const firstVideo = ref<HTMLVideoElement>(),
  secondVideo = ref<HTMLVideoElement>(),
  currentFrame = ref(0),
  evidenceError = ref(''),
  evidenceBusy = ref(false);
const evidence = ref<any[]>([]);
watch(
  candidate,
  () => {
    evidence.value = candidate.value?.evidence || [];
  },
  { immediate: true },
);
const previousFocus = document.activeElement as HTMLElement | null;
const url = (a: any) => assetUrl(a.id, a.revision);
const fps = computed(() => asset.value?.data?.fps || 24);
const mediaSeconds = (a: any) =>
  a?.data?.duration || a?.data?.metadata?.duration || a?.data?.probe?.duration;
async function historyList() {
  try {
    history.value = await api('/records/' + record.value.id + '/history');
  } catch (e: any) {
    error.value = e.message;
  }
}
async function historyVersion(revision: number) {
  try {
    record.value = await api(`/records/${record.value.id}?revision=${revision}`);
  } catch (e: any) {
    error.value = e.message;
  }
}
async function saveEvidence() {
  if (!asset.value) return;
  evidenceBusy.value = true;
  try {
    const frame = await api(`/assets/${asset.value.id}/evidence`, 'POST', {
      revision: asset.value.revision,
      frameIndex: currentFrame.value,
    });
    if (!evidence.value.some((a) => a.id === frame.id))
      evidence.value.push({ ...frame, cleared: false, issues: [], pinned: false });
  } catch (e: any) {
    evidenceError.value = e.message;
  } finally {
    evidenceBusy.value = false;
  }
}
function locate(frame: number) {
  if (firstVideo.value) {
    firstVideo.value.pause();
    firstVideo.value.currentTime = frame / fps.value;
    currentFrame.value = frame;
  }
}
async function restoreEvidence(a: any) {
  try {
    await api(`/assets/${a.id}/restore`, 'POST', { revision: a.revision });
    a.cleared = false;
  } catch (e: any) {
    evidenceError.value = e.message;
  }
}
function step(amount: number) {
  const video = firstVideo.value;
  if (!video) return;
  video.pause();
  video.currentTime = Math.max(
    0,
    Math.min(video.duration || 0, (Math.round(video.currentTime * fps.value) + amount) / fps.value),
  );
  if (secondVideo.value) {
    secondVideo.value.pause();
    secondVideo.value.currentTime = video.currentTime;
  }
}
async function syncPlay() {
  try {
    if (!firstVideo.value) return;
    if (secondVideo.value) {
      secondVideo.value.currentTime = firstVideo.value.currentTime;
      secondVideo.value.muted = true;
    }
    await Promise.all([firstVideo.value.play(), secondVideo.value?.play()]);
  } catch (e: any) {
    error.value = '播放尚未准备好：' + e.message;
  }
}
function keyboard(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    emit('close');
  }
  if (e.key !== 'Tab' || !dialog.value) return;
  const elements = [
    ...dialog.value.querySelectorAll<HTMLElement>(
      'button:not(:disabled),a[href],input,textarea,select,video,audio,[tabindex="0"]',
    ),
  ].filter((el) => el.getClientRects().length);
  const first = elements[0],
    last = elements.at(-1);
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last?.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first?.focus();
  }
}
watch(selected, () => {
  currentFrame.value = 0;
  firstVideo.value?.pause();
  secondVideo.value?.pause();
  if (selected.value === compare.value) compare.value = '';
});
async function loadContext() {
  if (record.value?.kind !== 'authoring_result') return;
  const ref = record.value;
  try {
    const data = await api(
      `/projects/${ref.projectId}/workspace-records/${ref.id}?revision=${ref.revision}&detail=true`,
    );
    if (record.value.id === ref.id && record.value.revision === ref.revision) context.value = data;
  } catch (e: any) {
    error.value = e.message;
  }
}
function selection() {
  return {
    record: record.value,
    title: title.value,
    context: context.value,
    ...(objectFocus.value?.type === 'shot' ? { shotId: objectFocus.value.id } : {}),
    ...(objectFocus.value?.type === 'scene' ? { sceneId: objectFocus.value.id } : {}),
    ...(objectFocus.value?.type === 'subject' ? { subjectKey: objectFocus.value.id } : {}),
  };
}
watch(record, () => {
  context.value = null;
  void loadContext();
});
onMounted(() => {
  void loadContext();
  nextTick(() => dialog.value?.focus());
});
onBeforeUnmount(() => {
  firstVideo.value?.pause();
  secondVideo.value?.pause();
  previousFocus?.focus();
});
</script>

<template>
  <div class="modal-backdrop preview-backdrop" @click.self="emit('close')">
    <section
      ref="dialog"
      class="content-preview"
      role="dialog"
      aria-modal="true"
      :aria-label="title"
      tabindex="-1"
      @keydown="keyboard"
    >
      <header class="preview-heading">
        <div>
          <small>{{
            candidate
              ? '实际生成媒体 · 尚未因预览而采用'
              : record?.kind === 'authoring_result'
                ? '创作成果'
                : '固定版本内容'
          }}</small>
          <h2>{{ title }}</h2>
        </div>
        <div class="toolbar">
          <button v-if="!candidate" @click="emit('discuss', selection())">讨论这个内容</button
          ><button
            v-if="record?.kind === 'authoring_result' && !candidate"
            @click="emit('edit', selection())"
          >
            编辑</button
          ><button @click="emit('close')" aria-label="关闭预览">×</button>
        </div>
      </header>
      <div v-if="error" role="alert" class="error">{{ error }}</div>
      <div v-if="candidates?.length" class="candidate-tabs">
        <button
          v-for="c in candidates"
          :key="c.id"
          :class="{ active: selected === c.id }"
          @click="selected = c.id"
        >
          {{ c.label }} <small>{{ c.video ? '原片' : c.state }}</small></button
        ><label
          >并排比较<select v-model="compare">
            <option value="">关闭</option>
            <option
              v-for="c in candidates.filter((c) => c.id !== selected && c.video)"
              :key="c.id"
              :value="c.id"
            >
              {{ c.label }}
            </option>
          </select></label
        >
      </div>
      <div class="preview-body">
        <section v-if="asset && storageStatus !== 'available'" class="empty-state">
          <h3>{{ storageStatus === 'cleared' ? '文件已清理' : '文件缺失' }}</h3>
          <p>来源与版本记录保留，普通读取不会重建文件。</p>
          <button v-if="storageStatus === 'cleared'" @click="restoreCurrentAsset">恢复文件</button>
        </section>
        <template v-else-if="asset">
          <div v-if="asset.data.mediaType === 'image'" class="image-viewer">
            <img :src="url(asset)" :alt="title" :style="{ transform: `scale(${zoom})` }" />
            <div class="image-zoom">
              <button @click="zoom = Math.max(0.25, zoom - 0.25)" aria-label="缩小图片">−</button
              ><span>{{ Math.round(zoom * 100) }}%</span
              ><button @click="zoom = Math.min(4, zoom + 0.25)" aria-label="放大图片">＋</button
              ><button @click="zoom = 1">适合窗口</button>
            </div>
          </div>
          <div
            v-else-if="asset.data.mediaType === 'video'"
            class="video-comparison"
            :class="{ comparing: second?.video }"
          >
            <div>
              <video
                ref="firstVideo"
                :key="url(asset)"
                :src="url(asset)"
                controls
                playsinline
                preload="metadata"
                @timeupdate="
                  currentFrame = Math.round(($event.target as HTMLVideoElement).currentTime * fps)
                "
              /><span>{{ candidate?.label || asset.data.name }} · 原音开启</span>
            </div>
            <div v-if="second?.video">
              <video
                ref="secondVideo"
                :key="url(second.video)"
                :src="url(second.video)"
                controls
                muted
                playsinline
                preload="metadata"
              /><span>{{ second.label }} · 静音比较</span>
            </div>
          </div>
          <div v-else-if="asset.data.mediaType === 'audio'" class="audio-preview">
            <span class="audio-art">♫</span>
            <h3>{{ asset.data.name }}</h3>
            <audio :key="url(asset)" :src="url(asset)" controls preload="metadata" />
            <p>
              {{
                mediaSeconds(asset)
                  ? `${Number(mediaSeconds(asset)).toFixed(2)} 秒`
                  : '载入后显示实际时长'
              }}
              · {{ asset.data.category || '导入音频' }}
            </p>
            <p>听审状态取自人工审核记录。</p>
          </div>
          <div v-if="asset.data.mediaType === 'video'" class="frame-tools">
            <button :disabled="evidenceBusy" @click="saveEvidence">保存当前帧为证据</button
            ><span v-if="evidenceError" role="alert">{{ evidenceError }}</span>
            <button @click="step(-1)">← 前一帧</button
            ><output>第 {{ currentFrame }} 帧 · {{ (currentFrame / fps).toFixed(3) }} 秒</output
            ><button @click="step(1)">后一帧 →</button
            ><button v-if="second?.video" @click="syncPlay">同步播放（辅助比较）</button
            ><button v-if="candidate" @click="emit('review', { candidate, frame: currentFrame })">
              在此标注问题
            </button>
          </div>
          <div class="media-metadata">
            <span
              >{{ asset.data.width || asset.data.metadata?.width }} ×
              {{ asset.data.height || asset.data.metadata?.height }}</span
            ><span v-if="mediaSeconds(asset)"
              >实际 {{ Number(mediaSeconds(asset)).toFixed(2) }} 秒</span
            ><a :href="url(asset)" target="_blank" rel="noopener">打开原文件 ↗</a
            ><button v-if="asset.data.mediaType !== 'video'" @click="emit('bind', asset)">
              作为参考
            </button>
          </div>
          <section v-if="candidate" class="candidate-evidence">
            <div>
              <h3>关联声音</h3>
              <audio
                v-if="candidate.audio"
                :key="url(candidate.audio)"
                :src="url(candidate.audio)"
                controls
                preload="metadata"
              />
              <p v-else>尚无已归档原音</p>
              <button @click="emit('reviewEdit', candidate)">加入审看编辑</button>
            </div>
            <div>
              <h3>审看版</h3>
              <div v-for="output in candidate.exports" :key="output.id" class="review-output">
                <video :src="url(output)" controls playsinline preload="none" /><span
                  >{{ output.data.name || '字幕审看版' }} · {{ output.data.width }} ×
                  {{ output.data.height }}</span
                >
              </div>
              <p v-if="!candidate.exports?.length">尚无审看导出</p>
            </div>
            <div>
              <h3>证据与问题</h3>
              <div class="evidence-grid">
                <article v-for="a in evidence.filter((a) => a.pinned)" :key="a.id">
                  <img v-if="!a.cleared" :src="url(a)" :alt="a.data.name" />
                  <p>{{ a.data.name }} · {{ (a.data.frameIndex / fps).toFixed(2) }} 秒</p>
                  <p v-for="(i, n) in a.issues" :key="n">{{ i.description }}</p>
                  <button @click="locate(a.data.frameIndex)">定位原片</button>
                </article>
              </div>
              <details>
                <summary>其他过程附件 {{ evidence.filter((a) => !a.pinned).length }}</summary>
                <div class="evidence-grid">
                  <article v-for="a in evidence.filter((a) => !a.pinned)" :key="a.id">
                    <img v-if="!a.cleared" :src="url(a)" :alt="a.data.name" loading="lazy" />
                    <p>{{ a.data.name }} · {{ a.cleared ? '文件已清理' : '已归档附件' }}</p>
                    <button v-if="a.cleared" @click="restoreEvidence(a)">恢复文件</button
                    ><button @click="locate(a.data.frameIndex || 0)">定位原片</button
                    ><button v-if="!a.cleared" @click="emit('bind', a)">作为参考</button>
                  </article>
                </div>
              </details>
              <button @click="emit('inspect', candidate.id)">逐项审核与采用</button>
              <p v-if="!candidate.review">待审看。任务完成不代表成片通过。</p>
              <template v-else
                ><p>
                  {{
                    candidate.review.data.conclusion ||
                    candidate.review.data.summary ||
                    '已有逐项记录，部分项目仍需实际审看。'
                  }}
                </p>
                <ul v-if="candidate.review.data.issues">
                  <li v-for="(issue, i) in candidate.review.data.issues" :key="i">
                    {{ typeof issue === 'string' ? issue : issue.description || issue.message }}
                  </li>
                </ul>
                <details>
                  <summary>完整审核依据</summary>
                  <pre>{{ JSON.stringify(candidate.review.data, null, 2) }}</pre>
                </details></template
              >
            </div>
          </section>
        </template>
        <AuthoringRead
          v-else-if="record?.kind === 'authoring_result'"
          :record="record"
          :context="context"
          :focus="objectFocus"
          @navigate="objectFocus = $event"
          @edit="emit('edit', $event)"
          @handoff="emit('handoff', $event)"
          @candidate="emit('candidate', $event.id)"
        />
        <article v-else class="reading-view">
          <p>
            {{
              body.content ||
              body.text ||
              body.narrative ||
              body.description ||
              body.prompt ||
              body.action ||
              body.request ||
              '尚未提供可阅读正文'
            }}
          </p>
        </article>
        <details
          v-if="record?.id && !candidate"
          class="object-history"
          @toggle="detail = ($event.target as HTMLDetailsElement).open"
        >
          <summary>来源与对象记录</summary>
          <template v-if="detail"
            ><p>
              来源版本：{{ record.revision }} · {{ new Date(record.updatedAt).toLocaleString() }}
            </p>
            <button @click="historyList">查看历史版本</button
            ><button
              v-for="item in history"
              :key="item.revision"
              @click="historyVersion(item.revision)"
            >
              版本 {{ item.revision }}
            </button>
            <details>
              <summary>数据与完整执行依据</summary>
              <pre>{{ JSON.stringify(record.data, null, 2) }}</pre>
            </details></template
          >
        </details>
      </div>
    </section>
  </div>
</template>
