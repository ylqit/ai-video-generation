import { Store, HttpError } from './db.js';
import { productionHead } from './creation-heads.js';
import { resolveSeries, predecessorCanon } from './series-production.js';
import { generationDigest } from './h3-guided.js';
import { referenceCoverageBasis } from '../shared/reference-coverage.js';
import type { RecordDoc } from '../shared/contracts.js';
import type { WorkspaceContext, WorkspaceIssue } from '../shared/workspace.js';

// Selection is read-only and never guesses across works or series. A production head
// remains authoritative within its episode, while unactivated alternatives stay visible.
export function workspaceTarget(
  store: Store,
  projectId: string,
  runId?: string,
  episodeId?: string,
  seriesId?: string,
) {
  const series = store.list('series', projectId).filter((r) => !r.data.archived);
  const episodes = store.list('episode', projectId).filter((r) => !r.data.archived);
  const runs = store.list('creation_run', projectId).filter((r) => !r.data.archived);
  let run = runId ? store.get(runId) : null;
  if (
    run &&
    (run.kind !== 'creation_run' ||
      run.projectId !== projectId ||
      run.data.archived ||
      run.data.schemaVersion !== 9)
  )
    throw new HttpError(400, '创作运行不属于当前项目');
  let episode = episodeId
    ? episodes.find((e) => e.id === episodeId)
    : run
      ? episodes.find((e) => e.id === run!.data.episodeId)
      : null;
  if ((episodeId || run) && !episode) throw new HttpError(400, '分集不属于当前项目');
  if (run && episode && run.data.episodeId !== episode.id)
    throw new HttpError(400, '创作运行与分集不匹配');
  let selectedSeries = seriesId
    ? series.find((s) => s.id === seriesId)
    : episode
      ? series.find((s) => s.id === episode!.data.seriesId)
      : null;
  if (seriesId && !selectedSeries) throw new HttpError(400, '系列不属于当前项目');
  if (episode && selectedSeries && episode.data.seriesId !== selectedSeries.id)
    throw new HttpError(400, '分集与系列不匹配');
  if (!selectedSeries && !episode && series.length === 1) selectedSeries = series[0];
  const eligibleEpisodes = episodes.filter(
    (e) => !selectedSeries || e.data.seriesId === selectedSeries.id,
  );
  if (!episode && eligibleEpisodes.length === 1 && (selectedSeries || series.length <= 1))
    episode = eligibleEpisodes[0];
  if (!selectedSeries && episode)
    selectedSeries = series.find((s) => s.id === episode!.data.seriesId);
  const eligibleRuns = episode ? runs.filter((r) => r.data.episodeId === episode!.id) : [];
  if (!run && episode) {
    const head = productionHead(store, episode.id);
    run = eligibleRuns.find((r) => r.id === head.runId) || null;
  }
  const context: WorkspaceContext = {
    series: selectedSeries ? { id: selectedSeries.id, revision: selectedSeries.revision } : null,
    episode: episode ? { id: episode.id, revision: episode.revision } : null,
    profile: null,
    selectionRequired:
      !selectedSeries && series.length > 1
        ? 'series'
        : !episode && eligibleEpisodes.length > 1
          ? 'episode'
          : !run && eligibleRuns.length > 0
            ? 'run'
            : null,
    seriesChoices: series.map((s) => ({ id: s.id, revision: s.revision, title: s.data.title })),
    runChoices: eligibleRuns.map((r) => ({
      id: r.id,
      revision: r.revision,
      title: r.data.request || r.id,
      episodeId: r.data.episodeId,
    })),
    issues: [],
  };
  if (selectedSeries?.data.production) {
    context.profile = selectedSeries.data.production.profile;
    try {
      resolveSeries(store, episode?.data.seriesProduction ? episode : selectedSeries);
    } catch (error: any) {
      context.issues.push({
        code: 'series_basis',
        message: error.message,
        severity: 'blocking',
        gate: 'prepare',
        inScope: true,
        target: context.series,
        field: 'production',
        destination: 'series',
      });
    }
  }
  return { run, episode, episodes: eligibleEpisodes, context };
}

// This explains recorded readiness; execution still rechecks the actual fixed input.
// No remote probe, task creation, or project-wide generation preparation occurs here.
export function workspaceIssues(
  store: Store,
  context: WorkspaceContext,
  run: RecordDoc | null,
  results: Record<string, any>,
  scope: RecordDoc | null,
  requirements: any[],
  jobs: any[],
) {
  const issues = [...context.issues];
  const add = (issue: WorkspaceIssue) => issues.push(issue);
  if (!run) return issues;
  for (const stage of ['brief', 'script', 'direction', 'director', 'assets']) {
    const adopted = run.data.results?.[stage];
    const record = adopted && store.get(adopted.id, adopted.revision);
    if (!record || store.get(record.id).data.stale)
      add({
        code: `stage:${stage}`,
        message: `${stage} 需要完成并采用当前方案`,
        severity: 'blocking',
        gate: 'prepare',
        inScope: true,
        target: results[stage]
          ? { id: results[stage].id, revision: results[stage].revision }
          : null,
        field: stage,
        destination: 'authoring',
      });
  }
  if (!scope || scope.data.pending)
    add({
      code: 'scope',
      message: scope ? '当前范围等待导演计划采用' : '请选择本次执行范围',
      severity: 'blocking',
      gate: 'prepare',
      inScope: true,
      target: null,
      field: 'scope',
      destination: 'scope',
    });
  const shotIds = new Set<string>(scope?.data.shotIds || []);
  const groupIds = new Set<string>(scope?.data.groupIds || []);
  const allShots = results.director?.data.result.shots || [];
  const allGroups = results.director?.data.result.groups || [];
  for (const issue of run.data.issues || []) {
    const shot = allShots.find((s: any) => s.id === issue.targetId);
    const group = allGroups.find((g: any) => g.id === issue.targetId);
    const sceneShots = allShots.filter((s: any) => s.sceneId === issue.targetId);
    add({
      code: issue.code,
      message: issue.message,
      severity: issue.severity,
      gate:
        issue.category === 'evidence'
          ? 'adopt'
          : issue.stage === 'delivery'
            ? 'deliver'
            : 'prepare',
      inScope:
        !scope ||
        (shot
          ? shotIds.has(shot.id)
          : group
            ? groupIds.has(group.id)
            : sceneShots.length
              ? sceneShots.some((s: any) => shotIds.has(s.id))
              : true),
      target: results[issue.stage]
        ? { id: results[issue.stage].id, revision: results[issue.stage].revision }
        : null,
      field: issue.field || '',
      shotId: shot?.id,
      destination: issue.category === 'evidence' ? 'candidate' : 'authoring',
    });
  }
  for (const requirement of requirements) {
    const binding = requirement.binding;
    let problem = !binding?.inspected ? '尚未审看并绑定固定参考' : '';
    if (binding) {
      try {
        const asset = store.get(binding.asset.id, binding.asset.revision);
        if (
          asset.projectId !== run.projectId ||
          asset.kind !== 'asset' ||
          asset.data.stale ||
          store.get(asset.id).data.stale
        )
          problem = '参考资产已失效或归属不符';
        const { binding: _binding, inScope: _inScope, ...item } = requirement;
        if (binding.requirementDigest !== generationDigest(item))
          problem = '需求变化，请重新核对参考';
        if (
          binding.subjectDigest !==
          generationDigest(
            results.script?.data.result.subjects.find((s: any) => s.key === item.subjectKey) ||
              null,
          )
        )
          problem = '主体内容变化，请重新核对参考';
        if (
          item.coverage?.length &&
          results.director &&
          binding.coverageDigest !==
            generationDigest(referenceCoverageBasis(results.director.data.result, item.coverage))
        )
          problem = '交互设计变化，请重新审看覆盖';
      } catch (error: any) {
        problem = error.message;
      }
    }
    if (problem)
      add({
        code: `reference:${requirement.id}`,
        message: `${requirement.description}：${problem}`,
        severity: 'blocking',
        gate: 'prepare',
        inScope: requirement.inScope,
        target: results.assets
          ? { id: results.assets.id, revision: results.assets.revision }
          : null,
        field: `items.${requirement.id}`,
        requirementId: requirement.id,
        destination: 'references',
      });
  }
  for (const job of jobs) {
    if (['failed', 'unknown', 'cancelled'].includes(job.state) || job.holdReason)
      add({
        code: `job:${job.id}`,
        message: `${job.state}：${job.error || job.holdReason || '请查看原任务恢复动作'}`,
        severity: 'review',
        gate: 'prepare',
        inScope: !scope || job.input.creationScope?.id === scope.id,
        target: null,
        field: '',
        jobId: job.id,
        destination: 'job',
      });
  }
  if (context.episode) {
    const episode = store.get(context.episode.id, context.episode.revision);
    if (episode.data.seriesProduction) {
      try {
        const chain = predecessorCanon(store, episode, true);
        if (chain.waiting)
          add({
            code: 'canon_waiting',
            message: chain.waiting + '；可继续假设草稿，正式依赖在接续预览核对',
            severity: 'review',
            gate: 'prepare',
            inScope: true,
            target: context.series,
            field: 'chronology',
            destination: 'series',
          });
      } catch (error: any) {
        add({
          code: 'canon_basis',
          message: error.message,
          severity: 'review',
          gate: 'prepare',
          inScope: true,
          target: context.series,
          field: 'chronology',
          destination: 'series',
        });
      }
    }
  }
  if (jobs.some((j) => j.kind === 'generation' && j.state === 'succeeded'))
    add({
      code: 'candidate_review',
      message: '真实候选需核对实际区间；单段采用与整集交付分别确认',
      severity: 'review',
      gate: 'adopt',
      inScope: true,
      target: null,
      field: '',
      destination: 'candidate',
    });
  add({
    code: 'delivery_review',
    message: '交付前核对实际采用、接点、整集观看及固定导出版本',
    severity: 'info',
    gate: 'deliver',
    inScope: true,
    target: null,
    field: '',
    destination: 'delivery',
  });
  return issues;
}
