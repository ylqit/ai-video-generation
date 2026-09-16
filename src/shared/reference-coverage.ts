import type { DirectorResult, AuthoringResult } from './creation.js';
import { projectShotStaging, sceneDesignDependencies } from './staging-projection.js';
type Item = Extract<AuthoringResult, { stage: 'assets' }>['items'][number];

/** The design facts an inspected reference claims to cover, independent of card layout. */
export function referenceCoverageBasis(
  director: DirectorResult,
  coverage: NonNullable<Item['coverage']>,
) {
  return coverage.map((c) => {
    const shot = director.shots.find((s) => s.id === c.shotId);
    if (!shot) throw new Error(`参考覆盖的镜头不存在：${c.shotId}`);
    const design = director.sceneDesigns?.find((d) => d.sceneId === shot.sceneId);
    const projection = projectShotStaging(director, shot, (k) => k);
    return c.aspects.some((a) => ['space', 'interaction', 'composition', 'boundary'].includes(a))
      ? {
          coverage: c,
          shot,
          design: design ? sceneDesignDependencies(design, [shot]) : null,
          resolved: { ...projection.state, doors: projection.directing.doors },
        }
      : { coverage: c, visibleSubjectKeys: shot.visibleSubjectKeys };
  });
}

/** Coverage is explicit per shot/interaction; a group start never supplies later views. */
export function referenceCoverage(
  director: DirectorResult,
  items: Item[],
  bindings: Record<string, any> = {},
) {
  return director.shots.flatMap((shot) =>
    (shot.interactions || [])
      .filter((i) => i.required && i.kind !== 'observe')
      .map((interaction) => {
        const requirements = items.filter(
          (item) =>
            item.mediaType === 'image' &&
            item.coverage?.some(
              (c) =>
                c.shotId === shot.id &&
                c.interactionIds.includes(interaction.id) &&
                c.aspects.includes('interaction'),
            ),
        );
        const inspected = requirements.filter(
          (item) =>
            bindings[item.id]?.inspected &&
            bindings[item.id]?.coverage?.some(
              (c: any) =>
                c.shotId === shot.id &&
                c.interactionIds.includes(interaction.id) &&
                c.aspects.includes('interaction'),
            ),
        );
        return {
          shotId: shot.id,
          interactionId: interaction.id,
          requirementIds: requirements.map((i) => i.id),
          assets: inspected.map((i) => bindings[i.id].asset),
          status: inspected.length
            ? 'inspected_reference'
            : requirements.length
              ? 'awaiting_reference_review'
              : 'missing_reference',
          nativeInput: false,
          actualReviewRequired: true,
        };
      }),
  );
}
