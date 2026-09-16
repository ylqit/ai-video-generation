<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { api } from './api';
import { creationSettingsSchema } from '../shared/creation';
const props = defineProps<{ project: any }>();
const policy = ref<any>(creationSettingsSchema.parse({})),
  revision = ref(0),
  runtime = ref<any>(null),
  error = ref(''),
  notice = ref(''),
  busy = ref(false);
const capabilities = ref<any>(null);
const baseUrl = ref(''),
  newInstance = ref(false);
onMounted(async () => {
  try {
    const [settings, run, caps] = await Promise.all([
      api(`/projects/${props.project.id}/creation-settings`),
      api('/runtime'),
      api(`/projects/${props.project.id}/capabilities`),
    ]);
    policy.value = settings.settings?.data.policy || policy.value;
    revision.value = settings.settings?.revision || 0;
    runtime.value = run;
    capabilities.value = caps;
    baseUrl.value = run.profile.baseUrl;
  } catch (e: any) {
    error.value = e.message;
  }
});
function durationChanged() {
  const mode = policy.value.duration.mode;
  policy.value.duration =
    mode === 'derive'
      ? { mode }
      : mode === 'exact'
        ? { mode, seconds: 60 }
        : { mode, seconds: 60, tolerancePercent: 5 };
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const saved = await api(`/projects/${props.project.id}/creation-settings`, 'PUT', {
      revision: revision.value,
      policy: policy.value,
    });
    revision.value = saved.revision;
    notice.value = '创作政策已保存，已受理任务继续按原输入处理。';
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
async function saveRuntime() {
  try {
    await api('/settings', 'PUT', { baseUrl: baseUrl.value, newInstance: newInstance.value });
    notice.value = '执行服务配置已保存';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section class="global-page settings-page">
    <header class="page-heading">
      <div>
        <h1>设置</h1>
        <p>{{ project.data.title }} · 创作与执行政策</p>
      </div>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="capabilities">
      视频能力：{{ capabilities.video ? 'H3 已配置' : '待配置' }} ·
      {{ capabilities.verification === 'saved_probe' ? '已有节点探测' : '尚未探测' }} · 图片参考
      {{
        capabilities.guidedImages.available === true
          ? '可用'
          : capabilities.guidedImages.available === false
            ? '不可用'
            : '待核验'
      }}。图片通过任务包制作；音色样本用于听审；动作时序与声音描述作为文字请求，需审核实际视频。
    </p>
    <form class="settings-form" @submit.prevent="save">
      <section>
        <h2>创作推进</h2>
        <label
          >推进方式<select v-model="policy.progression">
            <option value="review">阶段审稿 · 主要成果等待确认</option>
            <option value="automatic">自动推进 · 在项目额度内工作</option>
          </select></label
        ><label
          >时长意图<select v-model="policy.duration.mode" @change="durationChanged">
            <option value="derive">依据内容规划</option>
            <option value="exact">精确时长</option>
            <option value="approximate">约略时长</option>
          </select></label
        >
        <div class="form-row">
          <label v-if="policy.duration.mode !== 'derive'"
            >全片目标（秒）<input
              v-model.number="policy.duration.seconds"
              type="number"
              min="1" /></label
          ><label v-if="policy.duration.mode === 'approximate'"
            >允许浮动（%）<input
              v-model.number="policy.duration.tolerancePercent"
              type="number"
              min="0"
              max="50"
          /></label>
        </div>
        <p>允许有依据的表演、机位和停顿。关键事件、对白与结局的修改从剧本开始。</p>
      </section>
      <section>
        <h2>媒体额度</h2>
        <label class="check"
          ><input
            v-model="policy.allowance.enabled"
            type="checkbox"
          />允许在以下累计额度内执行</label
        >
        <div class="form-row">
          <label
            >最大请求次数<input
              v-model.number="policy.allowance.maxGenerations"
              type="number"
              min="0" /></label
          ><label
            >最大请求秒数<input
              v-model.number="policy.allowance.maxGeneratedSeconds"
              type="number"
              min="0"
          /></label>
        </div>
        <p>重做计入额度。Codex 会话的图片制作回执独立记录。</p>
      </section>
      <section>
        <h2>默认视频输出</h2>
        <div class="form-row">
          <label
            >宽度<input
              v-model.number="policy.output.width"
              type="number"
              min="128"
              step="32" /></label
          ><label
            >高度<input
              v-model.number="policy.output.height"
              type="number"
              min="128"
              step="32" /></label
          ><label
            >采样步数<input v-model.number="policy.output.steps" type="number" min="1" max="50"
          /></label>
        </div>
        <p>实际输入能力在选择执行范围和提交前检查。最终交付始终需要用户确认实际导出。</p>
      </section>
      <button class="primary" :disabled="busy">保存项目设置</button>
    </form>
    <details class="settings-form">
      <summary>执行服务与能力</summary>
      <label>ComfyUI 地址<input v-model="baseUrl" type="url" /></label
      ><label class="check"><input v-model="newInstance" type="checkbox" />服务实例已更换</label
      ><button @click="saveRuntime">保存服务地址</button>
      <p>后台 Codex 负责文字创作；参考图通过素材任务交给 Codex 会话制作。独立声音使用导入素材。</p>
      <details>
        <summary>最近一次能力检查</summary>
        <pre>{{ JSON.stringify(runtime?.discovery, null, 2) }}</pre>
      </details>
    </details>
  </section>
</template>
