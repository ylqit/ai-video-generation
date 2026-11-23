import test from 'node:test';
import assert from 'node:assert/strict';
import { spatialFixture } from './fixtures/spatial-authoring.js';
import { validateStaging } from '../src/shared/authoring-staging.js';
import { authoringSchemas } from '../src/shared/creation.js';
import { codexOutputJsonSchema, decodeCodexOutput } from '../src/server/codex-output.js';
import {
  authoringPrevis,
  resolveStaging,
  projectShotStaging,
} from '../src/shared/staging-projection.js';
import { spatialAssessment } from '../src/shared/spatial.js';
import { sampleShot, spatialAnchor } from '../src/shared/spatial.js';
import { referenceCoverage, referenceCoverageBasis } from '../src/shared/reference-coverage.js';
import { sceneDesignDependencies } from '../src/shared/staging-projection.js';
import { soundRequirements, auditShotSemantics } from '../src/shared/shot-semantics.js';
import { validateObservedReview, validateIssueTarget } from '../src/server/review-evidence.js';

test('V9 r2 preserves operating faces, gaze and occluded speaking without frontal restrictions', () => {
  const { director, script } = spatialFixture();
  assert.deepEqual(validateStaging(director, script), []);
  const roundtrip = authoringSchemas.director.parse(JSON.parse(JSON.stringify(director)));
  assert.deepEqual(roundtrip, director);
  const old: any = structuredClone(director);
  delete old.contractRevision;
  delete old.sceneDesigns;
  assert.equal(authoringSchemas.director.parse(old).contractRevision, undefined);
});

test('dangling anchors, impossible references, windows and duplicate spatial identities are rejected', () => {
  const { director, script } = spatialFixture();
  director.shots[0].interactions![0].anchorId = 'missing';
  director.shots[0].performances[0].attention!.subjectKey = 'missing';
  director.shots[0].dialogue[0].mouth!.window = { startFrame: 100, endFrame: 130 };
  director.sceneDesigns![0].cameras.push(director.sceneDesigns![0].cameras[0]);
  const codes = validateStaging(director, script).map((i) => i.code);
  for (const code of [
    'interaction_anchor',
    'attention_subject',
    'mouth_window',
    'staging_duplicate',
  ])
    assert.ok(codes.includes(code));
});

test('real interactions require staging; an explicitly nonspatial product can use a centered shot', () => {
  const { director, script } = spatialFixture();
  director.sceneDesigns![0].applicability = 'not_applicable';
  director.shots[0].staging = null;
  assert.ok(validateStaging(director, script).some((i) => i.code === 'staging_required'));
  director.shots[0].interactions = [];
  director.shots[0].camera.composition = 'Centered product';
  assert.deepEqual(validateStaging(director, script), []);
});

test('wire schema makes nested optional properties explicit without fabricating geometry', () => {
  const check = (node: any) => {
    if (!node || typeof node !== 'object') return;
    assert.equal(node.oneOf, undefined);
    if (node.properties) {
      assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
      assert.equal(node.additionalProperties, false);
      Object.values(node.properties).forEach(check);
    }
    (node.anyOf || []).forEach(check);
    if (node.items) check(node.items);
  };
  for (const stage of [
    'brief',
    'script',
    'direction',
    'director',
    'assets',
    'editorial',
  ] as const) {
    const schema = codexOutputJsonSchema(stage);
    check(schema);
    assert.equal(schema.properties.contractRevision.const, 2);
  }
  const { director } = spatialFixture();
  const data: any = structuredClone(director);
  data.shots[0].staging.entry[0].position = null;
  assert.equal(
    (decodeCodexOutput('director', data) as any).shots[0].staging.entry[0].position,
    null,
  );
});

test('generic operating geometry separates unknown data, schematic plans and measured risks', () => {
  const { director } = spatialFixture();
  const basis = { id: 'director-result', revision: 1 };
  let spec = authoringPrevis(director, 'shot', basis);
  assert.equal(spatialAssessment(spec).status, 'incomplete');
  assert.ok(spatialAssessment(spec).missing.some((v) => v.includes('listener')));
  assert.equal(
    spatialAssessment(spec).issues.some((i) => i.code.startsWith('interaction-side')),
    false,
  );
  director.shots[0].staging!.entry[0].position = { x: 0.5, y: 0.1 };
  spec = authoringPrevis(director, 'shot', basis);
  assert.ok(spatialAssessment(spec).issues.some((i) => i.code.startsWith('interaction-side')));
  assert.ok(spatialAssessment(spec).issues.some((i) => i.code.startsWith('interaction-reach')));
  director.shots[0].staging!.entry[0].position = null;
  assert.equal(spatialAssessment(authoringPrevis(director, 'shot', basis)).status, 'incomplete');
  director.sceneDesigns![0].scale = 'schematic';
  assert.equal(spatialAssessment(authoringPrevis(director, 'shot', basis)).status, 'schematic');
});

test('spatial inheritance preserves unknowns and reports unexplained continuous discontinuities', () => {
  const { director, script } = spatialFixture();
  const next = structuredClone(director.shots[0]);
  next.id = 'next';
  next.staging!.entry = [];
  next.staging!.exit = [];
  director.shots.push(next);
  director.groups[0].shotIds.push(next.id);
  director.shots[0].staging!.exit = [
    { subjectKey: 'operator', position: { x: 0.4, y: 0.7 }, heading: null },
  ];
  assert.deepEqual(
    resolveStaging(director)
      .get('next')!
      .entry.find((p) => p.subjectKey === 'operator'),
    director.shots[0].staging!.exit[0],
  );
  next.staging!.entry = [{ subjectKey: 'operator', position: { x: 0.8, y: 0.8 }, heading: 0 }];
  assert.ok(validateStaging(director, script).some((i) => i.code === 'staging_continuity'));
  director.groups = [
    { ...director.groups[0], shotIds: ['shot'] },
    { id: 'later', shotIds: ['next'], transition: 'ellipsis', reason: 'Later.' },
  ];
  assert.equal(
    validateStaging(director, script).some((i) => i.code === 'staging_continuity'),
    false,
  );
});

test('authoring and production projections preserve operating anchors and independent head/gaze', () => {
  const { director } = spatialFixture();
  director.shots[0].performances[0].headHeading = 90;
  const projection = projectShotStaging(director, director.shots[0], (k) => `instance:${k}`);
  assert.equal(projection.directing.staging.anchors[0].instanceId, 'instance:device');
  assert.equal(projection.directing.interactions[0].eventId, 'shot:operate:whole');
  assert.deepEqual(projection.directing.performance[0].attention, {
    instanceId: 'instance:device',
    anchor: 'Watch the operating surface.',
    anchorId: 'control',
  });
  assert.equal(projection.directing.performance[0].headHeading, 90);
  assert.equal(director.shots[0].staging!.entry[0].heading, 0);
});

test('previsualization and execution share the same interaction event window', () => {
  const { director } = spatialFixture();
  director.shots[0].cues = [
    {
      id: 'touch',
      target: { kind: 'event', eventId: 'operate' },
      window: { startFrame: 30, endFrame: 80 },
      afterIds: [],
    },
  ];
  const projected = projectShotStaging(director, director.shots[0], (key) => key);
  const preview = authoringPrevis(director, 'shot', { id: 'author', revision: 1 });
  assert.ok(preview.directing);
  assert.equal(preview.directing.events[0].startFrame, projected.directing.events[0].startFrame);
  assert.equal(preview.directing.events[0].endFrame, projected.directing.events[0].endFrame);
  assert.deepEqual(
    authoringPrevis(director, 'shot', {
      id: 'author',
      revision: 1,
      data: { status: 'adopted' },
      parentId: 'run',
    } as any),
    preview,
  );
  assert.equal(projected.directing.events[0].startFrame, 30);
  assert.equal(projected.directing.events[0].endFrame, 80);
  assert.equal(projected.directing.events[0].id, projected.directing.interactions[0].eventId);
});

test('a first-frame identity image is not interaction coverage; explicit inspected coverage has a changing design basis', () => {
  const { director } = spatialFixture();
  const item: any = {
    id: 'image',
    mediaType: 'image',
    purpose: 'composition',
    shotIds: ['shot'],
    coverage: [
      { shotId: 'shot', interactionIds: ['use'], aspects: ['interaction', 'composition'] },
    ],
  };
  assert.equal(
    referenceCoverage(director, [item], {
      image: { inspected: true, groupStart: { shotId: 'shot' } },
    })[0].status,
    'awaiting_reference_review',
  );
  const bindings = {
    image: { inspected: true, coverage: item.coverage, asset: { id: 'real-image', revision: 2 } },
  };
  assert.equal(referenceCoverage(director, [item], bindings)[0].status, 'inspected_reference');
  const original = structuredClone(referenceCoverageBasis(director, item.coverage));
  director.sceneDesigns![0].anchors[0].normalHeading = 0;
  assert.notDeepEqual(referenceCoverageBasis(director, item.coverage), original);
  const other = { ...structuredClone(director.sceneDesigns![0].cameras[0]), id: 'unused' };
  director.sceneDesigns![0].cameras.push(other);
  const selected = structuredClone(
    sceneDesignDependencies(director.sceneDesigns![0], director.shots),
  );
  other.heading = 240;
  assert.deepEqual(sceneDesignDependencies(director.sceneDesigns![0], director.shots), selected);
});

test('planned occlusion cannot waive actual mouth review and each visible source interval needs lip sync', () => {
  const d: any = {
    version: 2,
    contractRevision: 2,
    events: [],
    sound: {
      dialogue: [
        {
          id: 'line-id',
          instanceId: 'speaker',
          text: 'Ready?',
          delivery: 'onscreen',
          mouth: { visibility: 'occluded', window: null },
        },
      ],
    },
  };
  const requirement = soundRequirements(d)[0];
  assert.equal(requirement.id, 'dialogue:line-id');
  const spec = { shotId: 'shot', frames: 120, directing: d };
  const review: any = {
    audioEvidence: [
      {
        shotId: 'shot',
        requirementId: requirement.id,
        speakerId: 'speaker',
        text: 'Ready?',
        status: 'pass',
        inspection: 'audio',
        startFrame: 0,
        endFrame: 120,
      },
    ],
  };
  assert.ok(auditShotSemantics(spec, review, { in: 0, out: 5 }).some((e) => e.includes('可见性')));
  Object.assign(review.audioEvidence[0], {
    mouthInspected: true,
    mouthObserved: 'occluded',
    mouthWindows: [],
  });
  assert.deepEqual(auditShotSemantics(spec, review, { in: 0, out: 5 }), []);
  Object.assign(review.audioEvidence[0], {
    mouthObserved: 'visible',
    mouthWindows: [{ startFrame: 30, endFrame: 50, lipSyncReviewed: false }],
  });
  assert.ok(auditShotSemantics(spec, review, { in: 0, out: 5 }).some((e) => e.includes('口型')));
  review.audioEvidence[0].mouthWindows[0].lipSyncReviewed = true;
  assert.deepEqual(auditShotSemantics(spec, review, { in: 0, out: 5 }), []);
});

test('interaction evidence is bound to frozen identities and adopted source intervals', () => {
  const spec: any = {
    version: 2,
    shotId: 'shot',
    frames: 120,
    directing: {
      version: 2,
      contractRevision: 2,
      events: [],
      sound: { dialogue: [] },
      interactions: [{ id: 'transfer', required: true }],
    },
  };
  const evidence = {
    shotId: 'shot',
    interactionId: 'transfer',
    inspection: 'motion',
    status: 'pass',
    startFrame: 10,
    endFrame: 40,
    notes: 'The receiver supports the object after release.',
  };
  assert.ok(auditShotSemantics(spec, {}, { in: 0, out: 5 }).some((e) => e.includes('transfer')));
  assert.deepEqual(
    auditShotSemantics(spec, { interactionEvidence: [evidence] }, { in: 0, out: 5 }),
    [],
  );
  assert.ok(
    auditShotSemantics(spec, { interactionEvidence: [evidence] }, { in: 1, out: 5 }).length,
  );
  assert.throws(
    () =>
      validateObservedReview(
        { input: { prepared: { shotSpecs: [spec] } } },
        { data: { frameCount: 120 } },
        { in: 0, out: 5, interactionEvidence: [{ ...evidence, interactionId: 'invented' }] },
      ),
    /冻结/,
  );
});

test('three-way attention and nonhuman effectors keep authored camera and local operating surfaces', () => {
  const { director, script } = spatialFixture();
  const third = { ...structuredClone(script.subjects[0]), key: 'third', name: 'Third' };
  script.subjects.push(third);
  director.shots[0].visibleSubjectKeys.push('third');
  director.shots[0].performances.push({
    ...structuredClone(director.shots[0].performances[0]),
    id: 'third-attention',
    subjectKey: 'third',
    attention: {
      subjectKey: 'operator',
      point: null,
      anchorId: null,
      description: 'Observe the operator rather than the camera.',
    },
  });
  director.shots[0].interactions![0].effector = 'mechanical gripper';
  assert.deepEqual(validateStaging(director, script), []);
  director.shots[0].staging!.entry.find((p) => p.subjectKey === 'device')!.heading = 90;
  const spec = authoringPrevis(director, 'shot', { id: 'author', revision: 1 });
  const anchor = spatialAnchor(spec, sampleShot(spec, 0), 'control')!;
  assert.equal(anchor.normalHeading, 270);
  assert.equal(anchor.position.x, 2.7);
  assert.equal(anchor.position.z, 3);
  assert.equal(spec.directing!.camera.description, 'side; Make the contact readable.');
  assert.equal((spec.directing as any).interactions[0].effector, 'mechanical gripper');
});

test('media issue links resolve only against the fixed shot contract', () => {
  const specs = [
    {
      shotId: 's',
      directing: {
        interactions: [{ id: 'use' }],
        events: [{ id: 'press' }],
        sound: { dialogue: [{ id: 'line' }] },
      },
    },
  ];
  assert.doesNotThrow(() =>
    validateIssueTarget(specs, {
      shotId: 's',
      interactionId: 'use',
      eventId: 'press',
      lineId: 'line',
    }),
  );
  assert.throws(
    () => validateIssueTarget(specs, { shotId: 's', interactionId: 'invented' }),
    /冻结/,
  );
  assert.throws(() => validateIssueTarget(specs, { shotId: 'other', lineId: 'line' }), /冻结/);
});

test('door state and path endpoints carry into later shots and invalidate their reference basis', () => {
  const { director, script } = spatialFixture();
  director.sceneDesigns![0].barriers.push({
    id: 'door',
    name: 'Passage',
    kind: 'door',
    start: { x: 0.1, y: 0.4 },
    end: { x: 0.9, y: 0.4 },
    height: 2,
    thickness: 0.1,
    open: false,
    regions: [],
  });
  const first = director.shots[0];
  first.staging!.doors = [{ barrierId: 'door', frame: 30, open: true }];
  first.staging!.paths = [
    {
      subjectKey: 'operator',
      keys: [
        { frame: 0, position: { x: 0.5, y: 0.65 }, heading: 0 },
        { frame: 119, position: { x: 0.5, y: 0.25 }, heading: 0 },
      ],
    },
  ];
  const next = structuredClone(first);
  next.id = 'next';
  next.staging!.entry = [];
  next.staging!.exit = [];
  next.staging!.paths = [];
  next.staging!.doors = [];
  director.shots.push(next);
  director.groups[0].shotIds.push('next');
  assert.deepEqual(validateStaging(director, script), []);
  const spec = authoringPrevis(director, 'next', { id: 'author', revision: 1 });
  assert.equal(sampleShot(spec, 0).barriers[0].open, true);
  assert.deepEqual(
    sampleShot(spec, 0).instances.find((p: any) => p.instanceId === 'operator').pose.position,
    { x: 0.5, y: 0.25 },
  );
  const coverage: any = [
    { shotId: 'next', interactionIds: ['use'], aspects: ['space', 'interaction'] },
  ];
  const before = structuredClone(referenceCoverageBasis(director, coverage));
  first.staging!.doors[0].open = false;
  assert.notDeepEqual(referenceCoverageBasis(director, coverage), before);
  first.staging!.doors[0].open = true;
  next.staging!.doors = [{ barrierId: 'door', frame: 12, open: false }];
  const closing = authoringPrevis(director, 'next', { id: 'author', revision: 1 });
  assert.equal(sampleShot(closing, 11).barriers[0].open, true);
  assert.equal(sampleShot(closing, 12).barriers[0].open, false);
  first.staging!.exit = [{ subjectKey: 'operator', position: { x: 0.9, y: 0.9 }, heading: 0 }];
  assert.ok(validateStaging(director, script).some((i) => i.code === 'staging_path_state'));
});
