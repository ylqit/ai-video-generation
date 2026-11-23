<script setup lang="ts">
import { computed } from 'vue';
import { assetUrl } from './api';
const props = defineProps<{ input: any }>();
const anchors = computed(() =>
  (props.input.prepared?.anchors || []).map((a: any) => ({
    ...a,
    image: props.input.prepared.images.find((p: any) => p.key === a.key),
  })),
);
</script>
<template>
  <div class="generation-preview" v-if="input.prepared">
    <h4>执行预览 · {{ input.templateVersion }}</h4>
    <p v-if="input.formatComparison" :class="input.formatComparison.matches ? '' : 'warning'">
      {{ input.formatComparison.message }} · 生成 {{ input.formatComparison.generation.width }}:{{
        input.formatComparison.generation.height
      }}
      → 交付 {{ input.formatComparison.delivery.width }}×{{
        input.formatComparison.delivery.height
      }}
    </p>
    <p v-if="input.effectivePlan">
      本集依据：{{ input.effectivePlan.series?.id || '项目' }}；{{
        input.effectivePlan.runtime
          ? `${input.effectivePlan.runtime.targetFrames / 24} 秒`
          : input.effectivePlan.duration.mode
      }}。本次片段不代表已完成整集。
    </p>
    <section v-if="input.modelExecution">
      <p>
        {{ input.modelExecution.connection.data.name }} v{{
          input.modelExecution.connection.revision
        }}
        · {{ input.modelExecution.modelId }} · {{ input.modelExecution.protocol }}
      </p>
      <p>
        Prompt 方案：{{
          input.modelExecution.promptProfile
        }}。能力登记与离线编译不代表真实调用已验证。
      </p>
      <details v-if="input.executionDifference?.comparedJobId" open>
        <summary>与本组上次固定任务的执行差异</summary>
        <p v-for="c in input.executionDifference.changes">
          {{ c.field }}：{{ c.from }} → {{ c.to }}
        </p>
        <p v-if="!input.executionDifference.changes.length">执行选择和媒体职责未改变。</p>
      </details>
      <table
        v-if="input.referenceBindingPlan?.bindings?.length || input.prepared.inputBindings?.length"
      >
        <thead>
          <tr>
            <th>标签</th>
            <th>素材版本</th>
            <th>用途</th>
            <th>请求角色</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="b in input.referenceBindingPlan?.bindings || input.prepared.inputBindings"
            :key="b.id"
          >
            <td>{{ b.label }}</td>
            <td>{{ b.asset.id }} v{{ b.asset.revision }}</td>
            <td>{{ b.purpose }}</td>
            <td>{{ b.role }}</td>
          </tr>
        </tbody>
      </table>
      <details v-if="input.prepared.request">
        <summary>固定逻辑请求（提交时才读取媒体）</summary>
        <pre>{{ input.prepared.request }}</pre>
      </details>
    </section>
    <section v-if="input.prepared.contractRevision === 2">
      <h4>设计与软件检查</h4>
      <p v-for="s in input.prepared.spatialAssessments" :key="s.shotId">
        {{ s.shotId }} ·
        {{
          (
            {
              not_applicable: '空间不适用',
              not_run: '空间检查未执行',
              schematic: '示意布局',
              incomplete: '空间数据不完整',
              checked: '已执行代理几何检查',
            } as any
          )[s.status]
        }}
        · {{ s.reason }}<span v-if="s.missing.length"> · 缺少 {{ s.missing.join('、') }}</span>
      </p>
      <p v-for="c in input.referenceCoverage" :key="`${c.shotId}:${c.interactionId}`">
        {{ c.shotId }} / {{ c.interactionId }} ·
        {{
          c.status === 'inspected_reference' ? '已有明确覆盖的已审参考' : '参考覆盖待完成'
        }}。交互参考属于制作依据，实际动作仍需看片。
      </p>
      <h4>生成后需实际核对</h4>
      <p>
        人物关注目标、物件操作面、接触与动作结果、镜头连续性以及对白声音。软件检查和灰模预演不自动形成媒体采用。
      </p>
    </section>
    <details v-if="input.prepared.referenceChecks?.length" open>
      <summary>图像状态冲突与审核例外</summary>
      <p v-for="c in input.prepared.referenceChecks">
        {{ c.bindingId }} / {{ c.shotId }}：{{ c.status }} · {{ c.reason }}
        <span v-if="c.conflicts.length">{{ c.conflicts }}</span>
      </p>
      <p>程序只比较明确填写的属性；图内自由内容仍需实际看图审核。</p>
    </details>
    <details v-if="input.prepared.projection && input.prepared.contractRevision !== 2">
      <summary>当前镜头有效输入清单</summary>
      <section v-for="p in input.prepared.projection">
        <strong>{{ p.shotId }}</strong>
        <p v-for="d in p.decisions">
          {{ d.field }} · {{ d.status }} · {{ d.reason }} <span v-if="d.text">{{ d.text }}</span>
        </p>
      </section>
    </details>
    <details v-if="input.dependencies">
      <summary>本任务实际使用的固定版本</summary>
      <p v-for="d in input.dependencies">{{ d.id }} · v{{ d.revision }}</p>
      <pre v-if="input.continuation?.snapshot">{{ input.continuation.snapshot }}</pre>
    </details>
    <details v-if="input.prepared.complexity">
      <summary>动作拆分时需要权衡的因素</summary>
      <p v-for="c in input.prepared.complexity">
        {{ c.shotId }}：画面实例 {{ c.visibleInstances }}，事件 {{ c.events }}，接触关系
        {{ c.contactRelations }}，相机 {{ c.cameraMotion }}，对白
        {{ c.dialogue }}。遮挡与动作可读性仍需视觉审核。
      </p>
    </details>
    <template v-if="input.planning"
      ><p>
        生成级别：{{
          input.planning.mode === 'formal' ||
          (!input.planning.mode && input.segment.mode !== 'ref2va')
            ? '正式'
            : '探索'
        }}
        · 图片预算 {{ input.prepared.images.length }} / 9
      </p>
      <p v-for="c in input.planning.checks" class="warning">
        设计提示 {{ c.code }}：{{ c.message }}
      </p>
      <p v-for="o in input.planning.omitted" class="warning">
        未纳入 {{ o.bindingId }}：{{ o.reason }}
      </p>
      <details>
        <summary>参考图片用途与纳入原因</summary>
        <p v-for="b in input.planning.selected">{{ b.id }} · {{ b.role }} · {{ b.reason }}</p>
      </details></template
    >
    <p v-if="!input.modelExecution || input.modelExecution.protocol === 'comfy-h3'">
      {{ input.width }} × {{ input.height }} · {{ input.steps }} 步 · 24 fps · seed
      {{ input.seed }} · ref_image_size=match
    </p>
    <p v-if="input.capabilities && !input.modelExecution">
      能力校验：{{
        input.capabilities.verification === 'saved_probe' ? '使用已保存探测结果' : '连接待探测'
      }}；音色样本用于听审，动作时序通过文字请求。
    </p>
    <p>
      计划
      {{
        input.planning?.shots?.reduce((n: number, s: any) => n + Math.round(s.duration * 24), 0) ||
        Math.round(input.segment.duration * 24)
      }}
      帧；归档后另核对实际输出与采用帧数。
    </p>
    <p>
      请求 {{ input.segment.duration }} 秒 → {{ input.prepared.frameCount }} 帧 /
      {{ input.prepared.duration.toFixed(3) }} 秒
    </p>
    <div class="preview-images">
      <figure v-for="p in input.prepared.images" :key="p.key">
        <img :src="assetUrl(p.assetId, p.revision)" :alt="p.name" />
        <figcaption>{{ p.label }} · {{ p.name }} · v{{ p.revision }}</figcaption>
      </figure>
    </div>
    <p v-for="s in input.prepared.subjects" :key="s.id">
      <strong>{{ s.label }} · {{ s.id }}</strong> ← {{ s.pictures.join('、') }}<br />{{
        (s.instructions || []).join('；')
      }}
    </p>
    <div class="preview-images">
      <figure v-for="a in anchors" :key="a.resolvedFrameIndex">
        <div class="anchor-crop" :style="{ aspectRatio: `${input.width} / ${input.height}` }">
          <img
            :src="assetUrl(a.assetId, a.revision)"
            :alt="`${a.label} 实际居中裁剪`"
            :style="{
              width: `${(a.image.width / a.crop.width) * 100}%`,
              height: `${(a.image.height / a.crop.height) * 100}%`,
              left: `${(-a.crop.x / a.crop.width) * 100}%`,
              top: `${(-a.crop.y / a.crop.height) * 100}%`,
            }"
          />
        </div>
        <figcaption>
          {{ a.label }} · 第 {{ a.resolvedFrameIndex }} 帧 /
          {{ a.seconds.toFixed(3) }} 秒<br />居中裁剪：{{ a.crop.width }}×{{ a.crop.height }}，偏移
          {{ a.crop.x }}, {{ a.crop.y }}<br />{{ a.instruction }}
        </figcaption>
      </figure>
    </div>
    <details v-if="input.creativeBrief">
      <summary>固定制作规范与规则来源</summary>
      <p>
        配置 {{ input.creativeBrief.profile.id }} · revision
        {{ input.creativeBrief.profile.revision }} · {{ input.creativeBrief.digest }}
      </p>
      <p v-for="m in input.creativeBrief.modules">
        {{ m.data.category }} / {{ m.data.name }} · {{ m.ref.id }}:{{ m.ref.revision }}
      </p>
      <p v-for="c in input.creativeBrief.checks">{{ c.code }}：{{ c.message }}</p>
      <p>
        世界与叙事规则进入导演创作和审核；执行正文使用已审核的具体行动，模块标签不会自动增添剧情事实。
      </p>
    </details>
    <details v-if="input.prepared.trace">
      <summary>导演字段实际参与情况</summary>
      <p v-for="t in input.prepared.consumption || input.prepared.trace">
        {{ t.shotId }} · {{ t.field }} → {{ t.status }} · {{ (t.consumers || []).join(' / ') }}
        {{ t.reason || '' }}
      </p>
    </details>
    <p class="warning" v-for="c in input.prepared.spatialChecks || []">
      空间检查 {{ c.code }}：{{ c.message }}
    </p>
    <details>
      <summary>完整模型提示词（本次执行冻结）</summary>
      <pre>{{ input.prepared.finalPrompt }}</pre>
    </details>
    <p class="muted">保留要求是生成目标，结果需另行审核。</p>
  </div>
</template>
<style scoped>
.generation-preview {
  min-width: 0;
  overflow-wrap: anywhere;
  margin: 16px 0;
  border-top: 1px solid #58746f;
  padding-top: 16px;
}
.preview-images {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}
figure {
  margin: 0 0 16px;
  width: 250px;
}
figure > img {
  width: 100%;
  height: 160px;
  object-fit: contain;
  background: #182222;
}
figcaption {
  font-size: 12px;
  line-height: 1.7;
  margin-top: 6px;
  overflow-wrap: anywhere;
}
.anchor-crop {
  position: relative;
  overflow: hidden;
  width: 100%;
}
.anchor-crop img {
  position: absolute;
  max-width: none;
  object-fit: fill;
}
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
