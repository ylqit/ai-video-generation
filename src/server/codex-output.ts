import { assistantDecisionSchema } from '../shared/assistant.js';
import { seriesProposalResultSchema } from '../shared/series-proposal.js';
import { z } from 'zod';
import { authoringSchemas, shotCueSchema } from '../shared/creation.js';
import { discussionResponseSchema } from '../shared/creation-media.js';
import { localReplacementSchemas } from '../shared/authoring-replacement.js';

const script = authoringSchemas.script;
const scene = script.shape.scenes.element;
const dialogue = scene.shape.dialogue.element;

// Structured Outputs requires every property on the wire. A missing translation
// is represented by null there, while the authoring contract keeps it optional.
export const codexOutputSchemas = {
  ...authoringSchemas,
  script: script.extend({
    scenes: scene
      .extend({
        dialogue: dialogue
          .extend({ translation: dialogue.shape.translation.unwrap().nullable() })
          .array(),
      })
      .array(),
  }),
  // Zod's discriminated union emits oneOf, which the provider rejects. These
  // branches have distinct required kind literals, so anyOf is equivalent.
  director: authoringSchemas.director.extend({
    shots: authoringSchemas.director.shape.shots.element
      .extend({
        cues: shotCueSchema.extend({ target: z.union(shotCueSchema.shape.target.options) }).array(),
      })
      .array(),
  }),
  discussion: discussionResponseSchema,
  assistant: assistantDecisionSchema,
  series_proposal: seriesProposalResultSchema,
};

// One dialect boundary adapts every nested optional field. It does not change
// domain defaults or convert explicitly nullable unknown geometry into values.
export function codexOutputJsonSchema(stage: keyof typeof codexOutputSchemas, local = false) {
  const schema: any = z.toJSONSchema(
    local && (stage === 'script' || stage === 'director')
      ? localReplacementSchemas[stage]
      : codexOutputSchemas[stage],
    { io: 'output' },
  );
  if (stage !== 'discussion' && stage !== 'assistant' && stage !== 'series_proposal' && !local) {
    schema.properties.contractRevision = { type: 'number', const: 2 };
    schema.required = [...new Set([...(schema.required || []), 'contractRevision'])];
  }
  const adapt = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.oneOf) {
      node.anyOf = node.oneOf;
      delete node.oneOf;
    }
    if (node.properties) {
      const required = new Set(node.required || []);
      for (const [name, value] of Object.entries(node.properties)) {
        adapt(value);
        if (!required.has(name)) node.properties[name] = { anyOf: [value, { type: 'null' }] };
      }
      node.required = Object.keys(node.properties);
      node.additionalProperties = false;
    }
    if (node.items) adapt(node.items);
    for (const option of node.anyOf || []) adapt(option);
    for (const child of Object.values(node.$defs || {})) adapt(child);
  };
  adapt(schema);
  return schema;
}

export function decodeCodexOutput(stage: string, value: unknown): unknown {
  // Keep malformed authoring outputs intact for the normal diagnostic/repair
  // path. Only the transport's optional-translation sentinel is normalized.
  if (stage in authoringSchemas && value && typeof value === 'object') {
    const local =
      (value as any).protocol === 'local-authoring-v1' &&
      (stage === 'script' || stage === 'director');
    const schema: any = z.toJSONSchema(
      local
        ? localReplacementSchemas[stage as 'script' | 'director']
        : authoringSchemas[stage as keyof typeof authoringSchemas],
      {
        io: 'output',
      },
    );
    const nullable = (s: any): boolean =>
      s.type === 'null' || (s.anyOf || s.oneOf || []).some(nullable);
    const normalize = (data: any, shape: any) => {
      if (!data || typeof data !== 'object') return;
      if (Array.isArray(data)) {
        data.forEach((v) => normalize(v, shape.items || {}));
        return;
      }
      const actual = shape.properties
        ? shape
        : (shape.anyOf || shape.oneOf || []).find((s: any) => s.properties) || shape;
      for (const [key, field] of Object.entries<any>(actual.properties || {})) {
        if (data[key] === null && !(actual.required || []).includes(key) && !nullable(field))
          delete data[key];
        else normalize(data[key], field);
      }
    };
    normalize(value, schema);
  }
  if (stage !== 'script' || !value || typeof value !== 'object') return value;
  const output = value as Record<string, unknown>;
  if (!Array.isArray(output.scenes)) return value;
  for (const scene of output.scenes) {
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.dialogue)) continue;
    for (const line of scene.dialogue) {
      if (line && typeof line === 'object' && line.translation === null) delete line.translation;
    }
  }
  return value;
}
