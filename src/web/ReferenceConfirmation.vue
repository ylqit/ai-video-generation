<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WorkspaceSnapshot } from '../shared/workspace';
import { referenceStartGroup } from '../shared/workspace';
import type { RecordDoc } from '../shared/contracts';
import { api, assetUrl } from './api';
import MediaLibrary from './MediaLibrary.vue';
const props = defineProps<{ snapshot: WorkspaceSnapshot }>();
const emit = defineEmits(['refresh']);
const choices = ref<
  Record<
    string,
    { assetId: string; inspected: boolean; conclusion: string; asGroupStart?: boolean }
  >
>({});
const busy = ref(false),
  error = ref('');
const attempts = new Map<string, string>();
const requirements = computed(() => props.snapshot.requirements.filter((r) => r.inScope));
const libraryRequirement = ref<string | null>(null),
  pickedAssets = ref<Record<string, RecordDoc>>({});
const availableAssets = computed(() => {
  const assets = new Map<string, RecordDoc>();
  for (const asset of [...props.snapshot.assets, ...Object.values(pickedAssets.value)]) {
    if (!assets.has(asset.id) || assets.get(asset.id)!.revision < asset.revision)
      assets.set(asset.id, asset);
  }
  return [...assets.values()];
});
const assetFor = (id: string) =>
  availableAssets.value.find((a) => a.id === choices.value[id]?.assetId);
function pickAsset(asset: RecordDoc) {
  const item = requirements.value.find((r) => r.id === libraryRequirement.value);
  if (
    !item ||
    asset.projectId !== props.snapshot.project.id ||
    asset.data.stale ||
    asset.data.mediaType !== item.mediaType
  ) {
    error.value = '请选择当前需求对应类型的本项目有效素材';
    return;
  }
  pickedAssets.value[asset.id] = asset;
  choices.value[item.id].assetId = asset.id;
  choices.value[item.id].inspected = false;
  choices.value[item.id].conclusion = '';
  libraryRequirement.value = null;
  error.value = '';
}
watch(
  () => props.snapshot.run?.id,
  () => {
    choices.value = {};
    pickedAssets.value = {};
    libraryRequirement.value = null;
  },
  { immediate: true },
);
watch(
  requirements,
  (items) => {
    for (const item of items)
      choices.value[item.id] ||= { assetId: '', inspected: false, conclusion: '' };
  },
  { immediate: true },
);
watch(
  () =>
    Object.fromEntries(
      requirements.value.map(({ binding: _binding, inScope: _inScope, ...item }) => {
        const asset = assetFor(item.id);
        return [
          item.id,
          JSON.stringify({
            requirement: item,
            asGroupStart: Boolean(choices.value[item.id]?.asGroupStart),
            anchorGroups: choices.value[item.id]?.asGroupStart
              ? props.snapshot.results?.director?.data.result.groups
              : null,
            subject: props.snapshot.subjects?.find((s) => s.key === item.subjectKey),
            asset: asset
              ? {
                  id: asset.id,
                  revision: asset.revision,
                  sha256: asset.data.sha256,
                  stale: asset.data.stale,
                }
              : null,
          }),
        ];
      }),
    ),
  (current, previous) => {
    for (const [id, basis] of Object.entries(current))
      if (previous?.[id] !== basis && choices.value[id]) {
        choices.value[id].inspected = false;
        choices.value[id].conclusion = '';
      }
  },
  { flush: 'sync' },
);
async function confirm() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    const items = requirements.value
      .filter((r) => choices.value[r.id]?.assetId)
      .map((r) => {
        const choice = choices.value[r.id],
          asset = assetFor(r.id)!;
        if (!choice.inspected || !choice.conclusion.trim())
          throw new Error('请逐项审看或听审，并填写实际结论');
        return {
          requirementId: r.id,
          asset: { id: asset.id, revision: asset.revision },
          ...(choice.asGroupStart ? { asGroupStart: true } : {}),
          inspected: true,
          conclusion: choice.conclusion,
        };
      });
    if (!items.length) throw new Error('请先选择需要确认的参考');
    const body = { runRevision: props.snapshot.run!.revision, items },
      serialized = JSON.stringify(body);
    if (!attempts.has(serialized)) attempts.set(serialized, crypto.randomUUID());
    await api(`/creation-runs/${props.snapshot.run!.id}/reference-confirmations`, 'POST', {
      ...body,
      idempotencyKey: attempts.get(serialized),
    });
    choices.value = Object.fromEntries(
      requirements.value.map((r) => [r.id, { assetId: '', inspected: false, conclusion: '' }]),
    );
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <details
    v-if="
      snapshot.run &&
      !snapshot.run.data.materialized &&
      ['production', 'assets'].includes(snapshot.run.data.stage) &&
      requirements.length
    "
    class="reference-confirmation"
  >
    <summary>批量确认本次范围参考（{{ requirements.length }} 项）</summary>
    <p>先查看图片或听取音色样本，再填写实际结论。提交后会同时采用并绑定所选精确版本。</p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <div v-for="item in requirements" :key="item.id">
      <label
        >{{ item.description || item.id }} · {{ item.mediaType === 'audio' ? '声音' : '图片' }}
        <select
          v-model="choices[item.id].assetId"
          @change="
            choices[item.id].inspected = false;
            choices[item.id].conclusion = '';
          "
        >
          <option value="">保留当前绑定</option>
          <option
            v-for="asset in availableAssets.filter(
              (a) => a.data.mediaType === item.mediaType && !a.data.stale,
            )"
            :key="asset.id"
            :value="asset.id"
          >
            {{ asset.data.name }} · v{{ asset.revision }}
          </option>
        </select>
      </label>
      <p v-for="c in item.coverage || []" :key="c.shotId">
        本次确认覆盖 {{ c.shotId }} · {{ c.aspects.join('、')
        }}<span v-if="c.interactionIds.length"> · 交互 {{ c.interactionIds.join('、') }}</span>
      </p>
      <p v-if="item.preserve?.length">保持：{{ item.preserve.join('；') }}</p>
      <p v-if="item.allow?.length">允许改变：{{ item.allow.join('；') }}</p>
      <button :disabled="busy" @click="libraryRequirement = item.id">从素材库选择</button>
      <template v-if="assetFor(item.id)"
        ><img
          v-if="item.mediaType === 'image'"
          :src="assetUrl(assetFor(item.id)!.id, assetFor(item.id)!.revision)"
          :alt="item.description"
        /><audio
          v-else
          controls
          :src="assetUrl(assetFor(item.id)!.id, assetFor(item.id)!.revision)"
        /><label
          v-if="referenceStartGroup(item, snapshot.results?.director?.data.result.groups || [])"
          ><input v-model="choices[item.id].asGroupStart" type="checkbox" />用作所属生成组首帧（第 0
          帧）</label
        ><label
          ><input v-model="choices[item.id].inspected" type="checkbox" />已实际{{
            item.mediaType === 'audio' ? '听审' : '审看'
          }}</label
        ><textarea
          v-model="choices[item.id].conclusion"
          placeholder="主体一致性、清晰度或音色的实际结论"
        />
      </template>
    </div>
    <button :disabled="busy" @click="confirm">同时确认并绑定所选参考</button>
  </details>
  <div v-if="libraryRequirement" class="modal-backdrop" @click.self="libraryRequirement = null">
    <section
      class="dialog wide"
      role="dialog"
      aria-label="选择参考素材"
      v-dialog-focus="() => (libraryRequirement = null)"
    >
      <header>
        <h2>选择参考素材</h2>
        <button @click="libraryRequirement = null" aria-label="关闭素材选择">×</button>
      </header>
      <p>{{ requirements.find((r) => r.id === libraryRequirement)?.description }}</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <MediaLibrary
        :project="snapshot.project"
        :version="snapshot.run?.revision || 0"
        pick
        @pick="pickAsset"
      />
    </section>
  </div>
</template>
<style scoped>
.reference-confirmation {
  margin: 16px 0;
  padding: 16px;
  border: 1px solid var(--border, #d6d9e0);
  border-radius: 12px;
}
.reference-confirmation > div {
  padding: 12px 0;
  border-top: 1px solid var(--border, #d6d9e0);
}
label {
  display: flex;
  gap: 8px;
  align-items: center;
  margin: 8px 0;
  flex-wrap: wrap;
}
select {
  min-width: 0;
  max-width: 100%;
}
input[type='checkbox'] {
  width: auto;
}
img {
  display: block;
  max-width: 100%;
  max-height: 240px;
}
textarea {
  width: 100%;
  min-height: 60px;
}
</style>
