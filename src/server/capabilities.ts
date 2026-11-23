import { Store } from './db.js';
import { generationDigest } from './h3-guided.js';
import { H3_CREATION_CAPABILITIES } from '../shared/creation.js';
import { ModelRegistry } from './model-registry.js';

export function projectModelCapabilities(
  store: Store,
  projectId: string,
  episodeId: string | null,
) {
  const registry = new ModelRegistry(store);
  const video = registry.resolve(projectId, episodeId, 'video', undefined, false);
  const image = registry.resolve(projectId, episodeId, 'image', undefined, false);
  const original =
    video?.protocol === 'comfy-h3'
      ? creationCapabilities(
          store,
          video.connection.data,
          store.setting<any>(
            `model_probe:${video.connection.id}:${video.connection.revision}`,
            null,
          )?.discovery || null,
        )
      : creationCapabilities(store);
  if (!video && !image) return original;
  const snapshot = {
    ...original,
    ...(video
      ? {
          provider: video.protocol,
          minSeconds: video.capabilities.minSeconds!,
          maxSeconds: video.capabilities.maxSeconds!,
          modes: video.capabilities.modes,
          compilerVersion: video.adapterVersion,
          video: true,
          selectedVideo: video,
          verification: video.protocol === 'comfy-h3' ? original.verification : 'catalog_declared',
          guidedImages:
            video.protocol === 'comfy-h3'
              ? original.guidedImages
              : {
                  available: !!video.capabilities.supportsGuides,
                  reason: '按固定模型能力；启用状态在提交前检查',
                },
          ...(video.protocol !== 'comfy-h3'
            ? {
                dimensions: undefined,
                steps: undefined,
                frameAlignment: undefined,
                nativeNodes: [],
                instanceId: null,
                resolution: video.capabilities.resolutions,
                ratios: video.capabilities.ratios,
              }
            : {}),
        }
      : {}),
    image: !!image,
    selectedImage: image,
    imageWorkflow: image ? 'provider_candidate_and_review' : original.imageWorkflow,
  };
  const { digest: _digest, ...content } = snapshot;
  return { ...content, digest: generationDigest(content) };
}

// Only saved discovery facts and locally implemented compiler behavior are read.
export function creationCapabilities(
  store: Store,
  profile = store.setting<any>('comfy', null),
  discovery = store.setting<any>('discovery', null),
) {
  const snapshot = {
    ...H3_CREATION_CAPABILITIES,
    video: !!profile?.baseUrl && !!profile?.instanceId,
    version: 'studio-h3-capabilities-2',
    compilerVersion: 'authoring-v9-h3-4',
    authoringVersion: 9,
    contractRevision: 2,
    spatial: {
      layout: 'planning_check',
      attention: 'text_request',
      interaction: 'text_request',
      geometry: 'planning_check',
      evidence: 'actual_media_required',
    },
    instanceId: profile?.instanceId || null,
    verification: discovery ? 'saved_probe' : 'unverified',
    modes: ['t2v', 'i2v', 'ref2va'],
    guidedImages: discovery?.capabilities?.guidedImages || {
      available: null,
      reason: '尚未保存探测结果',
    },
    dimensions: { min: 128, max: 1344, multipleOf: 32 },
    steps: { min: 1, max: 50 },
    frameAlignment: { modulus: 17, remainder: 5 },
    references: {
      image: 'native_input',
      voiceSample: 'review_only',
      voiceDescription: 'text_request',
      timing: 'text_request',
    },
    imageWorkflow: 'external_task_package',
    originalAudio: 'inspect_actual_output',
    nativeNodes: [...(discovery?.nativeNodes || [])].sort(),
  };
  return { ...snapshot, digest: generationDigest(snapshot) };
}
