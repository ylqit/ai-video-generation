import { creativeModuleSchema, type CreativeModule } from '../shared/creative-modules.js';

// Original authored methods. Repository references inform the separation of concerns;
// these records contain no copied third-party prompts and have no runtime reference dependency.
const sources = [
  {
    title: 'Studio 原创组合规则',
    location: 'src/server/creative-catalog.ts',
    license: '本次原创；Studio 尚未单独声明新增规则许可证',
    note: '按职责拆分，适用性由镜头审核和真实视频验证。',
  },
  {
    title: 'Toonflow 美术与叙事技法的职责分离（设计借鉴）',
    location:
      '../reference/Toonflow-app/data/skills/art_skills/2D_90s_japanese_anime/README.md; ../reference/Toonflow-app/data/skills/story_skills/Scifi_post_apocalypse/README.md',
    license: '源仓库 LICENSE 为 Apache-2.0；此处重写方法，未复制模板正文或图片',
    note: '保留专业职责拆分，去除日漫与怀旧暖色、科幻与末世的强制绑定。',
  },
  {
    title: '本地教程与 H3 提示词指南对应记录',
    location: 'docs/CREATIVE_MODULE_SOURCES.md',
    license: '原教程未确认再分发许可，仅保留方法摘要、路径及指纹',
    note: '运行时不读取根 docs 或 reference；实际加载的是工程随附规则和固定模块记录。',
  },
];
const common = {
  formatVersion: 1,
  scope: '可与其他类别独立组合；明确镜头设计优先，已确认事实不得被模块默认值改写。',
  sources,
  limitations: [
    '建议不证明模型已经支持；连续动作须播放审核，声音须实际听审。',
    '画风、技术或魔法标签不能替代已确认的事实和规则。',
  ],
};
const visuals = [
  {
    id: 'modern-anime',
    name: '现代二维日漫',
    representation: 'anime_2d',
    line: 'Crisp controlled ink contours with deliberate line weight.',
    proportions: 'Consistent stylized adult anatomy; graphic facial planes.',
    materials: 'Graphic color regions; preserve cloth folds without photographic skin pores.',
    shading: 'Two or three deliberate cel-shaded values; stable hard shadow shapes.',
    palette: 'Controlled local colors and a restrained accent palette.',
    backgrounds: 'Painted perspective backgrounds with matching graphic contrast.',
    effects:
      'Designed graphic effects with readable silhouettes, no accidental photoreal particles.',
    motion: 'Clear anticipation, key poses and follow-through; stable drawings during turns.',
  },
  {
    id: 'soft-anime',
    name: '柔和手绘日漫',
    representation: 'hand_drawn',
    line: 'Soft hand-drawn contours with restrained irregularity.',
    proportions: 'Stable gently stylized adult proportions and expressive eyes.',
    materials: 'Visible painted texture and soft pigment variation.',
    shading: 'Soft painted tonal transitions; avoid abrupt CG specular highlights.',
    palette:
      'Muted coordinated pigments; atmosphere follows the chosen environment, not a compulsory warm palette.',
    backgrounds: 'Hand-painted environments sharing texture and edge softness with characters.',
    effects: 'Painterly atmospheric effects integrated with the illustration.',
    motion: 'Legible modest motion; preserve paint texture and facial design through time.',
  },
  {
    id: 'stylized-3d',
    name: '风格化三维',
    representation: 'stylized_3d',
    line: 'Volume-defined contours rather than mandatory ink outlines.',
    proportions: 'Deliberate stylized proportions with consistent joint and prop scale.',
    materials: 'Designed physically coherent cartoon materials with restrained microtexture.',
    shading: 'Soft volumetric lighting with grounded contact shadows.',
    palette: 'Art-directed local colors; no prescribed warm urban setting.',
    backgrounds: 'Environments use the same material and geometric simplification.',
    effects: 'Volumetric but readable effects with stable scale.',
    motion:
      'Weight, anticipation, contact and recovery remain visible; avoid rubbery uncontrolled deformation.',
  },
  {
    id: 'film-cg',
    name: '写实电影 CG',
    representation: 'realistic_cg',
    line: 'Geometry and lighting define contours; no ink outlines.',
    proportions: 'Plausible adult proportions and consistent object dimensions.',
    materials: 'Physically plausible skin, fabric, metal and surface roughness.',
    shading: 'Motivated key light, believable indirect light and contact shadows.',
    palette: 'Coherent cinematic grade with protected material color identity.',
    backgrounds: 'Detailed coherent CG environment, matching lens perspective and light.',
    effects: 'Effects illuminate nearby surfaces and obey authored source and propagation rules.',
    motion: 'Plausible mass, inertia and articulated contact; avoid weightless sliding.',
  },
  {
    id: 'live-action',
    name: '写实真人电影',
    representation: 'live_action',
    line: 'Photographic edges and natural optical falloff.',
    proportions: 'Natural adult anatomy and stable facial identity.',
    materials: 'Natural skin texture, fabric weave and credible wear.',
    shading: 'Motivated practical lighting with stable exposure across motion.',
    palette: 'Consistent photographic grade; preserve skin and costume color.',
    backgrounds: 'Credible live-action location with consistent lens and depth cues.',
    effects: 'Effects blend with live-action exposure and environmental response.',
    motion: 'Natural attention shifts, hand contact, breathing and restrained performance.',
  },
] as const;
const records: { key: string; data: CreativeModule }[] = visuals.map(({ id, name, ...spec }) => ({
  key: id,
  data: creativeModuleSchema.parse({
    ...common,
    category: 'visual',
    name,
    responsibility: '统一人物、场景、道具、效果和运动中的媒介表现。',
    spec,
    stageRules: {
      series_plan: ['只制定美术媒介与一致性规范，不因媒介选择推断故事题材或人物性格。'],
      episode_script: ['保持事件和人物选择；画风变化不能改写已确认事实。'],
      shot_plan: [
        `落实以下运动表现：${spec.motion}`,
        '分别说明线条、阴影、材质、背景融合与动作关键姿态；为转身和接触准备必要视图。',
      ],
      asset_requirements: [
        Object.values(spec).slice(1).join(' '),
        '角色、环境、道具和效果统一审核。单张总览不能替代独立视图。',
      ],
      repair: ['只修订出现漂移的维度及受影响镜头，保留已采用的历史候选。'],
    },
    references: [
      '正式身份角度与本镜头可见结构',
      '同媒介的场景、关键道具与效果样例；首帧须符合目标画幅',
    ],
    examples: [
      {
        good: `${spec.shading} ${spec.motion}`,
        bad: '某公司风格，质量最高，超级电影感。',
        reason: '可观察的外观和动作要求才可追溯到参考与审核项。',
      },
    ],
    checks: [
      '首、中、末帧的媒介、比例、材质是否一致',
      '连续播放中的风格漂移、接触、脸手变化',
      '角色与环境是否融为同一美术体系',
    ],
  }),
}));
const worlds = [
  {
    key: 'urban',
    name: '都市',
    society: 'Everyday contemporary institutions, work and shared living spaces.',
    mechanisms: [
      'Establish access, ownership, schedules and practical obligations before a conflict.',
    ],
    costs: ['Time, trust, work responsibility and physical constraints.'],
    spatialRules: ['Show doors, routes, shared spaces and the location of consequential objects.'],
    forbiddenAssumptions: [
      'Do not infer supernatural powers, romance or criminal conspiracy from an urban label.',
    ],
  },
  {
    key: 'science-fiction',
    name: '科幻',
    society:
      'An explicitly designed technological society; its everyday operation must be understandable.',
    mechanisms: [
      'Introduce each consequential device through an observable operation.',
      'Define energy source, capacity, interface and failure condition before the payoff.',
    ],
    costs: ['Show what is lost when a finite technical resource is consumed.'],
    spatialRules: [
      'Keep airlocks, powered barriers, controls and safe routes geographically stable.',
    ],
    forbiddenAssumptions: [
      'Science fiction does not automatically imply apocalypse, unlimited energy or sentient machines.',
    ],
  },
  {
    key: 'western-fantasy',
    name: '欧美奇幻',
    society:
      'A specifically authored fantasy culture, with institutions and material life independent of visual style.',
    mechanisms: [
      'Establish magic source, range, capacity, duration and barrier conditions before decisive use.',
    ],
    costs: ['Every decisive spell respects its established resource cost and trade-off.'],
    spatialRules: [
      'Make protected and exposed areas, approach routes and magical boundaries readable.',
    ],
    forbiddenAssumptions: [
      'Do not invent races, gods, prophecies or resurrection rules without approval.',
    ],
  },
  {
    key: 'campus',
    name: '校园',
    society: 'Study, clubs and peer responsibility; specify ages and institutional setting.',
    mechanisms: ['Make shared responsibilities, access rules and deadlines concrete.'],
    costs: ['Choices affect trust, effort, opportunity and repair obligations.'],
    spatialRules: [
      'Establish classroom or clubroom entrances, shared work surfaces and who can observe an action.',
    ],
    forbiddenAssumptions: [
      'Campus does not imply romance, bullying, adolescent characters or a particular animation style.',
    ],
  },
];
for (const { key, name, ...spec } of worlds)
  records.push({
    key,
    data: creativeModuleSchema.parse({
      ...common,
      category: 'world',
      name,
      responsibility: '提供生活、技术或魔法的具体机制与行动成本，保持已确认世界事实。',
      spec,
      stageRules: {
        source_events: ['提取已给出的事实与证据；未明确的世界规则保留为待确认建议。'],
        series_plan: [spec.society, ...spec.mechanisms, ...spec.forbiddenAssumptions],
        episode_script: [...spec.costs, '每次行动结果必须来自已建立的世界规则。'],
        shot_plan: [...spec.spatialRules, '通过可见操作交代机制，不依赖解释性旁白修复因果。'],
        asset_requirements: ['制作关键设施、接口、容器及状态变化的明确参考。'],
        repair: ['区分修改世界事实和修正生成错误，禁止后者自动进入剧情状态。'],
      },
      references: ['关键设施与世界机制的可见载体', '出入口和行动成本所需的空间参考'],
      examples: [
        {
          good: spec.mechanisms[0],
          bad: '科幻所以自动出现无穷能源。',
          reason: '题材方法帮助建立规则，不替用户确认事实。',
        },
      ],
      checks: ['关键规则是否在回收前展示', '资源数量与代价是否保留', '场景操作是否具体且可理解'],
    }),
  });
const narratives = [
  {
    key: 'growth',
    name: '成长',
    centralQuestion: 'What responsibility does the protagonist initially avoid?',
    choice:
      'Offer a concrete alternative, then make the protagonist choose responsibility at a cost.',
    causality: 'The new action changes the practical outcome.',
    information: 'Show the initial limitation before the consequential choice.',
    payoff: 'End on an observable changed behavior, not an unearned reward.',
  },
  {
    key: 'relationship',
    name: '关系',
    centralQuestion: 'What does one character misunderstand or undervalue about another?',
    choice: 'Make care or trust observable through a costly action.',
    causality: 'The action changes how the other character responds.',
    information: 'Let reactions reveal a changing understanding without redundant exposition.',
    payoff: 'Close on a changed interaction while preserving the cost.',
  },
  {
    key: 'mystery',
    name: '悬疑',
    centralQuestion: 'What concrete discrepancy demands explanation?',
    choice: 'The investigator must test a plausible belief through action.',
    causality: 'Clues support the eventual explanation and disprove the initial inference.',
    information:
      'Track world truth, character belief and audience knowledge separately; never fabricate a hidden clue at the reveal.',
    payoff: 'Revisit visible evidence so the viewer can understand the corrected interpretation.',
  },
  {
    key: 'adventure',
    name: '冒险',
    centralQuestion: 'What goal requires entering or crossing danger?',
    choice: 'Force a meaningful trade-off between incompatible goals.',
    causality: 'Tools, allies and rules established earlier enable the resolution.',
    information: 'Make routes, threat and available resources understandable before action.',
    payoff: 'Resolve the immediate goal and show the resulting loss or responsibility.',
  },
];
for (const { key, name, ...spec } of narratives)
  records.push({
    key,
    data: creativeModuleSchema.parse({
      ...common,
      category: 'narrative',
      name,
      responsibility: '组织目标、阻力、信息、选择、行动与回报，不绑定题材或画风。',
      spec,
      stageRules: {
        series_plan: [
          spec.centralQuestion,
          spec.payoff,
          '先完成整体故事的核心问题、结局方向、人物变化和跨集铺垫，再按需展开。',
        ],
        episode_script: [
          spec.choice,
          spec.causality,
          spec.information,
          '每场记录进入状态、阻力、选择、结果和离开状态。',
        ],
        shot_plan: ['每个镜头只承担可观察的主要事件；安排反应与因果衔接，记录必须事件。'],
        repair: ['局部修改同时核对伏笔与回收，不扩大到无关镜头。'],
      },
      references: ['人物行为与反应所需的正式身份参考', '提供因果证据的道具与状态图片'],
      examples: [
        {
          good: spec.choice,
          bad: '增加热血或悬疑形容词，但人物没有作出选择。',
          reason: '叙事必须落实为行动及可见后果。',
        },
      ],
      checks: [
        '不读制作文档能否理解目标与结果',
        '转折是否有前置依据',
        '代价与人物变化是否在结尾可见',
      ],
    }),
  });
const directions = [
  {
    key: 'epic',
    name: '史诗',
    scale: 'Relate human-sized choices to a clearly established large environment.',
    framing:
      'Use motivated wide establishing views and selected low angles; preserve readable silhouettes.',
    performance: 'Purposeful restrained choices remain legible at the selected shot scale.',
    rhythm: 'Contrast scale-setting pauses with decisive actions and aftermath.',
    sound: 'Environmental scale and consequential effects; no mandatory music or crowds.',
  },
  {
    key: 'intimate',
    name: '亲密克制',
    scale: 'Focus on meaningful small actions and interpersonal distance.',
    framing: 'Use motivated medium and close framing without hiding causal objects.',
    performance:
      'Stimulus, fixed attention target, decision, action and reaction; avoid unfocused eye wandering.',
    rhythm: 'Allow a readable reaction and quiet consequence after action.',
    sound: 'Clear local details, breathing and concise dialogue when required.',
  },
  {
    key: 'tense',
    name: '紧张',
    scale: 'Make danger, distance and limited opportunity measurable to the viewer.',
    framing: 'Restrict information intentionally, but show every clue required for understanding.',
    performance: 'Attention remains directed toward the authored threat or objective.',
    rhythm: 'Build anticipation and shorten action beats only after geography is established.',
    sound:
      'Use motivated approaching sounds and deliberate silence; do not substitute noise for stakes.',
  },
];
for (const { key, name, ...spec } of directions)
  records.push({
    key,
    data: creativeModuleSchema.parse({
      ...common,
      category: 'direction',
      name,
      responsibility: '将创作意图落实为表演、景别、机位、空间、节奏与声音。',
      spec,
      stageRules: {
        series_plan: [spec.scale],
        episode_script: [spec.rhythm, '明确观众应看到的选择和反应。'],
        shot_plan: [
          spec.framing,
          spec.performance,
          spec.sound,
          '明确镜头设计覆盖默认建议。数值空间用于检查，同时编写已审核的可见空间英文描述。',
        ],
        asset_requirements: [
          '提供服务于构图、视线目标与动作状态的参考，不将机位示意自动作为正式美术。',
        ],
        repair: ['修订刺激来源、关注对象、动作目标或节奏，不仅替换形容词。'],
      },
      references: ['构图与视线目标参考', '关键事件的开始和结束状态'],
      examples: [
        {
          good: spec.performance,
          bad: '史诗感等于永远低角度、宏大配乐和大量人物。',
          reason: '表现方法应服务本镜头任务，不强制污染内容。',
        },
      ],
      checks: [
        '关注对象是否稳定可辨',
        '空间和必须动作是否真正可见',
        '镜头尺度与声音是否服务人物选择',
      ],
    }),
  });
export const creativeCatalog = records.map((r) => ({ ...r, catalogVersion: 2 }));
