import { DomainService } from './domain-service.js';
import { Store, HttpError } from './db.js';
import { dialogueTakeSchema } from '../shared/series.js';
import { fixedSeriesRecord, resolveSeries } from './series-production.js';

export function saveDialogueTake(store: Store, projectId: string, raw: unknown) {
  const data = dialogueTakeSchema.parse(raw),
    ep = fixedSeriesRecord(store, projectId, data.episode, 'episode');
  if (store.get(ep.id).revision !== ep.revision) throw new HttpError(409, '对白审核需要当前分集');
  const { voices } = resolveSeries(store, ep),
    shot = ep.data.shots.find((s: any) => s.id === data.shotId),
    line = shot?.directing?.sound.dialogue.find((l: any) => l.id === data.lineId);
  const voice = voices.find((v) => v.instanceId === data.instanceId)?.record;
  if (
    !line ||
    line.instanceId !== data.instanceId ||
    line.text !== data.actualText ||
    !voice ||
    voice.id !== data.voice.id ||
    voice.revision !== data.voice.revision ||
    line.voiceProfile.id !== voice.id ||
    line.voiceProfile.revision !== voice.revision
  )
    throw new HttpError(409, '对白、说话者或固定声音版本不符');
  const asset = fixedSeriesRecord(store, projectId, data.asset, 'asset');
  if (
    !asset.data.adopted ||
    asset.data.mediaType !== 'audio' ||
    data.out > asset.data.duration ||
    [data.in, data.out].some((n) => Math.abs(n * 24 - Math.round(n * 24)) > 1e-6)
  )
    throw new HttpError(400, '对白需要已采用音频及有效整帧区间');
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
