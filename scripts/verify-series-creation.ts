// Isolated offline rehearsal. No Worker or provider client is started. Synthetic
// text and review doubles exercise handoffs; they are never real story evidence.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import express from 'express';
import { fixture } from '../tests/fixtures/workspace.js';
import { configureModel } from '../tests/fixtures/models.js';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import { CreationService } from '../src/server/creation.js';
import { SeriesProductionService } from '../src/server/series-production.js';
import { SeriesProposals } from '../src/server/series-proposal.js';
import { SubjectBindings } from '../src/server/subject-bindings.js';
import { SourceAdaptation } from '../src/server/source-adaptation.js';
import { WorkspaceService } from '../src/server/workspace.js';
import { CreationMediaService } from '../src/server/creation-media.js';
import { prepareImageTask } from '../src/server/image-production.js';
import { DeliveryService } from '../src/server/delivery.js';
import { AssemblyService } from '../src/server/assembly.js';
import { ValidationExperiments } from '../src/server/validation-experiment.js';
import { renderPlan, renderTimeline, type RenderCheckpoint } from '../src/server/render.js';
import { timelineMap } from '../src/shared/edit-timeline.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { config, prepareData } from '../src/server/config.js';
import { runProcess, ingestAsset, probeMedia, hashFile } from '../src/server/media.js';
import { createApp } from '../src/server/app.js';
import type { AuthoringStage } from '../src/shared/creation.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-series-rehearsal-'));
prepareData(root);
const evidence = path.resolve(
  '../docs/architecture/2026-11-23-series-validation/evidence',
  process.argv.includes('--browser-only') ? 'browser' : '.',
);
await fs.mkdir(evidence, { recursive: true });
const ref = (d: any) => ({ id: d.id, revision: d.revision });
const prototype = fixture({ after() {} });
const outputs = structuredClone(prototype.outputs);
prototype.store.close();
const store = new Store(path.join(root, 'studio.sqlite'));
const studio = new StudioService(store),
  domain = new DomainService(store),
  creation = new CreationService(store),
  workspace = new WorkspaceService(store);
store.setSetting('comfy', { baseUrl: 'http://127.0.0.1:9', instanceId: 'offline-no-provider' });
const project = studio.createProject({
  title: '离线演练 · 校园系列 5 分钟 × 10 集',
  mode: 'series',
  brief: '合成脚本与媒体，只验证工程链路，不作为真实作品',
});
let profile = domain.save(project.id, 'creation_profile', {
  name: '校园二维日漫 · 离线规范',
  rulesVersion: 'director-v7',
  composition: {
    moduleRefs: [],
    overrides: { visual: 'Modern Japanese 2D animation, restrained campus daylight.' },
    artEntries: [],
  },
});
profile = domain.publish(profile.id, profile.revision, {
  inspected: true,
  conclusion: '人工写入的离线视觉规范',
});
let series = store.list('series', project.id)[0];
const seriesService = new SeriesProductionService(store);
const p = seriesService.preview(series.id, {
  version: 1,
  profile: ref(profile),
  targetEpisodes: 10,
  runtime: { targetFrames: 7200, toleranceFrames: 0 },
  canvas: { width: 1024, height: 576, mismatch: 'letterbox' },
});
series = seriesService.apply(series.id, {
  ...p,
  revision: series.revision,
  idempotencyKey: 'rehearsal-plan-10-5',
});
assert.equal(store.list('episode', project.id).length, 0);
assert.equal(store.jobs().length, 0);
creation.saveSettings(project.id, 0, {
  maxTextRepairs: 0,
  output: { width: 1024, height: 576, steps: 20 },
});

const source = store.create('chapter', project.id, {
  title: '离线改编材料',
  text: '# 模型展\n两个同学准备模型。缺口被遮住，同伴到场，随后主动揭示缺口。\n# 关系变化\n共同承担责任，而非模型自动修复。',
});
const indexing = new SourceAdaptation(store),
  sourceDraft = indexing.preview(project.id, [ref(source)]);
sourceDraft.data.entries[0].events = [
  { id: 'damage-reveal', statement: '先遮住缺口，后主动揭示', locked: true },
];
const sourceIndex = indexing.save(project.id, {
  data: sourceDraft.data,
  idempotencyKey: 'rehearsal-source-index',
});
const proposalService = new SeriesProposals(store),
  proposalInput = {
    request: '用校园模型展的创意组织一季，先可见行动，无画内对白。',
    approach: 'specification_first',
    requestedEpisodes: 10,
    requestedRuntime: { targetFrames: 7200, toleranceFrames: 0 },
    sources: [ref(sourceIndex)],
    adaptation: {
      version: 1,
      mode: 'faithful_adaptation',
      preserve: ['先遮盖后揭示，不自动修复'],
      allow: ['镜头与表演表达'],
      pending: [],
      decisions: [],
    },
  };
const proposalPreparation = proposalService.prepare(series.id, proposalInput);
const titles = ['约定', '分工', '缺口', '隐瞒', '发现', '坦白', '重做', '受阻', '协作', '展示'];
const proposal = proposalService.save(series.id, {
  input: proposalInput,
  digest: proposalPreparation.digest,
  idempotencyKey: 'rehearsal-season-proposal',
  result: {
    version: 1,
    title: '校园模型展 · 工程演练提案',
    rationale: '人工构造的季纲数据，不作为优秀长剧本的验证',
    story: {
      goal: '完成模型展',
      conflict: '责任与协作',
      ending: '两人共同承担责任',
      characters: [
        { key: 'lead', name: '林', start: '独立工作', change: '主动说明问题', end: '共同制作' },
        { key: 'peer', name: '周', start: '不知缺口', change: '了解原因', end: '协作' },
      ],
      information: [{ id: 'damage', statement: '模型受损', plantEpisode: 3, revealEpisode: 6 }],
    },
    episodes: titles.map((title, i) => ({
      title: `第${i + 1}集 ${title}`,
      question: `如何处理${title}？`,
      conflict: '意见和资源存在差异',
      choice: '可见行动推动变化',
      outcome: `本集推进${title}`,
      openQuestions: i < 9 ? ['下一集如何处理后果'] : [],
      runtime: { targetFrames: 7200, toleranceFrames: 0 },
      sourceEntryIds: [sourceIndex.data.entries[0].id],
    })),
    assumptions: ['离线人工测试数据'],
    openQuestions: [],
  },
});
const proposalPreview = proposalService.preview(proposal.id, { revision: proposal.revision });
series = proposalService.apply(proposal.id, {
  revision: proposal.revision,
  digest: proposalPreview.digest,
  idempotencyKey: 'rehearsal-season-adoption',
});
assert.equal(store.jobs().length, 0);
const identities = ['lead', 'peer'].map((id, i) =>
  domain.save(project.id, 'entity', {
    name: i ? '周' : '林',
    type: 'character',
    subtype: 'human',
    description: 'Offline identity definition; no actual character match claim.',
    instances: [{ id, name: i ? '周' : '林' }],
    attributes: [],
  }),
);

await runProcess(config.ffmpeg, [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=blue:s=320x180:r=24:d=10',
  '-c:v',
  'libx264',
  '-pix_fmt',
  'yuv420p',
  path.join(root, 'synthetic.mp4'),
]);
await runProcess(config.ffmpeg, [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  'color=blue:s=320x180',
  '-frames:v',
  '1',
  path.join(root, 'synthetic.png'),
]);
const image = await ingestAsset(store, root, project.id, path.join(root, 'synthetic.png'), {
  name: '仅用于接口测试的蓝色图片',
});
const video = await ingestAsset(store, root, project.id, path.join(root, 'synthetic.mp4'), {
  name: '仅用于时间线测试的蓝色视频',
});
const imageAdopted = store.update(image.id, image.revision, {
  ...image.data,
  adopted: true,
  simulation: true,
});
const videoAdopted = store.update(video.id, video.revision, {
  ...video.data,
  adopted: true,
  simulation: true,
});
configureModel(store, project.id, 'openai-images');
const rows: any[] = [];
let firstRun: any, firstEpisode: any;
for (let n = 0; n < 10; n++) {
  series = store.get(series.id);
  const ep = studio.createEpisode(project.id, {
    title: titles[n],
    seriesId: series.id,
    slotId: series.data.production.slots[n].id,
  });
  let run = creation.create(project.id, {
    episodeId: ep.id,
    request: '校园模型展，本集开头 5 秒观察桌面；先用可见行动写完整剧本。',
    idempotencyKey: `rehearsal-episode-${n}`,
  });
  for (const job of store
    .jobs(project.id)
    .filter((j) => j.input.creationRunId === run.id || j.input.context?.runId === run.id))
    store.patchJob(job.id, { state: 'cancelled' });
  assert.equal(store.jobs(project.id).filter((j) => j.state === 'queued').length, 0);
  const context = creation.context(run.id, 'brief');
  assert.equal(context.settings.duration.mode, 'exact');
  assert.equal((context.settings.duration as any).seconds, 300);
  if (n > 0) assert.equal(context.predecessor?.hypothetical, true);
  rows.push({
    episodeId: ep.id,
    runId: run.id,
    frames: 7200,
    context: context.predecessor,
    state: n ? 'hypothetical_draft' : 'start',
  });
  if (n) continue;
  firstRun = run;
  firstEpisode = ep;
  const sourceShot = outputs.director.shots[0];
  outputs.brief.intent = 'narrative';
  outputs.brief.goal = 'Offline campus production handoff';
  outputs.script.subjects = identities.map((d, i) => ({
    key: i ? 'peer' : 'lead',
    name: d.data.name,
    kind: 'human',
    description: d.data.description,
    attributes: [],
  }));
  outputs.script.screenplayText =
    '离线人工剧本样本。两人在社团活动室观察模型并依次检查结构。本文及镜头只检验合同交接，不表示足以支撑五分钟观看。';
  outputs.script.scenes = [
    {
      id: 'club',
      title: '模型展准备',
      setting: 'Campus clubroom',
      narrative: 'Inspect a model together.',
      dialogue: [],
      events: Array.from({ length: 30 }, (_, i) => ({
        id: `event${i}`,
        description: 'Both students observe the model without dialogue.',
        sourceFactIds: [],
      })),
    },
  ];
  outputs.direction.visual = 'Modern Japanese 2D animation; campus daylight.';
  outputs.director.sceneDesigns = [
    {
      ...outputs.director.sceneDesigns[0],
      sceneId: 'club',
      id: 'club-layout',
      reason: 'Static isolated engineering fixture; no spatial action is claimed.',
    },
  ];
  outputs.director.shots = Array.from({ length: 30 }, (_, i) => ({
    ...structuredClone(sourceShot),
    id: `shot${i}`,
    sceneId: 'club',
    frames: 240,
    visibleSubjectKeys: ['lead', 'peer'],
    events: [{ eventId: `event${i}`, phase: 'whole' }],
    action: 'Two adult students observe the model on the table.',
    performances: ['lead', 'peer'].map((key) => ({
      id: `${key}-${i}`,
      subjectKey: key,
      trigger: 'Inspect the model',
      goal: 'Observe',
      obstacle: 'None',
      visible: 'Looks at the model.',
      attention: null,
      headHeading: null,
    })),
  }));
  outputs.director.groups = Array.from({ length: 30 }, (_, i) => ({
    id: `group${i}`,
    shotIds: [`shot${i}`],
    transition: 'independent',
    reason: 'Offline independent input preparation',
  }));
  outputs.assets.items = [
    {
      id: 'lead-identity',
      subjectKey: 'lead',
      mediaType: 'image',
      purpose: 'identity',
      description: 'Lead identity fixture',
      prompt: 'An adult campus student.',
      layout: 'One subject',
      shotIds: [],
      view: 'front',
      preserve: ['Identity'],
      allow: ['Camera'],
      coverage: [],
    },
  ];
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets'] as AuthoringStage[]) {
    run = creation.get(run.id);
    const draft = creation.saveResult(run.id, stage, outputs[stage], run.revision);
    if (stage === 'script')
      new SubjectBindings(store).save(run.id, {
        revision: creation.get(run.id).revision,
        script: ref(draft),
        bindings: draft.data.result.subjects.map((s: any, i: number) => ({
          subjectKey: s.key,
          subjectDigest: generationDigest(s),
          decision: 'reuse',
          entity: ref(identities[i]),
          instanceId: s.key,
          reason: '离线测试：明确复用系列固定实例',
        })),
        idempotencyKey: 'rehearsal-cast-map',
      });
    run = creation.approve(run.id, draft.id, draft.revision, `rehearsal-adopt-${stage}`);
  }
  const task = new CreationMediaService(store, root).createAssetTask(run.id, {
    revision: run.revision,
    requirementId: 'lead-identity',
    idempotencyKey: 'rehearsal-asset-task',
  }).task;
  const imagePreparation = prepareImageTask(store, task.id, {
    taskRevision: task.revision,
    viewId: task.data.views[0].id,
    operation: 'generate',
    promptSource: 'task',
    references: [],
    referenceUses: [],
  });
  assert.equal(imagePreparation.input.effectivePlan.runtime.targetFrames, 7200);
  await fs.writeFile(
    path.join(evidence, 'IMAGE_PREPARATION.json'),
    JSON.stringify(imagePreparation, null, 2),
  );
  run = creation.bindAsset(run.id, {
    revision: creation.get(run.id).revision,
    requirementId: 'lead-identity',
    asset: ref(imageAdopted),
    inspected: true,
    conclusion: '离线测试替身：纯蓝色图片，仅用于验证实际文件与引用连接；不作为人物质量通过',
  });
  const scope = store.get(run.data.scope.id);
  const prepared = workspace.preview(scope.id, scope.revision, run.revision);
  assert.equal(
    prepared.run.data.productionPreview.inputs.length,
    30,
    JSON.stringify(prepared.run.data.issues),
  );
  assert.equal(
    store.jobs(project.id).filter((j) => j.kind === 'generation' || j.kind === 'image').length,
    0,
  );
  rows[0].preparedGroups = 30;
  rows[0].preparedFrames = 7200;
  await fs.writeFile(
    path.join(evidence, 'VIDEO_PREPARATION_SAMPLE.json'),
    JSON.stringify(prepared.run.data.productionPreview.inputs[0], null, 2),
  );
  run = creation.get(run.id);
  // Explicit simulation records; no real model attempt, remote receipt, or Canon.
  const currentEpisode = store.get(ep.id);
  for (const segment of currentEpisode.data.segments) {
    const review = store.create(
      'generation_review',
      project.id,
      {
        simulation: true,
        inspected: true,
        video: ref(videoAdopted),
        in: 0,
        out: 10,
        dimensions: {
          identity: 'unreviewed',
          props: 'unreviewed',
          space: 'unreviewed',
          action: 'unreviewed',
          style: 'unreviewed',
          audio: 'unreviewed',
        },
        observations: [],
        eventEvidence: [],
      },
      ep.id,
    );
    store.create(
      'segment_selection',
      project.id,
      {
        simulation: true,
        schemaVersion: 3,
        segmentId: segment.id,
        creationRunId: run.id,
        video: ref(videoAdopted),
        review: ref(review),
        in: 0,
        out: 10,
        volume: 0,
        coverage: segment.shotIds.map((id: string) => ({ shotId: id, in: 0, out: 10 })),
        boundary: {
          start: { facts: [], relations: [], relationObjectIds: [], actions: [] },
          end: { facts: [], relations: [], relationObjectIds: [], actions: [] },
        },
      },
      ep.id,
    );
  }
  const delivery = new DeliveryService(store, root),
    draft = delivery.draft(run.id, { mode: 'work' });
  assert.equal(timelineMap(draft.edlDraft).frames, 7200);
  const timeline = {
    ...draft.edlDraft,
    schemaVersion: 3,
    clips: draft.edlDraft.clips.map((c: any, i: number) => ({ ...c, id: `clip${i}` })),
    audio: [],
    overlays: [
      {
        id: 'fixture-label',
        text: 'OFFLINE SYNTHETIC FIXTURE',
        sourceDialogueId: null,
        startFrame: 0,
        endFrame: 7200,
        position: 'bottom',
        fontSize: 24,
        color: '#ffffff',
      },
    ],
  };
  const plan = delivery.create(run.id, {
    runRevision: run.revision,
    target: { mode: 'work' },
    edlDraft: timeline,
    idempotencyKey: 'rehearsal-delivery',
  });
  const assembly = new AssemblyService(store).inspect(plan.data.edl.id);
  assert.ok(assembly.scopes.some((s) => !s.passed));
  rows[0].deliveryPlan = ref(plan);
  rows[0].joins = assembly.scopes.filter((s) => s.scope === 'join').length;
  rows[0].formalDelivery = false;
  const render = renderPlan(timeline);
  assert.equal(render.frames, 7200);
  let checkpoint: RenderCheckpoint | undefined;
  if (process.argv.includes('--render')) {
    const file = path.join(root, 'render', 'five-minute-offline.mp4');
    console.log('Rendering isolated 7200-frame fixture:', root);
    await renderTimeline(timeline, [videoAdopted], root, file, undefined, {
      save: (c) => {
        checkpoint = c;
        console.log('Archived render parts:', c.parts.length);
      },
    });
    const metadata = await probeMedia(file);
    assert.equal(metadata.frameCount, 7200);
    const parts = generationDigest(checkpoint!.parts);
    await renderTimeline(timeline, [videoAdopted], root, file, undefined, {
      previous: checkpoint,
      save: (c) => {
        checkpoint = c;
      },
    });
    assert.equal(generationDigest(checkpoint!.parts), parts);
    rows[0].rendered = {
      file,
      metadata,
      sha256: await hashFile(file),
      reusedParts: checkpoint!.parts.length,
    };
    await fs.copyFile(file, path.join(evidence, 'five-minute-offline.mp4'));
  }
  for (const [width, height] of [
    [576, 1024],
    [768, 768],
  ])
    assert.equal(renderPlan({ ...timeline, width, height }).frames, 7200);
  firstRun = creation.get(run.id);
  firstEpisode = store.get(ep.id);
}
const experiments = new ValidationExperiments(store),
  experimentInput = {
    seriesId: series.id,
    seeds: [104729, 130363],
    assets: [],
    recipe: {
      baseline: 'native-h3-directed-v4',
      experimental: 'campus-state-order',
      experimentalRevision: 'proposal-1',
      change:
        'Only state/order/reveal expression; reviewed director revisions required before compilation',
    },
    environment: { nodeVersion: '', workflowDigest: '', inspected: false },
    quote: {
      source: '',
      checkedAt: '',
      currency: 'CNY',
      videoPerRequest: null,
      textPerRequest: null,
    },
  };
const pack = experiments.prepare(project.id, experimentInput);
const experiment = experiments.save(project.id, {
  input: experimentInput,
  digest: pack.digest,
  idempotencyKey: 'rehearsal-experiment-pack',
});
await fs.writeFile(
  path.join(evidence, 'REAL_VALIDATION_PREPARATION.json'),
  JSON.stringify(pack, null, 2),
);
const historicalRoot = path.resolve(
  '../.workspaces/studio-pre-rebuild-backup/productions/style-world-validation',
);
const historical = [];
for (const name of [
  'assets/A01.png',
  'assets/B01-1.png',
  'assets/B01-2.png',
  'METRICS.json',
  'evidence/FINAL_VERIFICATION.json',
]) {
  const file = path.join(historicalRoot, name);
  historical.push({
    path: file,
    sha256: await hashFile(file),
    use: name.endsWith('.png')
      ? 'candidate_reference_needs_new_purpose_review'
      : 'historical_evidence_only',
  });
}
await fs.writeFile(
  path.join(evidence, 'HISTORICAL_INPUT_INVENTORY.json'),
  JSON.stringify(historical, null, 2),
);
const progress = seriesService.progress(series.id);
const summary = {
  date: '2026-11-23',
  root,
  projectId: project.id,
  seriesId: series.id,
  firstRunId: firstRun.id,
  firstEpisodeId: firstEpisode.id,
  experiment: ref(experiment),
  realModelCalls: 0,
  workerStarted: false,
  generationJobs: store.jobs(project.id).filter((j) => j.kind === 'generation').length,
  imageJobs: store.jobs(project.id).filter((j) => j.kind === 'image').length,
  cancelledTextPreparationJobs: store
    .jobs(project.id)
    .filter((j) => j.kind === 'creative' && j.state === 'cancelled').length,
  confirmedCanon: store.list('continuity', project.id).length,
  formalReleases: store.list('episode_release', project.id).length,
  plannedFrames: 72000,
  rows,
  progress,
  warning:
    '人工合成文本、纯色媒体与明确标记的采用替身；不证明人物一致性、自然接续或剧本质量。后九集只建立假设草稿与要求核对。',
};
await fs.writeFile(path.join(evidence, 'OFFLINE_REHEARSAL.json'), JSON.stringify(summary, null, 2));
console.log(
  JSON.stringify({
    root,
    projectId: project.id,
    seriesId: series.id,
    firstRunId: firstRun.id,
    evidence,
    rows: rows.length,
    realModelCalls: 0,
  }),
);
if (process.argv.includes('--serve')) {
  const app = express();
  app.use((req, res, next) =>
    req.method !== 'GET' && /\/(model-generate|generate|submit|assistant-runs)(\/|$)/.test(req.path)
      ? res.status(403).json({ error: '离线浏览器演练禁止执行生成' })
      : next(),
  );
  app.use(createApp(store, root));
  const server = app.listen(4386, '127.0.0.1');
  console.log('Offline browser: http://127.0.0.1:4386');
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, () => {
      server.close();
      store.close();
      process.exit(0);
    });
} else store.close();
