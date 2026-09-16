<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { creationStageLabels } from '../shared/creation';
import { api } from './api';
const props = defineProps<{ snapshot: WorkspaceSnapshot; references: any[]; episodeId?: string }>();
const emit = defineEmits([
  'removeRef',
  'refresh',
  'open',
  'created',
  'close',
  'approve',
  'sourceImported',
]);
const request = ref(''),
  mode = ref<'discuss' | 'revise' | 'execute'>('discuss'),
  stage = ref('script'),
  action = ref('prepare_scope'),
  error = ref(''),
  busy = ref(false),
  sourceOpen = ref(false),
  sourceText = ref('');
const running = computed(() =>
  props.snapshot.jobs.filter(
    (j) => j.kind === 'creative' && ['queued', 'running', 'preparing'].includes(j.state),
  ),
);
const drafts = computed(() =>
  Object.values(props.snapshot.results).filter((r) => r && !r.data.adopted && !r.data.stale),
);
const allowedStages = computed(() => Object.keys(props.snapshot.results));
async function send() {
  if (!request.value.trim() || busy.value) return;
  busy.value = true;
  error.value = '';
  const owner = `${props.snapshot.project.id}:${props.episodeId || ''}:${props.snapshot.run?.id || ''}`;
  const submitted = request.value;
  try {
    if (!props.snapshot.run) {
      const run = await api(`/projects/${props.snapshot.project.id}/creation-runs`, 'POST', {
        request: submitted,
        ...(props.episodeId ? { episodeId: props.episodeId } : {}),
        sources: props.references.map(({ id, revision }) => ({ id, revision })),
        idempotencyKey: crypto.randomUUID(),
      });
      if (
        owner !==
        `${props.snapshot.project.id}:${props.episodeId || ''}:${(props.snapshot.run as WorkspaceSnapshot['run'])?.id || ''}`
      )
        return;
      emit('created', run.id);
    } else {
      const scoped = props.references.filter((r) => r.shotId || r.sceneId);
      const baseline = scoped[0];
      if (
        mode.value === 'revise' &&
        scoped.some((r) => r.id !== baseline.id || r.revision !== baseline.revision)
      )
        throw new Error('一次局部修订只针对同一份专业方案；请移除其他方案的镜头或场景标签后提交');
      const result = await api(`/creation-runs/${props.snapshot.run.id}/messages`, 'POST', {
        revision: props.snapshot.run.revision,
        mode: mode.value,
        request: submitted,
        references: props.references.map(({ id, revision, shotId, sceneId, subjectKey }) => ({
          id,
          revision,
          ...(subjectKey ? { subjectKey } : {}),
          ...(shotId ? { shotId } : {}),
          ...(sceneId ? { sceneId } : {}),
        })),
        idempotencyKey: crypto.randomUUID(),
        ...(mode.value === 'revise'
          ? {
              stage: baseline?.shotId ? 'director' : baseline?.sceneId ? 'script' : stage.value,
              ...(baseline
                ? {
                    writable: {
                      baseline: { id: baseline.id, revision: baseline.revision },
                      shotIds: [...new Set(scoped.flatMap((r) => (r.shotId ? [r.shotId] : [])))],
                      sceneIds: [...new Set(scoped.flatMap((r) => (r.sceneId ? [r.sceneId] : [])))],
                    },
                  }
                : {}),
            }
          : {}),
        ...(mode.value === 'execute' ? { action: { type: action.value } } : {}),
      });
      if (
        owner !==
        `${props.snapshot.project.id}:${props.episodeId || ''}:${props.snapshot.run?.id || ''}`
      )
        return;
      if (result.run?.id) emit('created', result.run.id);
    }
    if (request.value === submitted) request.value = '';
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function importSource() {
  busy.value = true;
  error.value = '';
  try {
    const source = await api(`/projects/${props.snapshot.project.id}/sources`, 'POST', {
      title: '导入剧本资料',
      text: sourceText.value,
    });
    emit('sourceImported', source);
    sourceText.value = '';
    sourceOpen.value = false;
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function fileSource(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) sourceText.value = await file.text();
}
</script>
<template>
  <div class="assistant-panel">
    <header>
      <div class="assistant-avatar">✧</div>
      <div><strong>创作助手</strong><small>围绕具体成果，一起推进作品</small></div>
      <button class="icon-button" @click="emit('close')" aria-label="收起创作助手">→</button>
    </header>
    <div class="conversation" aria-live="polite" aria-label="创作会话">
      <div class="assistant-intro">
        <span class="mini-label">WORKSPACE ASSISTANT</span>
        <h2>{{ snapshot.run ? '继续这部作品' : '想创作怎样的故事？' }}</h2>
        <p>
          {{
            snapshot.candidates.length
              ? '已有候选可以直接审看和比较。选中具体内容后，点击“讨论”加入固定版本引用。'
              : '描述创作目标，或带入已有资料。需求、剧本、导演安排和素材会逐步形成可预览的成果。'
          }}
        </p>
        <div class="suggestions">
          <button
            @click="
              mode = 'discuss';
              request = '根据当前已有成果，说明下一步需要处理的具体问题。';
            "
          >
            梳理下一步</button
          ><button @click="sourceOpen = true">导入已有剧本</button>
        </div>
      </div>
      <article
        v-for="message in snapshot.messages"
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <div class="message-meta">
          <span>{{ message.role === 'user' ? '你' : 'Studio' }}</span
          ><time>{{
            new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          }}</time
          ><span v-if="message.mode">{{
            { discuss: '讨论', revise: '修订', execute: '执行' }[message.mode as string] ||
            message.mode
          }}</span>
        </div>
        <p>{{ message.text }}</p>
        <button
          v-for="link in (message as any).resultLinks || []"
          :key="link.id"
          class="message-result"
          @click="emit('open', link)"
        >
          {{ link.title || '查看成果' }} ↗
        </button>
      </article>
      <article v-for="job in running" :key="job.id" class="message assistant progress-message">
        <span class="live-dot"></span
        >{{ job.state === 'queued' ? '文字任务已排队' : '文字任务执行中'
        }}<small>{{ creationStageLabels[job.stage] || '对象讨论' }}</small>
      </article>
      <article v-for="draft in drafts" :key="draft!.id" class="draft-result">
        <small>{{ creationStageLabels[draft!.data.stage] }} · 新草稿</small>
        <h3>{{ draft!.data.result.title }}</h3>
        <p>{{ draft!.data.result.summary }}</p>
        <div>
          <button @click="emit('open', draft)">查看成果</button
          ><button class="primary" @click="emit('approve', draft)">采用此方案</button>
        </div>
      </article>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
    </div>
    <form class="assistant-composer" @submit.prevent="send">
      <div v-if="references.length" class="context-chips">
        <button
          v-for="(reference, index) in references"
          :key="`${reference.id}:${reference.revision}:${reference.shotId || ''}`"
          type="button"
          @click="emit('removeRef', index)"
          :title="reference.title"
        >
          {{ reference.title }}{{ reference.shotId ? ' · 本镜' : '' }} ×
        </button>
      </div>
      <div class="composer-modes">
        <button
          v-for="[id, label] in [
            ['discuss', '讨论'],
            ['revise', '修订'],
            ['execute', '执行'],
          ]"
          :key="id"
          type="button"
          :class="{ active: mode === id }"
          @click="mode = id as any"
        >
          {{ label }}</button
        ><span>{{
          mode === 'discuss'
            ? '讨论保留现有成果'
            : mode === 'revise'
              ? '生成新草稿'
              : '按选定操作推进'
        }}</span>
      </div>
      <label v-if="mode === 'revise'" class="composer-choice"
        >修订阶段<select v-model="stage">
          <option v-for="id in allowedStages" :key="id" :value="id">
            {{ creationStageLabels[id] }}
          </option>
        </select></label
      ><label v-if="mode === 'execute'" class="composer-choice"
        >操作<select v-model="action">
          <option value="prepare_scope">准备当前范围的生成预览</option>
          <option value="pause">暂停后续推进</option>
          <option value="resume">恢复后续推进</option>
        </select></label
      ><textarea
        v-model="request"
        rows="4"
        :placeholder="
          mode === 'discuss'
            ? '讨论故事、画面或具体候选…'
            : mode === 'revise'
              ? '描述需要修改的内容与范围…'
              : '补充本次执行要求…'
        "
        aria-label="创作指令"
        @keydown.ctrl.enter.prevent="send"
      />
      <div class="composer-footer">
        <span>Ctrl + Enter 发送</span
        ><button
          class="primary send-button"
          :disabled="busy || !request.trim()"
          aria-label="发送创作指令"
        >
          ↑
        </button>
      </div>
    </form>
    <div v-if="sourceOpen" class="modal-backdrop" @click.self="sourceOpen = false">
      <form
        class="dialog"
        v-dialog-focus="() => (sourceOpen = false)"
        @submit.prevent="importSource"
      >
        <header>
          <h2>导入剧本资料</h2>
          <button type="button" @click="sourceOpen = false">×</button>
        </header>
        <label>读取文本文件<input type="file" accept=".txt,.md" @change="fileSource" /></label
        ><label>剧本正文<textarea v-model="sourceText" rows="12" /></label>
        <p>来源会保存为作品资料；将具体来源加入会话后再用于创作。</p>
        <footer>
          <button type="button" @click="sourceOpen = false">取消</button
          ><button class="primary" :disabled="busy || !sourceText.trim()">保存资料</button>
        </footer>
      </form>
    </div>
  </div>
</template>
<style scoped>
.assistant-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.assistant-panel > header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--line);
  flex-shrink: 0;
}
.assistant-avatar {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  background: #f0eefc;
  color: #8b82c1;
  display: grid;
  place-items: center;
  font-size: 23px;
}
.assistant-panel header strong {
  font-size: 12px;
}
.assistant-panel header small {
  display: block;
  font-size: 10px;
  margin-top: 4px;
}
.assistant-panel header > button {
  margin-left: auto;
}
.conversation {
  flex: 1;
  overflow: auto;
  padding: 23px 22px;
  scrollbar-width: thin;
}
.mini-label {
  font-size: 8px;
  letter-spacing: 1.5px;
  color: #b0adca;
}
.assistant-intro h2 {
  font-size: 19px;
  margin: 12px 0;
}
.assistant-intro p {
  font-size: 12px;
  color: #8b8fa3;
  line-height: 1.9;
}
.suggestions {
  display: flex;
  gap: 7px;
  margin: 18px 0 28px;
  flex-wrap: wrap;
}
.suggestions button {
  font-size: 10px;
  border-radius: 18px;
  padding: 6px 10px;
  color: #8a869f;
}
.message {
  margin: 0 0 22px;
  max-width: 100%;
}
.message-meta {
  display: flex;
  gap: 9px;
  align-items: center;
  color: #9fa2b4;
  font-size: 9px;
  margin-bottom: 8px;
}
.message-meta > span:first-child {
  font-weight: 600;
  color: #6f728a;
}
.message p {
  font-size: 12px;
  color: #666c85;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 0;
  line-height: 1.85;
}
.message.user {
  padding: 13px 15px;
  background: #f4f4fa;
  border-radius: 10px;
  margin-left: 20px;
}
.message.user p {
  color: #575c75;
}
.message-result {
  display: block;
  margin-top: 9px;
  font-size: 11px;
  text-align: left;
  color: var(--accent);
  max-width: 100%;
  white-space: normal;
}
.progress-message {
  color: #8a85b4;
  font-size: 11px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.progress-message small {
  margin-left: auto;
  font-size: 10px;
}
.live-dot {
  height: 5px;
  width: 5px;
  display: inline-block;
  border-radius: 50%;
  background: #a49cde;
}
.draft-result {
  border: 1px solid #dedbf2;
  border-radius: 9px;
  padding: 15px;
  margin-bottom: 18px;
  background: #fdfcff;
}
.draft-result small {
  font-size: 10px;
}
.draft-result h3 {
  font-size: 13px;
  margin: 8px 0;
}
.draft-result p {
  font-size: 11px;
  color: #8b8fa3;
}
.draft-result > div {
  display: flex;
  gap: 8px;
}
.draft-result button {
  font-size: 10px;
}
.assistant-composer {
  margin: 0 16px 16px;
  padding: 11px;
  border: 1px solid #dddfe9;
  border-radius: 11px;
  background: #fff;
  box-shadow: 0 3px 15px #282d5207;
  flex-shrink: 0;
}
.composer-modes {
  display: flex;
  align-items: center;
  gap: 3px;
}
.composer-modes button {
  font-size: 10px;
  border: 0;
  padding: 4px 9px;
  min-height: 25px;
  background: none;
  color: #9598ab;
}
.composer-modes button.active {
  color: #7870b4;
  background: #f1effb;
  border-radius: 6px;
}
.composer-modes > span {
  font-size: 9px;
  color: #babccc;
  margin-left: auto;
}
.assistant-composer textarea {
  border: 0;
  box-shadow: none;
  resize: vertical;
  width: 100%;
  font-size: 12px;
  line-height: 1.8;
  padding: 13px 4px 6px;
  min-height: 75px;
  max-height: 220px;
}
.assistant-composer textarea::placeholder {
  color: #b5b7c6;
}
.composer-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 9px;
  color: #b0b3c6;
}
.send-button {
  width: 29px;
  height: 29px;
  min-height: 29px;
  padding: 0;
  font-size: 19px;
  border-radius: 7px;
}
.context-chips {
  display: flex;
  gap: 5px;
  flex-wrap: wrap;
  margin-bottom: 8px;
}
.context-chips button {
  font-size: 9px;
  padding: 4px 7px;
  max-width: 250px;
  overflow: hidden;
  text-overflow: ellipsis;
  background: #f0eefb;
  color: #8b84b5;
  border: 0;
}
.composer-choice {
  flex-direction: row;
  align-items: center;
  font-size: 10px;
  margin: 8px 0 0;
}
.composer-choice select {
  font-size: 10px;
  padding: 4px 6px;
  flex: 1;
}
.conversation .error {
  font-size: 11px;
}
</style>
