import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './fixtures/workspace.js';
import { configureModel } from './fixtures/models.js';
import { ModelRegistry } from '../src/server/model-registry.js';
import { CreationMediaService } from '../src/server/creation-media.js';
import { prepareImageTask } from '../src/server/image-production.js';
import { ProductionAssistant } from '../src/server/production-assistant.js';
import { Worker } from '../src/server/worker.js';
import { storyCoverage } from '../src/server/story-coverage.js';
import { edlSchema, timelineDuration } from '../src/shared/contracts.js';
import { timelineMap, visualLayerAt, roleFrames } from '../src/shared/edit-timeline.js';
import { codexOutputJsonSchema } from '../src/server/codex-output.js';
import {
  presentationEvidence,
  validateCanonPresentation,
} from '../src/server/presentation-evidence.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('catalog distinguishes kinds/families/protocols; individual disable gates frozen queued models without rewriting history', (t) => {
  const f = fixture(t),
    { registry, connection, selection } = configureModel(f.store, f.project.id, 'responses');
  const fixed = registry.resolveSelection(selection),
    oldJobs = f.store.jobs().length;
  const data = structuredClone(connection.data);
  data.models.push({ ...data.models[0], id: 'other-model', enabled: true });
  data.models[0].enabled = false;
  const body = { revision: connection.revision, data, idempotencyKey: 'model-save-offline' };
  const next = registry.saveConnection(body, connection.id);
  assert.deepEqual(registry.saveConnection(body, connection.id), next);
  assert.throws(
    () => registry.saveConnection({ ...body, data: { ...data, name: 'other' } }, connection.id),
    /回执/,
  );
  assert.throws(() => registry.resolveSelection(selection), /停用|移除/);
  assert.equal(registry.catalog().models.find((m) => m.id === 'other-model')!.available, true);
  assert.equal(registry.catalog().models.find((m) => m.id === fixed.modelId)!.available, false);
  assert.deepEqual(registry.connection(connection.id, 1).data, connection.data);
  assert.equal(f.store.jobs().length, oldJobs);
  assert.deepEqual(
    new Set(registry.catalog().offers.map((o) => o.kind)),
    new Set(['text', 'image', 'video', 'speech']),
  );
});

test('image preparation consumes adopted requirement and fixed direction, keeps roles aligned, never generates or rewrites on preview', (t) => {
  const f = fixture(t, true);
  configureModel(f.store, f.project.id, 'openai-images');
  const task = new CreationMediaService(f.store, '').createAssetTask(f.run.id, {
    revision: f.store.get(f.run.id).revision,
    requirementId: 'outside',
    idempotencyKey: 'image-task-quality',
  }).task;
  const body: any = {
    taskRevision: task.revision,
    viewId: task.data.views[0].id,
    operation: 'generate',
    promptSource: 'task',
    references: [],
    referenceUses: [],
  };
  const before = f.store.jobs().length,
    first = prepareImageTask(f.store, task.id, body);
  assert.deepEqual(prepareImageTask(f.store, task.id, body), first);
  assert.ok(first.input.prepared.basis?.direction?.reference);
  assert.match(first.input.prepared.finalPrompt, /./);
  assert.equal(f.store.jobs().length, before);
  assert.throws(
    () =>
      prepareImageTask(f.store, task.id, {
        ...body,
        promptSource: 'reviewed_override',
        prompt: 'Changed.',
      }),
    /核对/,
  );
  const a = f.store.create('asset', f.project.id, {
    mediaType: 'image',
    adopted: true,
    path: 'not-uploaded.png',
    sha256: 'fixed',
  });
  for (const purpose of ['style', 'identity', 'action_start']) {
    const p = prepareImageTask(f.store, task.id, {
      ...body,
      operation: 'edit',
      references: [{ id: a.id, revision: 1 }],
      referenceUses: [
        {
          asset: { id: a.id, revision: 1 },
          purpose,
          preserve: ['blue surface'],
          allow: ['different background'],
        },
      ],
    });
    assert.equal(p.input.prepared.bindings[0].purpose, purpose);
    assert.match(p.input.prepared.finalPrompt, new RegExp('Image 1: ' + purpose));
    assert.match(
      p.input.prepared.finalPrompt,
      /Preserve: blue surface\. May change: different background/,
    );
    assert.equal(p.input.assets[0].asset.id, a.id);
  }
  const viewTask = f.store.update(task.id, task.revision, {
    ...task.data,
    views: task.data.views.map((v: any) => ({
      ...v,
      instruction: 'Show the side connector in close detail.',
    })),
  });
  const viewPreparation = prepareImageTask(f.store, task.id, {
    ...body,
    taskRevision: viewTask.revision,
  });
  assert.ok(viewPreparation.input.prepared.finalPrompt.includes(task.data.views[0].instruction));
  assert.match(
    viewPreparation.input.prepared.finalPrompt,
    /Show the side connector in close detail/,
  );
  assert.ok(
    viewPreparation.input.prepared.finalPrompt.includes('View: ' + task.data.views[0].view),
  );
  const override = prepareImageTask(f.store, task.id, {
    ...body,
    taskRevision: viewTask.revision,
    promptSource: 'reviewed_override',
    overrideReviewed: true,
    prompt: 'A reviewed replacement.',
  });
  assert.equal(override.input.prepared.finalPrompt, 'A reviewed replacement.');
  assert.equal(
    override.input.prepared.consumption.find((c: any) => c.field === 'direction.visual')?.mode,
    'planning_check',
  );
  const direction = f.store.get(task.data.directionResult.id);
  f.store.update(direction.id, direction.revision, { ...direction.data, stale: true });
  assert.throws(
    () => prepareImageTask(f.store, task.id, { ...body, taskRevision: viewTask.revision }),
    /方向已变化/,
  );
});

test('source-event coverage remains planned until fixed adopted evidence covers the event; trimming removes the claim', (t) => {
  const f = fixture(t),
    run = f.store.get(f.run.id);
  const results = Object.fromEntries(
    Object.entries(run.data.results).map(([k, r]: any) => [k, f.store.get(r.id, r.revision)]),
  );
  assert.equal(storyCoverage(f.store, run, results)[0].status, 'planned');
  const job = f.store.createJob(
    'generation',
    f.project.id,
    run.data.episodeId,
    {
      creationRunId: run.id,
      authoring: run.data.results,
      segment: { duration: 3 },
      profile: f.store.setting('comfy', null),
      offlineFixture: true,
    },
    'coverage-quality',
  );
  const video = f.store.create('asset', f.project.id, { mediaType: 'video' });
  const review = f.store.create(
    'generation_review',
    f.project.id,
    {
      jobId: job.id,
      video: { id: video.id, revision: 1 },
      eventEvidence: [
        {
          shotId: 'shot1',
          eventId: 'shot1:event1:whole',
          inspection: 'motion',
          status: 'pass',
          observed: 'occurred',
          startFrame: 24,
          endFrame: 48,
        },
      ],
    },
    run.data.episodeId,
  );
  const selection = f.store.create(
    'segment_selection',
    f.project.id,
    {
      creationRunId: run.id,
      video: { id: video.id, revision: 1 },
      review: { id: review.id, revision: 1 },
      in: 0,
      out: 3,
    },
    run.data.episodeId,
  );
  assert.equal(storyCoverage(f.store, run, results)[0].status, 'observed');
  f.store.update(selection.id, 1, { ...selection.data, out: 1.5 });
  assert.equal(storyCoverage(f.store, run, results)[0].status, 'planned');
});

test('EDL v3 overlap uses one source map, preserves audio coordinates and legacy v2, and rejects dangling/triple joins', () => {
  const old: any = {
    schemaVersion: 2,
    episodeId: 'e',
    width: 128,
    height: 128,
    fps: 24,
    clips: [
      { assetId: 'a', revision: 1, in: 0, out: 13, volume: 1 },
      { assetId: 'b', revision: 1, in: 0, out: 13, volume: 1 },
    ],
    audio: [{ assetId: 's', revision: 1, start: 11, in: 0, out: 3, volume: 1 }],
  };
  assert.deepEqual(edlSchema.parse(old), old);
  const edl = edlSchema.parse({
    ...old,
    schemaVersion: 3,
    clips: old.clips.map((c: any, i: number) => ({
      ...c,
      id: String(i),
      ...(i
        ? { transition: { kind: 'dissolve', fromClipId: '0', frames: 48 } }
        : { visualFadeInFrames: 24 }),
    })),
  });
  assert.equal(timelineMap(edl).frames, 576);
  assert.equal(timelineDuration(edl), 24);
  assert.equal(roleFrames(edl, 'story'), 576);
  assert.equal(visualLayerAt(timelineMap(edl).clips[1], 288).opacity, 0.5);
  assert.deepEqual(edl.audio, old.audio);
  assert.throws(() => edlSchema.parse({ ...edl, clips: [edl.clips[1], edl.clips[0]] }), /相邻/);
  assert.throws(
    () => edlSchema.parse({ ...edl, clips: [{ ...edl.clips[0], out: 1 }, edl.clips[1]] }),
    /叠化/,
  );
  for (const [episodes, minutes] of [
    [10, 5],
    [20, 20],
  ]) {
    const frames = Array.from(
      { length: episodes },
      (_, i) =>
        timelineMap({
          ...old,
          clips: [{ ...old.clips[0], out: minutes * 60, assetId: 'episode' + i }],
        }).frames,
    );
    assert.equal(
      frames.reduce((n, v) => n + v, 0),
      episodes * minutes * 60 * 24,
    );
  }
});

test('rendered Canon evidence must survive trim, dissolve, overlays and effective sound; original observations stay immutable', (t) => {
  const f = fixture(t),
    ref = (d: any) => ({ id: d.id, revision: d.revision });
  const video = f.store.create('asset', f.project.id, { mediaType: 'video' });
  const review = f.store.create('generation_review', f.project.id, {
    eventEvidence: [
      { id: 'connection', inspection: 'motion', startFrame: 48, endFrame: 72 },
      { id: 'start', inspection: 'motion', startFrame: 0, endFrame: 12 },
    ],
    audioEvidence: [{ id: 'line', inspection: 'audio', startFrame: 48, endFrame: 72 }],
  });
  const selection = f.store.create('segment_selection', f.project.id, {
    video: ref(video),
    review: ref(review),
    in: 0,
    out: 5,
  });
  const c = {
    id: 'a',
    assetId: video.id,
    revision: 1,
    in: 0,
    out: 5,
    volume: 1,
    selection: ref(selection),
  };
  const edl: any = {
    schemaVersion: 3,
    episodeId: f.run.data.episodeId,
    width: 128,
    height: 128,
    fps: 24,
    clips: [c],
    audio: [],
  };
  const canon = {
    facts: [{ source: { kind: 'media', selection: ref(selection), evidenceIds: ['connection'] } }],
  };
  validateCanonPresentation(f.store, edl, canon, []);
  const dissolve = {
    ...edl,
    clips: [
      c,
      {
        ...c,
        id: 'b',
        selection: undefined,
        transition: { kind: 'dissolve', fromClipId: 'a', frames: 60 },
      },
    ],
  };
  assert.throws(() => validateCanonPresentation(f.store, dissolve, canon, []), /实际导出/);
  const rendered = [
    { data: { presentedEvidence: [{ selection: ref(selection), evidenceId: 'connection' }] } },
  ];
  validateCanonPresentation(f.store, dissolve, canon, rendered);
  const trimmed = { ...edl, clips: [{ ...c, out: 2.5 }] };
  assert.throws(() => validateCanonPresentation(f.store, trimmed, canon, rendered), /采用区间/);
  const overlays = { ...edl, overlays: [{ startFrame: 48, endFrame: 60 }] };
  assert.throws(() => validateCanonPresentation(f.store, overlays, canon, []), /实际导出/);
  const sound = {
    ...edl,
    audio: [{ assetId: 'audio', revision: 1, start: 2, in: 0, out: 1, volume: 1 }],
  };
  assert.equal(
    presentationEvidence(f.store, sound).find((e) => e.evidenceId === 'line').affected,
    true,
  );
  assert.equal(
    presentationEvidence(f.store, { ...edl, clips: [{ ...c, fadeInFrames: 12 }] }).find(
      (e) => e.evidenceId === 'line',
    ).affected,
    false,
  );
  assert.deepEqual(f.store.get(review.id).data, review.data);
  const previous = f.store.create(
    'segment_selection',
    f.project.id,
    selection.data,
    'previous-episode',
  );
  validateCanonPresentation(
    f.store,
    edl,
    {
      facts: [{ source: { kind: 'media', selection: ref(previous), evidenceIds: ['connection'] } }],
    },
    [],
  );
  const boundary = f.store.update(selection.id, selection.revision, {
    ...selection.data,
    boundary: {
      end: {
        frame: 119,
        relations: [],
        actions: [],
        windows: [{ startFrame: 96, endFrame: 120, inspection: 'motion' }],
      },
    },
  });
  const withBoundary = {
    ...edl,
    clips: [{ ...c, selection: ref(boundary), visualFadeOutFrames: 24 }],
  };
  const related = { relationSources: [{ objectId: 'battery', selection: ref(boundary) }] };
  assert.throws(() => validateCanonPresentation(f.store, withBoundary, related, []), /实际导出/);
  const boundaryReview = [
    {
      data: {
        presentedEvidence: [{ selection: ref(boundary), evidenceId: 'selection_boundary:end' }],
      },
    },
  ];
  validateCanonPresentation(f.store, withBoundary, related, boundaryReview);
  assert.throws(
    () =>
      validateCanonPresentation(
        f.store,
        { ...withBoundary, clips: [{ ...withBoundary.clips[0], out: 4 }] },
        related,
        boundaryReview,
      ),
    /采用区间/,
  );
});
