import {
  modelCapabilities,
  promptProfiles,
  type ModelProtocol,
  type ConnectionData,
} from './models.js';

export type ModelKind = 'text' | 'image' | 'video' | 'speech';
export const modelKinds = {
  text: '文本模型',
  image: '图片模型',
  video: '视频模型',
  speech: '语音模型',
} as const;
// Implemented adapters only: names never confer capabilities.
export const modelOffers: Array<{
  family: string;
  name: string;
  kind: ModelKind;
  protocol: ModelProtocol;
  preset: ConnectionData['models'][number]['preset'];
  baseUrl: string;
  modelId: string;
}> = [
  {
    family: 'tencent-asr',
    name: '腾讯录音识别极速版',
    kind: 'speech',
    protocol: 'tencent-asr',
    preset: 'tencent-asr',
    baseUrl: 'https://asr.cloud.tencent.com',
    modelId: '16k_zh',
  },
  {
    family: 'minimax-speech',
    name: 'MiniMax Speech',
    kind: 'speech',
    protocol: 'minimax-speech',
    preset: 'minimax-speech',
    baseUrl: 'https://api.minimax.io',
    modelId: 'speech-2.8-hd',
  },
  {
    family: 'cosyvoice',
    name: 'CosyVoice',
    kind: 'speech',
    protocol: 'cosyvoice',
    preset: 'cosyvoice',
    baseUrl: 'https://dashscope.aliyuncs.com',
    modelId: 'cosyvoice-v3-plus',
  },
  {
    family: 'doubao-speech',
    name: '豆包语音',
    kind: 'speech',
    protocol: 'doubao-speech',
    preset: 'doubao-speech',
    baseUrl: 'https://openspeech.bytedance.com',
    modelId: 'seed-tts-2.0-standard',
  },
  {
    family: 'baidu-speech',
    name: '百度声音复刻',
    kind: 'speech',
    protocol: 'baidu-speech',
    preset: 'baidu-speech',
    baseUrl: 'https://aip.baidubce.com',
    modelId: 'voice-clone',
  },
  {
    family: 'tencent-speech',
    name: '腾讯 VRS / TTS',
    kind: 'speech',
    protocol: 'tencent-speech',
    preset: 'tencent-speech',
    baseUrl: 'https://vrs.tencentcloudapi.com',
    modelId: 'YTLX_V2',
  },
  {
    family: 'sync',
    name: 'Sync · 口型处理',
    kind: 'video',
    protocol: 'sync-lipsync',
    preset: 'sync-lipsync',
    baseUrl: 'https://api.sync.so',
    modelId: 'sync-3',
  },
  {
    family: 'text',
    name: '文本／结构化创作',
    kind: 'text',
    protocol: 'codex',
    preset: 'text',
    baseUrl: 'https://api.openai.com/v1',
    modelId: '',
  },
  {
    family: 'text',
    name: '文本／结构化创作',
    kind: 'text',
    protocol: 'responses',
    preset: 'text',
    baseUrl: 'https://api.openai.com/v1',
    modelId: '',
  },
  {
    family: 'text',
    name: '文本／结构化创作',
    kind: 'text',
    protocol: 'chat-completions',
    preset: 'text',
    baseUrl: 'https://api.openai.com/v1',
    modelId: '',
  },
  {
    family: 'images',
    name: 'Images 生成与编辑',
    kind: 'image',
    protocol: 'openai-images',
    preset: 'image',
    baseUrl: 'https://api.openai.com/v1',
    modelId: '',
  },
  {
    family: 'minimax-h3',
    name: 'MiniMax H3',
    kind: 'video',
    protocol: 'comfy-h3',
    preset: 'h3-comfy',
    baseUrl: 'http://127.0.0.1:8188',
    modelId: 'MiniMax-H3',
  },
  {
    family: 'minimax-h3',
    name: 'MiniMax H3',
    kind: 'video',
    protocol: 'minimax-video',
    preset: 'h3-api',
    baseUrl: 'https://api.minimax.io',
    modelId: 'MiniMax-H3',
  },
  {
    family: 'seedance',
    name: 'Seedance 2.0',
    kind: 'video',
    protocol: 'ark-video',
    preset: 'seedance-2',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    modelId: '',
  },
];
export function catalogOffers() {
  return modelOffers.map((offer) => ({
    ...offer,
    capabilities: modelCapabilities(offer.preset),
    promptProfiles: promptProfiles.filter((p) => p.family === offer.preset),
  }));
}
