<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { assetUrl } from './api';
import StoryboardRehearsal from './StoryboardRehearsal.vue';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['preview', 'edit', 'scope', 'candidate', 'discuss', 'handoff']);
const mode = ref('cards'),
  selected = ref<string[]>([]);
const director = computed(() => props.snapshot.results.director);
const script = computed(() => props.snapshot.results.script?.data.result);
const shots = computed(() => {
  let start = 0;
  return (director.value?.data.result.shots || []).map((shot: any, index: number) => {
    const startFrame = start;
    start += shot.frames;
    const scene = script.value?.scenes.find((s: any) => s.id === shot.sceneId);
    const requirements = props.snapshot.requirements.filter((r) => r.shotIds.includes(shot.id));
    const imageRef = requirements.find(
      (r) => ['composition', 'action_start'].includes(r.purpose) && r.binding,
    )?.binding?.asset;
    return {
      ...shot,
      index,
      startFrame,
      endFrame: start,
      scene,
      requirements,
      imageRef,
      dialogue: (scene?.dialogue || []).filter((d: any) =>
        shot.dialogue.some((p: any) => p.lineId === d.id),
      ),
      candidates: props.snapshot.candidates.filter((c) => c.shotIds.includes(shot.id)),
      inScope: props.snapshot.scope?.data.shotIds.includes(shot.id),
    };
  });
});
const name = (key: string) => script.value?.subjects.find((s: any) => s.key === key)?.name || key;
function toggleAll() {
  selected.value =
    selected.value.length === shots.value.length ? [] : shots.value.map((s: any) => s.id);
}
</script>

<template>
  <section class="storyboard-view">
    <StoryboardRehearsal :snapshot="snapshot" />
    <header class="view-toolbar">
      <div class="segmented">
        <button :class="{ active: mode === 'cards' }" @click="mode = 'cards'">镜头卡</button
        ><button :class="{ active: mode === 'table' }" @click="mode = 'table'">紧凑表格</button>
      </div>
      <span>{{ shots.length }} 镜 · 计划 {{ snapshot.timing.totalFrames / 24 }} 秒</span
      ><button @click="toggleAll">
        {{ selected.length === shots.length ? '取消全选' : '全选' }}</button
      ><button class="primary" :disabled="!selected.length" @click="emit('scope', selected)">
        选择制作范围 {{ selected.length || '' }}</button
      ><button v-if="director" @click="emit('edit', { record: director })">
        调整顺序与导演计划
      </button>
    </header>
    <div v-if="!shots.length" class="empty-state">
      <h2>导演计划尚未完成</h2>
      <p>已有剧本仍可从资源画布阅读和编辑。</p>
    </div>
    <div v-else-if="mode === 'cards'" class="shot-grid">
      <article
        v-for="shot in shots"
        :key="shot.id"
        class="shot-card"
        :class="{ 'in-scope': shot.inScope }"
      >
        <header>
          <label class="check"
            ><input
              v-model="selected"
              type="checkbox"
              :value="shot.id"
              :aria-label="`选择镜头 ${shot.index + 1}`"
            /><strong>{{ String(shot.index + 1).padStart(2, '0') }}</strong></label
          ><span>{{ shot.startFrame / 24 }}–{{ shot.endFrame / 24 }} 秒</span
          ><span v-if="shot.inScope" class="status-tag">本次范围</span>
        </header>
        <div class="shot-picture">
          <img
            v-if="shot.imageRef"
            :src="assetUrl(shot.imageRef.id, shot.imageRef.revision)"
            :alt="shot.purpose"
            loading="lazy"
          />
          <div v-else>
            <span>▧</span>
            <p>
              {{
                shot.requirements.some((r: any) =>
                  ['composition', 'action_start'].includes(r.purpose),
                )
                  ? '执行要求的构图参考待准备'
                  : shot.interactions?.some((i: any) => i.required)
                    ? '可补充交互构图参考'
                    : '当前方案不要求构图图'
              }}
            </p>
            <small>故事规划已保存 · 未生成</small>
          </div>
        </div>
        <div class="shot-content">
          <small>{{ shot.scene?.title }}</small>
          <h3>{{ shot.scene?.title || shot.purpose }}</h3>
          <p class="shot-action">{{ shot.action }}</p>
          <div class="subject-tags">
            <span v-for="key in shot.visibleSubjectKeys" :key="key">{{ name(key) }}</span>
          </div>
          <blockquote v-for="line in shot.dialogue" :key="line.id">
            <strong>{{ name(line.speakerKey) }}</strong>
            <p>{{ line.text }}</p>
            <p v-if="line.translation" class="translation">{{ line.translation }}</p>
          </blockquote>
          <dl>
            <dt>镜头任务</dt>
            <dd>{{ shot.purpose }}</dd>
            <dt>观众注意</dt>
            <dd>{{ shot.audienceFocus || '未声明' }}</dd>
            <dt>信息变化</dt>
            <dd>{{ shot.informationChange || '未声明' }}</dd>
            <dt>切出理由</dt>
            <dd>{{ shot.cutReason || '未声明' }}</dd>
            <dt>机位</dt>
            <dd>
              {{ shot.camera.shotSize }} · {{ shot.camera.position }} ·
              {{ shot.camera.composition }}
            </dd>
            <dt>表演</dt>
            <dd>
              {{ shot.performances.map((p: any) => p.visible).join('；') || '尚未填写分项表演' }}
            </dd>
          </dl>
          <details>
            <summary>完整导演安排、状态与参考</summary>
            <p>镜头任务：{{ shot.purpose }}</p>
            <p>{{ shot.action }}</p>
            <p>
              机位：{{ shot.camera.position }}；{{ shot.camera.composition }}；{{
                shot.camera.motion
              }}
            </p>
            <p>
              表演：{{
                shot.performances.map((p: any) => p.visible).join('；') || '尚未填写分项表演'
              }}
            </p>
            <p>
              入口：{{
                shot.entryState
                  .map((s: any) => `${name(s.subjectKey)} ${s.key}: ${s.value}`)
                  .join('；') || '尚未声明'
              }}
            </p>
            <p>
              出口：{{
                shot.exitState
                  .map((s: any) => `${name(s.subjectKey)} ${s.key}: ${s.value}`)
                  .join('；') || '尚未声明'
              }}
            </p>
            <p v-for="r in shot.requirements" :key="r.id">
              {{ r.description }} · {{ r.binding ? '已绑定' : '待制作'
              }}<button v-if="!r.binding" @click="emit('handoff', r)">交给 Codex</button>
            </p>
            <p>环境声：{{ shot.environmentSound || '未安排' }}</p>
          </details>
        </div>
        <footer>
          <button
            @click="
              emit('preview', {
                type: 'shot',
                id: 'shot:' + shot.id,
                record: { id: director!.id, revision: director!.revision },
                shotIds: [shot.id],
              })
            "
          >
            查看本镜</button
          ><button @click="emit('edit', { record: director, shotId: shot.id })">编辑本镜</button
          ><button @click="emit('discuss', { record: director, shotId: shot.id })">讨论</button
          ><button
            v-if="shot.candidates.length"
            class="primary"
            @click="emit('candidate', shot.candidates[0].id)"
          >
            审看 {{ shot.candidates.length }} 个候选</button
          ><span v-else>未生成 {{ shot.frames / 24 }} 秒</span>
        </footer>
      </article>
    </div>
    <div v-else class="table-scroll">
      <table class="storyboard-table">
        <thead>
          <tr>
            <th>选择</th>
            <th>镜头 / 场景</th>
            <th>时间</th>
            <th>任务与动作</th>
            <th>对白</th>
            <th>机位</th>
            <th>视频</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="shot in shots" :key="shot.id">
            <td>
              <input
                v-model="selected"
                type="checkbox"
                :value="shot.id"
                :aria-label="`选择镜头 ${shot.index + 1}`"
              />
            </td>
            <td>
              {{ shot.index + 1 }}<small>{{ shot.scene?.title }}</small>
            </td>
            <td>{{ shot.startFrame / 24 }}–{{ shot.endFrame / 24 }}s</td>
            <td>
              <strong>{{ shot.purpose }}</strong>
              <p>{{ shot.action }}</p>
            </td>
            <td>
              <p v-for="line in shot.dialogue" :key="line.id">
                {{ name(line.speakerKey) }}：{{ line.text }}<small>{{ line.translation }}</small>
              </p>
            </td>
            <td>
              {{ shot.camera.shotSize }}<small>{{ shot.camera.composition }}</small>
            </td>
            <td>
              <button
                v-if="shot.candidates.length"
                @click="emit('candidate', shot.candidates[0].id)"
              >
                {{ shot.candidates.length }} 个候选</button
              ><span v-else>未生成</span>
            </td>
            <td>
              <button @click="emit('edit', { record: director, shotId: shot.id })">编辑</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
