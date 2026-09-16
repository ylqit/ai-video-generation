<script setup lang="ts">
import BoundaryActions from './BoundaryActions.vue';
import { computed } from 'vue';
import StateFactsEditor from './StateFactsEditor.vue';
import { soundRequirements } from '../shared/shot-semantics';
const props = defineProps<{ draft: any; job: any }>();
const crypto = globalThis.crypto;
const specs = computed(() => props.job.input.prepared?.shotSpecs || []);
const instances = computed(() => [
  ...new Map<string, any>(
    specs.value.flatMap((s: any) => s.state?.instances || []).map((i: any) => [i.instanceId, i]),
  ).values(),
]);
const audio = computed(() =>
  specs.value.flatMap((s: any) =>
    soundRequirements(s.directing).map((r) => ({ ...r, shotId: s.shotId })),
  ),
);
</script>
<template>
  <section>
    <section v-if="specs.some((s: any) => s.version === 3)">
      <h4>采用边界附近的实际观察</h4>
      <p>
        默认边界附近约一秒，按动作或对白扩展。裁剪改变后需要确认新边界，截图不能证明运动和声音。
      </p>
      <div class="panel" v-for="(w, i) in draft.boundaryWindows">
        <div class="form-grid">
          <label
            >边界<select v-model="w.side">
              <option value="start">起始</option>
              <option value="end">结束</option>
            </select></label
          ><label>起帧<input type="number" v-model.number="w.startFrame" /></label
          ><label>出帧<input type="number" v-model.number="w.endFrame" /></label
          ><label
            >检查方式<select v-model="w.inspection">
              <option value="motion">播放动作</option>
              <option value="audio">实际听审</option>
            </select></label
          ><label
            >结论<select v-model="w.status">
              <option value="unknown">未知</option>
              <option value="issues">问题</option>
              <option value="pass">通过</option>
            </select></label
          ><label>观察依据<textarea v-model="w.notes" /></label
          ><label>外观<textarea v-model="w.appearance" /></label
          ><label>声音<textarea v-model="w.sound" /></label>
        </div>
        <BoundaryActions v-if="w.inspection === 'motion'" :rows="w.actions" /><button
          @click="draft.boundaryWindows.splice(i, 1)"
        >
          移除窗口
        </button>
      </div>
      <button
        @click="
          draft.boundaryWindows ||= [];
          draft.boundaryWindows.push({
            side: 'end',
            startFrame: Math.max(Math.round(draft.in * 24), Math.round(draft.out * 24) - 24),
            endFrame: Math.round(draft.out * 24),
            inspection: 'motion',
            status: 'unknown',
            actions: [],
            appearance: '',
            sound: '',
            notes: '',
          });
        "
      >
        添加边界观察窗口
      </button>
    </section>
    <h4>实际状态观察</h4>
    <p v-if="job.output.basisCorrected" class="warning">
      此任务的固定依据已经纠正：{{ job.output.basisCorrectionMessage }}。需要实际重新审核。
    </p>
    <label
      >依据纠正后的复核结论（有纠正时必填）<textarea v-model="draft.correctionConclusion" />
    </label>
    <p>
      填写源视频中实际可确认的值和半开帧区间。没有看到某物不等于它不存在；静帧不证明整个区间持续成立。
    </p>
    <StateFactsEditor
      :rows="draft.observations"
      :instances="instances"
      :documents="job.input.planning?.records || []"
      observations
    />
    <h4>实际关系观察</h4>
    <div class="panel" v-for="(o, n) in draft.relationObservations">
      <label v-for="i in instances"
        ><input type="checkbox" :value="i.instanceId" v-model="o.objectIds" />已检查对象
        {{ i.instanceId }}</label
      >
      <div class="form-grid">
        <label>起帧<input type="number" min="0" v-model.number="o.startFrame" /></label
        ><label>出帧（不含）<input type="number" min="1" v-model.number="o.endFrame" /></label
        ><label>观察依据<input v-model="o.notes" /></label>
      </div>
      <div class="form-grid" v-for="(r, k) in o.relations">
        <label
          >对象<select v-model="r.objectId">
            <option v-for="i in instances" :value="i.instanceId">{{ i.instanceId }}</option>
          </select></label
        ><label
          >关系<select v-model="r.type">
            <option v-for="v in ['heldBy', 'attachedTo', 'containedIn', 'locatedIn']">
              {{ v }}
            </option>
          </select></label
        ><label>目标实例或区域<input v-model="r.targetId" /></label
        ><label>附着点（可选）<input v-model="r.anchor" /></label
        ><label>数量<input type="number" min="1" v-model.number="r.quantity" /></label
        ><label>最大数量<input type="number" min="1" v-model.number="r.maxQuantity" /></label
        ><label><input type="checkbox" v-model="r.confirmed" />实际确认此关系</label
        ><button @click="o.relations.splice(k, 1)">移除关系</button>
      </div>
      <button
        @click="
          o.relations.push({
            objectId: o.objectIds[0] || '',
            type: 'heldBy',
            targetId: '',
            anchor: '',
            quantity: 1,
            maxQuantity: 1,
            confirmed: false,
          })
        "
      >
        增加观察到的关系</button
      ><label
        ><input
          type="checkbox"
          v-model="o.inspected"
        />确实检查了所列对象（空关系表示已确认没有上述关系）</label
      ><button @click="draft.relationObservations.splice(n, 1)">删除关系观察</button>
    </div>
    <button
      @click="
        draft.relationObservations.push({
          id: crypto.randomUUID(),
          objectIds: [],
          startFrame: 0,
          endFrame: 1,
          relations: [],
          inspected: false,
          notes: '',
        })
      "
    >
      增加关系观察区间
    </button>
    <h4 v-if="audio.length">对白与声音实际听审</h4>
    <div class="panel" v-for="ev in draft.audioEvidence">
      <p>
        {{ ev.shotId }} ·
        {{
          audio.find((r: any) => r.id === ev.requirementId && r.shotId === ev.shotId)?.description
        }}
      </p>
      <div class="form-grid">
        <label
          v-if="
            audio.find((r: any) => r.id === ev.requirementId && r.shotId === ev.shotId)
              ?.lipSyncRequired &&
            !audio.find((r: any) => r.id === ev.requirementId && r.shotId === ev.shotId)
              ?.mouthReviewRequired
          "
          ><input
            v-model="ev.lipSyncReviewed"
            type="checkbox"
          />已实际核对画内说话人与口型同步</label
        >
        <section
          v-if="
            audio.find((r: any) => r.id === ev.requirementId && r.shotId === ev.shotId)
              ?.mouthReviewRequired
          "
        >
          <label
            >实际嘴部可见性<select
              v-model="ev.mouthObserved"
              @change="
                ev.mouthInspected = false;
                ev.mouthWindows = [];
              "
            >
              <option :value="undefined">未检查</option>
              <option value="unknown">无法判断</option>
              <option value="visible">至少部分可见</option>
              <option value="occluded">全程遮挡</option>
              <option value="out_of_frame">全程画外</option>
            </select></label
          >
          <label
            ><input
              type="checkbox"
              v-model="ev.mouthInspected"
            />已实际观看整个对白区间的嘴部可见性</label
          >
          <template v-if="ev.mouthObserved === 'visible'"
            ><div v-for="(w, index) in ev.mouthWindows || []" :key="index">
              <label>可见开始源帧<input type="number" v-model.number="w.startFrame" /></label
              ><label>可见结束源帧<input type="number" v-model.number="w.endFrame" /></label
              ><label
                ><input type="checkbox" v-model="w.lipSyncReviewed" />此可见区间口型已核对</label
              ><button type="button" @click="ev.mouthWindows.splice(index, 1)">移除区间</button>
            </div>
            <button
              type="button"
              @click="
                (ev.mouthWindows ||= []).push({
                  startFrame: ev.startFrame,
                  endFrame: ev.endFrame,
                  lipSyncReviewed: false,
                })
              "
            >
              增加实际可见区间
            </button></template
          >
        </section>
        <label
          >听审结论<select v-model="ev.status">
            <option value="unreviewed">未听审</option>
            <option value="pass">实际听审通过</option>
            <option value="issues">有问题</option>
          </select></label
        ><label>开始源帧<input type="number" min="0" v-model.number="ev.startFrame" /></label
        ><label>结束源帧（不含）<input type="number" min="1" v-model.number="ev.endFrame" /></label
        ><template v-if="ev.requirementId.startsWith('dialogue:')"
          ><label
            >实际说话者<select v-model="ev.speakerId">
              <option value="">未确认</option>
              <option v-for="i in instances" :value="i.instanceId">{{ i.instanceId }}</option>
            </select></label
          ><label>实际听到的原文<textarea v-model="ev.text" /></label></template
        ><label v-else
          >听到人声<select v-model="ev.voicePresent">
            <option :value="undefined">未确认</option>
            <option :value="false">没有人声</option>
            <option :value="true">有人声</option>
          </select></label
        ><label>听审依据<input v-model="ev.notes" /></label>
      </div>
    </div>
    <template v-if="job.input.segment.repair"
      ><h4>替换区间两侧接续审核</h4>
      <p>按实际采用边界对照两侧动作及声音，原错误尾帧不作为必须恢复的目标。</p>
      <div class="form-grid" v-for="ev in draft.spliceEvidence">
        <strong
          >{{ ev.side === 'before' ? '前侧' : '后侧' }} ·
          {{ ev.inspection === 'audio' ? '听审' : '运动审核' }}</strong
        ><label
          >结论<select v-model="ev.status">
            <option value="unreviewed">未检查</option>
            <option value="pass">通过</option>
            <option value="issues">有问题</option>
          </select></label
        ><label>采用边界及对照依据<textarea v-model="ev.notes" /></label></div
    ></template>
  </section>
</template>
