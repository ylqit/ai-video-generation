<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { api } from './api';
import { voiceStateLabels } from '../shared/speech';
import RecordPicker from './RecordPicker.vue';
import SpeechBudget from './SpeechBudget.vue';
import SpeechRequest from './SpeechRequest.vue';
import LipSyncPreparation from './LipSyncPreparation.vue';
import GlobalVoiceEditor from './GlobalVoiceEditor.vue';
const newVoice = ref(false);
const props = defineProps<{ projectId: string; documents: any[] }>(),
  emit = defineEmits(['refresh']);
const voices = ref<any[]>([]),
  search = ref(''),
  chosen = ref(''),
  entity = ref<any>(null),
  name = ref(''),
  route = ref('tts'),
  locked = ref(true),
  pronunciation = ref(''),
  performance = ref(''),
  profile = ref(''),
  lineKey = ref(''),
  selectedVoice = ref<any>(null),
  selectedLine = ref<any>(null),
  error = ref(''),
  review = ref(''),
  inspected = ref(false),
  application = ref<any>(null),
  voiceOffset = ref(0),
  voiceTotal = ref(0);
const profiles = computed(() =>
  props.documents.filter((d) => d.kind === 'voice_profile' && d.data.version === 2),
);
const editing = ref<any>(null);
const editorOpen = ref(false);
function newApplication() {
  editing.value = null;
  application.value = null;
  entity.value = null;
  chosen.value = '';
  name.value = '';
  pronunciation.value = '';
  performance.value = '';
  inspected.value = false;
  review.value = '';
  editorOpen.value = true;
}
async function editProfile(p: any) {
  editorOpen.value = true;
  editing.value = p;
  application.value = p;
  name.value = p.data.name;
  entity.value = p.data.entity;
  chosen.value = p.data.globalVoice.id + ':' + p.data.globalVoice.revision;
  route.value = p.data.route;
  locked.value = p.data.requireVoiceIdentity;
  pronunciation.value = p.data.pronunciation;
  performance.value = p.data.performance;
  const fixed = await api(
    '/voices/' + p.data.globalVoice.id + '?revision=' + p.data.globalVoice.revision,
  );
  voices.value = [fixed, ...voices.value.filter((v) => v.id !== fixed.id)];
  inspected.value = false;
  review.value = '';
}
const lines = computed(() =>
  props.documents
    .filter((d) => d.kind === 'episode')
    .flatMap((ep) =>
      (ep.data.shots || []).flatMap((s: any) =>
        (s.directing?.sound?.dialogue || []).map((l: any) => ({
          key: ep.id + ':' + s.id + ':' + l.id,
          ep,
          shot: s,
          line: l,
          name: ep.data.title + '／' + s.id + '／' + l.text,
        })),
      ),
    ),
);
async function loadVoices() {
  try {
    const p = await api(
      '/voices?' +
        new URLSearchParams({
          search: search.value,
          offset: String(voiceOffset.value),
          limit: '25',
        }),
    );
    const selected = voices.value.find((v) => v.id + ':' + v.revision === chosen.value);
    voices.value =
      selected &&
      !p.items.some((v: any) => v.id === selected.id && v.revision === selected.revision)
        ? [selected, ...p.items]
        : p.items;
    voiceTotal.value = p.total;
  } catch (e: any) {
    error.value = e.message;
  }
}
onMounted(loadVoices);
async function save() {
  try {
    const v = voices.value.find((v) => v.id + ':' + v.revision === chosen.value);
    if (!v || !entity.value) throw new Error('选择固定全局音色及本作品主体');
    application.value = await api(
      editing.value
        ? '/domain/' + editing.value.id
        : '/projects/' + props.projectId + '/voice-applications',
      editing.value ? 'PUT' : 'POST',
      {
        ...(editing.value ? { revision: editing.value.revision } : {}),
        data: {
          version: 2,
          name: name.value || v.data.name,
          entity: entity.value,
          globalVoice: { id: v.id, revision: v.revision },
          language: v.data.language,
          timbre: v.data.description || v.data.name,
          pronunciation: pronunciation.value || v.data.pronunciation,
          performance: performance.value || v.data.performance,
          route: route.value,
          requireVoiceIdentity: locked.value,
        },
      },
    );
    editing.value = application.value;
    emit('refresh');
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function publish() {
  try {
    if (!inspected.value || !review.value.trim()) throw new Error('填写本角色的声音审查结论');
    application.value = await api('/domain/' + application.value.id + '/publish', 'POST', {
      revision: application.value.revision,
      review: { inspected: true, conclusion: review.value },
    });
    editing.value = application.value;
    emit('refresh');
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function bind() {
  try {
    const item = lines.value.find((l) => l.key === lineKey.value),
      p = profiles.value.find((p) => p.id === profile.value);
    if (!item || !p) throw new Error('选择台词和已发布声音应用');
    await api('/episodes/' + item.ep.id + '/line-production', 'PUT', {
      revision: item.ep.revision,
      shotId: item.shot.id,
      lineId: item.line.id,
      voiceProfile: { id: p.id, revision: p.revision },
      route: p.data.route,
    });
    emit('refresh');
    selectedLine.value = null;
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
async function prepare() {
  try {
    const item = lines.value.find((l) => l.key === lineKey.value);
    if (!item?.line.voiceProfile) throw new Error('先固定本句制作方式及声音应用');
    const p = await api(
      '/records/' + item.line.voiceProfile.id + '/versions/' + item.line.voiceProfile.revision,
    );
    if (p.data.route !== 'tts')
      throw new Error('此句不是 TTS 路线；导入配音使用下方采用入口，原生对白进入原视频准备');
    selectedVoice.value = await api(
      '/voices/' + p.data.globalVoice.id + '?revision=' + p.data.globalVoice.revision,
    );
    selectedLine.value = {
      episode: { id: item.ep.id, revision: item.ep.revision },
      shotId: item.shot.id,
      lineId: item.line.id,
      instanceId: item.line.instanceId,
      voiceProfile: item.line.voiceProfile,
      text: item.line.text,
    };
    error.value = '';
  } catch (e: any) {
    error.value = e.message;
  }
}
</script>
<template>
  <section class="panel">
    <h3>人物与声音</h3>
    <p>新音色默认在素材库的全局音色中创建。此处固定选角；全局升级不替换已选版本。</p>
    <SpeechBudget :project-id="projectId" />
    <p class="error" v-if="error">{{ error }}</p>
    <button @click="newVoice = true">新建全局音色并用于作品</button
    ><GlobalVoiceEditor v-if="newVoice" @saved="loadVoices" @close="newVoice = false" />
    <button @click="newApplication">新增角色声音应用</button>
    <details :open="editorOpen">
      <summary>{{ editing ? '编辑角色声音应用（保存为新版本）' : '角色声音应用' }}</summary>
      <label
        >搜索全局音色<input
          v-model="search"
          @change="
            voiceOffset = 0;
            loadVoices();
          " /></label
      ><label
        >固定全局音色版本<select v-model="chosen">
          <option value="">选择全局音色固定版本</option>
          <option
            v-for="v in voices"
            :key="v.id + ':' + v.revision"
            :value="v.id + ':' + v.revision"
          >
            {{ v.data.name }} v{{ v.revision }} · {{ voiceStateLabels[v.data.state] }}
          </option>
        </select></label
      ><button
        :disabled="voiceOffset === 0"
        @click="
          voiceOffset -= 25;
          loadVoices();
        "
      >
        上一页</button
      ><button
        :disabled="voiceOffset + 25 >= voiceTotal"
        @click="
          voiceOffset += 25;
          loadVoices();
        "
      >
        下一页</button
      ><RecordPicker
        :project-id="projectId"
        kind="entity"
        label="本作品角色／旁白主体"
        @select="entity = { id: $event.id, revision: $event.revision }"
      />
      <p>{{ entity }}</p>
      <label>应用名称<input v-model="name" /></label
      ><label
        >制作方式<select v-model="route">
          <option value="native">视频原生对白</option>
          <option value="imported">导入配音</option>
          <option value="tts">TTS 配音</option>
        </select></label
      ><label><input type="checkbox" v-model="locked" />要求固定声音身份</label
      ><label>发音要求<textarea v-model="pronunciation" /></label
      ><label>角色默认表演<textarea v-model="performance" /></label
      ><button @click="save">保存新应用版本</button
      ><template v-if="application"
        ><label><input type="checkbox" v-model="inspected" />已核对声音与角色</label
        ><label>结论<textarea v-model="review" /></label
        ><button @click="publish">发布作品声音应用</button></template
      >
    </details>
    <p v-for="p in profiles" :key="p.id">
      {{ p.data.name }} v{{ p.revision }} → 全局 v{{ p.data.globalVoice.revision }} ·
      {{ p.data.route }} · {{ p.data.published ? '已发布' : '草稿' }}
      <button @click="editProfile(p)">编辑／升级固定版本</button>
    </p>
    <h4>台词与配音工作台</h4>
    <label
      >台词<select v-model="lineKey" @change="selectedLine = null">
        <option value="">选择已采用台词</option>
        <option v-for="l in lines" :value="l.key">{{ l.name }}</option>
      </select></label
    ><label
      >声音应用<select v-model="profile">
        <option value="">选择已发布应用</option>
        <option v-for="p in profiles.filter((p) => p.data.published)" :value="p.id">
          {{ p.data.name }} v{{ p.revision }} · {{ p.data.route }}
        </option>
      </select></label
    ><button @click="bind">固定本句制作方式与声音</button
    ><button @click="prepare">读取本句合成依据</button>
    <SpeechRequest
      v-if="selectedLine && selectedVoice"
      :key="selectedLine.episode.revision + ':' + selectedLine.lineId"
      :voice="selectedVoice"
      :project-id="projectId"
      :text="selectedLine.text"
      :line="{
        episode: selectedLine.episode,
        shotId: selectedLine.shotId,
        lineId: selectedLine.lineId,
        instanceId: selectedLine.instanceId,
        voiceProfile: selectedLine.voiceProfile,
      }"
    />
    <LipSyncPreparation :project-id="projectId" :documents="documents" />
  </section>
</template>
