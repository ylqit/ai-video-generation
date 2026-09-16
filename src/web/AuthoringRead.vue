<script setup lang="ts">
import { computed } from 'vue';
import { assetUrl } from './api';
import DirectorSpace from './DirectorSpace.vue';
const props = defineProps<{
  record: any;
  context: any;
  focus?: { type: string; id: string } | null;
}>();
const emit = defineEmits(['navigate', 'edit', 'handoff', 'candidate']);
const body = computed(() => props.record.data.result);
const script = computed(() => props.context?.results?.script?.data.result);
const director = computed(() => props.context?.results?.director?.data.result);
const factText = (id: string) =>
  props.context?.results?.brief?.data.result.lockedFacts.find((f: any) => f.id === id)?.statement ||
  `事实引用缺失：${id}`;
const subjects = computed(() =>
  (script.value?.subjects || []).filter(
    (s: any) => props.focus?.type !== 'subject' || s.key === props.focus.id,
  ),
);
const scenes = computed(() =>
  (body.value.scenes || []).filter(
    (s: any) => props.focus?.type !== 'scene' || s.id === props.focus.id,
  ),
);
const shots = computed(() => {
  let start = 0;
  return (body.value.shots || [])
    .map((s: any, index: number) => {
      const begin = start;
      start += s.frames;
      return { ...s, index, start: begin, end: start };
    })
    .filter((s: any) => props.focus?.type !== 'shot' || s.id === props.focus.id);
});
const subjectName = (key: string) =>
  script.value?.subjects.find((s: any) => s.key === key)?.name || `引用缺失：${key}`;
const stateText = (s: any) =>
  `${subjectName(s.subjectKey)} · ${script.value?.subjects.find((p: any) => p.key === s.subjectKey)?.attributes.find((a: any) => a.key === s.key)?.label || s.key}：${s.value === null ? '尚未声明' : s.value}`;
const relationText = (r: any) =>
  `${subjectName(r.objectKey)} · ${{ heldBy: '由其持有', attachedTo: '附着于', containedIn: '包含于', locatedIn: '位于' }[r.type as string] || r.type} · ${subjectName(r.targetKey)} ${r.anchor}`;
const related = (id: string) =>
  props.context?.requirements?.filter((r: any) => r.shotIds.includes(id)) || [];
function dialogueFor(shot: any) {
  return shot.dialogue.map(({ lineId: id, delivery }: any) => ({
    ...(script.value?.scenes.flatMap((s: any) => s.dialogue).find((l: any) => l.id === id) || {
      id,
      text: `引用缺失：${id}`,
    }),
    delivery,
  }));
}
</script>
<template>
  <article class="reading-view">
    <p v-if="!focus" class="reading-lead">{{ body.summary }}</p>
    <p v-for="message in context?.missing" :key="message" class="content-gap">
      引用缺失：{{ message }}
    </p>
    <template v-if="body.stage === 'brief'">
      <h3>创作目标</h3>
      <p>{{ body.goal }}</p>
      <h3>受众</h3>
      <p>{{ body.audience || '尚未声明' }}</p>
      <h3>固定事实与来源</h3>
      <p v-for="fact in body.lockedFacts" :key="fact.id">
        {{ fact.statement
        }}<small>
          ·
          {{
            fact.source
              ? '固定来源 ' + fact.source.id + ' / 版本 ' + fact.source.revision
              : '未指定独立来源'
          }}</small
        >
      </p>
      <h3>交付要求</h3>
      <ul>
        <li v-for="item in body.requirements" :key="item">{{ item }}</li>
      </ul>
    </template>
    <template v-else-if="body.stage === 'script'">
      <section v-if="focus?.type !== 'scene'">
        <h3>人物与主体</h3>
        <section v-for="subject in subjects" :key="subject.key">
          <h3>{{ subject.name }}</h3>
          <small>{{
            { human: '人物', animal: '动物', object: '物体', environment: '环境', graphic: '图文' }[
              subject.kind as string
            ]
          }}</small>
          <p>{{ subject.description }}</p>
          <p v-if="!subject.attributes.length" class="content-gap">尚未声明结构化属性</p>
          <p v-for="a in subject.attributes" :key="a.key">
            {{ a.label }}：{{ a.values.join(' / ') || a.type }}
          </p>
          <h4>出场镜头</h4>
          <p
            v-for="shot in director?.shots.filter((s: any) =>
              s.visibleSubjectKeys.includes(subject.key),
            )"
            :key="shot.id"
          >
            {{ shot.purpose }}
          </p>
          <div
            v-for="r in context?.requirements.filter((r: any) => r.subjectKey === subject.key)"
            :key="r.id"
            class="detail-reference"
          >
            <img
              v-if="r.binding && r.mediaType === 'image'"
              :src="assetUrl(r.binding.asset.id, r.binding.asset.revision)"
              :alt="r.description"
            />
            <audio
              v-if="r.binding && r.mediaType === 'audio'"
              :src="assetUrl(r.binding.asset.id, r.binding.asset.revision)"
              controls
              preload="none"
            />
            <p>{{ r.description }} · {{ r.binding ? '已绑定' : '待制作' }}</p>
          </div>
        </section>
      </section>
      <template v-if="focus?.type !== 'subject'"
        ><section v-for="scene in scenes" :key="scene.id" class="script-scene">
          <h3>{{ scene.title }}</h3>
          <small>{{ scene.setting }}</small>
          <p>{{ scene.narrative }}</p>
          <h4>事件</h4>
          <section v-for="e in scene.events" :key="e.id">
            <p>{{ e.description }}</p>
            <small v-for="id in e.sourceFactIds" :key="id">依据：{{ factText(id) }}</small>
          </section>
          <h4>对白</h4>
          <p v-if="!scene.dialogue.length">无已声明对白</p>
          <blockquote v-for="line in scene.dialogue" :key="line.id">
            <strong>{{ subjectName(line.speakerKey) }} · {{ line.language }}</strong>
            <p :lang="line.language">{{ line.text }}</p>
            <p>{{ line.translation || '尚未填写字幕译文' }}</p>
            <small v-if="line.sourceFactId">依据：{{ factText(line.sourceFactId) }}</small>
          </blockquote>
          <h4>对应镜头</h4>
          <p v-for="s in director?.shots.filter((s: any) => s.sceneId === scene.id)" :key="s.id">
            {{ s.purpose }} · {{ s.frames / 24 }} 秒
          </p>
        </section>
        <details v-if="!focus">
          <summary>剧本全文</summary>
          <p>{{ body.screenplayText }}</p>
        </details></template
      >
    </template>
    <template v-else-if="body.stage === 'direction'"
      ><section
        v-for="[key, label] in [
          ['visual', '视觉'],
          ['narrative', '叙事'],
          ['directing', '导演'],
          ['editing', '剪辑'],
          ['sound', '声音'],
          ['assetPolicy', '资产政策'],
        ]"
        :key="key"
      >
        <h3>{{ label }}</h3>
        <p>{{ body[key] || '尚未声明' }}</p>
      </section>
      <div
        v-for="r in context?.requirements.filter((r: any) => r.binding)"
        :key="r.id"
        class="detail-reference"
      >
        <img
          v-if="r.mediaType === 'image'"
          :src="assetUrl(r.binding.asset.id, r.binding.asset.revision)"
          :alt="r.description"
        />
        <audio
          v-if="r.mediaType === 'audio'"
          :src="assetUrl(r.binding.asset.id, r.binding.asset.revision)"
          controls
          preload="none"
        />
        <p>{{ r.description }}</p>
      </div></template
    >
    <template v-else-if="body.stage === 'director'">
      <nav v-if="focus?.type === 'shot'" class="toolbar">
        <button
          :disabled="!shots.length || shots[0]?.index === 0"
          @click="emit('navigate', { type: 'shot', id: body.shots[shots[0].index - 1].id })"
        >
          ← 上一镜</button
        ><span>{{ shots[0]?.index + 1 }} / {{ body.shots.length }}</span
        ><button
          :disabled="!shots.length || shots[0]?.index === body.shots.length - 1"
          @click="emit('navigate', { type: 'shot', id: body.shots[shots[0].index + 1].id })"
        >
          下一镜 →
        </button>
      </nav>
      <p v-if="!shots.length" class="content-gap">当前固定版本未包含所选镜头</p>
      <section v-for="shot in shots" :key="shot.id">
        <h3>{{ String(shot.index + 1).padStart(2, '0') }} · {{ shot.purpose }}</h3>
        <p>
          {{ shot.start / 24 }}–{{ shot.end / 24 }} 秒 · {{ shot.frames }} 帧 ·
          {{ script?.scenes.find((s: any) => s.id === shot.sceneId)?.title || '场景引用缺失' }}
        </p>
        <div class="detail-grid">
          <section>
            <h4>故事任务</h4>
            <p>{{ shot.visibleSubjectKeys.map(subjectName).join('、') }}</p>
            <p v-for="e in shot.events" :key="e.eventId">
              {{
                script?.scenes.flatMap((s: any) => s.events).find((x: any) => x.id === e.eventId)
                  ?.description || '事件引用缺失：' + e.eventId
              }}
              ·
              {{
                { whole: '完整发生', start: '开始', continue: '继续', complete: '完成' }[
                  e.phase as string
                ]
              }}
            </p>
            <h4>动作与表演</h4>
            <p>{{ shot.action }}</p>
            <p v-if="!shot.performances.length" class="content-gap">
              {{
                shot.visibleSubjectKeys.some((k: string) =>
                  script?.subjects.some(
                    (s: any) => s.key === k && ['human', 'animal'].includes(s.kind),
                  ),
                )
                  ? '尚未填写分项表演；已有动作描述仍保留。'
                  : '无人或物体镜头，不要求人类表演。'
              }}
            </p>
            <section v-for="p in shot.performances" :key="p.subjectKey">
              <h4>{{ subjectName(p.subjectKey) }}</h4>
              <dl>
                <dt>触发</dt>
                <dd>{{ p.trigger }}</dd>
                <dt>目标与阻碍</dt>
                <dd>{{ p.goal }} / {{ p.obstacle }}</dd>
                <dt>可见表现</dt>
                <dd>{{ p.visible }}</dd>
              </dl>
            </section>
          </section>
          <section>
            <h4>摄影与空间</h4>
            <dl>
              <template
                v-for="[key, label] in [
                  ['shotSize', '景别'],
                  ['position', '机位'],
                  ['composition', '构图'],
                  ['motion', '摄影机运动'],
                  ['reason', '运动依据'],
                ]"
                :key="key"
                ><dt>{{ label }}</dt>
                <dd>{{ shot.camera[key] || '尚未声明' }}</dd></template
              >
            </dl>
            <h4>对白与声音</h4>
            <blockquote v-for="line in dialogueFor(shot)" :key="line.id">
              <span>{{
                (
                  {
                    onscreen: '画内对白',
                    offscreen: '画外对白',
                    voiceover: '旁白',
                    unspecified: '旧版：呈现方式待明确',
                  } as any
                )[line.delivery]
              }}</span>
              <strong v-if="line.speakerKey"
                >{{ subjectName(line.speakerKey) }} · {{ line.language }}</strong
              >
              <p>{{ line.text }}</p>
              <p>{{ line.translation }}</p>
            </blockquote>
            <p v-for="cue in shot.cues" :key="cue.id">
              时序 {{ cue.id }} · {{ cue.target.kind }}
              {{ cue.target.eventId || cue.target.lineId || cue.target.performanceId }} ·
              {{ cue.window ? `${cue.window.startFrame}–${cue.window.endFrame} 帧` : '时间未指定'
              }}<span v-if="cue.afterIds.length"> · 在 {{ cue.afterIds.join('、') }} 之后</span>
            </p>
            <button
              v-if="shot.dialogue.length && context?.results.script"
              @click="
                emit('edit', { record: context.results.script, sceneId: shot.sceneId, context })
              "
            >
              在剧本中编辑对白
            </button>
            <dl>
              <dt>环境声</dt>
              <dd>{{ shot.environmentSound || '尚未声明' }}</dd>
              <dt>动作声</dt>
              <dd>{{ shot.actionSound || '尚未声明' }}</dd>
              <dt>声音接续</dt>
              <dd>{{ shot.soundContinuation || '尚未声明' }}</dd>
            </dl>
          </section>
        </div>
        <DirectorSpace :director="body" :shot="shot" :basis="record" />
        <details open>
          <summary>接续与执行关系</summary>
          <div class="detail-grid">
            <section
              v-for="[key, label] in [
                ['entryState', '入口状态'],
                ['exitState', '出口状态'],
                ['entryRelations', '入口物体关系'],
                ['exitRelations', '出口物体关系'],
              ]"
              :key="key"
            >
              <h4>{{ label }}</h4>
              <p v-if="!shot[key].length" class="content-gap">尚未声明</p>
              <p v-for="(value, i) in shot[key]" :key="i">
                {{ key.endsWith('State') ? stateText(value) : relationText(value) }}
              </p>
            </section>
          </div>
          <p v-for="g in body.groups.filter((g: any) => g.shotIds.includes(shot.id))" :key="g.id">
            生成组 {{ g.id }} ·
            {{
              {
                independent: '独立镜头',
                continuous: '连续接续',
                ellipsis: '时间省略',
                location_change: '地点切换',
                flashback: '回忆',
              }[g.transition as string]
            }}
            · {{ g.reason }}
          </p>
          <h4>实际参考</h4>
          <p v-if="!related(shot.id).length" class="content-gap">
            当前固定上下文未提供镜头参考绑定
          </p>
          <div v-for="r in related(shot.id)" :key="r.id" class="detail-reference">
            <img
              v-if="r.binding && r.mediaType === 'image'"
              :src="assetUrl(r.binding.asset.id, r.binding.asset.revision)"
              :alt="r.description"
            />
            <audio
              v-if="r.binding && r.mediaType === 'audio'"
              :src="assetUrl(r.binding.asset.id, r.binding.asset.revision)"
              controls
              preload="none"
            />
            <p>{{ r.description }} · {{ r.purpose }} · {{ r.binding ? '已绑定参考' : '待制作' }}</p>
          </div>
          <p
            v-for="c in context?.candidates.filter((c: any) => c.shotIds.includes(shot.id))"
            :key="c.id"
          >
            <button @click="emit('candidate', c)">{{ c.label }} · 查看候选</button>
          </p>
        </details>
      </section>
    </template>
    <template v-else-if="body.stage === 'assets'"
      ><section v-for="item in body.items" :key="item.id">
        <h3>{{ item.description }}</h3>
        <p>
          {{ subjectName(item.subjectKey) }} · {{ item.mediaType }} · {{ item.purpose }} ·
          {{ item.layout }} · {{ item.view }}
        </p>
        <p>关联镜头：{{ item.shotIds.join('、') || '通用参考' }}</p>
        <p>{{ item.prompt }}</p>
        <p>
          {{
            context?.requirements.find((r: any) => r.id === item.id)?.binding
              ? '已绑定真实参考'
              : '尚无此需求的当前绑定'
          }}
        </p>
        <button @click="emit('handoff', item)">交给 Codex 制作</button>
      </section></template
    >
    <template v-else-if="body.stage === 'editorial'"
      ><h3>配乐与声音</h3>
      <p>
        {{ body.musicDecision === 'no_music' ? '不使用配乐' : '导入配乐' }} · {{ body.musicReason }}
      </p>
      <section v-for="(item, i) in body.audio" :key="i">
        <p>
          {{
            context?.assets.find(
              (a: any) => a.id === item.asset.id && a.revision === item.asset.revision,
            )?.data.name || '音频引用缺失'
          }}
          · {{ item.startFrame / 24 }}–{{
            (item.startFrame + item.outFrame - item.inFrame) / 24
          }}
          秒 · 音量 {{ item.volume }}
        </p>
        <audio :src="assetUrl(item.asset.id, item.asset.revision)" controls preload="none" />
      </section>
      <h3>字幕与图文</h3>
      <p v-for="line in body.overlays" :key="line.id">
        {{ line.startFrame / 24 }}–{{ line.endFrame / 24 }} 秒：{{ line.text
        }}<small> · {{ line.position }} / {{ line.fontSize }}px / {{ line.color }}</small>
      </p></template
    >
    <details v-if="body.assumptions?.length || body.sources?.length">
      <summary>来源与假设</summary>
      <p v-for="a in body.assumptions" :key="a">{{ a }}</p>
      <p v-for="s in body.sources" :key="s.id">固定来源 {{ s.id }} · 版本 {{ s.revision }}</p>
    </details>
    <section v-if="body.openQuestions?.length">
      <h3>需要决定</h3>
      <p v-for="q in body.openQuestions" :key="q">{{ q }}</p>
    </section>
    <p v-for="(i, n) in record.data.issues" :key="n" class="content-gap">
      {{ i.message }} · {{ i.field }}
    </p>
  </article>
</template>
