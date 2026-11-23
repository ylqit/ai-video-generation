export interface ValidationCase {
  id: string;
  family: 'identity' | 'action' | 'narrative';
  scenario: string;
  repeat: number;
  seed: number;
  condition: 'A' | 'B' | 'shared';
  dependsOn: string[];
  difference: string;
  requiredAssets: string[];
  checks: string[];
}

// Preregistered screening matrix. These are planned attempts, never job commands.
export function validationCases(seeds: [number, number]): ValidationCase[] {
  const cases: ValidationCase[] = [];
  seeds.forEach((seed, index) => {
    const repeat = index + 1;
    for (const scenario of ['front', 'three_quarter', 'turn_return', 'two_subjects'])
      for (const condition of ['A', 'B'] as const)
        cases.push({
          id: `identity-${scenario}-${repeat}-${condition}`,
          family: 'identity',
          scenario,
          repeat,
          seed,
          condition,
          dependsOn: [],
          difference:
            condition === 'A'
              ? '共同视觉规范与相同构图首帧；不增加身份槽'
              : '保持 A 的契约、首帧及参数；只增加本镜可见主体的固定身份参考槽',
          requiredAssets: [
            `composition:${scenario}`,
            ...(condition === 'B'
              ? ['identity:lead', ...(scenario === 'two_subjects' ? ['identity:peer'] : [])]
              : []),
          ],
          checks: [
            'identity_drift',
            'identity_swap',
            'wardrobe_leak',
            'occlusion_recovery',
            'unexpected_voice',
          ],
        });
    for (const scenario of ['notebook_handoff', 'cover_damage']) {
      const upstream = `action-${scenario}-${repeat}-upstream`;
      cases.push({
        id: upstream,
        family: 'action',
        scenario,
        repeat,
        seed,
        condition: 'shared',
        dependsOn: [],
        difference: '共用前段；播放后确认实际采用边界与动作阶段',
        requiredAssets: [`composition:${scenario}`, 'identity:lead'],
        checks: ['required_event', 'boundary_known', 'unexpected_voice'],
      });
      for (const condition of ['A', 'B'] as const)
        cases.push({
          id: `action-${scenario}-${repeat}-${condition}`,
          family: 'action',
          scenario,
          repeat,
          seed,
          condition,
          dependsOn: [upstream],
          difference:
            condition === 'A'
              ? '独立准备、状态正确的构图起点'
              : '从共同前段实际采用边界派生起点；相同后段契约',
          requiredAssets:
            condition === 'A' ? [`continuation:${scenario}`] : [`adopted_boundary:${upstream}`],
          checks: [
            'action_restart',
            'skipped_phase',
            'direction',
            'contact',
            'holding',
            'sound_join',
          ],
        });
    }
    const first = `narrative-${repeat}-shared`;
    cases.push({
      id: first,
      family: 'narrative',
      scenario: 'conceal_damage',
      repeat,
      seed,
      condition: 'shared',
      dependsOn: [],
      difference: '共同首段：破损模型被笔记本遮住；不得恢复完好',
      requiredAssets: ['composition:conceal_damage', 'identity:lead'],
      checks: ['conceal_completed', 'damage_retained', 'unexpected_voice'],
    });
    for (const condition of ['A', 'B'] as const)
      for (const step of [2, 3])
        cases.push({
          id: `narrative-${repeat}-${condition}-${step}`,
          family: 'narrative',
          scenario: step === 2 ? 'peer_arrives' : 'deliberate_reveal',
          repeat,
          seed,
          condition,
          dependsOn: [step === 2 ? first : `narrative-${repeat}-${condition}-2`],
          difference:
            condition === 'A'
              ? '当前已采用的表达方案；保留全部状态与引用校验'
              : '相同事实；只加强当前状态、事件顺序、不得提前揭示的实验文字方案',
          requiredAssets: [
            `adopted_boundary:${step === 2 ? first : `narrative-${repeat}-${condition}-2`}`,
          ],
          checks: [
            'early_presence',
            'early_reveal',
            'state_reset',
            'ending_undone',
            'event_order',
            'sound_join',
          ],
        });
  });
  return cases;
}

export const validationControls = {
  style: '校园二维日漫',
  subjectCount: 2,
  visibleDialogue: false,
  protocol: 'comfy-h3',
  mode: 'ref2va',
  width: 1024,
  height: 576,
  fps: 24,
  secondsPerRequest: 10,
  videoRequestLimit: 38,
  requestedSecondsLimit: 380,
  imageRequests: 0,
  textRequestLimit: 8,
  automaticRepairs: 0,
  primaryEdit: 'hard_cut',
  seedGuarantee: 'paired_only_not_exact_reproducibility',
  stoppedUpstream: 'record_not_ready_no_replacement',
  thirdNarrativeSegment: 'cumulative_chain_if_actual_branches_diverge',
} as const;

export const textValidationCases = [
  'idea-1',
  'idea-2',
  'prose-1',
  'prose-2',
  'screenplay-1',
  'screenplay-2',
  'season-1',
  'season-2',
];
