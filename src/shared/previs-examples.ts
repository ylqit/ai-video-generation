import { directingSchema, prepareShot } from './directing.js';
import { shotStateSchema } from './domain.js';

// Ordinary demonstration data. No scene-name branches are used by the renderer.
const cases = [
  {
    id: 'isolation',
    name: '灰港隔离区 · 路线示例',
    shape: 'capsule',
    height: 1.7,
    width: 0.5,
    depth: 0.4,
    instances: ['rescuer', 'technician'],
    doors: true,
    action: 'The rescuer leaves through the open side door before it closes.',
    motion: [
      { frame: 0, position: { x: 0.4, y: 0.55 }, heading: 180 },
      { frame: 80, position: { x: 0.8, y: 0.55 }, heading: 90 },
      { frame: 119, position: { x: 0.8, y: 0.7 }, heading: 180 },
    ],
  },
  {
    id: 'animal',
    name: '动物场景 · 身体朝向与关注目标',
    shape: 'box',
    height: 0.6,
    width: 0.45,
    depth: 1.1,
    instances: ['animal', 'target'],
    doors: false,
    action: 'The animal turns its body and moves while maintaining attention on the other subject.',
    motion: [
      { frame: 0, position: { x: 0.4, y: 0.55 }, heading: 180 },
      { frame: 60, position: { x: 0.4, y: 0.5 }, heading: 90 },
      { frame: 119, position: { x: 0.4, y: 0.45 }, heading: 90 },
    ],
  },
  {
    id: 'products',
    name: '双产品展示 · 独立实例',
    shape: 'cylinder',
    height: 0.8,
    width: 0.5,
    depth: 0.5,
    instances: ['product-a', 'product-b'],
    doors: false,
    action: 'Product A rotates in place; product B remains stationary as a separate instance.',
    motion: [
      { frame: 0, position: { x: 0.4, y: 0.55 }, heading: 180 },
      { frame: 30, position: { x: 0.4, y: 0.55 }, heading: 270 },
      { frame: 60, position: { x: 0.4, y: 0.55 }, heading: 0 },
      { frame: 90, position: { x: 0.4, y: 0.55 }, heading: 90 },
      { frame: 119, position: { x: 0.4, y: 0.55 }, heading: 180 },
    ],
  },
] as const;
export const previsExamples = cases.map((c) => {
  const layout = {
    id: c.id + '-layout',
    revision: 1,
    data: {
      name: c.name,
      space: { width: 8, depth: 8, height: 3 },
      regions: [],
      markers: [
        { id: 'control', name: 'Control', kind: 'fixed_object', position: { x: 0.78, y: 0.7 } },
      ],
      cameras: [
        {
          id: 'front',
          name: 'Front camera',
          position: { x: 0.5, y: 0.95 },
          heading: 0,
          framing: 'full',
          optics: { height: 1.8, pitch: -8, fov: 60 },
        },
      ],
      barriers: c.doors
        ? [
            {
              id: 'side-wall-north',
              name: 'Side wall',
              kind: 'wall',
              start: { x: 0.7, y: 0 },
              end: { x: 0.7, y: 0.4 },
              height: 2.4,
              thickness: 0.1,
            },
            {
              id: 'side-wall-south',
              name: 'Side wall',
              kind: 'wall',
              start: { x: 0.7, y: 0.6 },
              end: { x: 0.7, y: 1 },
              height: 2.4,
              thickness: 0.1,
            },
            {
              id: 'main',
              name: 'Main door',
              kind: 'door',
              start: { x: 0.1, y: 0.3 },
              end: { x: 0.6, y: 0.3 },
              height: 2.4,
              thickness: 0.1,
              open: true,
            },
            {
              id: 'side',
              name: 'Side door',
              kind: 'door',
              start: { x: 0.7, y: 0.4 },
              end: { x: 0.7, y: 0.6 },
              height: 2.1,
              thickness: 0.1,
              open: true,
            },
          ]
        : [],
    },
  };
  const state = shotStateSchema.parse({
    layout: { id: layout.id, revision: 1 },
    cameraId: 'front',
    instances: c.instances.map((id) => ({
      instanceId: id,
      entity: { id: c.id + '-entity', revision: 1 },
    })),
    start: c.instances.map((instanceId, i) => ({
      instanceId,
      position: { x: 0.4 + i * 0.2, y: 0.55 },
      heading: 180,
    })),
    end: c.instances.map((instanceId, i) => ({
      instanceId,
      position: i ? { x: 0.6, y: 0.55 } : c.motion.at(-1)!.position,
      heading: i ? 180 : c.motion.at(-1)!.heading,
    })),
    confirmed: true,
  });
  const shot = {
    id: c.id + '-shot',
    scene: c.id,
    duration: 5,
    description: c.name,
    dialogue: '',
    continuity: '',
    state,
    directing: directingSchema.parse({
      version: 1,
      purpose: 'Review spatial relationships using ordinary project data.',
      execution: { action: c.action },
      paths: [{ instanceId: c.instances[0], keys: c.motion }],
      doors: c.doors ? [{ barrierId: 'side', frame: 90, open: false }] : [],
      performance: [
        {
          instanceId: c.instances[0],
          stimulus: 'A nearby subject is present.',
          intention: 'Maintain attention.',
          reaction: 'Follow the planned movement while the other subject stays in place.',
          attention: { instanceId: c.instances[1], anchor: 'center' },
        },
      ],
      proxies: c.instances.map((instanceId, i) => ({
        instanceId,
        shape: c.shape,
        width: c.width,
        depth: c.depth,
        height: c.height,
        color: i ? '#80bfa7' : '#edbc76',
      })),
    }),
  };
  return { id: c.id, name: c.name, layout, shot, spec: prepareShot(shot, [layout]) };
});
