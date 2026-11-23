import { DomainService } from './domain-service.js';
import { Store, HttpError } from './db.js';
import { dialogueTakeSchema } from '../shared/series.js';
import { fixedSeriesRecord } from './series-production.js';

export function saveDialogueTake(store: Store, projectId: string, raw: unknown) {
  const data = dialogueTakeSchema.parse(raw),
    ep = fixedSeriesRecord(store, projectId, data.episode, 'episode');
  if (store.get(ep.id).revision !== ep.revision) throw new HttpError(409, '对白审核需要当前分集');
  const shot = ep.data.shots.find((s: any) => s.id === data.shotId),
    line = shot?.directing?.sound.dialogue.find((l: any) => l.id === data.lineId);
  const voice = line?.voiceProfile
    ? fixedSeriesRecord(store, projectId, line.voiceProfile, 'voice_profile')
    : null;
  if (
    !line ||
    line.instanceId !== data.instanceId ||
    line.text !== data.actualText ||
    !voice ||
    voice.data.stale ||
    voice.id !== data.voice.id ||
    voice.revision !== data.voice.revision ||
    line.voiceProfile?.id !== voice.id ||
    line.voiceProfile?.revision !== voice.revision
  )
    throw new HttpError(409, '对白、说话者或固定声音版本不符');
  const asset = fixedSeriesRecord(store, projectId, data.asset, 'asset');
  if (
    data.sampleRange &&
    Number(asset.data.streams?.find((s: any) => s.type === 'audio')?.sampleRate) !==
      data.sampleRange.sampleRate
  )
    throw new HttpError(400, '采用采样率必须来自实际归档音频');
  if (data.source === 'tts') {
    if (!data.synthesisJobId || asset.data.jobId !== data.synthesisJobId)
      throw new HttpError(400, '合成音频需要匹配作业回执');
    const job = store.job(data.synthesisJobId);
    if (
      job.kind !== 'speech' ||
      job.state !== 'succeeded' ||
      job.projectId !== projectId ||
      job.input.text !== data.actualText ||
      job.input.line?.instanceId !== data.instanceId ||
      job.input.line?.voiceProfile.id !== data.voice.id ||
      job.input.line?.voiceProfile.revision !== data.voice.revision
    )
      throw new HttpError(409, '声音作业与台词、说话者或版本不符');
  }
  if (
    data.sampleRange &&
    (data.sampleRange.outSample <= data.sampleRange.inSample ||
      data.sampleRange.outSample > Math.round(asset.data.duration * data.sampleRange.sampleRate) ||
      Math.abs(data.sampleRange.inSample / data.sampleRange.sampleRate - data.in) >
        1 / data.sampleRange.sampleRate ||
      Math.abs(data.sampleRange.outSample / data.sampleRange.sampleRate - data.out) >
        1 / data.sampleRange.sampleRate)
  )
    throw new HttpError(400, '声音采样区间与采用范围不匹配');
  if (
    asset.data.mediaType !== 'audio' ||
    data.out > asset.data.duration ||
    (!data.sampleRange &&
      [data.in, data.out].some((n) => Math.abs(n * 24 - Math.round(n * 24)) > 1e-6))
  )
    throw new HttpError(400, '对白需要本作品音频及有效区间');
  if (data.source === 'h3_extracted') {
    if (!data.sourceVideo) throw new HttpError(400, 'H3 提取对白需要原视频');
    const video = fixedSeriesRecord(store, projectId, data.sourceVideo, 'asset');
    if (
      !video.data.jobId ||
      video.data.jobId !== asset.data.jobId ||
      video.data.mediaType !== 'video'
    )
      throw new HttpError(400, '提取声音与 H3 视频来源不符');
  }
  return store.transaction(() => {
    const doc = store.create('dialogue_take', projectId, data, ep.id),
      domain = new DomainService(store);
    domain.dependencies(doc, domain.refs(data));
    return doc;
  });
}
