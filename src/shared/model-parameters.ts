import type { ModelCapabilities, ModelProtocol } from './models.js';
export interface ModelParameterField {
  key: string;
  label: string;
  type: 'number' | 'select';
  values?: string[];
  min?: number;
  max?: number;
  step?: number;
}
/** Executable parameter catalog, shared by validation and the node editor. Protocol takes precedence over the broad model kind. */
export function modelParameterFields(
  protocol: ModelProtocol,
  c: ModelCapabilities,
): ModelParameterField[] {
  if (['codex', 'sync-lipsync'].includes(protocol) || c.kind === 'speech') return [];
  if (protocol === 'comfy-h3')
    return [
      { key: 'width', label: '宽度', type: 'number', min: 64, step: 32 },
      { key: 'height', label: '高度', type: 'number', min: 64, step: 32 },
      { key: 'steps', label: '步数', type: 'number', min: 1 },
      { key: 'seed', label: '种子', type: 'number', min: 0 },
    ];
  if (c.kind === 'text')
    return [
      { key: 'maxOutputTokens', label: '输出 Token 上限', type: 'number', min: 1, max: 100000 },
      { key: 'temperature', label: 'Temperature', type: 'number', min: 0, max: 2, step: 0.1 },
    ];
  if (c.kind === 'image')
    return [
      { key: 'size', label: '尺寸', type: 'select', values: c.sizes },
      { key: 'quality', label: '质量', type: 'select', values: c.qualities },
      { key: 'n', label: '张数', type: 'number', min: 1, max: 4 },
    ];
  return [
    { key: 'resolution', label: '分辨率', type: 'select', values: c.resolutions },
    { key: 'ratio', label: '画幅', type: 'select', values: c.ratios },
  ];
}
export function generationCompatibility(
  generation: any,
  protocol: ModelProtocol,
  caps: ModelCapabilities,
) {
  const issues: string[] = [],
    fields = modelParameterFields(protocol, caps);
  if (!caps.modes.includes(generation.mode))
    issues.push('当前模式 ' + generation.mode + ' 不受新模型支持，请明确改选');
  for (const [key, value] of Object.entries(generation.model.parameters)) {
    const field = fields.find((f) => f.key === key);
    if (!field || (field.values && !field.values.includes(String(value))))
      issues.push('参数 ' + key + '=' + value + ' 不适用；原值保留，需明确调整');
  }
  if (
    caps.kind === 'video' &&
    ((caps.minSeconds && generation.seconds < caps.minSeconds) ||
      (caps.maxSeconds && generation.seconds > caps.maxSeconds))
  )
    issues.push('请求时长不在当前模型范围内');
  return issues;
}
