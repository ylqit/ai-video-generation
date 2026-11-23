import { timelineMap, type EditDecisionList } from './edit-timeline.js';
export type TimelineCommand =
  | {
      action: 'trim';
      track: 'clips' | 'audio';
      index: number;
      boundary: 'in' | 'out';
      seconds: number;
    }
  | { action: 'reorder'; index: number; to: number }
  | { action: 'split'; index: number; frame: number; newId: string }
  | { action: 'transition'; index: number; frames: number }
  | { action: 'shift'; audio: number[]; subtitles: string[]; deltaFrames: number };

/** Both pointer editing and exact inputs use these commands. Independent lanes never ripple implicitly. */
export function editTimeline(
  source: EditDecisionList,
  command: TimelineCommand,
  media: Array<{ id: string; revision: number; data: any }>,
) {
  const edl: EditDecisionList = JSON.parse(JSON.stringify(source)),
    notices: string[] = [];
  const integer = (value: number) => {
    if (!Number.isInteger(value)) throw new Error('画面与时间线位置必须使用整数帧');
    return value;
  };
  if (command.action === 'trim') {
    const c = edl[command.track][command.index];
    if (!c) throw new Error('片段不存在');
    const asset = media.find((a) => a.id === c.assetId && a.revision === c.revision);
    if (!asset) throw new Error('源媒体版本不可用');
    let time = command.seconds;
    if (!Number.isFinite(time) || time < 0) throw new Error('裁剪位置无效');
    if (command.track === 'clips') {
      if (Math.abs(time * 24 - Math.round(time * 24)) > 1e-6)
        throw new Error('画面裁剪需要 24 fps 整帧');
      time = Math.round(time * 24) / 24;
    }
    if (asset.data.mediaType !== 'image' && time > asset.data.duration + 1e-8)
      throw new Error('裁剪超出真实源媒体');
    if (command.boundary === 'in' ? time >= c.out : time <= c.in)
      throw new Error('采用范围至少保留一帧画面或有效音频');
    c[command.boundary] = time;
    if (command.track === 'audio') {
      const a = edl.audio[command.index],
        rate =
          a.sampleRange?.sampleRate ||
          Number(asset.data.streams?.find((s: any) => s.type === 'audio')?.sampleRate);
      if (rate > 0) {
        a.sampleRange = {
          sampleRate: rate,
          inSample: Math.round(a.in * rate),
          outSample: Math.round(a.out * rate),
        };
        a.in = a.sampleRange.inSample / rate;
        a.out = a.sampleRange.outSample / rate;
        if (a.out <= a.in) throw new Error('音频裁剪至少保留一个采样');
      } else if (
        Math.abs(a.in * 24 - Math.round(a.in * 24)) > 1e-6 ||
        Math.abs(a.out * 24 - Math.round(a.out * 24)) > 1e-6
      )
        throw new Error('缺少实际采样率，无法固定精细音频边界');
    }
  } else if (command.action === 'reorder') {
    const { index, to } = command;
    if (!edl.clips[index] || to < 0 || to >= edl.clips.length) throw new Error('排序位置无效');
    const [c] = edl.clips.splice(index, 1);
    edl.clips.splice(to, 0, c);
    edl.clips.forEach((c, i) => {
      if (c.transition && c.transition.fromClipId !== edl.clips[i - 1]?.id) {
        delete c.transition;
        notices.push('片段 ' + (i + 1) + ' 的相邻素材变化，已移除旧叠化；音轨与字幕位置保留');
      }
    });
  } else if (command.action === 'split') {
    const entry = timelineMap(edl).clips[command.index];
    if (!entry) throw new Error('分割片段不存在');
    const offset = integer(command.frame) - entry.startFrame;
    if (
      offset <= entry.overlap ||
      offset >= entry.frames - (edl.clips[command.index + 1]?.transition?.frames || 0)
    )
      throw new Error('分割点必须位于片段内部并避开叠化区间');
    if (edl.clips.some((c) => c.id === command.newId)) throw new Error('新片段标识重复');
    const left = edl.clips[command.index],
      split = left.in + offset / 24,
      right = { ...structuredClone(left), id: command.newId, in: split };
    left.out = split;
    delete right.transition;
    delete right.visualFadeInFrames;
    delete right.fadeInFrames;
    delete left.visualFadeOutFrames;
    delete left.fadeOutFrames;
    edl.clips.splice(command.index + 1, 0, right);
    const next = edl.clips[command.index + 2];
    if (next?.transition) next.transition.fromClipId = right.id;
  } else if (command.action === 'transition') {
    const c = edl.clips[command.index],
      frames = integer(command.frames);
    if (!c || !command.index || frames < 0) throw new Error('转场需要相邻两侧片段');
    if (!frames) delete c.transition;
    else c.transition = { kind: 'dissolve', fromClipId: edl.clips[command.index - 1].id!, frames };
  } else {
    const delta = integer(command.deltaFrames);
    for (const i of new Set(command.audio)) {
      const a = edl.audio[i];
      if (!a) throw new Error('音轨不存在');
      a.start = (Math.round(a.start * 24) + delta) / 24;
      if (a.start < 0) throw new Error('音轨不能移到零点之前');
    }
    for (const id of new Set(command.subtitles)) {
      const o = edl.overlays?.find((o) => o.id === id);
      if (!o) throw new Error('字幕不存在');
      o.startFrame += delta;
      o.endFrame += delta;
      if (o.startFrame < 0) throw new Error('字幕不能移到零点之前');
    }
  }
  for (const [i, c] of edl.clips.entries()) {
    const count = Math.round((c.out - c.in) * 24),
      incoming = c.transition?.frames || 0,
      outgoing = edl.clips[i + 1]?.transition?.frames || 0;
    if (count < 1 || incoming >= count || outgoing >= count || incoming + outgoing > count)
      throw new Error('裁剪或转场耗尽片段，请先缩短相关叠化');
    if (
      (c.visualFadeInFrames || 0) + (c.visualFadeOutFrames || 0) > count ||
      (c.fadeInFrames || 0) + (c.fadeOutFrames || 0) > count
    )
      throw new Error('裁剪或分割穿过淡入淡出，请先调整包络');
  }
  const frames = timelineMap(edl).frames;
  for (const a of edl.audio)
    if ((a.fadeInFrames || 0) + (a.fadeOutFrames || 0) > Math.round((a.out - a.in) * 24))
      throw new Error('音频裁剪穿过包络，请先缩短淡入淡出');
  if (edl.overlays?.some((o) => o.endFrame > frames))
    notices.push('部分字幕超出缩短后的成片，位置保留；请明确移动或裁剪');
  if (edl.audio.some((a) => a.start + a.out - a.in > frames / 24))
    notices.push('部分独立音轨延伸到画面之外；请核对声音结束位置');
  return { edl, notices };
}
