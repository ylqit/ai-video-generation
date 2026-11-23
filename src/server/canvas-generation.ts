import { HttpError, Store } from './db.js';
import { ModelRegistry } from './model-registry.js';
import { generationDigest, prepareGuidedH3 } from './h3-guided.js';
import { frameCount } from '../shared/contracts.js';
import type { CanvasContent } from '../shared/canvas.js';
import { nodeMediaType } from '../shared/node-catalog.js';
import { projectNodeInputs } from './node-context.js';
import { imageEditPlanSchema, imageEditInstructions } from '../shared/image-edit-plan.js';

// Free-form creation has its own immutable recipe. Historical authored templates
// keep their original sections, contracts and task snapshots.
export function prepareCanvasGeneration(store: Store, canvasId: string, nodeId: string) {
  const canvas = store.get(canvasId);
  if (canvas.kind !== 'canvas') throw new HttpError(400, '需要画布');
  const data = canvas.data as CanvasContent,
    original = data.nodes.find((n) => n.id === nodeId);
  const projection =
    data.version === 2 && original
      ? projectNodeInputs(store, canvas.projectId, data, original)
      : null;
  const node = original
    ? { ...original, type: nodeMediaType(original.type), text: projection?.text || original.text }
    : null;
  if (!node?.generation || !['image', 'video'].includes(node.type!))
    throw new HttpError(400, '此节点需要图片或视频生成配置');
  const execution = new ModelRegistry(store).resolveSelection(node.generation.model);
  if (execution.capabilities.kind !== node.type) throw new HttpError(400, '模型类型与节点不匹配');
  if (!node.text.trim()) throw new HttpError(400, '请填写当前画面或动作');
  const refs = data.edges
    .filter(
      (e) =>
        e.target === nodeId &&
        e.relation === 'input' &&
        (data.version !== 2 ||
          e.asset ||
          data.nodes.find((n) => n.id === e.source)?.asset ||
          (!['text', 'context'].includes(e.targetHandle || '') &&
            !data.nodes.find((n) => n.id === e.source)?.binding &&
            !['document', 'note'].includes(data.nodes.find((n) => n.id === e.source)?.type || ''))),
    )
    .sort((a, b) =>
      data.version === 2
        ? (a.order ?? data.edges.indexOf(a)) - (b.order ?? data.edges.indexOf(b))
        : a.id.localeCompare(b.id),
    );
  if (
    ![
      'automatic',
      `canvas-image-v${data.version}`,
      `canvas-h3-v${data.version}`,
      `canvas-seedance-v${data.version}`,
    ].includes(execution.selection.promptProfile)
  )
    throw new HttpError(
      400,
      '画布使用独立版本的 Prompt 方案，请选择自动匹配；旧专业模板保留在原分镜制作中',
    );
  const assets = refs.map((edge) => {
    const source = data.nodes.find((n) => n.id === edge.source);
    const fixed = edge.asset || source?.asset;
    if (!fixed) throw new HttpError(409, `输入 ${source?.title || edge.source} 尚无实际素材`);
    const asset = store.get(fixed.id, fixed.revision);
    if (
      data.version === 2 &&
      source?.range &&
      asset.data.mediaType !== 'image' &&
      (source.range.in !== 0 || Math.abs(source.range.out - asset.data.duration) > 0.001)
    )
      throw new HttpError(
        400,
        '此参考选择了媒体区间，请先用截取操作生成固定片段，再连接为模型输入；当前接口不会隐式截取或发送完整原片代替选区',
      );
    if (
      asset.kind !== 'asset' ||
      asset.projectId !== canvas.projectId ||
      (asset.data.mediaType !== 'image' &&
        !(
          data.version === 2 &&
          execution.protocol === 'minimax-video' &&
          ['video', 'audio'].includes(asset.data.mediaType)
        ))
    )
      throw new HttpError(
        400,
        '当前图片／视频适配器的画布输入仅支持本作品固定图片；运动与声音参考可用组织连线保存',
      );
    if (
      !Number.isFinite(asset.data.bytes) ||
      asset.data.bytes >
        (asset.data.mediaType === 'audio' ? 15 : asset.data.mediaType === 'video' ? 50 : 30) *
          1024 *
          1024 ||
      (asset.data.mediaType !== 'audio' && (!asset.data.width || !asset.data.height))
    )
      throw new HttpError(400, '图片缺少尺寸或超过传输上限');
    if (
      ['audio', 'motion'].includes(edge.purpose!) &&
      !(data.version === 2 && execution.protocol === 'minimax-video')
    )
      throw new HttpError(400, '当前适配器未接入此参考用途');
    if (
      asset.data.mediaType !== 'image' &&
      ((asset.data.mediaType === 'video' ? edge.purpose !== 'motion' : edge.purpose !== 'audio') ||
        node.generation!.mode !== 'ref2va')
    )
      throw new HttpError(400, '视频／音频必须使用对应参考用途和参考生成模式');
    if (asset.data.mediaType !== 'image' && (asset.data.duration < 2 || asset.data.duration > 15))
      throw new HttpError(400, 'H3 视频／音频参考需要 2—15 秒');
    return {
      asset,
      reference: {
        assetId: asset.id,
        revision: asset.revision,
        role: edge.purpose === 'composition' ? 'scene' : edge.purpose,
        subjectId: edge.source,
        instruction: edge.instruction,
        usage: { purpose: edge.purpose, preserve: [], allow: [], shotIds: [], reviewed: false },
      },
    };
  });
  const model = execution.selection.parameters,
    mode = node.generation.mode;
  if (execution.selection.mode !== 'authored' && execution.selection.mode !== mode)
    throw new HttpError(409, '模型选择与节点模式不同，请重新选择对应模式');
  const bindings = assets.map((a, i) => ({
    id: refs[i].id,
    asset: { id: a.asset.id, revision: a.asset.revision },
    sha256: a.asset.data.sha256,
    purpose: refs[i].purpose!,
    instruction: refs[i].instruction,
    role: mode === 'ref2va' ? `reference_${a.asset.data.mediaType}` : a.reference.role,
    label: `<${a.asset.data.mediaType === 'video' ? 'Video' : a.asset.data.mediaType === 'audio' ? 'Audio' : 'Picture'} ${assets.slice(0, i + 1).filter((v) => v.asset.data.mediaType === a.asset.data.mediaType).length}>`,
    ...(data.version === 2 ? { mediaType: a.asset.data.mediaType } : {}),
    instanceIds: [refs[i].source],
    shotIds: [],
  }));
  let input: any = {
    ...(data.version === 2 ? { name: original!.title } : {}),
    canvas: { id: canvas.id, revision: canvas.revision },
    canvasNodeId: nodeId,
    modelExecution: execution,
    assets,
    dependencies: [
      { id: canvas.id, revision: canvas.revision },
      ...assets.map((a) => ({ id: a.asset.id, revision: a.asset.revision })),
      ...(projection?.dependencies || []),
    ],
    ...(projection
      ? { consumption: projection.consumption, shotSpecs: projection.shot ? [projection.shot] : [] }
      : {}),
  };
  if (node.type === 'image') {
    const edit = original?.settings?.imageEdit
      ? imageEditPlanSchema.parse(original.settings.imageEdit)
      : null;
    if (edit) {
      const source = assets.find(
        (a) => a.asset.id === edit.source.id && a.asset.revision === edit.source.revision,
      )?.asset;
      if (!source || mode !== 'edit')
        throw new HttpError(400, '编辑计划需要明确原图输入和编辑模式');
      if (
        edit.box &&
        (edit.box.x + edit.box.width > source.data.width ||
          edit.box.y + edit.box.height > source.data.height)
      )
        throw new HttpError(400, '重绘选区超出原图');
    }
    if (execution.protocol !== 'openai-images' || !['generate', 'edit'].includes(mode))
      throw new HttpError(400, '未实现此图片操作');
    if ((mode === 'generate' && assets.length) || (mode === 'edit' && !assets.length))
      throw new HttpError(400, '有参考图时使用编辑；纯文字使用生成');
    if (
      data.version === 2 &&
      assets.length + (edit?.action === 'inpaint' ? 1 : 0) >
        (execution.capabilities.maxReferenceImages || 0)
    )
      throw new HttpError(400, '参考图与局部重绘引导图合计超过当前图片模型输入上限');
    const finalPrompt = [
      ...bindings.map((b) => `${b.label}: ${b.purpose}. ${b.instruction}`),
      node.text,
      ...(edit ? [imageEditInstructions(edit)] : []),
    ].join('\n');
    input = {
      ...input,
      imageOperation: mode,
      ...(edit ? { imageEdit: edit } : {}),
      prepared: {
        rulesVersion: 'canvas-image-v1',
        finalPrompt,
        inputBindings: bindings,
        request: {
          model: execution.modelId,
          prompt: finalPrompt,
          n: model.n || 1,
          size: model.size || '1024x1024',
          quality: model.quality || 'auto',
        },
      },
    };
  } else {
    const caps = execution.capabilities,
      seconds = node.generation.seconds;
    if (
      !caps.modes.includes(mode) ||
      seconds < caps.minSeconds! ||
      seconds > caps.maxSeconds! ||
      (caps.integerSeconds && !Number.isInteger(seconds))
    )
      throw new HttpError(400, '模式或时长超出当前模型能力');
    const anchors = assets.filter((a) => ['first_frame', 'last_frame'].includes(a.reference.role!));
    if (new Set(anchors.map((a) => a.reference.role)).size !== anchors.length)
      throw new HttpError(400, '首帧或尾帧只能各指定一张');
    if (
      (mode === 't2v' && assets.length) ||
      (mode === 'i2v' && (!assets.length || anchors.length !== assets.length)) ||
      (mode === 'ref2va' &&
        (!assets.length ||
          assets.filter((a) => a.asset.data.mediaType === 'image').length >
            caps.maxReferenceImages!))
    )
      throw new HttpError(400, '模式与参考职责或数量不匹配');
    for (const kind of ['video', 'audio']) {
      const subset = assets.filter((a) => a.asset.data.mediaType === kind);
      if (subset.length > 3 || subset.reduce((s, a) => s + a.asset.data.duration, 0) > 15)
        throw new HttpError(400, 'H3 每类影音参考最多三份，合计不超过 15 秒');
    }
    if (execution.protocol !== 'comfy-h3' && mode === 'ref2va' && anchors.length)
      throw new HttpError(400, '此 API 参考模式未接入时间 Guide；请明确使用参考图或首尾帧模式');
    if (
      execution.protocol === 'ark-video' &&
      mode === 'i2v' &&
      !anchors.some((a) => a.reference.role === 'first_frame')
    )
      throw new HttpError(400, '方舟首尾帧模式需要首帧');
    const preservation = bindings
      .map((b) => `${b.label}: ${b.purpose}. ${b.instruction}`)
      .join('\n');
    const sound = node.generation.sound || 'N/A',
      music = node.generation.music || 'N/A';
    const h3 = execution.protocol !== 'ark-video';
    const prompt = h3
      ? [
          ...(mode === 'ref2va'
            ? [
                'subject_definitions:\n' + preservation,
                'summary:\n' + node.title,
                'retention_analysis:\n' + preservation,
              ]
            : assets.length
              ? ['image_alignment:\n' + preservation]
              : []),
          `${mode === 'ref2va' ? 'detailed_description' : 'integrated_multimodal_description'}:\n${node.text}`,
          'overall_soundscape:\n' + sound,
          'non_diegetic_music:\n' + music,
        ].join('\n\n')
      : `References:\n${preservation}\n\nAction:\n${node.text}\n\nSound:\n${sound}\nMusic: ${music}`;
    input = {
      ...input,
      width: model.width || 1024,
      height: model.height || 576,
      steps: model.steps || 8,
      seed: model.seed ?? 0,
      segment: {
        id: nodeId,
        shotIds: [],
        prompt,
        mode,
        duration: seconds,
        references: assets.map((a) => a.reference),
        guides: [],
      },
      templateVersion: execution.protocol === 'comfy-h3' ? 'canvas-h3-v1' : 'canvas-api-v1',
      prepared: {
        rulesVersion: h3 ? 'canvas-h3-v1' : 'canvas-seedance-v1',
        finalPrompt: prompt,
        inputBindings: bindings,
        frameCount:
          execution.protocol === 'comfy-h3' ? frameCount(seconds) : Math.round(seconds * 24),
        duration: seconds,
        images: [],
        subjects: [],
        anchors: [],
      },
    };
    if (execution.protocol === 'comfy-h3') {
      if (!execution.connection.data.instanceId)
        throw new HttpError(400, 'ComfyUI 连接缺少实例标识');
      input.profile = {
        baseUrl: execution.connection.data.baseUrl,
        instanceId: execution.connection.data.instanceId,
      };
      if (mode === 'ref2va') {
        input.segment.references = assets
          .filter((a) => !anchors.includes(a))
          .map((a) => a.reference);
        input.segment.guides = anchors.map((a) => ({
          assetId: a.asset.id,
          revision: a.asset.revision,
          frameIndex: a.reference.role === 'first_frame' ? 0 : -1,
          instruction: a.reference.instruction,
        }));
        input.segment.guidedPrompt = {
          summary: node.title,
          detailedDescription: '[Shot 1] ' + node.text,
          overallSoundscape: sound,
          nonDiegeticMusic: music,
        };
        const guided = prepareGuidedH3(input, { allowEmptyGuides: true });
        for (const binding of bindings) {
          const image = guided.images.find(
            (i) => i.key === `${binding.asset.id}:${binding.asset.revision}`,
          )!;
          binding.label = image.label;
          binding.role = ['first_frame', 'last_frame'].includes(binding.purpose)
            ? 'time_guide_and_text_reference'
            : 'reference_image';
        }
        input.prepared = { ...guided, rulesVersion: 'canvas-h3-v1', inputBindings: bindings };
      }
    } else {
      const adaptive = execution.protocol === 'minimax-video' && mode === 'i2v';
      if (adaptive && model.ratio)
        throw new HttpError(400, 'H3 首尾帧画幅取自输入图片，请移除固定比例');
      const min = execution.protocol === 'ark-video' ? 300 : 256;
      for (const { asset } of assets)
        if (
          asset.data.mediaType !== 'audio' &&
          (asset.data.width < min ||
            asset.data.height < min ||
            asset.data.width > 5760 ||
            asset.data.height > 5760 ||
            asset.data.width / asset.data.height < 0.4 ||
            asset.data.width / asset.data.height > 2.5)
        )
          throw new HttpError(400, '参考图片尺寸或比例超出视频 API 范围');
      if (
        assets.reduce(
          (n, a) => n + Math.ceil(a.asset.data.bytes / 3) * 4 + 512,
          Buffer.byteLength(prompt),
        ) >
        (data.version === 2 && execution.protocol === 'minimax-video' ? 64 : 60) * 1024 * 1024
      )
        throw new HttpError(400, '参考图片超出请求传输上限');
      input.prepared.request = {
        model: execution.modelId,
        content: [
          { type: 'text', text: prompt },
          ...bindings.map((b) => ({
            type: `${b.mediaType || 'image'}_url`,
            [`${b.mediaType || 'image'}_url`]: {
              url: `studio-asset:${b.asset.id}:${b.asset.revision}`,
            },
            role: b.role,
          })),
        ],
        duration: seconds,
        resolution: model.resolution || (h3 ? '768P' : '720p'),
        ratio: adaptive ? 'adaptive' : model.ratio || '16:9',
      };
    }
    const valid = new Set(bindings.map((b) => b.label));
    for (const m of input.prepared.finalPrompt.matchAll(/<(?:Picture|Video|Audio) \d+>/g))
      if (!valid.has(m[0])) throw new HttpError(400, 'Prompt 图片标签没有对应输入：' + m[0]);
  }
  if (data.version === 2) {
    input.prepared.rulesVersion = input.prepared.rulesVersion.replace(/v1$/, 'v2');
    if (input.templateVersion) input.templateVersion = input.templateVersion.replace(/v1$/, 'v2');
    input.canvasSemantic = { nodeId, type: original!.type, binding: original!.binding || null };
  }
  const digestInput = structuredClone(input);
  if (data.version === 2) {
    delete digestInput.canvas;
    digestInput.dependencies = digestInput.dependencies.filter((r: any) => r.id !== canvas.id);
  }
  return {
    input,
    digest: generationDigest(digestInput),
    projectId: canvas.projectId,
    episodeId: data.episodeId,
    warnings: ['画风、身份、动作与声音仍需依据实际结果判断；生成成功不代表质量通过。'],
  };
}
