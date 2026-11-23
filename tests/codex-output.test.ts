import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import {
  codexOutputSchemas,
  codexOutputJsonSchema,
  decodeCodexOutput,
} from '../src/server/codex-output.js';
import { authoringSchemas, shotCueSchema } from '../src/shared/creation.js';

test('every provider output object requires all declared properties', () => {
  function check(schema: any, location: string) {
    if (!schema || typeof schema !== 'object') return;
    for (const unsupported of [
      'oneOf',
      'allOf',
      'not',
      'if',
      'then',
      'else',
      'dependentRequired',
      'dependentSchemas',
      'patternProperties',
    ])
      assert.equal(Object.hasOwn(schema, unsupported), false, `${location}.${unsupported}`);
    if (schema.type === 'object') {
      assert.deepEqual(
        [...(schema.required ?? [])].sort(),
        Object.keys(schema.properties ?? {}).sort(),
        location,
      );
      assert.equal(schema.additionalProperties, false, location);
    }
    for (const [key, child] of Object.entries(schema)) {
      if (child && typeof child === 'object') check(child, `${location}.${key}`);
    }
  }
  for (const stage of Object.keys(codexOutputSchemas) as (keyof typeof codexOutputSchemas)[])
    check(codexOutputJsonSchema(stage), stage);
});

test('provider cue union preserves the exact discriminated target variants', () => {
  const wire = codexOutputSchemas.director.shape.shots.element.shape.cues.element;
  const examples = [
    { kind: 'event', eventId: 'S05' },
    { kind: 'dialogue', lineId: 'D11' },
    { kind: 'performance', performanceId: 'P10' },
    { kind: 'dialogue', eventId: 'S05' },
    { kind: 'event', eventId: 'S05', lineId: 'D11' },
    { eventId: 'S05' },
  ];
  for (const target of examples) {
    const value = { id: 'cue', target, window: null, afterIds: [] };
    assert.equal(wire.safeParse(value).success, shotCueSchema.safeParse(value).success);
  }
  const schema = z.toJSONSchema(wire, { io: 'output' }) as any;
  assert.equal(schema.properties.target.anyOf.length, 3);
});

test('optional translations cross the provider boundary without changing semantic nulls', () => {
  const line = {
    id: 'line',
    speakerKey: 'elena',
    text: '私が直します。',
    sourceFactId: null,
    language: 'ja',
  };
  const wire = codexOutputSchemas.script.shape.scenes.element.shape.dialogue.element;
  assert.equal(wire.safeParse(line).success, false);
  assert.equal(wire.safeParse({ ...line, translation: null }).success, true);
  const value = {
    scenes: [
      {
        dialogue: [
          { ...line, translation: null },
          { ...line, translation: '我来修。' },
        ],
      },
    ],
  };
  decodeCodexOutput('script', value);
  assert.deepEqual(value.scenes[0].dialogue[0], line);
  assert.equal(value.scenes[0].dialogue[1].translation, '我来修。');
  const domain = authoringSchemas.script.shape.scenes.element.shape.dialogue.element;
  assert.equal(domain.safeParse(value.scenes[0].dialogue[0]).success, true);
  assert.equal(domain.safeParse({ ...line, translation: null }).success, false);
});

test('malformed authoring content remains available for diagnosis', () => {
  for (const value of [
    null,
    'invalid',
    { scenes: 'invalid' },
    { scenes: [null, { dialogue: [null, 42, { text: 7, unexpected: true }] }] },
  ]) {
    const baseline = structuredClone(value);
    assert.deepEqual(decodeCodexOutput('script', value), baseline);
  }
  const other = { translation: null, scenes: [{ dialogue: [{ translation: null }] }] };
  assert.deepEqual(decodeCodexOutput('brief', structuredClone(other)), other);
});
