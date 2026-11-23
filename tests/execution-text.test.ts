import test from 'node:test';
import assert from 'node:assert/strict';
import { executionTextFields, projectExecutionText } from '../src/shared/execution-text.js';

test('execution wording is an immutable language projection and cannot edit dialogue, state, timing or identities', () => {
  const source: any = {
    script: {
      stage: 'script',
      subjects: [{ key: 'actor', name: '人物', description: '成年女钟表匠' }],
      scenes: [
        {
          id: 'room',
          events: [{ id: 'open', description: '她打开店门' }],
          dialogue: [
            { id: 'line', text: 'はい。明日、お店を開けます。', translation: '明天开门。' },
          ],
        },
      ],
    },
    director: {
      stage: 'director',
      shots: [
        {
          id: 's1',
          frames: 144,
          visibleSubjectKeys: ['actor'],
          dialogue: [{ lineId: 'line', delivery: 'offscreen' }],
          action: '她打开店门',
          performances: [],
          camera: {},
          entryState: [{ subjectKey: 'door', key: 'open', value: false }],
          exitState: [{ subjectKey: 'door', key: 'open', value: true }],
          entryRelations: [],
          exitRelations: [],
          cues: [],
        },
      ],
    },
  };
  const baseline = structuredClone(source);
  const entry = {
    path: '/script/subjects/0/description',
    source: '成年女钟表匠',
    text: 'An adult woman clockmaker.',
  };
  const projected: any = projectExecutionText(source, { reviewed: true, entries: [entry] });
  assert.equal(projected.script.subjects[0].description, entry.text);
  assert.deepEqual(source, baseline);
  assert.deepEqual(projected.script.scenes, baseline.script.scenes);
  assert.deepEqual(projected.director, baseline.director);
  assert.ok(
    executionTextFields(source).some((f) => f.path === '/script/scenes/0/events/0/description'),
  );
  for (const path of [
    '/script/scenes/0/dialogue/0/text',
    '/director/shots/0/frames',
    '/director/shots/0/visibleSubjectKeys',
    '/director/shots/0/entryState/0/value',
    '/__proto__/polluted',
  ])
    assert.throws(
      () => projectExecutionText(source, { reviewed: true, entries: [{ ...entry, path }] }),
      /不存在/,
    );
  assert.throws(
    () => projectExecutionText(source, { reviewed: true, entries: [entry, entry] }),
    /重复/,
  );
  assert.throws(
    () =>
      projectExecutionText(source, { reviewed: true, entries: [{ ...entry, source: '旧原文' }] }),
    /已变化/,
  );
  assert.throws(
    () =>
      projectExecutionText(source, { reviewed: true, entries: [{ ...entry, text: '尚未翻译' }] }),
    /英文/,
  );
  assert.throws(() => projectExecutionText(source, { reviewed: false, entries: [entry] } as any));
});
