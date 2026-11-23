import { HttpError } from './db.js';
import { generationDigest } from './h3-guided.js';
import { prepareVideoContract, stagedShotConsumption } from './video-contract.js';
import { spatialIssues, spatialAssessment } from '../shared/spatial.js';
import { renderShotDescriptions } from './shot-description.js';
import { promptProfiles, type InputBinding, type ModelExecution } from '../shared/models.js';

// Compiles frozen domain inputs only. Does not read credentials, upload, or call a model.
export function prepareApiVideo(input: any, execution: ModelExecution) {
  const mode = input.segment.mode;
  const caps = execution.capabilities;
  if (execution.selection.mode !== 'authored' && execution.selection.mode !== mode)
    throw new HttpError(
      409,
      '所选模式与已采用参考用途不同，请修订参考方案后重新准备；不会自动转换身份图为首帧',
    );
  if (!caps.modes.includes(mode)) throw new HttpError(400, '当前模型不支持此生成模式');
  const seconds = input.segment.duration;
  if (
    seconds < caps.minSeconds! ||
    seconds > caps.maxSeconds! ||
    (caps.integerSeconds && !Number.isInteger(seconds))
  )
    throw new HttpError(
      400,
      `模型要求 ${caps.minSeconds}–${caps.maxSeconds} 整数秒；当前 ${seconds} 秒，请明确调整分组或时间线`,
    );
  if (input.segment.guides?.length || input.planning.plan?.data.guides?.length)
    throw new HttpError(
      409,
      '当前 API 不支持 ComfyUI 时间 Guide；需要明确修订参考职责，未丢弃任何 Guide',
    );
  if (input.planning.omitted?.some((o: any) => /预算|九图/.test(o.reason)))
    throw new HttpError(409, '参考数量超出模型能力，不能静默丢弃辅助参考');
  const ref = mode === 'ref2va';
  const bindings: InputBinding[] = [];
  const selected = ref
    ? input.planning.selected
    : input.assets.map((a: any) => ({
        id: a.asset.id,
        asset: { id: a.asset.id, revision: a.asset.revision },
        instanceIds: [],
        usage: a.reference.usage,
        role: a.reference.role,
      }));
  for (const b of selected) {
    const asset = input.assets.find(
      (a: any) => a.asset.id === b.asset.id && a.asset.revision === b.asset.revision,
    )?.asset;
    if (!asset || asset.data.mediaType !== 'image')
      throw new HttpError(400, '参考绑定缺少固定图片资产');
    const shared = bindings.find(
      (v) =>
        v.asset.id === asset.id &&
        v.asset.revision === asset.revision &&
        v.role === (ref ? 'reference_image' : b.role),
    );
    if (shared) {
      shared.instanceIds = [...new Set([...shared.instanceIds, ...(b.instanceIds || [])])];
      shared.shotIds = [...new Set([...shared.shotIds, ...(b.usage?.shotIds || [])])];
      shared.purpose = [...new Set([...shared.purpose.split(', '), b.usage?.purpose || ''])]
        .filter(Boolean)
        .join(', ');
      continue;
    }
    const min = execution.protocol === 'ark-video' ? 300 : 256;
    if (![asset.data.width, asset.data.height, asset.data.bytes].every(Number.isFinite))
      throw new HttpError(400, '参考图片缺少已探测的尺寸或字节数');
    if (
      asset.data.width < min ||
      asset.data.height < min ||
      asset.data.width > 5760 ||
      asset.data.height > 5760 ||
      asset.data.width / asset.data.height < 0.4 ||
      asset.data.width / asset.data.height > 2.5 ||
      asset.data.bytes > 30 * 1024 * 1024
    )
      throw new HttpError(400, '图片尺寸、比例或字节数超出当前 API 输入范围');
    bindings.push({
      id: b.id,
      asset: b.asset,
      sha256: asset.data.sha256,
      purpose: b.usage?.purpose || '',
      role: ref ? 'reference_image' : b.role,
      label: `<Picture ${bindings.length + 1}>`,
      instanceIds: b.instanceIds || [],
      shotIds: b.usage?.shotIds || [],
    });
  }
  if (
    (mode === 't2v' && bindings.length) ||
    (mode === 'i2v' &&
      (!bindings.length ||
        bindings.length > 2 ||
        bindings.some((b) => !['first_frame', 'last_frame'].includes(b.role)))) ||
    (ref && (!bindings.length || bindings.length > caps.maxReferenceImages!))
  )
    throw new HttpError(400, '模式、图片数量与参考职责不匹配');
  if (mode === 'i2v' && new Set(bindings.map((b) => b.role)).size !== bindings.length)
    throw new HttpError(400, '首尾帧角色不能重复');
  if (
    execution.protocol === 'ark-video' &&
    mode === 'i2v' &&
    !bindings.some((b) => b.role === 'first_frame')
  )
    throw new HttpError(400, '当前方舟能力方案要求首帧，不能仅提交尾帧');
  const estimatedBytes = input.assets.reduce(
    (n: number, a: any) => n + Math.ceil(((a.asset.data.bytes || 0) * 4) / 3),
    0,
  );
  if (estimatedBytes > 60 * 1024 * 1024)
    throw new HttpError(400, '固定图片超过内联媒体传输预算，请准备较小的已审核图片');
  const context = prepareVideoContract(input, {
    ref,
    universal: true,
    seriesMode: input.segment.executionVersion.endsWith('-v4'),
  });
  const images = bindings.map((b) => ({
    key: `${b.asset.id}:${b.asset.revision}`,
    assetId: b.asset.id,
    revision: b.asset.revision,
    label: b.label,
  }));
  const subjects: any[] = [];
  if (ref)
    for (const b of selected)
      for (const id of b.instanceIds.length ? b.instanceIds : ['reference:' + b.id]) {
        let subject = subjects.find((s) => s.id === id);
        if (!subject) {
          subject = { id, label: `<Subject ${subjects.length + 1}>`, pictures: [] };
          subjects.push(subject);
        }
        const picture = images.find(
          (p) => p.assetId === b.asset.id && p.revision === b.asset.revision,
        )!;
        if (!subject.pictures.includes(picture.label)) subject.pictures.push(picture.label);
      }
  const render = (text: string) =>
    text.replace(/\{\{(subject|picture):([^}]+)\}\}/g, (_all, kind, id) => {
      const b = selected.find((v: any) => v.id === id);
      const label =
        kind === 'subject'
          ? subjects.find((v) => v.id === id)?.label
          : b &&
            images.find((p) => p.assetId === b.asset.id && p.revision === b.asset.revision)?.label;
      if (!label) throw new HttpError(400, '悬空执行引用：' + id);
      return label;
    });
  const { lines } = renderShotDescriptions(
    input,
    context,
    { subjects, images, anchors: [] },
    render,
  );
  const family = execution.protocol === 'minimax-video' ? 'h3-api' : 'seedance-2';
  const recipe = promptProfiles.find(
    (p) =>
      p.family === family &&
      p.modes.includes(mode) &&
      (execution.selection.promptProfile === 'automatic' ||
        execution.selection.promptProfile === p.id),
  );
  if (!recipe) throw new HttpError(400, '未实现与模式相匹配的 Prompt 方案');
  const definitions = subjects
    .map((s) => `${s.label}: ${s.id}, identity from ${s.pictures.join(', ')}.`)
    .join('\n');
  const retention = selected
    .map((b: any) => {
      const p = images.find((p) => p.assetId === b.asset.id && p.revision === b.asset.revision)!;
      return `${p.label}: ${b.usage?.purpose || b.role}; preserve ${(b.usage?.preserve || []).join('; ')}; allow ${(b.usage?.allow || []).join('; ')}. ${b.usage?.stateException || ''}`;
    })
    .join('\n');
  const sound =
    context.specs
      .map((s: any) => s.directing.sound.environment)
      .filter(Boolean)
      .join('; ') || 'N/A';
  const music =
    context.specs
      .map((s: any) => s.directing.sound.music)
      .filter(Boolean)
      .join('; ') || 'N/A';
  const finalPrompt =
    family === 'h3-api'
      ? [
          ...(ref
            ? [
                `subject_definitions:\n${definitions}`,
                'summary:\nExecute the approved shots in order.',
                `retention_analysis:\n${retention}`,
              ]
            : bindings.length
              ? [`image_alignment:\n${retention}`]
              : []),
          `${ref ? 'detailed_description' : 'integrated_multimodal_description'}:\n${lines.join('\n')}`,
          `overall_soundscape:\n${sound}`,
          `non_diegetic_music:\n${music}`,
        ].join('\n\n')
      : [
          `References:\n${definitions}\n${retention}`,
          `Shots:\n${lines.join('\n').replace(/<\/?d>/g, '')}`,
          `Sound:\n${sound}\nMusic: ${music}`,
        ].join('\n\n');
  if (/\{\{/.test(finalPrompt)) throw new HttpError(400, '存在未解析执行引用');
  const parameters = execution.selection.parameters;
  if (parameters.seed !== undefined)
    throw new HttpError(400, '当前视频 API 能力方案未支持 seed 参数');
  const imageDeterminesRatio = family === 'h3-api' && mode === 'i2v';
  if (imageDeterminesRatio && parameters.ratio)
    throw new HttpError(
      400,
      'H3 API 首尾帧模式由图片决定画幅；请将比例改为适配器默认并重新预览，不会提交被忽略的比例',
    );
  const boundaryImage = imageDeterminesRatio
    ? input.assets.find(
        (a: any) =>
          a.asset.id === (bindings.find((b) => b.role === 'first_frame') || bindings[0]).asset.id,
      )?.asset
    : null;
  const ratio = imageDeterminesRatio ? 'adaptive' : parameters.ratio || '16:9';
  const planningAspect = boundaryImage
    ? boundaryImage.data.width / boundaryImage.data.height
    : Number(ratio.split(':')[0]) / Number(ratio.split(':')[1]);
  const request = {
    model: execution.modelId,
    content: [
      { type: 'text', text: finalPrompt },
      ...bindings.map((b) => ({
        type: 'image_url',
        image_url: { url: `studio-asset:${b.asset.id}:${b.asset.revision}` },
        role: b.role,
      })),
    ],
    duration: seconds,
    resolution: parameters.resolution || (family === 'h3-api' ? '768P' : '720p'),
    ratio,
  };
  return {
    finalPrompt,
    rulesVersion: recipe.id,
    promptProfile: recipe,
    inputBindings: bindings,
    request,
    frameCount: Math.round(seconds * 24),
    duration: seconds,
    shotSpecs: context.specs,
    projection: context.projection,
    referenceChecks: context.referenceChecks,
    images,
    subjects,
    anchors: [],
    ...(context.staged
      ? {
          contractRevision: 2,
          spatialAssessments: context.specs.map((s: any) => ({
            shotId: s.shotId,
            ...spatialAssessment(s, planningAspect),
          })),
        }
      : {}),
    spatialChecks: context.specs.flatMap((s: any) => spatialIssues(s, planningAspect)),
    consumption: [
      ...(context.staged
        ? stagedShotConsumption(context.specs)
        : context.specs.flatMap((s: any) =>
            s.trace.map((t: any) => ({
              ...t,
              shotId: s.shotId,
              status: t.status === 'unsupported' ? 'unsupported' : 'planning_check',
            })),
          )),
      ...context.specs.flatMap((s: any) =>
        ['events', 'presence', 'information'].map((field) => ({
          shotId: s.shotId,
          field: `directing.${field}`,
          status: 'text_request',
          consumers: ['prompt', 'actual_media_review'],
        })),
      ),
      {
        field: 'state.attributes / state.relations',
        status: 'text_request',
        consumers: ['prompt', 'actual_media_review'],
      },
    ],
    trace: [
      ...bindings.map((b) => ({
        field: b.id,
        status: 'model_input',
        asset: b.asset,
        role: b.role,
      })),
      {
        field: 'events_and_continuity',
        status: 'post_generation_review',
        consumers: ['actual_media_review'],
      },
    ],
    bindingDigest: generationDigest(bindings),
  };
}

export function freezeModelPreparation(
  input: any,
  execution: ModelExecution | null,
  previous?: { jobId: string; input: any },
) {
  if (!execution) return input;
  if (execution.selection.mode !== 'authored' && execution.selection.mode !== input.segment.mode)
    throw new HttpError(409, '模型模式与采用方案不一致，请重新准备');
  const prepared =
    execution.protocol === 'comfy-h3' ? input.prepared : prepareApiVideo(input, execution);
  const bindings: InputBinding[] = execution.protocol === 'comfy-h3' ? [] : prepared.inputBindings;
  if (execution.protocol === 'comfy-h3') {
    for (const entry of input.assets) {
      const image = prepared.images.find(
        (p: any) => p.assetId === entry.asset.id && p.revision === entry.asset.revision,
      );
      const uses = (input.planning?.selected || []).filter(
        (b: any) => b.asset.id === entry.asset.id && b.asset.revision === entry.asset.revision,
      );
      if (image || input.segment.mode === 'i2v')
        bindings.push({
          id: image?.key || entry.asset.id,
          asset: { id: entry.asset.id, revision: entry.asset.revision },
          sha256: entry.asset.data.sha256,
          purpose:
            uses.map((b: any) => b.usage?.purpose).join(', ') ||
            entry.reference.usage?.purpose ||
            '',
          role: input.segment.mode === 'ref2va' ? 'reference_image' : entry.reference.role,
          label: image?.label || entry.reference.role,
          instanceIds: [...new Set<string>(uses.flatMap((b: any) => b.instanceIds || []))],
          shotIds: [...new Set<string>(uses.flatMap((b: any) => b.usage?.shotIds || []))],
        });
    }
    for (const anchor of prepared.anchors) {
      const asset = input.assets.find(
        (a: any) => a.asset.id === anchor.assetId && a.asset.revision === anchor.revision,
      )?.asset;
      if (!asset) throw new HttpError(400, '时间 Guide 缺少固定素材');
      bindings.push({
        id: 'guide:' + anchor.key + ':' + anchor.resolvedFrameIndex,
        asset: { id: asset.id, revision: asset.revision },
        sha256: asset.data.sha256,
        purpose: anchor.instruction,
        role: 'time_guide',
        frame: anchor.resolvedFrameIndex,
        label: anchor.label,
        instanceIds: [],
        shotIds: [],
      });
    }
  }
  const profile = prepared.rulesVersion?.startsWith('h3-')
    ? input.templateVersion
    : prepared.rulesVersion;
  if (
    execution.selection.promptProfile !== 'automatic' &&
    execution.selection.promptProfile !== profile
  )
    throw new HttpError(409, '所选 Prompt 版本与当前输入不匹配');
  const { digest: _digest, ...snapshot } = { ...execution, promptProfile: profile };
  const before = previous?.input;
  const comparisons = before
    ? [
        [
          'connection',
          before.modelExecution?.selection.connection || before.profile,
          execution.selection.connection,
        ],
        ['model', before.modelExecution?.modelId || 'legacy-comfy-h3', execution.modelId],
        ['protocol', before.modelExecution?.protocol || 'comfy-h3', execution.protocol],
        ['mode', before.segment.mode, input.segment.mode],
        ['promptProfile', before.templateVersion, profile],
        [
          'parameters',
          before.modelExecution?.selection.parameters || {
            width: before.width,
            height: before.height,
            steps: before.steps,
          },
          execution.selection.parameters,
        ],
        [
          'mediaRoles',
          (before.referenceBindingPlan?.bindings || before.prepared?.inputBindings)?.map(
            (b: any) => [b.asset, b.role, b.purpose],
          ) || before.segment.references,
          bindings.map((b: any) => [b.asset, b.role, b.purpose]),
        ],
      ]
        .filter(([, a, b]) => generationDigest(a ?? null) !== generationDigest(b ?? null))
        .map(([field, from, to]) => ({ field, from, to }))
    : [];
  return {
    ...input,
    prepared,
    referenceBindingPlan: { version: 1, bindings, digest: generationDigest(bindings) },
    executionDifference: {
      comparedJobId: previous?.jobId || null,
      changes: comparisons,
      unsupported: prepared.trace?.filter((t: any) => t.status === 'unsupported') || [],
    },
    modelExecution: { ...snapshot, digest: generationDigest(snapshot) },
    dependencies: [...(input.dependencies || []), ...execution.dependencies],
    ...(execution.protocol === 'comfy-h3'
      ? {}
      : {
          templateVersion: profile,
          compilerVersion: execution.adapterVersion,
          capabilities: execution.capabilities,
        }),
  };
}
