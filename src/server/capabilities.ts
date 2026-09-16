import { Store } from './db.js';
import { generationDigest } from './h3-guided.js';
import { H3_CREATION_CAPABILITIES } from '../shared/creation.js';

// Only saved discovery facts and locally implemented compiler behavior are read.
export function creationCapabilities(store: Store, profile = store.setting<any>('comfy', null)) {
  const discovery = store.setting<any>('discovery', null);
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
