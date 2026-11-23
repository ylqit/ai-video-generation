import { authoringSchemas } from '../../src/shared/creation.js';

const common = {
  schemaVersion: 9,
  contractRevision: 2,
  title: 'Generic interaction',
  summary: '',
  assumptions: [],
  openQuestions: [],
  sources: [],
  contentChange: 'preserved',
};
export function spatialFixture() {
  const script = authoringSchemas.script.parse({
    ...common,
    stage: 'script',
    screenplayText: 'A operates a device while B watches. Ready?',
    subjects: [
      ...['operator', 'listener'].map((key) => ({
        key,
        name: key,
        kind: 'human',
        description: key,
        attributes: [],
      })),
      {
        key: 'device',
        name: 'Device',
        kind: 'object',
        description: 'A rectangular mechanism.',
        attributes: [],
      },
      {
        key: 'room',
        name: 'Room',
        kind: 'environment',
        description: 'A workshop.',
        attributes: [],
      },
    ],
    scenes: [
      {
        id: 'scene',
        title: 'Work',
        setting: 'Room',
        narrative: '',
        events: [{ id: 'operate', description: 'A operates the device.', sourceFactIds: [] }],
        dialogue: [
          {
            id: 'line',
            speakerKey: 'operator',
            text: 'Ready?',
            language: 'en',
            sourceFactId: null,
          },
        ],
      },
    ],
  });
  const design = {
    id: 'space',
    sceneId: 'scene',
    environmentKey: 'room',
    applicability: 'spatial',
    reason: 'Operating relationship',
    source: null,
    scale: 'measured',
    space: { width: 6, depth: 6, height: 3 },
    regions: [],
    barriers: [],
    anchors: [
      {
        id: 'control',
        subjectKey: 'device',
        label: 'Control face',
        kind: 'operate',
        position: { x: 0.5, y: 1, height: 0.8 },
        normalHeading: 180,
        reach: 1.5,
      },
    ],
    cameras: [
      {
        id: 'side',
        name: 'Side view',
        position: { x: 0.15, y: 0.7 },
        heading: 70,
        height: 1.6,
        pitch: 0,
        fov: 60,
      },
    ],
    proxies: [
      {
        subjectKey: 'operator',
        shape: 'capsule',
        width: 0.5,
        depth: 0.4,
        height: 1.6,
        color: '#bbccdd',
      },
      { subjectKey: 'device', shape: 'box', width: 1, depth: 0.6, height: 1, color: '#ccbbaa' },
    ],
    assumptions: [],
  };
  const shot = {
    id: 'shot',
    sceneId: 'scene',
    frames: 120,
    purpose: 'Observe operation',
    visibleSubjectKeys: ['operator', 'listener', 'device', 'room'],
    events: [{ eventId: 'operate', phase: 'whole' }],
    dialogue: [
      { lineId: 'line', delivery: 'onscreen', mouth: { visibility: 'occluded', window: null } },
    ],
    cues: [],
    action: 'The operator presses the control.',
    visualTreatment: 'Restrained drawn animation.',
    audienceFocus: 'The control under the hand.',
    informationChange: 'The operator accepts the task.',
    cutReason: 'Hold the completed operation.',
    visibleSpace:
      'The operator faces the control side. The listener watches from across the table.',
    staging: {
      sceneDesignId: 'space',
      cameraId: 'side',
      entry: [
        { subjectKey: 'operator', position: { x: 0.5, y: 0.65 }, heading: 0 },
        { subjectKey: 'device', position: { x: 0.5, y: 0.5 }, heading: 0 },
      ],
      exit: [],
      paths: [],
      cameraKeys: [],
      doors: [],
      axis: null,
    },
    interactions: [
      {
        id: 'use',
        eventId: 'operate',
        actorKey: 'operator',
        targetKey: 'device',
        anchorId: 'control',
        kind: 'operate',
        effector: 'hand',
        precondition: 'The control is within reach.',
        action: 'Press the control.',
        result: 'The control moves down.',
        required: true,
      },
    ],
    performances: [
      {
        id: 'watch',
        subjectKey: 'listener',
        trigger: 'The operator begins.',
        goal: 'Understand.',
        obstacle: '',
        visible: 'The listener inclines toward the control.',
        attention: {
          subjectKey: 'device',
          point: null,
          anchorId: 'control',
          description: 'Watch the operating surface.',
        },
        headHeading: null,
      },
    ],
    camera: {
      shotSize: 'medium',
      position: 'side',
      composition: 'Operator and device in profile',
      motion: 'static',
      reason: 'Make the contact readable.',
    },
    entryState: [],
    exitState: [],
    entryRelations: [
      {
        objectKey: 'operator',
        type: 'locatedIn',
        targetKey: 'room',
        anchor: 'At the control side',
        anchorId: null,
      },
    ],
    exitRelations: [],
    environmentSound: 'Room tone.',
    actionSound: 'A click.',
    soundContinuation: 'Room tone continues.',
  };
  const director = authoringSchemas.director.parse({
    ...common,
    stage: 'director',
    sceneDesigns: [design],
    shots: [shot],
    groups: [
      {
        id: 'group',
        shotIds: ['shot'],
        transition: 'independent',
        reason: 'A complete operation.',
      },
    ],
  });
  return { script, director };
}
