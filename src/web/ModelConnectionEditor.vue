<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { api, serviceOffline } from './api';
import { useDraft } from './drafts';
const props = defineProps<{ initial: any }>();
const emit = defineEmits(['saved', 'close']);
const value = ref(JSON.parse(JSON.stringify(props.initial)));
const credentialMode = ref(
  value.value.data.credential
    ? 'keep'
    : ['codex', 'comfy-h3'].includes(value.value.data.protocol)
      ? 'none'
      : 'env',
);
const signingMode = ref(value.value.data.credentials ? 'keep' : 'env');
const signingId = ref(''),
  signingKey = ref('');
const signingEnvId = ref(
  value.value.data.credentials?.secretId?.kind === 'env'
    ? value.value.data.credentials.secretId.key
    : 'TENCENT_SECRET_ID',
);
const signingEnvKey = ref(
  value.value.data.credentials?.secretKey?.kind === 'env'
    ? value.value.data.credentials.secretKey.key
    : 'TENCENT_SECRET_KEY',
);
const envKey = computed({
    get: () =>
      value.value.environmentVariable ??
      (value.value.data.credential?.kind === 'env' ? value.value.data.credential.key : ''),
    set: (key) => {
      value.value.environmentVariable = key;
    },
  }),
  secret = ref(''),
  error = ref(''),
  busy = ref(false);
const draft = useDraft(
  () => 'model-connection:' + (props.initial.id || props.initial.data.protocol),
  () => props.initial.revision,
  value,
);
watch(
  () => value.value.data.credential,
  (credential) => {
    if (credential && credentialMode.value !== 'local') {
      credentialMode.value = 'keep';
      if (credential.kind === 'env') envKey.value = credential.key;
    }
  },
);
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    if (['tencent-speech', 'tencent-asr'].includes(value.value.data.protocol)) {
      if (signingMode.value === 'env')
        value.value.data.credentials = {
          secretId: { kind: 'env', key: signingEnvId.value },
          secretKey: { kind: 'env', key: signingEnvKey.value },
        };
      else if (signingMode.value === 'local') {
        const secretId = await api('/model-credentials', 'POST', { secret: signingId.value });
        const secretKey = await api('/model-credentials', 'POST', { secret: signingKey.value });
        value.value.data.credentials = { secretId, secretKey };
        signingId.value = '';
        signingKey.value = '';
        signingMode.value = 'keep';
      }
      value.value.data.credential = null;
    } else if (credentialMode.value === 'local') {
      value.value.data.credential = await api('/model-credentials', 'POST', {
        secret: secret.value,
      });
      secret.value = '';
      credentialMode.value = 'keep';
    } else if (credentialMode.value === 'env')
      value.value.data.credential = { kind: 'env', key: envKey.value };
    else if (credentialMode.value === 'none') value.value.data.credential = null;
    value.value.idempotencyKey ||= crypto.randomUUID();
    const body = {
      revision: value.value.revision,
      data: value.value.data,
      idempotencyKey: value.value.idempotencyKey,
    };
    try {
      await api(
        '/model-connections' + (value.value.id ? '/' + value.value.id : ''),
        value.value.id ? 'PUT' : 'POST',
        body,
      );
    } catch (e) {
      const recovered = await api('/model-connection-saves/' + value.value.idempotencyKey).catch(
        () => null,
      );
      if (
        !recovered?.connection ||
        JSON.stringify(recovered.connection.data) !== JSON.stringify(body.data)
      )
        throw e;
    }
    await draft.discard();
    emit('saved');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <form class="connection-editor panel" @submit.prevent="save">
    <h3>{{ value.id ? '连接与模型的新版本' : '新建连接与模型' }}</h3>
    <p>服务地址和凭据属于连接；每个模型独立启用。密钥不保存在浏览器草稿中。</p>
    <p role="status">{{ draft.message.value }}</p>
    <p v-if="draft.conflict.value" class="error">
      存在旧草稿，请核对。<button type="button" @click="draft.discard">清除旧草稿</button>
    </p>
    <p v-if="error && !serviceOffline" class="error" role="alert">{{ error }}</p>
    <fieldset :disabled="busy" class="connection-fields">
      <label v-if="value.data.protocol === 'tencent-asr'"
        >腾讯云 AppId<input v-model="value.data.appId" required pattern="[0-9]+" /></label
      ><label>连接名称<input v-model="value.data.name" required /></label>
      <label>服务地址<input v-model="value.data.baseUrl" required type="url" /></label>
      <fieldset v-if="['tencent-speech', 'tencent-asr'].includes(value.data.protocol)">
        <legend>腾讯签名凭据</legend>
        <select v-model="signingMode">
          <option value="env">服务端环境变量</option>
          <option value="local">Windows 本机加密</option>
          <option v-if="value.data.credentials" value="keep">保留成组凭据引用</option></select
        ><template v-if="signingMode === 'env'"
          ><label>SecretId 环境变量<input v-model="signingEnvId" /></label
          ><label>SecretKey 环境变量<input v-model="signingEnvKey" /></label></template
        ><template v-if="signingMode === 'local'"
          ><label
            >SecretId<input
              type="password"
              v-model="signingId"
              autocomplete="new-password" /></label
          ><label
            >SecretKey<input
              type="password"
              v-model="signingKey"
              autocomplete="new-password" /></label
        ></template>
      </fieldset>
      <label v-if="!['comfy-h3', 'tencent-speech', 'tencent-asr'].includes(value.data.protocol)"
        >凭据<select v-model="credentialMode">
          <option value="env">服务端环境变量</option>
          <option value="local">Windows 本机加密</option>
          <option v-if="value.data.credential" value="keep">保留凭据引用</option>
          <option v-if="value.data.protocol === 'codex'" value="none">CLI 已登录身份</option>
        </select></label
      >
      <label
        v-if="
          credentialMode === 'env' &&
          !['tencent-speech', 'tencent-asr'].includes(value.data.protocol)
        "
        >环境变量名<input v-model="envKey" required autocomplete="off"
      /></label>
      <label
        v-if="
          credentialMode === 'local' &&
          !['tencent-speech', 'tencent-asr'].includes(value.data.protocol)
        "
        >API 密钥<input v-model="secret" required type="password" autocomplete="new-password"
      /></label>
      <template v-if="value.data.protocol.includes('speech') || value.data.protocol === 'cosyvoice'"
        ><label>账户标识（非密钥）<input v-model="value.data.account" /></label
        ><label>地域<input v-model="value.data.region" /></label
      ></template>
      <label v-if="value.data.protocol === 'doubao-speech'"
        >语音产品 Resource ID<input
          v-model="value.data.speechResourceId"
          placeholder="seed-icl-2.0"
      /></label>
      <label v-if="['tencent-speech', 'tencent-asr'].includes(value.data.protocol)"
        >TTS 服务地址<input
          v-model="value.data.ttsBaseUrl"
          placeholder="https://tts.tencentcloudapi.com"
      /></label>
      <fieldset v-for="(model, i) in value.data.models" :key="i">
        <legend>模型 {{ Number(i) + 1 }}</legend>
        <label>精确模型／部署 ID<input v-model="model.id" required /></label>
        <label>显示名称<input v-model="model.name" required /></label>
        <label v-if="value.data.protocol === 'chat-completions'"
          ><input
            v-model="model.imageInput"
            type="checkbox"
          />已核对该模型支持图像输入（视觉分析）</label
        >
        <label
          ><input
            type="checkbox"
            :checked="model.enabled !== false"
            @change="model.enabled = ($event.target as HTMLInputElement).checked"
          />启用此模型</label
        >
      </fieldset>
      <label
        ><input
          v-model="value.data.compatible"
          type="checkbox"
        />自定义服务已核对协议兼容（不代表真实生成验证）</label
      >
      <label><input v-model="value.data.enabled" type="checkbox" />启用此连接供项目选择</label>
      <details>
        <summary>容量与实例</summary>
        <label>共享容量组<input v-model="value.data.capacityGroup" required /></label>
        <label
          >并发上限<input v-model.number="value.data.concurrency" type="number" min="1" max="8"
        /></label>
        <label v-if="value.data.protocol === 'comfy-h3'"
          >ComfyUI 实例<input v-model="value.data.instanceId" required
        /></label>
      </details>
      <button class="primary" :disabled="busy || !!draft.conflict.value">保存固定版本</button>
      <button type="button" @click="emit('close')">关闭并保留草稿</button>
    </fieldset>
  </form>
</template>
<style scoped>
.connection-editor {
  margin-top: 16px;
}
label {
  display: block;
  margin: 10px 0;
}
input:not([type='checkbox']),
select {
  width: 100%;
  box-sizing: border-box;
}
fieldset {
  border: 1px solid var(--border);
  margin: 12px 0;
}
.connection-fields {
  border: 0;
  padding: 0;
}
</style>
