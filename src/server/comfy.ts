import {
  modularRefTemplate,
  modularBaseTemplate,
  universalRefTemplate,
  universalBaseTemplate,
  seriesRefTemplate,
  seriesBaseTemplate,
  prepareModularH3,
} from './modular-h3.js';
import { generationDigest } from './h3-guided.js';
import { directedTemplateVersion, prepareDirectedH3 } from './directed-h3.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import WebSocket from 'ws';
import type { Job } from '../shared/contracts.js';
import { frameCount } from '../shared/contracts.js';
export { frameCount } from '../shared/contracts.js';
import { HttpError } from './db.js';
import { attachGuidedH3, guidedCapability, guidedTemplateVersion } from './h3-guided.js';
import { plannedTemplateVersion, preparePlannedH3 } from './reference-plan.js';
export type Graph = Record<string, { class_type: string; inputs: Record<string, any> }>;
export const models = {
  ref: 'minimax_h3_ref2va_pruned_int8_convrot.safetensors',
  fl: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors',
  clip: 'qwen3vl_32b_minimax_h3_int4_convrot.safetensors',
  video: 'minimax_h3_video_vae_fp16.safetensors',
  audio: 'minimax_h3_audio_vae_fp32.safetensors',
};
export function compileH3(input: any, files: Map<string, string>, jobId: string): Graph {
  if (['canvas-h3-v1', 'canvas-h3-v2'].includes(input.templateVersion)) {
    if (input.segment.mode === 'ref2va') {
      const graph = compileNativeH3(
        { ...input, segment: { ...input.segment, references: [] } },
        new Map(),
        jobId,
      );
      return attachGuidedH3(graph, input, files, input.prepared);
    }
    return compileNativeH3(input, files, jobId);
  }

  if (
    [modularBaseTemplate, universalBaseTemplate, seriesBaseTemplate].includes(input.templateVersion)
  ) {
    const prepared = prepareModularH3(input);
    if (generationDigest(prepared) !== generationDigest(input.prepared))
      throw new HttpError(409, '固定 Base 预览已变化');
    return compileNativeH3(
      { ...input, segment: { ...input.segment, prompt: prepared.finalPrompt } },
      files,
      jobId,
    );
  }
  if (
    [modularRefTemplate, universalRefTemplate, seriesRefTemplate].includes(input.templateVersion)
  ) {
    const graph = compileNativeH3(
      { ...input, segment: { ...input.segment, references: [] } },
      new Map(),
      jobId,
    );
    return attachGuidedH3(graph, input, files, prepareModularH3(input));
  }
  if (input.templateVersion === directedTemplateVersion) {
    const graph = compileNativeH3(
      { ...input, segment: { ...input.segment, references: [] } },
      new Map(),
      jobId,
    );
    return attachGuidedH3(graph, input, files, prepareDirectedH3(input));
  }
  if (input.templateVersion === plannedTemplateVersion) {
    const graph = compileNativeH3(
      { ...input, segment: { ...input.segment, references: [] } },
      new Map(),
      jobId,
    );
    return attachGuidedH3(graph, input, files, preparePlannedH3(input));
  }
  if (input.templateVersion === guidedTemplateVersion) {
    const graph = compileNativeH3(
      { ...input, segment: { ...input.segment, references: [] } },
      new Map(),
      jobId,
    );
    return attachGuidedH3(graph, input, files);
  }
  if (input.segment.guides?.length)
    throw new HttpError(400, '带关键帧的任务必须使用增强模板，不能降级执行');
  return compileNativeH3(input, files, jobId);
}
function compileNativeH3(input: any, files: Map<string, string>, jobId: string): Graph {
  const s = input.segment,
    ref = s.mode === 'ref2va';
  const refs = s.references || [];
  if (ref && refs.some((r: any) => ['first_frame', 'last_frame'].includes(r.role)))
    throw new HttpError(400, 'Ref2VA 身份参考不能代替首尾帧条件');
  if (s.mode === 't2v' && refs.length)
    throw new HttpError(400, 'T2V 不接受参考图，请选择 I2V 或 Ref2VA');
  if (
    s.mode === 'i2v' &&
    (!refs.length || refs.some((r: any) => !['first_frame', 'last_frame'].includes(r.role)))
  )
    throw new HttpError(400, 'I2V 需要首帧或尾帧');
  const graph: Graph = {
    model: {
      class_type: 'UNETLoader',
      inputs: { unet_name: ref ? models.ref : models.fl, weight_dtype: 'default' },
    },
    clip: {
      class_type: 'CLIPLoader',
      inputs: { clip_name: models.clip, type: 'minimax', device: 'default' },
    },
    video_vae: { class_type: 'VAELoader', inputs: { vae_name: models.video } },
    audio_vae: { class_type: 'VAELoader', inputs: { vae_name: models.audio } },
    condition: {
      class_type: ref ? 'MiniMaxH3ReferenceToVideo' : 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['clip', 0],
        vae: ['video_vae', 0],
        prompt: s.prompt,
        width: input.width,
        height: input.height,
        length: frameCount(s.duration),
        ...(ref ? { audio_vae: ['audio_vae', 0], ref_image_size: 'match' } : {}),
      },
    },
    sampler: { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    schedule: {
      class_type: 'BasicScheduler',
      inputs: { model: ['model', 0], scheduler: 'simple', steps: input.steps, denoise: 1 },
    },
    noise: { class_type: 'RandomNoise', inputs: { noise_seed: input.seed } },
    guider: {
      class_type: 'BasicGuider',
      inputs: { model: ['model', 0], conditioning: ['condition', 0] },
    },
    sample: {
      class_type: 'SamplerCustomAdvanced',
      inputs: {
        noise: ['noise', 0],
        guider: ['guider', 0],
        sampler: ['sampler', 0],
        sigmas: ['schedule', 0],
        latent_image: ['condition', 1],
      },
    },
    decode_video: {
      class_type: 'VAEDecode',
      inputs: { samples: ['sample', 0], vae: ['video_vae', 0] },
    },
    decode_audio: {
      class_type: 'VAEDecodeAudio',
      inputs: { samples: ['sample', 0], vae: ['audio_vae', 0] },
    },
    combine: {
      class_type: 'CreateVideo',
      inputs: { images: ['decode_video', 0], audio: ['decode_audio', 0], fps: 24, bit_depth: 8 },
    },
    save: {
      class_type: 'SaveVideo',
      inputs: {
        video: ['combine', 0],
        filename_prefix: `studio/${jobId}`,
        format: 'mp4',
        codec: 'h264',
      },
    },
  };
  let imageIndex = 0,
    videoIndex = 0,
    audioIndex = 0;
  const anchorRoles = new Set<string>();
  const instructions: string[] = [];
  for (const [i, r] of refs.entries()) {
    const media = input.assets.find(
      (a: any) => a.reference.assetId === r.assetId && a.reference.revision === r.revision,
    )?.asset.data;
    const filename = files.get(
      [
        modularBaseTemplate,
        universalBaseTemplate,
        seriesBaseTemplate,
        'canvas-h3-v1',
        'canvas-h3-v2',
      ].includes(input.templateVersion)
        ? `${r.assetId}:${r.revision}`
        : r.assetId,
    );
    if (!filename) throw new Error('缺少已上传素材回执');
    const node = `reference_${i}`;
    if (ref && r.role === 'video') {
      if (media?.mediaType !== 'video' || media.duration < 2 || media.duration > 15)
        throw new HttpError(400, '参考视频必须为 2–15 秒');
      if (videoIndex >= 3) throw new HttpError(400, '最多 3 段参考视频');
      graph[node] = {
        class_type: 'VHS_LoadVideo',
        inputs: {
          video: filename,
          force_rate: 24,
          custom_width: 0,
          custom_height: 0,
          frame_load_cap: 360,
          skip_first_frames: 0,
          select_every_nth: 1,
          format: 'None',
        },
      };
      graph.condition.inputs[`ref_videos.ref_video_${videoIndex}`] = [node, 0];
      if (media.hasAudio)
        graph.condition.inputs[`ref_video_audios.ref_video_audio_${videoIndex}`] = [node, 2];
      instructions.push(
        `<Video ${++videoIndex}>: ${r.instruction || 'Use as motion and audiovisual reference.'}`,
      );
    } else if (ref && r.role === 'audio') {
      if (media?.mediaType !== 'audio') throw new HttpError(400, '音频参考请使用独立音频资产');
      if (audioIndex >= 3) throw new HttpError(400, '最多 3 段参考音频');
      graph[node] = { class_type: 'LoadAudio', inputs: { audio: filename } };
      graph.condition.inputs[`ref_audios.ref_audio_${audioIndex}`] = [node, 0];
      instructions.push(`<Audio ${++audioIndex}>: ${r.instruction || 'Use as audio reference.'}`);
    } else {
      if (media?.mediaType !== 'image') throw new HttpError(400, '身份、场景或首尾帧参考需要图片');
      graph[node] = { class_type: 'LoadImage', inputs: { image: filename } };
      if (ref) {
        if (imageIndex >= 9) throw new HttpError(400, '当前原生节点最多 9 张参考图');
        graph.condition.inputs[`ref_images.ref_image_${imageIndex++}`] = [node, 0];
        instructions.push(`<Picture ${imageIndex}>: ${r.role}. ${r.instruction}`);
      } else {
        if (anchorRoles.has(r.role)) throw new HttpError(400, '同一首尾帧角色只能指定一张图片');
        anchorRoles.add(r.role);
        graph.condition.inputs[r.role] = [node, 0];
      }
    }
  }
  if (instructions.length)
    graph.condition.inputs.prompt = s.prompt + '\n\nReference mapping:\n' + instructions.join('\n');
  return graph;
}
export class ComfyClient {
  baseUrl: string;
  constructor(
    url: string,
    public timeout = 20000,
  ) {
    const u = new URL(url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash)
      throw new HttpError(400, '请输入不含凭据或查询参数的 HTTP(S) 地址');
    this.baseUrl = url.replace(/\/$/, '');
  }
  async request(path: string, init: RequestInit = {}, timeout = this.timeout) {
    const response = await fetch(this.baseUrl + path, {
      ...init,
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      const body = (await response.text()).slice(0, 1200);
      throw new HttpError(response.status, `ComfyUI ${response.status}: ${body}`);
    }
    return response;
  }
  async json(path: string) {
    return (await this.request(path)).json() as Promise<any>;
  }
  async discover() {
    const [stats, nodes, queue] = await Promise.all([
      this.json('/system_stats'),
      this.json('/object_info'),
      this.json('/queue'),
    ]);
    return {
      checkedAt: Date.now(),
      stats,
      queue: {
        running: queue.queue_running?.length || 0,
        pending: queue.queue_pending?.length || 0,
      },
      models: {
        diffusion: nodes.UNETLoader?.input?.required?.unet_name?.[0] || [],
        clip: nodes.CLIPLoader?.input?.required?.clip_name?.[0] || [],
        vae: nodes.VAELoader?.input?.required?.vae_name?.[0] || [],
      },
      nativeNodes: Object.keys(nodes).filter(
        (n) => n.startsWith('MiniMaxH3') || n.startsWith('JR_') || n.includes('TESpeed'),
      ),
      capabilities: { guidedImages: guidedCapability(nodes) },
      nodes,
    };
  }
  async validate(graph: Graph) {
    const nodes = await this.json('/object_info');
    const guided = Object.values(graph).some((n) => n.class_type === 'MiniMaxH3AddGuide');
    if (guided) {
      const capability = guidedCapability(nodes);
      if (!capability.available) throw new HttpError(400, capability.reason);
    }
    for (const [id, node] of Object.entries(graph)) {
      const schema = nodes[node.class_type];
      if (!schema) throw new HttpError(400, `云端缺少节点 ${node.class_type}`);
      for (const [name, rule] of Object.entries(schema.input?.required || {}) as [string, any][]) {
        if (!(name in node.inputs)) throw new HttpError(400, `${id} 缺少 ${name}`);
        const uploadInput =
          (node.class_type === 'LoadImage' && name === 'image') ||
          (node.class_type === 'LoadAudio' && name === 'audio') ||
          (node.class_type === 'VHS_LoadVideo' && name === 'video');
        if (
          !uploadInput &&
          Array.isArray(rule[0]) &&
          !Array.isArray(node.inputs[name]) &&
          !rule[0].includes(node.inputs[name])
        )
          throw new HttpError(400, `${id}.${name} 在云端不可用`);
      }
      if (guided) {
        const inputs = { ...schema.input?.required, ...schema.input?.optional };
        for (const [name, value] of Object.entries(node.inputs)) {
          if (!Array.isArray(value)) continue;
          const [sourceId, outputIndex] = value;
          const source = graph[sourceId];
          const output = source && nodes[source.class_type]?.output?.[outputIndex];
          if (!source || !Number.isInteger(outputIndex) || !output)
            throw new HttpError(400, `${id}.${name} 引用不存在的节点输出`);
          const rule = inputs[name]?.[0];
          if (
            typeof rule === 'string' &&
            !['*', 'COMFY_AUTOGROW_V3'].includes(rule) &&
            rule !== output
          )
            throw new HttpError(400, `${id}.${name} 需要 ${rule}，收到 ${output}`);
          if (name.startsWith('ref_images.') && output !== 'IMAGE')
            throw new HttpError(400, `${id}.${name} 必须连接图片`);
        }
      }
    }
  }
  async upload(file: string, name: string) {
    const form = new FormData();
    form.set('image', new Blob([await fs.readFile(file)]), name);
    form.set('type', 'input');
    form.set('overwrite', 'true');
    const data = (await (
      await this.request('/upload/image', { method: 'POST', body: form })
    ).json()) as any;
    if (typeof data.name !== 'string') throw new Error('上传缺少文件回执');
    return data.subfolder ? `${data.subfolder}/${data.name}` : data.name;
  }
  async submit(graph: Graph, job: Job) {
    const response = await this.request('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: graph,
        client_id: job.id,
        extra_data: {
          studio: {
            job_id: job.id,
            instance_id: job.input.profile.instanceId,
            graph_hash: createHash('sha256').update(JSON.stringify(graph)).digest('hex'),
          },
        },
      }),
    });
    const data = (await response.json()) as any;
    if (!data.prompt_id) throw new Error('提交响应没有 prompt_id，需人工核对');
    return String(data.prompt_id);
  }
  watch(jobId: string, onEvent: (event: any) => void) {
    const url = new URL(this.baseUrl + '/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('clientId', jobId);
    const socket = new WebSocket(url, { handshakeTimeout: 10000 });
    socket.on('message', (data, binary) => {
      if (!binary)
        try {
          onEvent(JSON.parse(data.toString()));
        } catch {
          /* Non-JSON extension frames are not task completion events. */
        }
    });
    socket.on('error', (e) =>
      onEvent({ type: 'connection_warning', data: { message: e.message } }),
    );
    return socket;
  }
}
