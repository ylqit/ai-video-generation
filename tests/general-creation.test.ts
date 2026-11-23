import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { DomainService } from '../src/server/domain-service.js';
import { Worker } from '../src/server/worker.js';
import { creativeCatalog } from '../src/server/creative-catalog.js';
import { BatchService } from '../src/server/batches.js';
import { prepareModularH3 } from '../src/server/modular-h3.js';
import { resolveCreativeBrief, projectShotBrief } from '../src/server/creative-brief.js';
import { compileH3 } from '../src/server/comfy.js';
import { prepareContinuation } from '../src/server/continuation.js';
import {
  generationDependencies,
  correctionAffectsInput,
  boundaryChanges,
} from '../src/server/generation-dependencies.js';
import { directingSchema, prepareShot, continuityIssues } from '../src/shared/directing.js';
import { shotStateSchema, reviewSchema } from '../src/shared/domain.js';
import { dramaturgyIssues, dramaturgySchema } from '../src/shared/longform.js';
import { spliceSelection, repairWindow } from '../src/server/selection-splice.js';
import { validateObservedReview } from '../src/server/review-evidence.js';
import {
  stateFactSchema,
  evaluateCondition,
  validateShotSemantics,
  auditShotSemantics,
  incomingSchema,
} from '../src/shared/shot-semantics.js';
const ref = (d: any) => ({ id: d.id, revision: d.revision });
const fact = (value: any, instanceId = 'device', key = 'powered') => ({
  instanceId,
  key,
  status: value === null ? ('unknown' as const) : ('known' as const),
  value,
});
const observe = (id: string, value: any, startFrame: number, endFrame: number) => ({
  ...fact(value),
  id,
  startFrame,
  endFrame,
  inspection: 'motion',
});
const event = (id: string, startFrame: number, endFrame: number, more: any = {}) => ({
  id,
  description: id,
  startFrame,
  endFrame,
  mode: 'occurrence',
  inspection: 'motion',
  required: true,
  afterIds: [],
  preconditions: [],
  changes: [],
  strictWindow: false,
  ...more,
});
async function fixture(t: any) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'studio-general-'));
  const store = new Store(path.join(root, 'studio.sqlite')),
    service = new StudioService(store),
    domain = new DomainService(store);
  t.after(async () => {
    store.close();
    assert.ok(root.startsWith(path.join(os.tmpdir(), 'studio-general-')));
    await fs.rm(root, { recursive: true, force: true });
  });
  const project = service.createProject({ title: 'Universal product', mode: 'short', brief: '' });
  const entity = domain.save(project.id, 'entity', {
    name: 'Device',
    type: 'object',
    instances: [
      { id: 'device', name: 'First' },
      { id: 'twin', name: 'Second' },
    ],
    attributes: [{ key: 'powered', label: 'Powered', type: 'boolean' }],
    description: 'Future repair restores both devices.',
    fixedFeatures: ['Both devices are glowing.'],
  });
  let profile = domain.save(project.id, 'creation_profile', {
    name: 'Product only',
    rulesVersion: 'director-v6',
    composition: {
      moduleRefs: [],
      overrides: { visual: 'Photographic product lighting.' },
      artBible: {
        characters: 'An unneeded partner arrives later.',
        environments: '',
        props: 'Restore the device in the ending.',
        effects: '',
      },
      artEntries: [
        {
          id: 'surface',
          target: { kind: 'instance', id: 'device' },
          aspect: 'identity',
          text: 'Brushed silver housing.',
          stable: true,
        },
        {
          id: 'twin-art',
          target: { kind: 'instance', id: 'twin' },
          aspect: 'identity',
          text: 'A second housing.',
          stable: true,
        },
      ],
    },
  });
  profile = domain.publish(profile.id, profile.revision, {
    inspected: true,
    conclusion: 'Offline authored fixture',
  });
  const shot: any = {
    id: 's',
    scene: 'table',
    duration: 5,
    description: 'Turn on the device',
    dialogue: '',
    continuity: '',
    state: shotStateSchema.parse({
      instances: [
        { instanceId: 'device', entity: ref(entity) },
        { instanceId: 'twin', entity: ref(entity) },
      ],
      confirmed: true,
      attributes: { start: [fact(false)], end: [fact(true)] },
    }),
    directing: directingSchema.parse({
      version: 2,
      presence: { visible: ['device'] },
      execution: { action: 'The device is connected, then its indicator turns on.' },
      events: [
        event('connect', 0, 24, { changes: [] }),
        event('start', 24, 48, {
          afterIds: ['connect'],
          preconditions: [{ instanceId: 'device', key: 'powered', operator: 'eq', value: false }],
          changes: [fact(true)],
        }),
      ],
    }),
  };
  const ep = store.create('episode', project.id, {
    title: 'Demo',
    summary: '',
    script: '',
    incoming: {},
    outgoing: {},
    openLoops: [],
    number: 1,
    approved: true,
    stale: false,
    sourceChapterIds: [],
    shots: [shot],
    segments: [
      {
        id: 'g',
        shotIds: ['s'],
        duration: 5,
        mode: 't2v',
        prompt: 'Old future synopsis',
        references: [],
        executionVersion: 'native-h3-base-v3',
        generationMode: 'formal',
      },
    ],
  });
  const req = {
    episodeId: ep.id,
    episodeRevision: ep.revision,
    segmentId: 'g',
    width: 1024,
    height: 576,
    steps: 20,
    seed: 5,
  };
  const cloud = { baseUrl: 'http://127.0.0.1:9999', instanceId: 'offline' };
  const prepared = service.prepareGeneration(req, cloud);
  return { root, store, service, domain, project, entity, profile, shot, ep, req, cloud, prepared };
}
function goodReview(video: any, job: any) {
  return reviewSchema.parse({
    jobId: job.id,
    video: ref(video),
    in: 0,
    out: 5,
    inspected: true,
    dimensions: {
      identity: 'pass',
      action: 'pass',
      props: 'pass',
      space: 'pass',
      style: 'pass',
      audio: 'pass',
    },
    issues: [],
    observations: [observe('off', false, 0, 24), observe('on', true, 47, 120)],
    eventEvidence: [
      {
        shotId: 's',
        eventId: 'connect',
        status: 'pass',
        inspection: 'motion',
        startFrame: 0,
        endFrame: 12,
        observed: 'occurred',
      },
      {
        shotId: 's',
        eventId: 'start',
        status: 'pass',
        inspection: 'motion',
        startFrame: 12,
        endFrame: 48,
        observed: 'occurred',
      },
    ],
  });
}
async function candidate(t: any) {
  const f = await fixture(t),
    job = f.store.createJob(
      'generation',
      f.project.id,
      f.ep.id,
      f.prepared.input,
      crypto.randomUUID(),
    );
  f.store.patchJob(job.id, { state: 'succeeded' });
  const video = f.store.create('asset', f.project.id, {
    name: 'Offline metadata only',
    mediaType: 'video',
    adopted: true,
    duration: 121 / 24,
    frameCount: 121,
    jobId: job.id,
    sha256: 'fixture',
  });
  const review = f.domain.review(f.project.id, goodReview(video, job));
  const select = {
    episode: ref(f.ep),
    segmentId: 'g',
    jobId: job.id,
    video: ref(video),
    review: ref(review),
    in: 0,
    out: 5,
    coverage: [{ shotId: 's', in: 0, out: 5 }],
  };
  return { ...f, job, video, review, select };
}
test('V3 optional composition projects only visible stable art and compiles fixed inputs deterministically', async (t) => {
  const f = await fixture(t),
    p = f.prepared.input.prepared;
  assert.match(p.finalPrompt, /Brushed silver/);
  assert.doesNotMatch(
    p.finalPrompt,
    /unneeded partner|second housing|Future repair|glowing|Old future/,
  );
  assert.equal(
    p.projection[0].decisions.find((d: any) => d.field === 'artEntries.twin-art').reason,
    'not_visible',
  );
  assert.equal(f.domain.shotChecks(f.project.id, [f.shot]).length, 0);
  assert.deepEqual(p.trace.find((t: any) => t.field === 'artEntries.surface').consumers, [
    'prompt',
  ]);
  assert.deepEqual(f.service.prepareGeneration(f.req, f.cloud), f.prepared);
  assert.equal(f.store.jobs().length, 0);
  assert.deepEqual(
    compileH3(f.prepared.input, new Map(), 'offline'),
    compileH3(f.prepared.input, new Map(), 'offline'),
  );
  assert.deepEqual(f.prepared.input.dependencies, generationDependencies(f.prepared.input));
});
test('unknown is distinct from false and identical products hold independent state', () => {
  assert.equal(
    evaluateCondition({ instanceId: 'device', key: 'powered', operator: 'eq', value: false }, [
      fact(null),
    ]),
    'unknown',
  );
  assert.equal(
    evaluateCondition({ instanceId: 'twin', key: 'powered', operator: 'eq', value: false }, [
      fact(true),
      fact(false, 'twin'),
    ]),
    'pass',
  );
  assert.throws(() => stateFactSchema.parse({ ...fact(null), value: false }));
});
test('causal prerequisites require declared ancestors, reject cycles and attribute type errors', async (t) => {
  const f = await fixture(t),
    s = structuredClone(f.shot);
  s.directing.events[1].preconditions[0].value = true;
  assert.match(validateShotSemantics(s, [f.entity]).join(' '), /前提/);
  s.directing.events[0].afterIds = ['start'];
  assert.match(validateShotSemantics(s, [f.entity]).join(' '), /循环/);
  s.state.attributes.start[0].value = 'on';
  assert.match(validateShotSemantics(s, [f.entity]).join(' '), /类型/);
});
test('reversed event evidence and unfinished observed prerequisites cannot pass adoption', async (t) => {
  const f = await candidate(t),
    spec = f.prepared.input.prepared.shotSpecs[0],
    r = structuredClone(f.review.data);
  assert.deepEqual(auditShotSemantics(spec, r, { in: 0, out: 5 }), []);
  r.eventEvidence[0].endFrame = 50;
  assert.match(auditShotSemantics(spec, r, { in: 0, out: 5 }).join(' '), /顺序/);
  r.eventEvidence[0].endFrame = 12;
  r.observations[0].value = true;
  assert.match(auditShotSemantics(spec, r, { in: 0, out: 5 }).join(' '), /前提/);
});
test('sustained state and forbidden events require full interval review including actual output tail', () => {
  const spec = {
    shotId: 's',
    frames: 120,
    directing: {
      version: 2,
      events: [
        event('off', 0, 120, {
          mode: 'sustain',
          condition: { instanceId: 'device', key: 'powered', operator: 'eq', value: false },
        }),
        event('restart', 0, 120, { mode: 'forbidden' }),
      ],
      sound: { dialogue: [], checks: [] },
    },
  };
  const review = {
    observations: [observe('off', false, 0, 121)],
    eventEvidence: ['off', 'restart'].map((eventId) => ({
      shotId: 's',
      eventId,
      status: 'pass',
      inspection: 'motion',
      startFrame: 0,
      endFrame: 121,
      observed: eventId === 'off' ? 'occurred' : 'absent',
    })),
  };
  assert.deepEqual(auditShotSemantics(spec, review, { in: 0, out: 121 / 24 }), []);
  review.eventEvidence[1].endFrame = 120;
  assert.match(
    auditShotSemantics(spec, review, { in: 0, out: 121 / 24 }).join(' '),
    /整个|完整|区间/,
  );
  review.eventEvidence[1].endFrame = 121;
  review.observations[0].endFrame = 119;
  assert.match(auditShotSemantics(spec, review, { in: 0, out: 121 / 24 }).join(' '), /持续/);
});
test('adoption freezes actual crop boundaries, changing crop invalidates lost events and boundary evidence', async (t) => {
  const f = await candidate(t),
    s = f.domain.select(f.project.id, f.select);
  assert.equal(s.data.boundary.end.frame, 119);
  assert.equal(s.data.boundary.end.facts[0].value, true);
  const trimmed = f.domain.select(
    f.project.id,
    { ...f.select, out: 1, coverage: [{ shotId: 's', in: 0, out: 1 }] },
    s.revision,
  );
  assert.equal(trimmed.data.boundary.end.facts[0].value, false);
  assert.equal(f.store.get(s.id, s.revision).data.boundary.end.facts[0].value, true);
  const tail = f.domain.select(
    f.project.id,
    { ...f.select, out: 121 / 24, coverage: [{ shotId: 's', in: 0, out: 121 / 24 }] },
    trimmed.revision,
  );
  assert.equal(tail.data.boundary.end.facts[0].status, 'unknown');
  assert.doesNotThrow(() =>
    f.service.validateEdl(f.project.id, {
      clips: [{ assetId: f.video.id, revision: 1, in: 1, out: 5, selection: ref(s) }],
      audio: [],
    }),
  );
});
test('dependent preparation uses reviewed boundary while independent and historical modes remain explicit', async (t) => {
  const f = await candidate(t),
    s = f.domain.select(f.project.id, f.select),
    ep = structuredClone(f.ep);
  ep.data.shots[0].state.attributes.start = [fact(true)];
  const segment = {
    ...ep.data.segments[0],
    id: 'next',
    incoming: incomingSchema.parse({
      mode: 'continue',
      selection: ref(s),
      decisions: [{ instanceId: 'device', key: 'powered', decision: 'inherit' }],
    }),
  };
  assert.equal(prepareContinuation(f.store, ep, segment).snapshot.facts[0].value, true);
  ep.data.shots[0].state.attributes.start = [fact(false)];
  assert.match(prepareContinuation(f.store, ep, segment).warnings.join(';'), /不符/);
  segment.incoming.mode = 'historical';
  segment.incoming.boundary = 'start';
  assert.equal(prepareContinuation(f.store, ep, segment).snapshot.facts[0].value, false);
  assert.equal(
    prepareContinuation(f.store, ep, { ...segment, incoming: { mode: 'independent' } }).snapshot,
    null,
  );
  assert.equal(f.store.list('continuity', f.project.id).length, 0);
});
test('optional module versions preserve jobs; correction matching includes profile, module and used selection keys', async (t) => {
  const f = await fixture(t),
    input = f.prepared.input;
  assert.ok(correctionAffectsInput(input, { source: f.profile.id, affected: [] }));
  const frozen = {
    ...input,
    segment: {
      incoming: {
        selection: { id: 'sel', revision: 1 },
        decisions: [{ instanceId: 'device', key: 'powered' }],
        relationDecisions: [],
      },
    },
    dependencies: [{ id: 'sel', revision: 1 }],
  };
  const before = { end: { facts: [fact(false), fact(false, 'twin')], relations: [] } },
    after = { end: { facts: [fact(false), fact(true, 'twin')], relations: [] } };
  const correction = {
    source: 'sel',
    affected: [],
    selectionChange: boundaryChanges(before, after),
  };
  assert.equal(correctionAffectsInput(frozen, correction), false);
  after.end.facts[0].value = true;
  correction.selectionChange = boundaryChanges(before, after);
  assert.equal(correctionAffectsInput(frozen, correction), true);
});
test('ellipsis still checks key state and ownership; per-property explanations permit legal changes', async (t) => {
  const f = await fixture(t),
    next = structuredClone(f.shot);
  next.id = 'next';
  next.directing.transition = { kind: 'ellipsis', reason: 'Later', changes: [] };
  assert.ok(continuityIssues([f.shot, next]).some((i) => i.code.startsWith('attribute')));
  next.directing.transition.changes = [
    {
      objectId: 'device',
      property: 'attribute:powered',
      reason: 'Operator switches it off during ellipsis',
    },
  ];
  assert.equal(continuityIssues([f.shot, next]).length, 0);
});
test('audio requires heard text and speaker; silence needs complete interval evidence', () => {
  const spec = {
    shotId: 's',
    frames: 120,
    directing: {
      version: 2,
      events: [],
      sound: {
        dialogue: [{ instanceId: 'operator', text: 'Connected.' }],
        checks: [{ id: 'quiet', kind: 'no_speech' }],
      },
    },
  };
  const r = {
    audioEvidence: [
      {
        shotId: 's',
        requirementId: 'dialogue:0',
        inspection: 'audio',
        status: 'pass',
        startFrame: 0,
        endFrame: 20,
        speakerId: 'wrong',
        text: 'Connected.',
      },
      {
        shotId: 's',
        requirementId: 'quiet',
        inspection: 'audio',
        status: 'pass',
        startFrame: 20,
        endFrame: 120,
        voicePresent: false,
      },
    ],
  };
  assert.match(auditShotSemantics(spec, r, { in: 0, out: 5 }).join(' '), /说话者/);
  assert.match(auditShotSemantics(spec, r, { in: 0, out: 5 }).join(' '), /整个/);
  assert.throws(
    () =>
      validateObservedReview(
        {
          input: { prepared: { shotSpecs: [{ ...spec, version: 2 }] }, planning: { records: [] } },
        },
        { data: { frameCount: 120 } },
        {
          in: 0,
          out: 5,
          audioEvidence: [...r.audioEvidence, { ...r.audioEvidence[0], status: 'issues' }],
        },
      ),
    /审核项重复/,
  );
  const ambient = {
    ...spec,
    directing: {
      ...spec.directing,
      sound: { dialogue: [], checks: [], environment: 'A continuous hum.' },
    },
  };
  assert.match(
    auditShotSemantics(ambient, { audioEvidence: [] }, { in: 0, out: 5 }).join(' '),
    /field:environment/,
  );
  assert.deepEqual(
    auditShotSemantics(
      ambient,
      {
        audioEvidence: [
          {
            shotId: 's',
            requirementId: 'field:environment',
            status: 'pass',
            inspection: 'audio',
            startFrame: 0,
            endFrame: 120,
          },
        ],
      },
      { in: 0, out: 5 },
    ),
    [],
  );
});
test('Ref V3 shares one image across two separate instances and rejects declared future image states', async (t) => {
  const f = await fixture(t),
    input = structuredClone(f.prepared.input),
    image = {
      id: 'image',
      revision: 1,
      data: { width: 1024, height: 576, mediaType: 'image', adopted: true, sha256: 'fixture' },
    };
  input.templateVersion = 'native-h3-directed-v3';
  input.segment.mode = 'ref2va';
  input.segment.guidedPrompt = null;
  input.assets = [{ asset: image, reference: { assetId: image.id, revision: 1 } }];
  input.planning.instances = input.planning.shots[0].state.instances;
  input.planning.shots[0].directing.presence.visible = ['device', 'twin'];
  input.planning.shots[0].state.attributes.start.push(fact(false, 'twin'));
  input.planning.plan = {
    data: { guides: [{ bindingId: 'both', frameIndex: 0, instruction: 'Initial composition.' }] },
  };
  input.planning.selected = [
    {
      id: 'both',
      asset: ref(image),
      instanceIds: ['device', 'twin'],
      role: 'identity',
      reason: 'Product identity.',
      usage: {
        purpose: 'identity',
        shotIds: ['s'],
        preserve: ['Housing shape.'],
        allow: ['Authored state changes.'],
        reviewed: true,
        depictedState: [],
      },
      retain: [],
      allow: [],
      inheritBackground: false,
    },
  ];
  input.prepared = prepareModularH3(input);
  assert.equal(input.prepared.images.length, 1);
  assert.equal(input.prepared.subjects.length, 2);
  const graph = compileH3(input, new Map([['image:1', 'fixture.png']]), 'offline');
  const guide = Object.values(graph).find((n: any) => n.class_type.includes('AddGuide'));
  assert.ok(guide);
  assert.match(input.prepared.finalPrompt, /Housing shape/);
  assert.doesNotMatch(input.prepared.finalPrompt, /Future repair|Both devices are glowing/);
  input.planning.selected[0].usage.depictedState = [fact(true)];
  assert.ok(
    prepareModularH3(input).referenceChecks.some((c: any) => c.status === 'conflict_advisory'),
  );
  input.planning.selected[0].usage.stateException =
    'Keep shape only; ignore the lit indicator in the identity image.';
  assert.equal(prepareModularH3(input).referenceChecks![0].status, 'reviewed_exception');
  input.planning.selected[0].usage.purpose = 'action_start';
  assert.ok(prepareModularH3(input).referenceChecks!.length);
});
test('Worker holds corrected fixed modules and preserves optional versions without sending any model request', async (t) => {
  const f = await fixture(t);
  let module = f.domain.save(f.project.id, 'creative_module', creativeCatalog[0].data);
  module = f.domain.publish(module.id, module.revision, { inspected: true, conclusion: 'fixture' });
  const input = {
    ...f.prepared.input,
    dependencies: [...f.prepared.input.dependencies, ref(module)],
  };
  const job = f.store.createJob('generation', f.project.id, f.ep.id, input, crypto.randomUUID());
  const worker = new Worker(f.store, f.root, () => {
    throw new Error('No remote calls allowed');
  });
  const optional = f.domain.save(
    f.project.id,
    'creative_module',
    { ...module.data, name: 'Optional upgrade' },
    module.id,
    module.revision,
  );
  assert.equal(f.store.job(job.id).holdReason, null);
  f.domain.impact(optional.id, true, 'Correct erroneous style requirement');
  await worker.tick();
  assert.equal(f.store.job(job.id).holdReason, 'dependencies_need_review');
  worker.stop();
  assert.equal(f.store.job(job.id).promptId, null);
});
test('correction requires a new explicit review and completed outputs are marked for review', async (t) => {
  const f = await candidate(t);
  f.domain.impact(f.entity.id, true, 'Correct property interpretation');
  assert.equal(f.store.job(f.job.id).output.basisCorrected, true);
  const selected = f.domain.select(f.project.id, { ...f.select, review: null });
  assert.equal(selected.data.quality, 'unobserved');
  assert.throws(
    () => f.domain.review(f.project.id, f.review.data, f.review.id, f.review.revision),
    /复核|结论/,
  );
  const review = f.domain.review(
    f.project.id,
    {
      ...f.review.data,
      correctionConclusion: 'Rechecked all frames and confirmed the declared values.',
    },
    f.review.id,
    f.review.revision,
  );
  assert.ok(review.data.correctionBasis.length);
});
test('local replacement separates source problem, candidate generation and adopted ranges, requiring both joins', async (t) => {
  const f = await candidate(t),
    original = f.domain.select(f.project.id, f.select);
  const segment = {
    ...f.ep.data.segments[0],
    repair: {
      sourceSelection: ref(original),
      issueRange: { startFrame: 24, endFrame: 48 },
      generationRange: { startFrame: 0, endFrame: 120 },
      adoptRange: { startFrame: 0, endFrame: 120 },
      goal: 'Finish the action without undoing the result.',
      preserve: ['Preserve housing.'],
      desiredEnd: [fact(true)],
      checkBefore: true,
      checkAfter: true,
    },
  };
  assert.equal(prepareContinuation(f.store, f.ep, segment).dependencies[0].id, original.id);
  let ep = f.service.saveEpisode(f.ep.id, f.ep.revision, { ...f.ep.data, segments: [segment] });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const currentSelection = f.store.get(original.id);
  assert.equal(currentSelection.data.stale, true);
  const prepared = f.service.prepareGeneration({ ...f.req, episodeRevision: ep.revision }, f.cloud);
  const job = f.store.createJob(
    'generation',
    f.project.id,
    ep.id,
    prepared.input,
    crypto.randomUUID(),
  );
  f.store.patchJob(job.id, { state: 'succeeded' });
  const video = f.store.create('asset', f.project.id, { ...f.video.data, jobId: job.id });
  const review = f.domain.review(f.project.id, goodReview(video, job));
  const selection = {
    ...f.select,
    episode: ref(ep),
    jobId: job.id,
    video: ref(video),
    review: ref(review),
  };
  assert.equal(f.store.list('generation_review').length, 2);
  const updated = f.domain.review(
    f.project.id,
    {
      ...review.data,
      spliceEvidence: ['before', 'after'].flatMap((side) =>
        ['motion', 'audio'].map((inspection) => ({
          side,
          inspection,
          sourceSelection: ref(original),
          status: 'pass',
          notes: 'Inspected the adopted boundary and adjacent media.',
        })),
      ),
    },
    review.id,
    review.revision,
  );
  const replacement = f.domain.select(
    f.project.id,
    { ...selection, review: ref(updated) },
    currentSelection.revision,
  );
  assert.equal(replacement.revision, currentSelection.revision + 1);
  assert.equal(f.store.get(original.id, original.revision).data.video.id, f.video.id);
  assert.deepEqual(
    replacement.data.composition.parts.map((p: any) => [p.video.id, p.in, p.out]),
    [
      [f.video.id, 0, 1],
      [video.id, 0, 5],
      [f.video.id, 2, 5],
    ],
  );
  assert.equal(replacement.data.composition.totalFrames, 216);
  assert.equal(replacement.data.boundary.end.source.video.id, f.video.id);
  assert.equal(replacement.data.candidateBoundary.source.video.id, video.id);
  const edl = f.domain.assemble(f.project.id, ep.id);
  assert.equal(edl.clips.length, 3);
  f.service.saveEdl(f.project.id, edl);
  assert.doesNotThrow(() => f.service.saveEdl(f.project.id, { ...edl, clips: edl.clips.slice(1) }));
});
test('information withholding must use an explicitly forbidden event and remains a review requirement', async (t) => {
  const f = await fixture(t),
    input = structuredClone(f.prepared.input),
    s = input.planning.shots[0];
  input.information = [
    {
      id: 'hidden',
      kind: 'audience_knowledge',
      statement: 'The serial number identifies the owner.',
      shotIds: ['s'],
      afterIds: [],
    },
  ];
  s.directing.information = [{ informationId: 'hidden', eventId: 'reveal', purpose: 'withhold' }];
  s.directing.events.push(event('reveal', 0, 120));
  assert.throws(() => prepareModularH3(input), /禁止揭示/);
  s.directing.events.at(-1).mode = 'forbidden';
  assert.match(prepareModularH3(input).finalPrompt, /must not occur/);
});
test('legacy candidates gain observations only through an explicit post-generation review basis', async (t) => {
  const f = await fixture(t),
    legacy = structuredClone(f.prepared.input);
  legacy.templateVersion = 'native-h3-base-v2';
  legacy.prepared.shotSpecs.forEach((s: any) => {
    s.version = 1;
    s.directing.version = 1;
  });
  const job = f.store.createJob('generation', f.project.id, f.ep.id, legacy, crypto.randomUUID());
  f.store.patchJob(job.id, { state: 'succeeded' });
  const video = f.store.create('asset', f.project.id, {
    mediaType: 'video',
    adopted: true,
    duration: 5,
    frameCount: 120,
    jobId: job.id,
  });
  const raw = goodReview(video, job),
    before = JSON.stringify(f.store.job(job.id).input);
  assert.throws(() => f.domain.review(f.project.id, raw), /旧任务/);
  const review = f.domain.review(f.project.id, { ...raw, observationBasis: ref(f.ep) });
  assert.equal(review.data.evaluation.source, 'explicit_post_generation_review');
  assert.equal(JSON.stringify(f.store.job(job.id).input), before);
  const selection = f.domain.select(f.project.id, {
    episode: ref(f.ep),
    segmentId: 'g',
    jobId: job.id,
    video: ref(video),
    review: ref(review),
    in: 0,
    out: 5,
    coverage: [{ shotId: 's', in: 0, out: 5 }],
  });
  assert.equal(selection.data.boundary.end.facts[0].value, true);
});
test('mixed readiness freezes only ready entries; upstream adoption does not append to an already confirmed batch', async (t) => {
  const f = await fixture(t),
    next = structuredClone(f.shot);
  next.id = 'next';
  next.state.attributes.start = [fact(true)];
  next.directing.events = [];
  const ep = f.store.update(f.ep.id, f.ep.revision, {
    ...f.ep.data,
    shots: [f.shot, next],
    segments: [
      f.ep.data.segments[0],
      {
        ...f.ep.data.segments[0],
        id: 'dependent',
        shotIds: ['next'],
        incoming: incomingSchema.parse({
          mode: 'continue',
          awaiting: { episodeId: f.ep.id, segmentId: 'g' },
          decisions: [{ instanceId: 'device', key: 'powered', decision: 'inherit' }],
        }),
      },
    ],
  });
  f.store.setSetting('comfy', f.cloud);
  const batches = new BatchService(f.store),
    batch = batches.save({
      name: 'Mixed',
      items: ['g', 'dependent'].map((id) => ({
        ...f.req,
        id,
        episodeRevision: ep.revision,
        segmentId: id,
      })),
    });
  const preview = batches.preview(batch.id);
  assert.equal(preview.count, 1);
  assert.match(preview.excluded[0].reason, /等待上游/);
  assert.equal(f.store.jobs().length, 0);
  const confirmed = batches.confirm(batch.id, batch.revision, preview.digest, crypto.randomUUID());
  assert.equal(confirmed.items.length, 1);
  assert.throws(() => batches.save(batch.draft, batch.id, batch.revision), /新建/);
  assert.equal(f.store.jobs().length, 1);
});
test('loss of confirmed empty relationships is a relevant boundary change', () => {
  const before = { end: { facts: [], relations: [], relationObjectIds: ['device'] } },
    after = { end: { facts: [], relations: [], relationObjectIds: [] } };
  assert.deepEqual(boundaryChanges(before, after).end.objects, ['device']);
});
test('Base V3 requires reviewed frame duties and compares declared state at the correct boundary', async (t) => {
  const f = await fixture(t),
    input = structuredClone(f.prepared.input),
    image = {
      id: 'first',
      revision: 1,
      data: { width: 1024, height: 576, mediaType: 'image', adopted: true, sha256: 'fixture' },
    };
  input.segment.mode = 'i2v';
  input.segment.references = [{ assetId: image.id, revision: 1, role: 'first_frame' }];
  input.assets = [{ reference: input.segment.references[0], asset: image }];
  assert.throws(() => prepareModularH3(input), /明确用途/);
  input.segment.references[0].usage = {
    purpose: 'action_start',
    shotIds: [],
    preserve: [],
    allow: [],
    reviewed: true,
    depictedState: [fact(true)],
  };
  assert.ok(prepareModularH3(input).referenceChecks!.length);
  input.segment.references[0].usage.depictedState = [fact(false)];
  input.prepared = prepareModularH3(input);
  const graph = compileH3(input, new Map([['first:1', 'first.png']]), 'offline');
  assert.ok(Object.values(graph).some((n: any) => n.class_type === 'LoadImage'));
  assert.equal(input.prepared.trace.filter((t: any) => t.status === 'model_input').length, 1);
});

test('changed adopted facts invalidate their transitive consumers and hold queued descendants only', async (t) => {
  const f = await candidate(t);
  let source = f.domain.select(f.project.id, f.select);
  // Seed a prior accepted boundary for this dependency lifecycle fixture.
  const previous = structuredClone(source.data);
  previous.boundary.end.facts[0].value = false;
  source = f.store.update(source.id, source.revision, previous);
  const dependent = (id: string, upstream?: any) => {
    const input = structuredClone(f.job.input);
    input.segment.id = id;
    input.segment.incoming = incomingSchema.parse(
      upstream
        ? {
            mode: 'continue',
            selection: ref(upstream),
            decisions: [{ instanceId: 'device', key: 'powered', decision: 'inherit' }],
          }
        : { mode: 'independent' },
    );
    input.dependencies = upstream ? [ref(upstream)] : [];
    const job = f.store.createJob('generation', f.project.id, f.ep.id, input, id);
    f.store.patchJob(job.id, { state: 'succeeded' });
    return f.store.create(
      'segment_selection',
      f.project.id,
      { ...previous, segmentId: id, jobId: job.id },
      f.ep.id,
    );
  };
  const second = dependent('second', source),
    third = dependent('third', second),
    independent = dependent('independent');
  const queued = f.store.createJob(
    'generation',
    f.project.id,
    f.ep.id,
    {
      ...f.job.input,
      dependencies: [ref(third)],
      segment: {
        ...f.job.input.segment,
        incoming: incomingSchema.parse({
          mode: 'continue',
          selection: ref(third),
          decisions: [{ instanceId: 'device', key: 'powered', decision: 'inherit' }],
        }),
      },
    },
    'queued-descendant',
  );
  f.domain.select(f.project.id, f.select, source.revision);
  assert.equal(f.store.get(second.id).data.stale, true);
  assert.equal(f.store.get(third.id).data.stale, true);
  assert.equal(f.store.job(third.data.jobId).output.basisCorrected, true);
  assert.equal(f.store.job(independent.data.jobId).output.basisCorrected, undefined);
  assert.equal(f.store.get(independent.id).data.stale, false);
  assert.equal(f.store.get(third.id, third.revision).data.stale, false);
  const corrections = f.store.db
    .prepare("SELECT data FROM events WHERE kind='domain_correction'")
    .all()
    .map((r: any) => JSON.parse(r.data));
  assert.ok(corrections.some((c: any) => correctionAffectsInput(queued.input, c)));
});

test('same-shot information ordering requires explicit V2 reveal event dependencies', async (t) => {
  const f = await fixture(t),
    shot = structuredClone(f.shot);
  shot.directing.information = [
    { informationId: 'setup', eventId: 'connect', purpose: 'reveal' },
    { informationId: 'payoff', eventId: 'start', purpose: 'reveal' },
  ];
  const dramaturgy = dramaturgySchema.parse({
    version: 1,
    targetFrames: 120,
    theme: 'Explanation',
    scenes: [
      {
        id: 'scene',
        title: 'Demo',
        targetFrames: 120,
        goal: 'Explain',
        obstacle: 'Unknown connection',
        action: 'Connect',
        outcome: 'Understand',
        shotIds: ['s'],
      },
    ],
    rules: [],
    plannedCanon: [],
    information: [
      { id: 'setup', kind: 'audience_knowledge', statement: 'Connected', shotIds: ['s'] },
      {
        id: 'payoff',
        kind: 'audience_knowledge',
        statement: 'Powered',
        shotIds: ['s'],
        afterIds: ['setup'],
      },
    ],
  });
  assert.deepEqual(dramaturgyIssues({ shots: [shot], dramaturgy }), []);
  shot.directing.events[1].afterIds = [];
  assert.match(dramaturgyIssues({ shots: [shot], dramaturgy }).join(' '), /先行揭示/);
  shot.directing.version = 1;
  assert.match(dramaturgyIssues({ shots: [shot], dramaturgy }).join(' '), /先行揭示/);
});

test('repeated repair preserves untouched media and rejects ambiguous source coordinates', () => {
  const source: any = {
    id: 'selection',
    revision: 2,
    data: {
      in: 0,
      out: 5,
      composition: {
        parts: [
          {
            video: { id: 'old', revision: 1 },
            review: { id: 'r', revision: 1 },
            in: 2,
            out: 3,
            volume: 1,
          },
          {
            video: { id: 'new', revision: 1 },
            review: { id: 'r2', revision: 1 },
            in: 0,
            out: 5,
            volume: 1,
          },
          {
            video: { id: 'old', revision: 1 },
            review: { id: 'r', revision: 1 },
            in: 4,
            out: 7,
            volume: 1,
          },
        ],
      },
      boundary: {
        start: { frame: 48, facts: [fact(false)], source: { video: { id: 'old', revision: 1 } } },
        end: { frame: 167, facts: [fact(true)], source: { video: { id: 'old', revision: 1 } } },
      },
    },
  };
  const repair = {
    sourceSelection: ref(source),
    issueSpace: 'selected_timeline',
    issueRange: { startFrame: 12, endFrame: 156 },
  };
  assert.throws(
    () => repairWindow(source.data, { ...repair, issueSpace: 'source_frames' }),
    /采用时间线/,
  );
  const candidate = {
    video: { id: 'latest', revision: 1 },
    review: { id: 'r3', revision: 1 },
    in: 1,
    out: 3,
    volume: 1,
  };
  const boundary = {
    source: { video: candidate.video, review: candidate.review },
    start: { frame: 24, facts: [] },
    end: { frame: 71, facts: [] },
  };
  const result = spliceSelection(source, repair, candidate, boundary);
  assert.deepEqual(
    result.composition.parts.map((p: any) => [p.video.id, p.in, p.out]),
    [
      ['old', 2, 2.5],
      ['latest', 1, 3],
      ['old', 4.5, 7],
    ],
  );
  assert.equal(result.composition.totalFrames, 120);
  assert.equal(result.boundary.end.source.video.id, 'old');
});

test('plan corrections and Worker readiness affect the changed V3 segment only', async (t) => {
  const f = await fixture(t),
    input = structuredClone(f.prepared.input);
  input.segment.id = 'independent';
  const kept = f.store.createJob('generation', f.project.id, f.ep.id, input, 'kept');
  const changed = f.store.createJob(
    'generation',
    f.project.id,
    f.ep.id,
    f.prepared.input,
    'changed',
  );
  f.store.event(null, 'domain_correction', { source: f.ep.id, segmentIds: ['g'], affected: [] });
  const executed: string[] = [];
  const worker = new Worker(f.store, f.root, () => {
    throw new Error('No remote calls');
  });
  (worker as any).execute = async (job: any) => {
    executed.push(job.id);
  };
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.job(changed.id).holdReason, 'dependencies_need_review');
  assert.equal(f.store.job(kept.id).holdReason, null);
  assert.deepEqual(executed, [kept.id]);
});

test('animals and damaged product variants use typed instance state without human pose fields', async (t) => {
  const f = await fixture(t);
  const entity = f.domain.save(
    f.project.id,
    'entity',
    {
      ...f.entity.data,
      type: 'character',
      subtype: 'animal',
      attributes: [
        {
          key: 'condition',
          label: 'Condition',
          type: 'enum',
          values: ['intact', 'damaged', 'repaired'],
        },
      ],
    },
    f.entity.id,
    f.entity.revision,
  );
  const shot = structuredClone(f.shot);
  shot.state.instances[0].entity = ref(entity);
  shot.state.attributes = {
    start: [fact('intact', 'device', 'condition')],
    end: [fact('damaged', 'device', 'condition')],
  };
  shot.directing.events = [
    event('change', 0, 120, { changes: [fact('damaged', 'device', 'condition')] }),
  ];
  assert.deepEqual(validateShotSemantics(shot, [entity]), []);
  assert.deepEqual(f.domain.shotChecks(f.project.id, [shot]), []);
  const brief = {
    ...f.prepared.input.creativeBrief,
    artEntries: [
      {
        id: 'base',
        target: { kind: 'instance', id: 'device' },
        aspect: 'identity',
        text: 'Stable identity',
        stable: true,
        scope: { shotIds: [] },
        when: [],
      },
      {
        id: 'future',
        target: { kind: 'instance', id: 'device' },
        aspect: 'appearance',
        text: 'Repaired appearance',
        stable: true,
        scope: { shotIds: [] },
        when: [{ instanceId: 'device', key: 'condition', value: 'repaired' }],
      },
    ],
  };
  const projection = projectShotBrief(brief, shot);
  assert.deepEqual(
    projection.entries.map((e: any) => e.id),
    ['base'],
  );
});

test('Worker permits explicitly frozen repair source when only its plan changed', async (t) => {
  const f = await candidate(t),
    original = f.domain.select(f.project.id, f.select);
  const segment = {
    ...f.ep.data.segments[0],
    repair: {
      sourceSelection: ref(original),
      issueSpace: 'source_frames',
      issueRange: { startFrame: 0, endFrame: 120 },
      generationRange: { startFrame: 0, endFrame: 120 },
      adoptRange: { startFrame: 0, endFrame: 120 },
      goal: 'Repair visible action.',
      preserve: [],
      desiredEnd: [fact(true)],
      checkBefore: false,
      checkAfter: false,
    },
  };
  let ep = f.service.saveEpisode(f.ep.id, f.ep.revision, { ...f.ep.data, segments: [segment] });
  ep = f.service.approveEpisode(ep.id, ep.revision);
  const input = f.service.prepareGeneration(
    { ...f.req, episodeRevision: ep.revision },
    f.cloud,
  ).input;
  const job = f.store.createJob('generation', f.project.id, ep.id, input, 'repair-queued');
  const executed: string[] = [];
  const worker = new Worker(f.store, f.root, () => {
    throw new Error('No remote calls');
  });
  (worker as any).execute = async (j: any) => {
    executed.push(j.id);
  };
  t.after(() => worker.stop());
  await worker.tick();
  assert.equal(f.store.job(job.id).holdReason, null);
  assert.deepEqual(executed, [job.id]);
  f.domain.impact(original.id, true, 'Original adopted evidence is incorrect');
  await worker.tick();
  assert.equal(f.store.job(job.id).holdReason, 'dependencies_need_review');
});
