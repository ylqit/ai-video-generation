import { z } from 'zod';
import type { AuthoringResult, AuthoringStage } from './creation.js';

type Results = Partial<Record<AuthoringStage, AuthoringResult>>;
export const executionTextSchema = z
  .object({
    reviewed: z.literal(true),
    entries: z
      .array(
        z
          .object({
            path: z.string().min(1).max(500),
            source: z.string().min(1).max(100000),
            text: z.string().trim().min(1).max(100000),
          })
          .strict(),
      )
      .max(10000),
  })
  .strict();
export type ExecutionText = z.infer<typeof executionTextSchema>;

// This whitelist is the language boundary, not a general authoring patch API.
// Dialogue, state values, identifiers, timing and all relationships stay intact.
function textTargets(results: Results) {
  const fields: { path: string; label: string; source: string; set: (text: string) => void }[] = [];
  const add = (path: string, label: string, owner: any, key: string) => {
    if (typeof owner?.[key] === 'string' && owner[key].trim())
      fields.push({
        path,
        label,
        source: owner[key],
        set: (text) => {
          owner[key] = text;
        },
      });
  };
  if (results.direction?.stage === 'direction')
    for (const key of ['visual', 'narrative', 'directing', 'editing', 'sound', 'assetPolicy'])
      add(`/direction/${key}`, `呈现方向 · ${key}`, results.direction, key);
  if (results.script?.stage === 'script') {
    results.script.subjects.forEach((s, i) =>
      add(`/script/subjects/${i}/description`, `主体 · ${s.name}`, s, 'description'),
    );
    results.script.scenes.forEach((scene, i) =>
      scene.events.forEach((event, j) =>
        add(
          `/script/scenes/${i}/events/${j}/description`,
          `事件 · ${event.id}`,
          event,
          'description',
        ),
      ),
    );
  }
  if (results.director?.stage === 'director')
    results.director.shots.forEach((shot, i) => {
      const base = `/director/shots/${i}`;
      for (const key of [
        'action',
        'visibleSpace',
        'visualTreatment',
        'environmentSound',
        'actionSound',
        'soundContinuation',
      ])
        add(`${base}/${key}`, `${shot.id} · ${key}`, shot, key);
      for (const key of ['shotSize', 'position', 'composition', 'reason'])
        add(`${base}/camera/${key}`, `${shot.id} · camera.${key}`, shot.camera, key);
      shot.performances.forEach((p, j) => {
        for (const key of ['trigger', 'goal', 'obstacle', 'visible'])
          add(`${base}/performances/${j}/${key}`, `${shot.id} · ${p.id} · ${key}`, p, key);
        if (p.attention)
          add(
            `${base}/performances/${j}/attention/description`,
            `${shot.id} · ${p.id} · attention`,
            p.attention,
            'description',
          );
      });
      (shot.interactions || []).forEach((interaction, j) => {
        for (const key of ['effector', 'precondition', 'action', 'result'])
          add(
            `${base}/interactions/${j}/${key}`,
            `${shot.id} · ${interaction.id} · ${key}`,
            interaction,
            key,
          );
      });
    });
  if (results.assets?.stage === 'assets')
    results.assets.items.forEach((item, i) => {
      add(`/assets/items/${i}/description`, `参考说明 · ${item.id}`, item, 'description');
      for (const key of ['preserve', 'allow'] as const)
        (item[key] || []).forEach((_value, j) =>
          add(`/assets/items/${i}/${key}/${j}`, `参考 ${item.id} · ${key}`, item[key], String(j)),
        );
    });
  return fields;
}

export function executionTextFields(results: Results) {
  return textTargets(results).map(({ path, label, source }) => ({ path, label, source }));
}

export function projectExecutionText(results: Results, wording?: ExecutionText): Results {
  const copy = structuredClone(results);
  if (!wording) return copy;
  const checked = executionTextSchema.parse(wording);
  const fields = new Map(textTargets(copy).map((field) => [field.path, field]));
  const seen = new Set<string>();
  for (const entry of checked.entries) {
    const field = fields.get(entry.path);
    if (!field || seen.has(entry.path)) throw new Error(`执行文案字段不存在或重复：${entry.path}`);
    if (field.source !== entry.source) throw new Error(`执行文案原文已变化：${entry.path}`);
    if (/[\u3400-\u9fff]/.test(entry.text.replace(/"(?:\\.|[^"\\])*"/g, '')))
      throw new Error(`执行译文须使用英文；画面中的原文可用双引号标注：${entry.path}`);
    field.set(entry.text);
    seen.add(entry.path);
  }
  return copy;
}
