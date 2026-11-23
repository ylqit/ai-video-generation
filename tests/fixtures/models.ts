import { ModelRegistry } from '../../src/server/model-registry.js';
import type { Store } from '../../src/server/db.js';
import type { ModelProtocol } from '../../src/shared/models.js';

export function configureModel(
  store: Store,
  projectId: string,
  protocol: ModelProtocol,
  ownerId = projectId,
) {
  const registry = new ModelRegistry(store);
  const preset =
    protocol === 'minimax-video'
      ? 'h3-api'
      : protocol === 'ark-video'
        ? 'seedance-2'
        : protocol === 'comfy-h3'
          ? 'h3-comfy'
          : protocol === 'openai-images'
            ? 'image'
            : 'text';
  const kind = ['h3-api', 'h3-comfy', 'seedance-2'].includes(preset) ? 'video' : preset;
  const connection = registry.saveConnection({
    revision: 0,
    data: {
      name: protocol + ' offline fixture',
      protocol,
      baseUrl: 'http://127.0.0.1:9',
      compatible: true,
      enabled: true,
      credential: protocol === 'comfy-h3' ? null : { kind: 'env', key: 'STUDIO_PROTOCOL_TEST_KEY' },
      capacityGroup: crypto.randomUUID(),
      concurrency: 1,
      ...(protocol === 'comfy-h3' ? { instanceId: 'offline' } : {}),
      models: [
        {
          id: ['minimax-video', 'comfy-h3'].includes(protocol) ? 'MiniMax-H3' : 'offline-model',
          name: 'Offline model',
          preset,
        },
      ],
    },
  });
  const selection = {
    connection: { id: connection.id, revision: connection.revision },
    modelId: connection.data.models[0].id,
    mode: 'authored',
    promptProfile: 'automatic',
    parameters: {},
  };
  const current = registry.config(projectId);
  const allowance = {
    enabled: true,
    connections: [...(current?.data.allowance?.connections || []), selection.connection],
    maxTextRequests: 10,
    maxImageRequests: 10,
    maxImages: 20,
    maxVideoRequests: 10,
    maxVideoSeconds: 150,
  };
  registry.saveConfig(projectId, projectId, {
    revision: current?.revision || 0,
    data: {
      version: 1,
      slots: {
        ...(current?.data.slots || {}),
        ...(ownerId === projectId ? { [kind]: selection } : {}),
      },
      allowance,
    },
  });
  if (ownerId !== projectId) {
    const old = registry.config(projectId, ownerId);
    registry.saveConfig(projectId, ownerId, {
      revision: old?.revision || 0,
      data: { version: 1, slots: { ...(old?.data.slots || {}), [kind]: selection } },
    });
  }
  return { registry, connection, selection, kind };
}
