import { createHash } from 'node:crypto';
import {
  guideSchema,
  guidedPromptSchema,
  referenceSchema,
  frameCount as alignedFrameCount,
} from '../shared/contracts.js';
import { HttpError } from './db.js';
import type { Graph } from './comfy.js';

export const guidedTemplateVersion = 'native-h3-guided-v1';
export const guidedRulesVersion = 'h3-reference-writing-v1';
export interface GuidedImage {
  assetId: string;
  revision: number;
  key: string;
  label: string;
  name: string;
  sha256: string;
  width: number;
  height: number;
}
export interface GuidedPreparation {
  rulesVersion: string;
  frameCount: number;
  duration: number;
  images: GuidedImage[];
  subjects: { id: string; label: string; pictures: string[]; instructions: string[] }[];
  anchors: {
    assetId: string;
    revision: number;
    key: string;
    label: string;
    frameIndex: number;
    resolvedFrameIndex: number;
    seconds: number;
    instruction: string;
    crop: { x: number; y: number; width: number; height: number };
  }[];
  finalPrompt: string;
}

// One preparation owns reference ordering, subject grouping, timeline validation and
// prompt rendering. Preview and execution consume this same result.
export function prepareGuidedH3(
  input: any,
  options: { allowEmptyGuides?: boolean } = {},
): GuidedPreparation {
  const s = input.segment;
  if (s.mode !== 'ref2va') throw new HttpError(400, '时间关键帧增强只用于 Ref2VA');
  const guides = guideSchema
    .array()
    .min(options.allowEmptyGuides ? 0 : 1)
    .parse(s.guides);
  const refs = referenceSchema.array().parse(s.references);
  const prose = guidedPromptSchema.parse(s.guidedPrompt);
  if (!Number.isFinite(s.duration) || s.duration < 5 || s.duration > 15)
    throw new HttpError(400, 'H3 请求时长必须为 5–15 秒');
  const frameCount = alignedFrameCount(s.duration);
  const images: GuidedImage[] = [];
  const subjects: GuidedPreparation['subjects'] = [];
  const definitions: string[] = [];
  const retention: string[] = [];
  const assets = new Map<string, any>(
    input.assets.map((a: any) => [`${a.reference.assetId}:${a.reference.revision}`, a.asset]),
  );
  for (const r of [...refs, ...guides]) {
    const key = `${r.assetId}:${r.revision}`;
    if (images.some((i) => i.key === key)) continue;
    const asset = assets.get(key);
    if (!asset || asset.data.mediaType !== 'image')
      throw new HttpError(400, '本版关键帧增强需要图片参考；视频和音频参考请使用普通 Ref2VA');
    if (!(asset.data.width > 0 && asset.data.height > 0))
      throw new HttpError(400, '图片缺少有效尺寸');
    images.push({
      assetId: r.assetId,
      revision: r.revision,
      key,
      label: `<Picture ${images.length + 1}>`,
      name: asset.data.name,
      sha256: asset.data.sha256,
      width: asset.data.width,
      height: asset.data.height,
    });
  }
  if (images.length > 9) throw new HttpError(400, '参考图与关键帧去重后合计最多 9 张');
  for (const r of refs) {
    if (!['identity', 'scene', 'style', 'prop'].includes(r.role))
      throw new HttpError(
        400,
        '增强模式请在关键帧区域指定首尾帧，参考用途使用身份、场景、画风或道具',
      );
    const key = `${r.assetId}:${r.revision}`;
    const picture = images.find((i) => i.key === key)!;
    const id = r.subjectId || assets.get(key).data.entityId || r.assetId;
    let subject = subjects.find((v) => v.id === id);
    if (!subject) {
      subject = { id, label: `<Subject ${subjects.length + 1}>`, pictures: [], instructions: [] };
      subjects.push(subject);
    }
    if (!subject.pictures.includes(picture.label)) subject.pictures.push(picture.label);
    subject.instructions.push(
      `${r.role}: ${r.instruction || 'Preserve the referenced visual features.'}`,
    );
  }
  for (const subject of subjects) {
    const instructions = [...new Set(subject.instructions)].join(' ');
    definitions.push(
      `${subject.label} is the same referenced content across ${subject.pictures.join(', ')}. ${instructions}`,
    );
    retention.push(
      `${subject.label}: fully_preserved - Preserve only the assigned reference attributes: ${instructions} Newly specified actions are not identity changes.`,
    );
  }
  const usedFrames = new Set<number>();
  const anchors = guides
    .map((g) => {
      const resolved = g.frameIndex === -1 ? frameCount - 1 : g.frameIndex;
      if (resolved >= frameCount)
        throw new HttpError(400, `关键帧 ${resolved} 越界，有效范围为 0–${frameCount - 1}`);
      if (usedFrames.has(resolved)) throw new HttpError(400, `关键帧位置冲突：第 ${resolved} 帧`);
      usedFrames.add(resolved);
      const key = `${g.assetId}:${g.revision}`;
      const picture = images.find((i) => i.key === key)!;
      // Matches common_upscale(..., crop='center'): integer crop before Lanczos resize.
      const sourceRatio = picture.width / picture.height;
      const targetRatio = input.width / input.height;
      const horizontal =
        sourceRatio > targetRatio
          ? (picture.width - picture.width * (targetRatio / sourceRatio)) / 2
          : 0;
      const vertical =
        sourceRatio < targetRatio
          ? (picture.height - picture.height * (sourceRatio / targetRatio)) / 2
          : 0;
      // Python round uses ties-to-even; Math.round alone shifts odd-sized crops by a pixel.
      const [x, y] = [horizontal, vertical].map((v) =>
        v % 1 === 0.5 ? 2 * Math.round(v / 2) : Math.round(v),
      );
      return {
        ...g,
        key,
        label: picture.label,
        resolvedFrameIndex: resolved,
        seconds: resolved / 24,
        crop: { x, y, width: picture.width - 2 * x, height: picture.height - 2 * y },
      };
    })
    .sort((a, b) => a.resolvedFrameIndex - b.resolvedFrameIndex);
  for (const anchor of anchors) {
    definitions.push(
      `${anchor.label} is a composition and state anchor at frame ${anchor.resolvedFrameIndex} (${anchor.seconds.toFixed(3)} seconds). ${anchor.instruction}`,
    );
    retention.push(
      `${anchor.label}: fully_preserved - Follow the approved anchor's composition and state at frame ${anchor.resolvedFrameIndex}; ${anchor.instruction}`,
    );
  }
  if (!/\[Shot 1\]/.test(prose.detailedDescription))
    throw new HttpError(400, '逐镜头描述须包含 [Shot 1]');
  let previousCut = 0;
  const shots = [...prose.detailedDescription.matchAll(/\[Shot (\d+)\]([^[]*)/g)];
  for (let i = 0; i < shots.length; i++) {
    if (Number(shots[i][1]) !== i + 1) throw new HttpError(400, 'Shot 编号必须从 1 连续递增');
    if (i === 0) {
      if (/^\s*At \d{2}:\d{2}\.\d{3},/.test(shots[i][2]))
        throw new HttpError(400, '首镜头从起始状态开始，不标记切换时间');
      continue;
    }
    const time = shots[i][2].match(/^\s*At (\d{2}):(\d{2})\.(\d{3}),/);
    if (!time || Number(time[2]) >= 60)
      throw new HttpError(400, '后续镜头须以 At MM:SS.mmm, 标记切换时间');
    const seconds = Number(time[1]) * 60 + Number(time[2]) + Number(time[3]) / 1000;
    if (seconds <= previousCut || seconds >= frameCount / 24)
      throw new HttpError(400, '镜头时间必须递增且位于有效片长内');
    previousCut = seconds;
  }
  const finalPrompt = [
    `subject_definitions:\n${definitions.join('\n')}`,
    `summary:\n${prose.summary}`,
    `retention_analysis:\n${retention.join('\n')}`,
    `detailed_description:\n${prose.detailedDescription}`,
    `overall_soundscape:\n${prose.overallSoundscape}`,
    `non_diegetic_music:\n${prose.nonDiegeticMusic}`,
  ].join('\n\n');
  const validLabels = new Set([...images.map((i) => i.label), ...subjects.map((v) => v.label)]);
  for (const tag of finalPrompt.matchAll(/<(?:Picture|Subject|Video|Audio)\s+\d+>/g))
    if (!validLabels.has(tag[0])) throw new HttpError(400, `提示词引用未绑定标签 ${tag[0]}`);
  return {
    rulesVersion: guidedRulesVersion,
    frameCount,
    duration: frameCount / 24,
    images,
    subjects,
    anchors,
    finalPrompt,
  };
}

export function generationDigest(input: any) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export function attachGuidedH3(
  graph: Graph,
  input: any,
  files: Map<string, string>,
  prepared: GuidedPreparation = prepareGuidedH3(input),
): Graph {
  if (input.prepared && generationDigest(input.prepared) !== generationDigest(prepared))
    throw new HttpError(409, '冻结的增强模板与当前编译结果不一致，请创建新任务');
  graph.condition.inputs.prompt = prepared.finalPrompt;
  prepared.images.forEach((picture, index) => {
    const filename = files.get(picture.key);
    if (!filename) throw new HttpError(400, `缺少图片版本上传回执 ${picture.key}`);
    graph[`guided_image_${index}`] = { class_type: 'LoadImage', inputs: { image: filename } };
    graph.condition.inputs[`ref_images.ref_image_${index}`] = [`guided_image_${index}`, 0];
  });
  let positive: [string, number] = ['condition', 0];
  prepared.anchors.forEach((anchor, index) => {
    const imageIndex = prepared.images.findIndex((i) => i.key === anchor.key);
    const id = `guide_${index}`;
    graph[id] = {
      class_type: 'MiniMaxH3AddGuide',
      inputs: {
        positive,
        latent: ['condition', 1],
        vae: ['video_vae', 0],
        image: [`guided_image_${imageIndex}`, 0],
        frame_idx: anchor.resolvedFrameIndex,
      },
    };
    positive = [id, 0];
  });
  graph.guider.inputs.conditioning = positive;
  return graph;
}

export function guidedCapability(nodes: any): { available: boolean; reason: string } {
  const guide = nodes.MiniMaxH3AddGuide;
  const reference = nodes.MiniMaxH3ReferenceToVideo;
  if (!guide) return { available: false, reason: '云端缺少 MiniMaxH3AddGuide' };
  const inputs = { ...guide.input?.required, ...guide.input?.optional };
  for (const [name, type] of Object.entries({
    positive: 'CONDITIONING',
    latent: 'LATENT',
    frame_idx: 'INT',
    image: 'IMAGE',
    vae: 'VAE',
  }))
    if (inputs[name]?.[0] !== type)
      return { available: false, reason: `Add Guide 输入 ${name} 契约不匹配` };
  if (guide.output?.length !== 1 || guide.output[0] !== 'CONDITIONING')
    return { available: false, reason: 'Add Guide 必须仅输出 CONDITIONING' };
  if (reference?.output?.[0] !== 'CONDITIONING' || reference?.output?.[1] !== 'LATENT')
    return { available: false, reason: 'Ref2VA 输出契约不匹配' };
  return { available: true, reason: '支持图片参考与时间关键帧联合约束' };
}
