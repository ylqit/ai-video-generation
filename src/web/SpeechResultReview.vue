<script setup lang="ts">
import { ref, watch } from 'vue';
import { api, assetUrl } from './api';
const props = defineProps<{ job: any; documents: any[] }>(),
  emit = defineEmits(['refresh']);
const voice = ref<any>(null),
  notes = ref(''),
  listened = ref(false),
  voiceMatch = ref(false),
  actualText = ref(props.job.input.text || ''),
  error = ref(''),
  busy = ref(false),
  saved = ref(''),
  start = ref(0),
  end = ref(0);
watch(
  () => props.job.id + ':' + props.job.state,
  async () => {
    const j = props.job;
    notes.value = '';
    listened.value = false;
    voiceMatch.value = false;
    actualText.value = j.input.text || '';
    error.value = '';
    saved.value = '';
    start.value = 0;
    end.value = j.output.audioTiming?.duration || 0;
    if (!j.projectId) {
      try {
        voice.value = await api('/voices/' + (j.output.voiceResult?.id || j.input.voice.id));
      } catch (e: any) {
        error.value = e.message;
      }
    }
  },
  { immediate: true },
);
async function confirm() {
  if (busy.value || saved.value) return;
  busy.value = true;
  try {
    if (!props.job.projectId) {
      if (!listened.value || !voiceMatch.value)
        throw new Error('此操作记录全局音色的可选听审结论；未听审音色仍可用于合成');
      await api('/voices/' + voice.value.id + '/confirm', 'POST', {
        revision: voice.value.revision,
        review: { audition: props.job.output.libraryMedia, listened: true, notes: notes.value },
      });
      saved.value = '音色已确认；作品可固定选用这个新版本';
    } else {
      const j = props.job,
        line = j.input.line;
      let a = props.documents.find((d) => d.id === j.output.assetIds?.[0]);
      if (!a) throw new Error('归档音频尚未读取');
      const ep = await api('/records/' + line.episode.id);
      if (!a.data.adopted)
        a = await api('/assets/' + a.id + '/adopt', 'POST', {
          revision: a.revision,
          adopted: true,
        });
      const sr = j.output.audioTiming.sampleRate,
        inSample = Math.round(start.value * sr),
        outSample = Math.round(end.value * sr);
      const take = await api('/projects/' + j.projectId + '/dialogue-takes', 'POST', {
        data: {
          version: 1,
          episode: { id: ep.id, revision: ep.revision },
          shotId: line.shotId,
          lineId: line.lineId,
          instanceId: line.instanceId,
          voice: line.voiceProfile,
          asset: { id: a.id, revision: a.revision },
          in: inSample / sr,
          out: outSample / sr,
          sampleRange: { sampleRate: sr, inSample, outSample },
          actualText: actualText.value,
          source: 'tts',
          synthesisJobId: j.id,
          listened: listened.value,
          voiceMatch: voiceMatch.value,
          conclusion: notes.value,
        },
      });
      saved.value = '已采用对白 ' + take.id + '；在剪辑中添加此对白音轨并处理原声。';
    }
    error.value = '';
    emit('refresh');
  } catch (e: any) {
    error.value = e.message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section v-if="job.state === 'succeeded'" class="panel">
    <h3>{{ job.kind === 'voice_clone' ? '复刻结果与试听' : '配音选用与可选听审' }}</h3>
    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="saved">{{ saved }}</p>
    <template v-if="job.output.libraryMedia || job.output.assetIds?.length"
      ><audio
        controls
        :src="
          job.projectId
            ? assetUrl(job.output.assetIds[0])
            : '/api/voice-media/' +
              job.output.libraryMedia.id +
              '/file?revision=' +
              job.output.libraryMedia.revision
        "
      />
      <template v-if="job.projectId"
        ><label>台词文本（未听审时来自请求）<textarea v-model="actualText" /></label
        ><label>采用起点（秒）<input type="number" step="any" v-model.number="start" /></label
        ><label>采用终点（秒）<input type="number" step="any" v-model.number="end" /></label
      ></template>
      <label
        ><input
          type="checkbox"
          v-model="listened"
        />已播放整个采用区间，检查意外人声、发音和噪声</label
      ><label><input type="checkbox" v-model="voiceMatch" />说话者与固定声音身份相符</label
      ><label>可选听审结论<textarea v-model="notes" /></label
      ><button
        :disabled="
          busy || !!saved || (!job.projectId && (!listened || !voiceMatch || !notes.trim()))
        "
        @click="confirm"
      >
        {{ job.projectId ? '采用此句配音' : '确认全局音色版本' }}
      </button></template
    >
    <p v-else>远端身份已归档，尚无试听。请到全局音色库准备新的合成试听。</p>
    <p>选用表示制作决定；没有听审不自动写成声音身份或口型通过。</p>
  </section>
</template>
