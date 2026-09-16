<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Job, RecordDoc } from '../shared/contracts';
import { assetUrl } from './api';
const props = defineProps<{ job: Job; assets: RecordDoc[] }>();
const comparison = ref('');
const videos = computed(() =>
  props.assets.filter(
    (a) => a.data.mediaType === 'video' && a.id !== props.job.output.videoAssetId,
  ),
);
</script>
<template>
  <div class="generation-review" v-if="job.input.prepared && job.output.videoAssetId">
    <h4>生成结果与身份对照</h4>
    <label
      >选择此前视频进行对照<select v-model="comparison">
        <option value="">不显示对照视频</option>
        <option v-for="a in videos" :key="a.id" :value="a.id">
          {{ a.data.name }} · v{{ a.revision }}
        </option>
      </select></label
    >
    <div class="review-videos">
      <figure>
        <video :src="assetUrl(job.output.videoAssetId)" controls preload="metadata" />
        <figcaption>本次候选；可暂停检查动作过程与主体的关键特征</figcaption>
      </figure>
      <figure v-if="comparison">
        <video
          :src="assetUrl(comparison, videos.find((a) => a.id === comparison)?.revision)"
          controls
          preload="metadata"
        />
        <figcaption>此前候选；用于观察差异，不构成单因素对照实验</figcaption>
      </figure>
    </div>
    <div class="review-stills">
      <figure v-for="p in job.input.prepared.images" :key="p.key">
        <img :src="assetUrl(p.assetId, p.revision)" :alt="p.name" />
        <figcaption>{{ p.label }} · {{ p.name }} · v{{ p.revision }}</figcaption>
      </figure>
      <figure v-for="f in job.output.reviewFrames || []" :key="f.assetId">
        <img :src="assetUrl(f.assetId, f.revision)" :alt="`生成审核帧 ${f.frameIndex}`" />
        <figcaption>第 {{ f.frameIndex }} 帧 · {{ f.seconds.toFixed(3) }} 秒</figcaption>
      </figure>
    </div>
    <p v-if="job.output.mediaCheck">
      实际 {{ job.output.mediaCheck.frameCount }} 帧 /
      {{ job.output.mediaCheck.duration.toFixed(3) }} 秒 · {{ job.output.mediaCheck.width }}×{{
        job.output.mediaCheck.height
      }}
      · {{ job.output.mediaCheck.frameCountMatches ? '帧数符合请求' : '帧数与预期不同，请复核' }}
    </p>
    <p class="muted">
      抽帧用于检查起始、运动过程与结束状态；系统不会自动认定一致性通过。请依据主体设定检查结构、材质、数量、附着关系和场景方向，并记录不适用或未检查的项目。
    </p>
  </div>
</template>
<style scoped>
.generation-review {
  margin-top: 20px;
  border-top: 1px solid #d6dfe9;
  padding-top: 12px;
}
.review-videos {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.review-videos figure {
  flex: 1;
  min-width: 260px;
  margin: 12px 0;
}
video {
  width: 100%;
  max-height: 320px;
  background: #192128;
}
.review-stills {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.review-stills figure {
  margin: 10px 0;
  width: 200px;
}
.review-stills img {
  width: 100%;
  height: 130px;
  object-fit: contain;
  background: #f1f2f4;
}
figcaption {
  font-size: 12px;
  line-height: 1.6;
}
</style>
