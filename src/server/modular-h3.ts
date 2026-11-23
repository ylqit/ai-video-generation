import { prepareVideoContract, stagedShotConsumption } from './video-contract.js';
import { renderShotDescriptions } from './shot-description.js';
import { spatialIssues, spatialAssessment } from '../shared/spatial.js';
import { frameCount } from '../shared/contracts.js';
import { preparePlannedH3 } from './reference-plan.js';
import { generationDigest } from './h3-guided.js';
import { HttpError } from './db.js';

export const modularRefTemplate = 'native-h3-directed-v2';
export const modularBaseTemplate = 'native-h3-base-v2';
export const universalRefTemplate = 'native-h3-directed-v3';
export const universalBaseTemplate = 'native-h3-base-v3';
export const seriesRefTemplate = 'native-h3-directed-v4';
export const seriesBaseTemplate = 'native-h3-base-v4';
export function prepareModularH3(input: any) {
  const seriesMode = [seriesRefTemplate, seriesBaseTemplate].includes(input.templateVersion);
  const universal = [
    universalRefTemplate,
    universalBaseTemplate,
    seriesRefTemplate,
    seriesBaseTemplate,
  ].includes(input.templateVersion);
  const ref = [modularRefTemplate, universalRefTemplate, seriesRefTemplate].includes(
    input.templateVersion,
  );
  if (
    !ref &&
    ![modularBaseTemplate, universalBaseTemplate, seriesBaseTemplate].includes(
      input.templateVersion,
    )
  )
    throw new HttpError(400, '未知模块化模板');
  if (ref !== (input.segment.mode === 'ref2va'))
    throw new HttpError(400, 'Base/Ref 模式与模板不匹配');
  if (!ref && input.segment.guides?.length)
    throw new HttpError(400, 'Base 使用明确首尾帧角色，不接受 Ref Add Guide');
  const context = prepareVideoContract(input, { ref, universal, seriesMode });
  const { brief, specs, staged, projection, referenceChecks } = context;
  const mapped = ref
    ? preparePlannedH3(input)
    : {
        images: [],
        subjects: [],
        anchors: [],
        frameCount: frameCount(input.segment.duration),
        duration: frameCount(input.segment.duration) / 24,
      };
  const render = (text: string) =>
    text.replace(/\{\{(subject|picture):([^}]+)\}\}/g, (_all, kind, id) => {
      if (!ref) throw new HttpError(400, 'Base 正文使用已审核主体名称，不使用 Ref 标签');
      if (kind === 'subject') {
        const subject = mapped.subjects.find((s: any) => s.id === id);
        if (!subject) throw new HttpError(400, `悬空主体引用 ${id}`);
        return subject.label;
      }
      const binding = input.planning.selected.find((b: any) => b.id === id);
      const picture =
        binding &&
        mapped.images.find(
          (p: any) => p.assetId === binding.asset.id && p.revision === binding.asset.revision,
        );
      if (!picture) throw new HttpError(400, `悬空图片引用 ${id}`);
      return picture.label;
    });
  const { visual, art, lines } = renderShotDescriptions(input, context, mapped, render);
  const retention = ref
    ? input.planning.selected
        .flatMap((b: any) => {
          if (universal && !b.usage)
            throw new HttpError(400, `参考 ${b.id} 需要明确用途和审核后的保留要求`);
          const picture = mapped.images.find(
            (p: any) => p.assetId === b.asset.id && p.revision === b.asset.revision,
          )!;
          return [
            ...(universal
              ? [
                  `${picture.label} applies only to shots ${b.usage.shotIds.join(', ') || input.segment.shotIds?.join(', ') || 'as declared'}; reference purpose ${b.usage.purpose}. ${b.usage.stateException || ''}`,
                ]
              : []),
            `${picture.label} (${universal ? b.usage.purpose : b.role || b.view}): preserve ${(universal ? b.usage.preserve : b.retain).join('; ')}; allowed changes: ${(universal ? b.usage.allow : b.allow).join('; ') || 'only the authored action'}; ${(universal ? ['environment', 'composition', 'action_start', 'action_end'].includes(b.usage.purpose) && b.inheritBackground : b.inheritBackground) ? 'inherit its explicitly assigned environment' : 'exclude its background unless separately assigned as a scene reference'}.`,
            ...(staged && ['identity', 'appearance'].includes(b.usage.purpose)
              ? [
                  `${picture.label} supplies identity features only. Do not inherit frontal pose, gaze toward the viewer, framing or background; follow the shot's staging.`,
                ]
              : []),
          ];
        })
        .concat(
          specs.flatMap((s: any) => [
            ...s.directing.execution.retention,
            ...(s.directing.execution.retentionBindings || []).map(
              (r: any) =>
                `${render(r.target)}: preserve ${r.preserve.join('; ')}; allow ${r.allow.join('; ')}; background ${r.background}.`,
            ),
          ]),
        )
    : [];
  if (ref && !universal)
    for (const instance of input.planning.instances) {
      const entity = input.planning.records.find(
        (r: any) => r.id === instance.entity.id && r.revision === instance.entity.revision,
      );
      const appearance =
        instance.appearance &&
        input.planning.records.find(
          (r: any) =>
            r.id === instance.appearance.id && r.revision === instance.appearance.revision,
        );
      const subject = mapped.subjects.find((s: any) => s.id === instance.instanceId);
      if (subject)
        retention.push(
          `${subject.label}: ${(entity?.data.fixedFeatures || []).join('; ')}${appearance ? `; appearance: ${appearance.data.description}; ${Object.values(appearance.data.features || {}).join('; ')}` : ''}`,
        );
    }
  const sections = [
    ...(ref
      ? [
          `subject_definitions:\n${mapped.subjects
            .map(
              (s: any) =>
                `${s.label}: ${universal ? s.id : input.planning.records.find((r: any) => r.id === input.planning.instances.find((i: any) => i.instanceId === s.id)?.entity.id)?.data.description || s.id}; the same assigned instance across ${s.pictures.join(', ')}.`,
            )
            .concat(
              mapped.anchors.map(
                (a: any) =>
                  `${a.label}: temporal composition anchor at frame ${a.resolvedFrameIndex}; ${render(a.instruction)}`,
              ),
            )
            .join('\n')}`,
          `summary:\n${render(universal ? '[reference generation] Execute only the following approved shot contracts in order.' : input.segment.guidedPrompt.summary)}`,
          `retention_analysis:\n${render(retention.join('\n'))}`,
        ]
      : []),
    `${ref ? 'detailed_description' : 'integrated_multimodal_description'}:\n${staged ? '' : `Visual treatment: ${visual || (universal ? brief.visualReference?.description || 'follow the applicable style entries' : '')}. ${brief.overrides.mixedMedia || ''}\nArt direction: ${art || 'use the approved input assets'}\n`}${lines.join('\n')}`,
    `overall_soundscape:\n${render(
      specs
        .map((s: any) => s.directing.sound.environment)
        .filter(Boolean)
        .join('; ') || 'N/A',
    )}`,
    `non_diegetic_music:\n${render(
      specs
        .map((s: any) => s.directing.sound.music)
        .filter((s: string) => s && s !== 'N/A')
        .join('; ') || 'N/A',
    )}`,
  ];
  let alignment = '';
  if (!ref) {
    const first = input.segment.references?.find((r: any) => r.role === 'first_frame');
    const last = input.segment.references?.find((r: any) => r.role === 'last_frame');
    const end = mapped.duration.toFixed(2);
    if (first && last)
      alignment = `How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot ${specs.length}) aligns with the ${end}-second mark of the target video.`;
    else if (first)
      alignment =
        'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.';
    else if (last)
      alignment = `How the reference pictures align with the target video — <Picture 1> (from [Shot ${specs.length}]) aligns with the ${end}-second mark of the target video.`;
  }
  const finalPrompt = [alignment, ...sections].filter(Boolean).join('\n\n');
  const labels = new Set([
    ...mapped.images.map((p: any) => p.label),
    ...mapped.subjects.map((s: any) => s.label),
  ]);
  if (!ref && input.segment.references?.length) {
    labels.add('<Picture 1>');
    if (input.segment.references.length === 2) labels.add('<Picture 2>');
  }
  for (const tag of finalPrompt.matchAll(/<(?:Subject|Picture|Video|Audio)\s+\d+>/g))
    if (!labels.has(tag[0])) throw new HttpError(400, `悬空标签 ${tag[0]}`);
  if (/\{\{/.test(finalPrompt)) throw new HttpError(400, '未解析的执行引用');
  if (
    /[\u3400-\u9fff]/.test(
      finalPrompt.replace(/<d>[\s\S]*?<\/d>/g, '').replace(/"(?:\\.|[^"\\])*"/g, ''),
    )
  )
    throw new HttpError(
      400,
      '执行描述、美术规范和模块覆盖须在审核前提供英文；对白可保留中文，预览不翻译',
    );
  const result: any = {
    ...mapped,
    finalPrompt,
    shotSpecs: specs,
    rulesVersion: seriesMode
      ? ref
        ? 'h3-directed-v4'
        : 'h3-base-v4'
      : universal
        ? ref
          ? 'h3-directed-v3'
          : 'h3-base-v3'
        : ref
          ? 'h3-directed-v2'
          : 'h3-base-v2',
    creativeBrief: brief,
    ...(universal ? { referenceChecks } : {}),
    spatialChecks: specs.flatMap((s: any) => spatialIssues(s, input.width / input.height)),
    ...(staged
      ? {
          contractRevision: 2,
          spatialAssessments: specs.map((s: any) => ({
            shotId: s.shotId,
            ...spatialAssessment(s, input.width / input.height),
          })),
          consumption: stagedShotConsumption(specs),
        }
      : {}),
    ...(universal
      ? {
          projection,
          complexity: specs.map((s: any) => ({
            shotId: s.shotId,
            visibleInstances: s.directing.presence.visible.length,
            events: s.directing.events.length,
            contactRelations: s.state?.endRelations.length || 0,
            cameraMotion: s.directing.camera.motion,
            dialogue: s.directing.sound.dialogue.length,
            occlusion: 'requires_visual_review',
          })),
        }
      : {}),
    trace: [
      ...(seriesMode
        ? [
            {
              field: 'directing.carry',
              status: 'text_request',
              consumers: ['prompt', 'continuation_check', 'boundary_review'],
            },
            {
              field: 'voice_profile.samples',
              status: 'post_generation_review',
              consumers: ['voice_review'],
              reason:
                'No audio reference connected to H3; text timbre is a request, not an identity lock.',
            },
          ]
        : []),
      ...specs.flatMap((s: any) =>
        s.trace.map((t: any) => ({
          shotId: s.shotId,
          ...t,
          ...(universal
            ? {
                status:
                  t.status === 'unsupported'
                    ? 'unsupported'
                    : [
                          'directing.paths',
                          'directing.doors',
                          'directing.proxies',
                          'directing.purpose',
                          'directing.audienceInformation',
                          'directing.transition',
                          'directing.axis',
                        ].includes(t.field)
                      ? 'planning_check'
                      : 'text_request',
                consumers:
                  t.status === 'unsupported'
                    ? []
                    : [
                          'directing.paths',
                          'directing.doors',
                          'directing.proxies',
                          'directing.purpose',
                          'directing.audienceInformation',
                          'directing.transition',
                          'directing.axis',
                        ].includes(t.field)
                      ? ['planning_or_previsualization', 'post_generation_review']
                      : ['prompt', 'post_generation_review'],
              }
            : {}),
        })),
      ),
      ...(universal
        ? projection
            .flatMap((p: any) =>
              p.decisions.map((d: any) => ({
                shotId: p.shotId,
                ...d,
                consumers: d.status === 'text_request' ? ['prompt'] : [],
              })),
            )
            .concat([
              {
                field: 'state.attributes',
                status: 'text_request',
                consumers: ['prompt', 'post_generation_review'],
              },
              {
                field: 'directing.events',
                status: 'post_generation_review',
                consumers: ['prompt', 'event_evidence', 'selection'],
              },
              ...mapped.anchors.map((a: any) => ({
                field: `guide:${a.label}@${a.resolvedFrameIndex}`,
                status: 'model_input',
                consumers: ['conditioning'],
                asset: { id: a.assetId, revision: a.revision },
              })),
              ...mapped.images.map((p: any) => ({
                field: `text image slot:${p.label}`,
                status: 'model_input',
                consumers: ['reference_slots'],
                asset: { id: p.assetId, revision: p.revision },
              })),
              ...(!ref
                ? (input.assets || []).map((a: any) => ({
                    field: `base:${a.reference.role}`,
                    status: 'model_input',
                    consumers: ['base_frame_condition'],
                    asset: { id: a.asset.id, revision: a.asset.revision },
                  }))
                : []),
              ...(brief.visualReference
                ? [
                    {
                      field: 'visualReference',
                      status: 'text_request',
                      consumers: ['reviewed_visual_description'],
                      reason:
                        'Image is a reviewed specification source; conditioning requires an explicit reference binding.',
                    },
                  ]
                : []),
              {
                field: 'state.start / state.end',
                status: 'planning_check',
                consumers: ['previsualization', 'continuity_checks'],
                reason:
                  'Numeric position and heading are not automatically translated to visible prose.',
              },
              {
                field: 'entity.description / legacy retain / summary',
                status: 'excluded',
                reason: 'use scoped art and reviewed reference usage',
              },
            ])
        : []),
      ...brief.modules.map((m: any) => ({
        field: `${m.ref.id}:${m.ref.revision}`,
        consumers: [
          m.data.category === 'visual'
            ? 'detailed_description'
            : m.data.category === 'direction'
              ? 'explicit shot or framing fallback'
              : 'director stage rules and review; never injected as world facts',
        ],
        status: universal
          ? m.data.category === 'visual'
            ? brief.overrides.visual
              ? 'excluded'
              : 'text_request'
            : 'planning_check'
          : 'consumed',
      })),
      {
        field: 'numeric geometry',
        consumers: [
          'previsualization and spatialChecks; execution.visibleSpace supplies visible prose',
        ],
        status: universal ? 'planning_check' : 'consumed',
      },
    ],
  };
  if (staged) {
    result.consumption.push(...result.trace.filter((t: any) => t.status === 'model_input'));
    result.trace = result.consumption;
  }
  return result;
}
