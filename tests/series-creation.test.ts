import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import { CreationService } from '../src/server/creation.js';
import {
  SeriesProductionService,
  episodeRuntime,
  predecessorCanon,
} from '../src/server/series-production.js';
import {
  effectiveEpisodePlan,
  episodePredecessor,
  assertEpisodePlanCurrent,
} from '../src/server/episode-plan.js';
import { SubjectBindings, subjectBindingIssues } from '../src/server/subject-bindings.js';
import { SeriesProposals } from '../src/server/series-proposal.js';
import {
  SourceAdaptation,
  validateAdaptationIntent,
  indexedSource,
} from '../src/server/source-adaptation.js';
import { ValidationExperiments } from '../src/server/validation-experiment.js';
import { generationDigest } from '../src/server/h3-guided.js';
import { inferDurationIntent } from '../src/shared/creation.js';
import { formatComparison } from '../src/shared/production-plan.js';
import { validationCases } from '../src/shared/validation-experiment.js';
import { codexOutputJsonSchema } from '../src/server/codex-output.js';
import { configureModel } from './fixtures/models.js';
import { Worker } from '../src/server/worker.js';
import { fixture } from './fixtures/workspace.js';
import { CreationMediaService } from '../src/server/creation-media.js';
import { freezeModelPreparation } from '../src/server/video-api-compile.js';
import { bindExperimentInput } from '../src/server/experiment-binding.js';

test('experiment preparation resolves the same Prompt scheme as freezing and requires real Guide/identity slot duties', (t) => {
  const f = setup(t),
    ep = f.episode(),
    registry = configureModel(f.store, f.project.id, 'comfy-h3').registry;
  const config = registry.config(f.project.id)!;
  registry.saveConfig(f.project.id, f.project.id, {
    revision: config.revision,
    data: { ...config.data, slots: { video: { ...config.data.slots.video, mode: 'ref2va' } } },
  });
  const asset = f.store.create('asset', f.project.id, {
    mediaType: 'image',
    adopted: true,
    sha256: 'a'.repeat(64),
    width: 1024,
    height: 576,
    simulation: true,
  });
  const service = new ValidationExperiments(f.store);
  const raw = {
    seriesId: f.series.id,
    episodeId: ep.id,
    seeds: [104729, 130363],
    assets: [
      { role: 'composition:front', asset: ref(asset), inspected: true, notes: '离线协议替身' },
    ],
    recipe: {
      baseline: 'native-h3-directed-v4',
      experimental: 'reviewed-writing-revision',
      experimentalRevision: '1',
      change: 'state/order only',
    },
    environment: {
      nodeVersion: 'offline-fixture',
      workflowDigest: 'b'.repeat(64),
      inspected: true,
    },
    quote: {
      source: 'offline test only, not a quote',
      checkedAt: '2026-11-23',
      currency: 'CNY',
      videoPerRequest: 0,
      textPerRequest: null,
    },
  };
  const prepared = service.prepare(f.project.id, raw),
    doc = service.save(f.project.id, {
      input: raw,
      digest: prepared.digest,
      idempotencyKey: 'frozen-model-experiment',
    });
  const input = freezeModelPreparation(
    {
      episode: ref(ep),
      segment: { mode: 'ref2va', duration: 10 },
      width: 1024,
      height: 576,
      seed: 104729,
      templateVersion: 'native-h3-directed-v4',
      assets: [{ asset, reference: { role: 'first_frame', usage: { purpose: 'composition' } } }],
      prepared: {
        rulesVersion: 'h3-fixture',
        images: [],
        anchors: [
          {
            key: 'start',
            assetId: asset.id,
            revision: asset.revision,
            resolvedFrameIndex: 0,
            instruction: 'same composition',
            label: 'start',
          },
        ],
      },
    },
    registry.resolve(f.project.id, ep.id, 'video'),
  );
  assert.equal(input.modelExecution.digest, prepared.model!.digest);
  const binding = { ...ref(doc), digest: prepared.digest, caseId: 'identity-front-1-A' };
  assert.equal(bindExperimentInput(f.store, input, binding).experiment.caseId, binding.caseId);
  assert.throws(
    () =>
      bindExperimentInput(f.store, { ...input, referenceBindingPlan: { bindings: [] } }, binding),
    /职责不符/,
  );
  assert.throws(() => bindExperimentInput(f.store, { ...input, seed: 17 }, binding), /种子不一致/);
  assert.equal(f.store.jobs().length, 0);
});
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ref = (d: any) => ({ id: d.id, revision: d.revision });
const intent = {
  version: 1 as const,
  mode: 'original' as const,
  preserve: [],
  allow: [],
  pending: [],
  decisions: [],
};
function setup(t: any) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const studio = new StudioService(store),
    domain = new DomainService(store),
    seriesService = new SeriesProductionService(store),
    creation = new CreationService(store);
  const project = studio.createProject({
    title: 'Offline five minutes',
    mode: 'series',
    brief: '',
  });
  let profile = domain.save(project.id, 'creation_profile', {
    name: 'Campus 2D',
    rulesVersion: 'director-v7',
    composition: {
      moduleRefs: [],
      overrides: { visual: 'Modern Japanese 2D animation' },
      artEntries: [],
    },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'Offline authored specification',
  });
  let series = store.list('series', project.id)[0];
  const preview = seriesService.preview(series.id, {
    version: 1,
    profile: ref(profile),
    targetEpisodes: 10,
    runtime: { targetFrames: 7200, toleranceFrames: 0 },
    canvas: { width: 1024, height: 576, mismatch: 'require_match' },
  });
  series = seriesService.apply(series.id, {
    ...preview,
    revision: series.revision,
    idempotencyKey: 'ten-episode-plan',
  });
  const episode = (n = 0) => {
    const s = store.get(series.id);
    return studio.createEpisode(project.id, {
      seriesId: s.id,
      slotId: s.data.production.slots.filter((v: any) => v.active)[n].id,
    });
  };
  const create = (ep: any, request = '开头 5 秒展示校园，从想法写成本集剧本。') =>
    creation.create(project.id, { episodeId: ep.id, request, idempotencyKey: crypto.randomUUID() });
  return {
    store,
    studio,
    domain,
    seriesService,
    creation,
    project,
    profile,
    series,
    episode,
    create,
  };
}
function proposalInput() {
  return {
    request: '两个同学为校园模型展合作，先提出有因果变化的系列提案。',
    approach: 'specification_first',
    requestedEpisodes: 10,
    requestedRuntime: { targetFrames: 7200, toleranceFrames: 0 },
    sources: [],
    adaptation: intent,
  };
}
function proposalResult(n = 10) {
  return {
    version: 1,
    title: '模型展',
    rationale: '每集完成一个可见制作问题，跨集关系逐步变化；工程测试文字。',
    story: {
      goal: '完成展览',
      conflict: '资源与合作',
      ending: '共同承担责任',
      characters: [
        { key: 'lead', name: '林', start: '独自承担', change: '学会协作', end: '接受帮助' },
      ],
      information: [],
    },
    episodes: Array.from({ length: n }, (_, i) => ({
      title: `第${i + 1}集`,
      question: `问题${i}`,
      conflict: '制作意见不同',
      choice: '共同尝试',
      outcome: '认识彼此的方案',
      openQuestions: [],
      runtime: { targetFrames: 7200, toleranceFrames: 0 },
      sourceEntryIds: [],
    })),
    assumptions: ['仅供离线流程验证'],
    openQuestions: [],
  };
}

test('10 x 5-minute plan flows into new author contexts without duration repeated, slot and episode overrides take precedence', (t) => {
  const f = setup(t);
  assert.equal(f.store.list('episode', f.project.id).length, 0);
  assert.equal(f.store.jobs().length, 0);
  const ep = f.episode(),
    run = f.create(ep);
  assert.deepEqual(run.data.duration, { mode: 'exact', seconds: 300 });
  const context = f.creation.context(run.id, 'brief');
  assert.equal(context.settings.duration.mode, 'exact');
  assert.deepEqual(context.effectivePlan?.runtime, episodeRuntime(f.store, ep));
  assert.equal(context.effectivePlan?.canvas.width, 1024);
  assert.equal(run.data.sources.length, 0);
  let series = f.store.get(f.series.id),
    data = structuredClone(series.data.production);
  data.slots[2].runtime = { targetFrames: 8640, toleranceFrames: 24 };
  const p = f.seriesService.preview(series.id, data);
  f.seriesService.apply(series.id, {
    ...p,
    revision: series.revision,
    idempotencyKey: 'third-six-minutes',
  });
  let third = f.episode(2),
    resolved = effectiveEpisodePlan(f.store, third);
  assert.equal(resolved.origins.duration, 'slot');
  assert.equal(resolved.runtime?.targetFrames, 8640);
  third = f.store.update(third.id, third.revision, {
    ...third.data,
    seriesProduction: {
      ...third.data.seriesProduction,
      runtime: { targetFrames: 4320, toleranceFrames: 0 },
    },
  });
  assert.equal(f.create(third).data.duration.seconds, 180);
});

test('local timing is not episode duration; conflicting whole-episode text stays a visible plan difference', (t) => {
  assert.deepEqual(inferDurationIntent('开头 5 秒，镜头持续 10 秒。'), { mode: 'derive' });
  assert.deepEqual(inferDurationIntent('开头 5 秒，整集 5 分钟'), { mode: 'exact', seconds: 300 });
  const f = setup(t),
    run = f.create(f.episode(), '整集 6 分钟');
  assert.equal(run.data.duration.seconds, 300);
  assert.equal(run.data.effectivePlan.warnings.length, 1);
});

test('plan resizing preserves slot and delivery history, changed requirements block new preparation until explicit revision', (t) => {
  const f = setup(t),
    ep = f.episode(),
    run = f.create(ep),
    original = f.store.get(f.series.id).data.production.slots.map((s: any) => s.id);
  for (const count of [8, 12]) {
    const s = f.store.get(f.series.id),
      p = f.seriesService.preview(s.id, { ...s.data.production, targetEpisodes: count });
    f.seriesService.apply(s.id, {
      ...p,
      revision: s.revision,
      idempotencyKey: `resize-to-${count}`,
    });
    assert.equal(
      f.store.get(s.id).data.production.slots.filter((v: any) => v.active).length,
      count,
    );
    assert.ok(
      f.store
        .get(s.id)
        .data.production.slots.some((v: any) => v.id === original[0] && v.episodeId === ep.id),
    );
  }
  const s = f.store.get(f.series.id),
    p = f.seriesService.preview(s.id, {
      ...s.data.production,
      runtime: { targetFrames: 1440, toleranceFrames: 0 },
    });
  f.seriesService.apply(s.id, {
    ...p,
    revision: s.revision,
    idempotencyKey: 'change-runtime-explicitly',
  });
  assert.throws(() => assertEpisodePlanCurrent(f.store, run), /制作要求已变化/);
  const revised = f.creation.revise(run.id, 'brief', '采用已经确认的新单集时长');
  assert.equal(revised.data.duration.seconds, 60);
  assert.doesNotThrow(() => assertEpisodePlanCurrent(f.store, revised));
});

test('missing direct predecessor is visible in draft context; independent units require an explicit reason and never borrow older facts', (t) => {
  const f = setup(t),
    first = f.episode(),
    second = f.episode(1),
    run = f.create(second);
  assert.equal(f.creation.context(run.id, 'brief').predecessor?.hypothetical, true);
  assert.ok(predecessorCanon(f.store, second).waiting);
  f.store.create(
    'continuity',
    f.project.id,
    { seriesId: f.series.id, confirmed: true, stale: true, schemaVersion: 3 },
    first.id,
  );
  assert.equal(episodePredecessor(f.store, second).status, 'waiting');
  const separate = f.store.update(second.id, second.revision, {
    ...second.data,
    seriesProduction: {
      ...second.data.seriesProduction,
      factDependency: { mode: 'independent', reason: '每集展示独立实验，只共享设计' },
    },
  });
  assert.equal(episodePredecessor(f.store, separate).status, 'independent');
  assert.equal(predecessorCanon(f.store, separate).canon, null);
});

test('same names only suggest reuse, explicit mapping fixes instance and refuses alias merging or changed subject', (t) => {
  const f = setup(t),
    ep = f.episode(),
    run = f.create(ep);
  const entity = f.domain.save(f.project.id, 'entity', {
    name: '同名产品',
    type: 'object',
    instances: [
      { id: 'one', name: '同名产品' },
      { id: 'two', name: '同名产品' },
    ],
    attributes: [],
  });
  const subjects = ['left', 'right'].map((key) => ({
    key,
    name: '同名产品',
    kind: 'object',
    description: 'Same design',
    attributes: [],
  }));
  const script = f.store.create(
    'authoring_result',
    f.project.id,
    { stage: 'script', result: { subjects }, adopted: false },
    run.id,
  );
  const service = new SubjectBindings(f.store),
    view = service.inspect(run.id);
  assert.equal(view.subjects[0].binding, null);
  assert.equal(view.subjects[0].suggestions.length, 2);
  const bindings = subjects.map((s, i) => ({
    subjectKey: s.key,
    subjectDigest: generationDigest(s),
    decision: 'reuse',
    entity: ref(entity),
    instanceId: i ? 'two' : 'one',
    reason: '两个独立实例共享外观',
  }));
  assert.throws(
    () =>
      service.save(run.id, {
        revision: run.revision,
        script: ref(script),
        bindings: bindings.map((b) => ({ ...b, instanceId: 'one' })),
        idempotencyKey: 'ambiguous-merge',
      }),
    /不能静默合并/,
  );
  const next = service.save(run.id, {
    revision: run.revision,
    script: ref(script),
    bindings,
    idempotencyKey: 'explicit-mapping',
  });
  assert.deepEqual(subjectBindingIssues(f.store, next, { subjects }), []);
  f.store.update(entity.id, entity.revision, { ...entity.data, name: '可选的新设计版本' });
  const choices = service.inspect(run.id).available;
  assert.ok(choices.some((a: any) => a.entity.revision === entity.revision));
  assert.ok(choices.some((a: any) => a.entity.revision === entity.revision + 1));
  assert.deepEqual(service.inspect(run.id).subjects[0].binding.entity, ref(entity));
  subjects[0].description = 'changed';
  assert.equal(subjectBindingIssues(f.store, next, { subjects }).length, 1);
  assert.equal(f.store.list('entity', f.project.id).length, 1);
});

test('no-script season proposals prepare deterministically, apply via versioned plan without episode or media jobs, reject stale sources', (t) => {
  const f = setup(t),
    service = new SeriesProposals(f.store),
    input = proposalInput();
  const a = service.prepare(f.series.id, input);
  assert.deepEqual(service.prepare(f.series.id, input), a);
  const proposal = service.save(f.series.id, {
    input,
    digest: a.digest,
    result: proposalResult(),
    idempotencyKey: 'save-season-from-idea',
  });
  const preview = service.preview(proposal.id, { revision: proposal.revision });
  const body = {
    revision: proposal.revision,
    digest: preview.digest,
    idempotencyKey: 'apply-season-from-idea',
  };
  const series = service.apply(proposal.id, body);
  assert.deepEqual(service.apply(proposal.id, body), series);
  assert.equal(series.data.production.story.goal, '完成展览');
  assert.equal(f.store.list('episode', f.project.id).length, 0);
  assert.equal(f.store.jobs().length, 0);
  assert.throws(
    () => service.preview(proposal.id, { revision: f.store.get(proposal.id).revision }),
    /来源已变化/,
  );
});

test('source indexing preserves exact spans, reviewed adaptation distinguishes presentation from story and fixes original facts', (t) => {
  const f = setup(t),
    source = f.store.create('chapter', f.project.id, {
      title: '原文',
      text: '# 第一章\n她怀疑同伴拿了钥匙。\n# 第二章\n她发现钥匙在自己书包。',
    });
  const service = new SourceAdaptation(f.store),
    preview = service.preview(f.project.id, [ref(source)]);
  assert.equal(preview.data.entries.length, 2);
  preview.data.entries[0].events = [{ id: 'suspicion', statement: '她怀疑同伴', locked: true }];
  const index = service.save(f.project.id, {
    data: preview.data,
    idempotencyKey: 'fixed-source-index',
  });
  assert.equal(
    indexedSource(f.store, index).data.entries[0].text,
    source.data.text.slice(0, preview.data.entries[0].end),
  );
  const intentWithChange: any = {
    ...intent,
    mode: 'faithful_adaptation',
    decisions: [
      {
        id: 'visible',
        source: ref(index),
        eventId: 'suspicion',
        change: 'presentation',
        before: '她怀疑同伴',
        after: '看空挂钩后看向同伴',
        approved: true,
        reason: '把心理转成可见反应，不确认同伴有罪',
      },
    ],
  };
  assert.doesNotThrow(() =>
    validateAdaptationIntent(f.store, f.project.id, intentWithChange, [ref(index)]),
  );
  intentWithChange.decisions[0].before = '同伴偷了钥匙';
  assert.throws(
    () => validateAdaptationIntent(f.store, f.project.id, intentWithChange, [ref(index)]),
    /原事件/,
  );
  assert.throws(
    () =>
      service.save(f.project.id, {
        data: { version: 1, entries: [{ ...preview.data.entries[0], end: 99999 }] },
        idempotencyKey: 'out-of-range-source',
      }),
    /越界/,
  );
});

test('horizontal, vertical and square canvas require explicit treatment, no pretend reframing', (t) => {
  const f = setup(t),
    plan = effectiveEpisodePlan(f.store, f.episode());
  assert.equal(formatComparison(plan, 1920, 1080).ready, true);
  assert.equal(formatComparison(plan, 720, 1280).ready, false);
  for (const [width, height] of [
    [576, 1024],
    [768, 768],
  ]) {
    plan.canvas = { width, height, mismatch: 'letterbox' };
    assert.equal(formatComparison(plan, 1024, 576).ready, true);
    assert.equal(formatComparison(plan, width, height).matches, true);
  }
});

test('preregistered experiment keeps all 38 planned attempts, unknowns and blocked preparation separate, no tasks or fake approval', (t) => {
  const f = setup(t),
    service = new ValidationExperiments(f.store);
  const input = {
    seriesId: f.series.id,
    seeds: [104729, 130363],
    assets: [],
    recipe: {
      baseline: 'native-h3-directed-v4',
      experimental: 'campus-state-order',
      experimentalRevision: '1',
      change: 'state/order only',
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
  const preparation = service.prepare(f.project.id, input);
  assert.deepEqual(preparation, service.prepare(f.project.id, input));
  assert.equal(preparation.cases.length, 38);
  for (const [family, n] of [
    ['identity', 16],
    ['action', 12],
    ['narrative', 10],
  ])
    assert.equal(preparation.cases.filter((c) => c.family === family).length, n);
  assert.equal(preparation.readyToSubmit, false);
  assert.equal(preparation.executionAuthorization, 'none');
  const doc = service.save(f.project.id, {
    input,
    digest: preparation.digest,
    idempotencyKey: 'offline-validation-pack',
  });
  service.record(doc.id, {
    revision: doc.revision,
    caseId: preparation.cases[0].id,
    outcome: 'preparation_blocked',
    notes: '身份与构图素材未审',
  });
  const report = service.report(doc.id);
  assert.equal(report.counts.attempted, 0);
  assert.equal((report.counts as Record<string, number>).preparation_blocked, 1);
  assert.equal(report.counts.pending, 37);
  assert.equal(f.store.jobs().length, 0);
  assert.ok(service.report(doc.id, true).cases.every((c: any) => !c.condition && !c.id));
  assert.equal(new Set(validationCases([104729, 130363]).map((c) => c.id)).size, 38);
});

test('season proposal uses existing text Worker, persists invalid output without repair or duplicate task', async (t) => {
  const oldKey = process.env.STUDIO_PROTOCOL_TEST_KEY;
  process.env.STUDIO_PROTOCOL_TEST_KEY = 'offline-test';
  t.after(() => {
    if (oldKey === undefined) delete process.env.STUDIO_PROTOCOL_TEST_KEY;
    else process.env.STUDIO_PROTOCOL_TEST_KEY = oldKey;
  });
  const f = setup(t);
  configureModel(f.store, f.project.id, 'codex', f.series.id);
  const service = new SeriesProposals(f.store),
    input = proposalInput(),
    prepared = service.prepare(f.series.id, input);
  const job = service.generate(f.series.id, {
    input,
    digest: prepared.digest,
    approved: true,
    idempotencyKey: 'offline-text-mock',
  });
  assert.equal(
    service.generate(f.series.id, {
      input,
      digest: prepared.digest,
      approved: true,
      idempotencyKey: 'offline-text-mock',
    }).id,
    job.id,
  );
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'series-proposal-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let calls = 0;
  const worker = new Worker(f.store, root, undefined, async () => {
    calls++;
    return { invalid: true };
  });
  await worker.tick();
  worker.stop();
  assert.equal(calls, 1, JSON.stringify(f.store.job(job.id)));
  assert.equal(f.store.list('series_proposal')[0].data.valid, false);
  assert.equal(f.store.jobs().length, 1);
  assert.equal(f.store.jobs()[0].state, 'succeeded');
  assert.equal(codexOutputJsonSchema('series_proposal').properties.contractRevision, undefined);
});

test('actual API ratio is checked against the frozen canvas; explicit letterboxing resolves it without altering the request', (t) => {
  for (const canvasTreatment of [undefined, 'letterbox'] as const) {
    const f = fixture(t, false, false, undefined, { canvasTreatment });
    configureModel(f.store, f.project.id, 'minimax-video');
    const scope = f.select();
    const prepared = f.workspace.preview(scope.scope.id, scope.scope.revision, f.run.revision);
    if (!canvasTreatment) {
      assert.ok(prepared.issues.some((i: any) => /生成与交付画幅不同/.test(i.message)));
      assert.equal(prepared.preview, null);
    } else {
      assert.deepEqual(prepared.issues, []);
      const input = prepared.preview!.inputs[0];
      assert.equal(input.prepared.request.ratio, '16:9');
      assert.equal(input.formatComparison.treatment, 'letterbox');
      assert.equal(input.effectivePlan.canvas.width, 864);
    }
    assert.equal(f.store.jobs().filter((j) => j.kind === 'generation').length, 0);
  }
});

test('asset task consumes the explicit shared instance entity instead of creating a second identity', (t) => {
  const f = fixture(t, true);
  const script = f.creation.adopted(f.run).script!;
  assert.ok(script.stage === 'script');
  const subject = script.subjects[0];
  const entity = new DomainService(f.store).save(f.project.id, 'entity', {
    name: subject.name,
    type: 'object',
    instances: [{ id: 'shared-product', name: subject.name }],
    attributes: [],
  });
  const run = f.store.update(f.run.id, f.run.revision, {
    ...f.run.data,
    subjectBindings: [
      {
        subjectKey: subject.key,
        subjectDigest: generationDigest(subject),
        decision: 'reuse',
        entity: ref(entity),
        instanceId: 'shared-product',
        reason: '固定同一系列产品身份',
      },
    ],
  });
  const assets = f.creation.adopted(run).assets!;
  assert.ok(assets.stage === 'assets');
  const count = f.store.list('entity', f.project.id).length;
  const task = new CreationMediaService(f.store, '.').createAssetTask(run.id, {
    revision: run.revision,
    requirementId: assets.items[0].id,
    idempotencyKey: 'shared-asset-task',
  }).task;
  assert.deepEqual(task.data.entity, ref(entity));
  assert.equal(f.store.list('entity', f.project.id).length, count);
});

test('experimental pass requires complete registered observations and listening, preserving failed attempts', (t) => {
  const f = setup(t),
    service = new ValidationExperiments(f.store),
    definition = validationCases([104729, 130363])[0];
  const ep = f.episode(),
    configured = configureModel(f.store, f.project.id, 'minimax-video');
  const model = configured.registry.resolve(f.project.id, ep.id, 'video')!;
  const experiment = f.store.create('validation_experiment', f.project.id, {
    preparation: { digest: 'fixed', cases: [definition], model },
    attempts: [],
  });
  const job = f.store.createJob(
    'generation',
    f.project.id,
    ep.id,
    {
      experiment: { id: experiment.id, digest: 'fixed', caseId: definition.id },
      modelExecution: model,
      segment: { duration: 10 },
      seed: definition.seed,
    },
    'mock-experiment-evidence',
  );
  const review = f.store.create('generation_review', f.project.id, {
    jobId: job.id,
    inspected: true,
    in: 0,
    out: 10,
    dimensions: {
      identity: 'pass',
      props: 'pass',
      space: 'pass',
      action: 'pass',
      style: 'pass',
      audio: 'unreviewed',
    },
  });
  const body = {
    revision: experiment.revision,
    caseId: definition.id,
    jobId: job.id,
    outcome: 'pass',
    notes: '离线审核契约测试替身',
    review: ref(review),
    observations: definition.checks.map((check) => ({
      check,
      status: 'pass',
      startFrame: 0,
      endFrame: 240,
      inspection: check === 'unexpected_voice' ? 'audio' : 'motion',
      notes: '仅验证审核契约，不是媒体观察结论',
    })),
  };
  assert.throws(() => service.record(experiment.id, body), /完整视听审核/);
  assert.throws(() => service.record(experiment.id, { ...body, observations: [] }), /明确观察/);
  assert.throws(
    () =>
      service.record(experiment.id, {
        ...body,
        observations: [{ ...body.observations[0], endFrame: 241 }],
      }),
    /观察区间/,
  );
  service.record(experiment.id, {
    ...body,
    outcome: 'quality_fail',
    notes: '实际失败不替换；听审保持未审',
  });
  assert.equal((service.report(experiment.id).counts as any).quality_fail, 1);
  assert.throws(
    () => service.record(experiment.id, { ...body, revision: f.store.get(experiment.id).revision }),
    /不得用重试/,
  );
});
