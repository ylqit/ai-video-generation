import { validateShotCues } from './authoring-timing.js';
import { validateStaging } from './authoring-staging.js';
import {
  durationBounds,
  H3_CREATION_CAPABILITIES,
  type AuthoringResult,
  type AuthoringStage,
  type CreationIssue,
  type CreationSettings,
  type DirectorResult,
  type ScriptResult,
} from './creation.js';

/** Validate declared authoring facts. Prose quality and actual media truth remain separate. */
export function validateAuthoringResult(
  result: AuthoringResult,
  prior: Partial<Record<AuthoringStage, AuthoringResult>>,
  settings: CreationSettings,
): CreationIssue[] {
  const issues: CreationIssue[] = [];
  const add = (
    code: string,
    category: CreationIssue['category'],
    field: string,
    message: string,
    severity: CreationIssue['severity'] = 'blocking',
  ) => issues.push({ code, category, field, message, severity, stage: result.stage, targetId: '' });
  const unique = (values: string[], field: string) => {
    if (new Set(values).size !== values.length)
      add('duplicate_identity', 'data', field, `${field} 存在重复标识`);
  };
  unique(
    result.sources.map((r) => `${r.id}:${r.revision}`),
    'sources',
  );
  if (result.contentChange === 'revision_requested')
    add(
      'script_revision_required',
      'consistency',
      'contentChange',
      '内容改编必须先形成并确认新的剧本版本',
    );
  for (const question of result.openQuestions)
    add('creative_decision', 'quality', 'openQuestions', question, 'review');
  if (result.stage === 'brief') {
    unique(
      result.lockedFacts.map((f) => f.id),
      'lockedFacts',
    );
  }
  const script = prior.script?.stage === 'script' ? prior.script : null;
  const director = prior.director?.stage === 'director' ? prior.director : null;
  if (result.stage === 'script') {
    unique(
      result.subjects.map((s) => s.key),
      'subjects',
    );
    unique(
      result.scenes.map((s) => s.id),
      'scenes',
    );
    const lines = result.scenes.flatMap((s) => s.dialogue),
      events = result.scenes.flatMap((s) => s.events);
    unique(
      lines.map((d) => d.id),
      'dialogue',
    );
    unique(
      events.map((e) => e.id),
      'events',
    );
    for (const subject of result.subjects) {
      unique(
        subject.attributes.map((a) => a.key),
        `subjects.${subject.key}.attributes`,
      );
      for (const attribute of subject.attributes)
        unique(attribute.values, `subjects.${subject.key}.${attribute.key}.values`);
    }
    if (!result.screenplayText.trim() || !result.scenes.length)
      add('script_incomplete', 'consistency', 'scenes', '剧本需要完整正文和至少一个场景');
    const facts = prior.brief?.stage === 'brief' ? prior.brief.lockedFacts : [];
    for (const line of lines) {
      if (!result.subjects.some((s) => s.key === line.speakerKey))
        add('unknown_speaker', 'data', `dialogue.${line.id}`, '说话人未在主体中声明');
      if (!result.screenplayText.includes(line.text))
        add(
          'dialogue_text_mismatch',
          'consistency',
          `dialogue.${line.id}`,
          '结构化对白与剧本正文不一致',
        );
      if (line.sourceFactId) {
        const original = facts.find((f) => f.id === line.sourceFactId);
        if (!original || original.kind !== 'dialogue' || original.statement !== line.text)
          add(
            'locked_dialogue_changed',
            'consistency',
            `dialogue.${line.id}`,
            '锁定对白必须逐字保留',
          );
      }
    }
    for (const event of events)
      for (const id of event.sourceFactIds)
        if (!facts.some((f) => f.id === id))
          add('unknown_source_fact', 'data', `events.${event.id}`, `来源事实不存在：${id}`);
    for (const fact of facts) {
      if (fact.kind === 'dialogue' && !lines.some((l) => l.sourceFactId === fact.id))
        add('locked_dialogue_missing', 'consistency', 'dialogue', `遗漏锁定对白 ${fact.id}`);
      if (
        ['event', 'ending', 'claim'].includes(fact.kind) &&
        !events.some((e) => e.sourceFactIds.includes(fact.id))
      )
        add('locked_event_missing', 'consistency', 'events', `遗漏锁定事实 ${fact.id}`);
    }
  }
  if (result.stage === 'direction' && !result.visual.trim())
    add(
      'direction_incomplete',
      'consistency',
      'visual',
      '需要明确画面呈现方向；不限定色板数量或风格类型',
    );
  if (result.stage === 'director') {
    if (!script) {
      add('source_script_required', 'consistency', 'shots', '导演计划需要已采用剧本');
      return issues;
    }
    issues.push(...validateStaging(result, script));
    unique(
      result.shots.map((s) => s.id),
      'shots',
    );
    unique(
      result.groups.map((g) => g.id),
      'groups',
    );
    const covered = result.groups.flatMap((g) => g.shotIds);
    unique(covered, 'groups.shotIds');
    if (
      !result.shots.length ||
      result.shots.some((s) => !covered.includes(s.id)) ||
      covered.some((id) => !result.shots.some((s) => s.id === id))
    )
      add('shot_coverage', 'consistency', 'groups', '每个镜头必须恰好属于一个制作单元');
    const events = script.scenes.flatMap((s) => s.events),
      lines = script.scenes.flatMap((s) => s.dialogue);
    const completed = new Set<string>(),
      started = new Set<string>(),
      spoken = new Set<string>();
    let previous: DirectorResult['shots'][number] | undefined;
    for (const group of result.groups) {
      if (
        ['ellipsis', 'location_change', 'flashback'].includes(group.transition) &&
        !group.reason.trim()
      )
        add(
          'transition_reason',
          'consistency',
          `groups.${group.id}`,
          '时间省略、换场或历史段需要明确理由',
        );
      if (group.transition !== 'continuous') previous = undefined;
      for (const id of group.shotIds) {
        const shot = result.shots.find((s) => s.id === id);
        if (!shot) continue;
        const field = `shots.${id}`;
        const scene = script.scenes.find((s) => s.id === shot.sceneId);
        if (!scene) add('unknown_scene', 'data', field, '镜头场景不存在');
        for (const subjectKey of shot.visibleSubjectKeys)
          if (!script.subjects.some((s) => s.key === subjectKey))
            add('unknown_subject', 'data', field, `主体不存在：${subjectKey}`);
        if (!shot.action.trim())
          add(
            'action_missing',
            'consistency',
            `${field}.action`,
            '需要可执行的画面动作；可以保留不确定的空间坐标',
          );
        unique(shot.visibleSubjectKeys, `${field}.visibleSubjectKeys`);
        unique(
          shot.events.map((e) => e.eventId),
          `${field}.events`,
        );
        unique(
          shot.performances.map((p) => p.id),
          `${field}.performances`,
        );
        for (const problem of validateShotCues(shot))
          add(problem.code, 'data', `${field}.cues`, problem.message);
        const speechCues = shot.cues.filter((c) => c.target.kind === 'dialogue' && c.window);
        for (let i = 0; i < speechCues.length; i++)
          for (let j = i + 1; j < speechCues.length; j++) {
            const a = speechCues[i],
              b = speechCues[j];
            const speaker = (c: typeof a) =>
              lines.find((l) => c.target.kind === 'dialogue' && l.id === c.target.lineId)
                ?.speakerKey;
            if (
              speaker(a) === speaker(b) &&
              a.window!.startFrame < b.window!.endFrame &&
              b.window!.startFrame < a.window!.endFrame
            )
              add(
                'speaker_overlap',
                'quality',
                `${field}.cues`,
                '同一说话人的对白窗口重叠，请核对声音安排',
                'review',
              );
          }
        if (
          !shot.performances.length &&
          shot.visibleSubjectKeys.some((key) =>
            script.subjects.some((s) => s.key === key && ['human', 'animal'].includes(s.kind)),
          )
        )
          add(
            'performance_detail',
            'quality',
            `${field}.performances`,
            '本镜人物表演尚未细化，请按剧情需要补充',
            'review',
          );
        for (const performance of shot.performances)
          if (!shot.visibleSubjectKeys.includes(performance.subjectKey))
            add('performance_subject', 'consistency', field, '表演对象必须在本镜主体中');
        for (const placement of shot.dialogue) {
          const lineId = placement.lineId;
          const line = lines.find((l) => l.id === lineId);
          if (
            line &&
            placement.delivery === 'onscreen' &&
            !shot.visibleSubjectKeys.includes(line.speakerKey)
          )
            add('onscreen_presence', 'data', field, '画内对白说话人必须可见');
          if (
            line &&
            placement.delivery === 'offscreen' &&
            shot.visibleSubjectKeys.includes(line.speakerKey)
          )
            add(
              'offscreen_presence',
              'data',
              field,
              '画外对白说话人不能同时列为本镜可见；镜内出场变化请拆镜',
            );
          if (!line || !scene?.dialogue.some((d) => d.id === lineId))
            add('unknown_dialogue', 'data', field, `对白不属于当前场景：${lineId}`);
          if (spoken.has(lineId))
            add('dialogue_repeated', 'consistency', field, `同一对白不能在后镜重演：${lineId}`);
          spoken.add(lineId);
        }
        for (const event of shot.events) {
          if (
            !events.some((e) => e.id === event.eventId) ||
            !scene?.events.some((e) => e.id === event.eventId)
          )
            add('unknown_event', 'data', field, `事件不属于当前场景：${event.eventId}`);
          if (completed.has(event.eventId) && group.transition !== 'flashback')
            add(
              'completed_action_repeated',
              'consistency',
              field,
              `事件已完成，不能在后镜重新执行：${event.eventId}`,
            );
          if (event.phase === 'start' || event.phase === 'whole') started.add(event.eventId);
          else if (!started.has(event.eventId) && group.transition !== 'flashback')
            add('action_start_missing', 'consistency', field, `动作需要开始阶段：${event.eventId}`);
          if (event.phase === 'complete' || event.phase === 'whole') completed.add(event.eventId);
        }
        for (const value of [...shot.entryState, ...shot.exitState]) {
          const definition = script.subjects
            .find((s) => s.key === value.subjectKey)
            ?.attributes.find((a) => a.key === value.key);
          if (
            !definition ||
            (value.value !== null &&
              (definition.type === 'boolean'
                ? typeof value.value !== 'boolean'
                : definition.type === 'number'
                  ? typeof value.value !== 'number'
                  : !definition.values.includes(String(value.value))))
          )
            add(
              'invalid_state_value',
              'data',
              field,
              `状态未声明或取值无效：${value.subjectKey}.${value.key}`,
            );
        }
        for (const relation of [...shot.entryRelations, ...shot.exitRelations]) {
          if (
            ![relation.objectKey, relation.targetKey].every((k) =>
              script.subjects.some((s) => s.key === k),
            )
          )
            add('unknown_relation_subject', 'data', field, '关系对象未在剧本中声明');
        }
        for (const side of ['entryState', 'exitState'] as const)
          unique(
            shot[side].map((s) => `${s.subjectKey}.${s.key}`),
            `${field}.${side}`,
          );
        if (previous)
          for (const value of shot.entryState) {
            const end = previous.exitState.find(
              (v) => v.subjectKey === value.subjectKey && v.key === value.key,
            );
            if (end && end.value !== null && value.value !== null && end.value !== value.value)
              add(
                'planned_boundary_conflict',
                'consistency',
                field,
                `计划边界状态冲突：${value.subjectKey}.${value.key}`,
              );
          }
        previous = shot;
      }
    }
    for (const line of lines)
      if (!spoken.has(line.id))
        add('dialogue_missing', 'consistency', 'shots', `遗漏剧本对白 ${line.id}`);
    for (const event of events)
      if (!completed.has(event.id))
        add('event_incomplete', 'consistency', 'shots', `来源事件尚未完整呈现 ${event.id}`);
    const frames = result.shots.reduce((n, s) => n + s.frames, 0),
      bounds = durationBounds(settings.duration);
    if (bounds && (frames < bounds.minFrames || frames > bounds.maxFrames))
      add(
        'duration_intent',
        'consistency',
        'shots.frames',
        `计划 ${frames} 帧不在交付范围 ${bounds.minFrames}–${bounds.maxFrames} 帧内`,
      );
  }
  if (result.stage === 'assets') {
    unique(
      result.items.map((i) => i.id),
      'items',
    );
    for (const item of result.items) {
      const director = prior.director?.stage === 'director' ? prior.director : null;
      for (const coverage of item.coverage || []) {
        const shot = director?.shots.find((s) => s.id === coverage.shotId);
        if (
          !shot ||
          (item.shotIds.length && !item.shotIds.includes(coverage.shotId)) ||
          coverage.interactionIds.some((id) => !shot.interactions?.some((i) => i.id === id))
        )
          add(
            'reference_coverage_target',
            'data',
            `items.${item.id}.coverage`,
            '参考覆盖必须指向需求范围内的镜头和真实交互',
          );
        if (
          coverage.interactionIds.length &&
          (!coverage.aspects.includes('interaction') ||
            ['identity', 'appearance'].includes(item.purpose))
        )
          add(
            'reference_coverage_purpose',
            'data',
            `items.${item.id}.coverage`,
            '身份参考不能自动证明交互；请明确相应的构图或空间审查用途',
          );
      }
      if (!script?.subjects.some((s) => s.key === item.subjectKey))
        add('unknown_subject', 'data', `items.${item.id}`, '资产必须对应已声明主体');
      if (!item.prompt.trim())
        add(
          'asset_prompt_missing',
          'consistency',
          `items.${item.id}`,
          '资产需要单一时点、可执行的提示词',
        );
      if (item.shotIds.some((id) => !director?.shots.some((s) => s.id === id)))
        add('unknown_shot', 'data', `items.${item.id}`, '资产用途引用了不存在的镜头');
      if ((item.mediaType === 'audio') !== (item.purpose === 'voice'))
        add('asset_modality', 'data', `items.${item.id}`, '音色使用音频，视觉参考使用图片');
    }
  }
  if (result.stage === 'editorial') {
    unique(
      result.overlays.map((o) => o.id),
      'overlays',
    );
    for (const overlay of result.overlays) {
      if (overlay.endFrame <= overlay.startFrame)
        add('overlay_interval', 'data', `overlays.${overlay.id}`, '图文区间必须非空');
      if (overlay.sourceDialogueId) {
        const line = script?.scenes
          .flatMap((s) => s.dialogue)
          .find((l) => l.id === overlay.sourceDialogueId);
        if (!line || (line.text !== overlay.text && line.translation !== overlay.text))
          add(
            'subtitle_text_changed',
            'consistency',
            `overlays.${overlay.id}`,
            '对白字幕必须对应剧本原文或已声明译文',
          );
      }
    }
    if (result.musicDecision === 'no_music' && result.audio.length)
      add('music_decision_conflict', 'consistency', 'audio', '无配乐决定不能同时添加音乐');
    if (result.musicDecision === 'import' && !result.audio.length)
      add('music_required', 'execution', 'audio', '需要导入配乐，或明确改为无配乐');
    for (const cue of result.audio)
      if (cue.outFrame <= cue.inFrame)
        add('audio_interval', 'data', 'audio', '音频采用区间必须非空');
  }
  return issues;
}

export function authoringExecutionIssues(
  director: DirectorResult,
  caps: {
    provider: string;
    minSeconds: number;
    maxSeconds: number;
    framesPerSecond: number;
  } = H3_CREATION_CAPABILITIES,
): CreationIssue[] {
  return director.groups.flatMap((group) => {
    const frames = group.shotIds.reduce(
      (n, id) => n + (director.shots.find((s) => s.id === id)?.frames || 0),
      0,
    );
    return frames < caps.minSeconds * caps.framesPerSecond ||
      frames > caps.maxSeconds * caps.framesPerSecond
      ? [
          {
            code: 'provider_duration',
            category: 'execution' as const,
            severity: 'blocking' as const,
            stage: 'production',
            field: `groups.${group.id}`,
            targetId: '',
            message: `${caps.provider === 'h3' ? 'H3' : caps.provider} 单次支持 ${caps.minSeconds}–${caps.maxSeconds} 秒；本单元为 ${frames / 24} 秒。请在已完成节拍处分组，或修改采用时间线。`,
          },
        ]
      : [];
  });
}
