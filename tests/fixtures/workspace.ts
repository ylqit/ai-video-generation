import { Store } from '../../src/server/db.js';
import { StudioService } from '../../src/server/service.js';
import { CreationService } from '../../src/server/creation.js';
import { WorkspaceService } from '../../src/server/workspace.js';
import type { AuthoringStage } from '../../src/shared/creation.js';
const common = {
  schemaVersion: 9,
  contractRevision: 2,
  title: 'Full work',
  summary: 'Five product moments',
  assumptions: [],
  openQuestions: [],
  sources: [],
  contentChange: 'preserved',
};

export function fixture(
  t: any,
  outsideImage = false,
  splitGroup = false,
  configure?: (outputs: any) => void,
  options: { database?: string; request?: string; canvasTreatment?: 'letterbox' } = {},
) {
  const store = new Store(options.database || ':memory:');
  t.after(() => store.close());
  const studio = new StudioService(store),
    creation = new CreationService(store),
    workspace = new WorkspaceService(store);
  const project = studio.createProject({ title: 'Workspace offline', mode: 'short', brief: '' });
  store.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9', instanceId: 'offline' });
  creation.saveSettings(project.id, 0, {
    allowance: { enabled: true, maxGenerations: 3, maxGeneratedSeconds: 36 },
    ...(options.canvasTreatment ? { output: { mismatch: options.canvasTreatment } } : {}),
  });
  let run = creation.create(project.id, {
    request: options.request || '60 秒产品短片',
    idempotencyKey: crypto.randomUUID(),
  });
  const outputs: Record<string, any> = {
    brief: {
      ...common,
      stage: 'brief',
      intent: 'commercial',
      goal: 'Show product moments',
      audience: 'Owners',
      lockedFacts: [],
      requirements: [],
    },
    script: {
      ...common,
      stage: 'script',
      screenplayText: 'Five views of a device.',
      subjects: [
        {
          key: 'device',
          name: 'Device',
          kind: 'object',
          description: 'Silver device.',
          attributes: [],
        },
      ],
      scenes: Array.from({ length: 5 }, (_, i) => ({
        id: `scene${i + 1}`,
        title: `Scene ${i + 1}`,
        setting: 'Neutral table',
        narrative: 'Device shown',
        events: [{ id: `event${i + 1}`, description: 'The device is shown.', sourceFactIds: [] }],
        dialogue: [],
      })),
    },
    direction: {
      ...common,
      stage: 'direction',
      visual: 'Product lighting',
      narrative: 'A device.',
      directing: 'Observe.',
      editing: 'Independent views',
      sound: 'Quiet room tone',
      assetPolicy: 'Text-only except an optional scoped reference.',
    },
    director: {
      ...common,
      stage: 'director',
      sceneDesigns: Array.from({ length: 5 }, (_, i) => ({
        id: `design${i + 1}`,
        sceneId: `scene${i + 1}`,
        environmentKey: null,
        applicability: 'not_applicable',
        reason: 'Isolated product view with no spatial dependency.',
        source: null,
        scale: 'schematic',
        space: null,
        regions: [],
        barriers: [],
        anchors: [],
        cameras: [],
        proxies: [],
        assumptions: [],
      })),
      shots: Array.from({ length: 5 }, (_, i) => ({
        id: `shot${i + 1}`,
        sceneId: `scene${i + 1}`,
        frames: 288,
        purpose: 'Observe',
        visibleSubjectKeys: ['device'],
        events: [{ eventId: `event${i + 1}`, phase: 'whole' }],
        dialogue: [],
        cues: [],
        action: 'A silver device sits on the table.',
        staging: null,
        interactions: [],
        visibleSpace: 'Isolated product.',
        audienceFocus: 'The device.',
        informationChange: 'Another product view.',
        cutReason: 'Complete view.',
        visualTreatment: 'Product lighting.',
        performances: [],
        camera: {
          shotSize: 'close-up',
          position: 'Front',
          composition: 'Centered',
          motion: 'static',
          reason: 'Observe',
        },
        entryState: [],
        exitState: [],
        entryRelations: [],
        exitRelations: [],
        environmentSound: 'Quiet room tone.',
        actionSound: 'N/A',
        soundContinuation: 'Room tone.',
      })),
      groups: Array.from({ length: 5 }, (_, i) => ({
        id: `P0${i + 1}`,
        shotIds: [`shot${i + 1}`],
        transition: 'independent',
        reason: 'Standalone moment.',
      })),
    },
    assets: {
      ...common,
      stage: 'assets',
      items: outsideImage
        ? [
            {
              id: 'outside',
              subjectKey: 'device',
              mediaType: 'image',
              purpose: 'identity',
              description: 'Only fifth shot reference',
              prompt: 'A device',
              layout: 'One instant',
              shotIds: ['shot5'],
              view: 'front',
            },
          ]
        : [],
    },
  };
  if (splitGroup) {
    outputs.director.shots[0].frames = 144;
    outputs.director.shots[0].events[0].phase = 'start';
    const second = structuredClone(outputs.director.shots[0]);
    second.id = 'shot1b';
    second.events[0].phase = 'complete';
    outputs.director.shots.splice(1, 0, second);
    outputs.director.groups[0].shotIds.push(second.id);
  }
  configure?.(outputs);
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[]) {
    run = creation.get(run.id);
    const draft = creation.saveResult(run.id, stage, structuredClone(outputs[stage]), run.revision);
    run = creation.approve(run.id, draft.id, draft.revision, crypto.randomUUID());
  }
  const select = (groupId = 'P01') =>
    workspace.saveScope(
      run.id,
      creation.get(run.id).revision,
      {
        name: groupId,
        mode: 'selection',
        groupIds: [groupId],
        output: { width: 864, height: 480, steps: 20, seed: 2026091401 },
      },
      true,
    );
  return {
    store,
    studio,
    creation,
    workspace,
    project,
    outputs,
    select,
    get run() {
      return creation.get(run.id);
    },
  };
}
