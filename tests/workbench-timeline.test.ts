import test from 'node:test';
import assert from 'node:assert/strict';
import { reactive } from 'vue';
import { editTimeline } from '../src/shared/timeline-editing.js';
import { timelineMap, edlSchema, type EditDecisionList } from '../src/shared/edit-timeline.js';
const media = [
  { id: 'v', revision: 1, data: { mediaType: 'video', duration: 10 } },
  {
    id: 'a',
    revision: 1,
    data: { mediaType: 'audio', duration: 5, streams: [{ type: 'audio', sampleRate: 48000 }] },
  },
];
const base = (): EditDecisionList => ({
  schemaVersion: 3,
  episodeId: '',
  fps: 24,
  width: 640,
  height: 360,
  clips: [
    { id: 'one', assetId: 'v', revision: 1, in: 0, out: 4, volume: 0 },
    { id: 'two', assetId: 'v', revision: 1, in: 4, out: 8, volume: 0 },
  ],
  audio: [{ assetId: 'a', revision: 1, in: 0, out: 3, start: 1, volume: 1 }],
  overlays: [
    {
      id: 's',
      text: '说明',
      startFrame: 48,
      endFrame: 72,
      position: 'bottom',
      fontSize: 36,
      color: '#ffffff',
      sourceDialogueId: null,
    },
  ],
});
test('EDIT-001 one-frame trim, split, reorder and dissolve share frame mapping without rippling other tracks', () => {
  const original = base(),
    trimmed = editTimeline(
      reactive(original),
      { action: 'trim', track: 'clips', index: 0, boundary: 'out', seconds: 95 / 24 },
      media,
    ).edl;
  assert.equal(timelineMap(trimmed).frames, 191);
  assert.equal(original.clips[0].out, 4);
  assert.deepEqual(trimmed.audio, original.audio);
  assert.deepEqual(trimmed.overlays, original.overlays);
  const split = editTimeline(
    trimmed,
    { action: 'split', index: 0, frame: 24, newId: 'split' },
    media,
  ).edl;
  assert.equal(split.clips.length, 3);
  assert.equal(split.clips[1].in, 1);
  assert.equal(timelineMap(split).frames, 191);
  edlSchema.parse(split);
  const dissolve = editTimeline(split, { action: 'transition', index: 2, frames: 12 }, media).edl;
  assert.equal(timelineMap(dissolve).frames, 179);
  const reordered = editTimeline(dissolve, { action: 'reorder', index: 2, to: 0 }, media);
  assert.equal(reordered.edl.clips[0].transition, undefined);
  assert.ok(reordered.notices.length);
  assert.equal(timelineMap(reordered.edl).frames, 191);
  assert.deepEqual(reordered.edl.audio, original.audio);
  edlSchema.parse(reordered.edl);
});
test('EDIT-002 source audio retains sample precision while explicit multiselection moves only chosen timeline items', () => {
  const a = editTimeline(
    base(),
    { action: 'trim', track: 'audio', index: 0, boundary: 'in', seconds: 1001 / 48000 },
    media,
  ).edl;
  assert.equal(a.audio[0].sampleRange?.inSample, 1001);
  assert.equal(a.audio[0].in, 1001 / 48000);
  const moved = editTimeline(
    a,
    { action: 'shift', audio: [0], subtitles: ['s'], deltaFrames: 13 },
    media,
  ).edl;
  assert.equal(moved.audio[0].start, 37 / 24);
  assert.equal(moved.overlays![0].startFrame, 61);
  assert.equal(moved.audio[0].in, 1001 / 48000);
  assert.deepEqual(moved.clips, a.clips);
  edlSchema.parse(moved);
  assert.throws(
    () => editTimeline(a, { action: 'shift', audio: [0], subtitles: [], deltaFrames: -25 }, media),
    /零点/,
  );
});
test('EDIT-003 invalid cuts, overlap and unknown samples never silently stretch or discard evidence', () => {
  const a = editTimeline(base(), { action: 'transition', index: 1, frames: 12 }, media).edl;
  assert.throws(
    () =>
      editTimeline(
        a,
        { action: 'trim', track: 'clips', index: 0, boundary: 'out', seconds: 0.25 },
        media,
      ),
    /耗尽/,
  );
  assert.throws(
    () => editTimeline(a, { action: 'split', index: 1, frame: 90, newId: 'bad' }, media),
    /叠化/,
  );
  assert.throws(
    () =>
      editTimeline(
        a,
        { action: 'trim', track: 'clips', index: 0, boundary: 'out', seconds: 10.5 },
        media,
      ),
    /源媒体/,
  );
  assert.throws(
    () =>
      editTimeline(
        a,
        { action: 'trim', track: 'clips', index: 0, boundary: 'out', seconds: 1.001 },
        media,
      ),
    /整帧/,
  );
  const b = base();
  b.overlays![0].startFrame = 170;
  b.overlays![0].endFrame = 190;
  const r = editTimeline(
    b,
    { action: 'trim', track: 'clips', index: 1, boundary: 'out', seconds: 7 },
    media,
  );
  assert.equal(r.edl.overlays![0].endFrame, 190);
  assert.match(r.notices.join(), /字幕/);
  assert.equal(edlSchema.safeParse(r.edl).success, false);
});
