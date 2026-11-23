import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from './db.js';
import { assertCurrentWorkspace } from './migrations.js';
import { inside, prepareData } from './config.js';
import { hashFile } from './media.js';

/** Offline import into a NEW directory; never updates the source or dispatches work. */
export async function retainWorkspace(sourceRoot: string, targetRoot: string, projectId: string) {
  sourceRoot = path.resolve(sourceRoot);
  targetRoot = path.resolve(targetRoot);
  if (
    sourceRoot === targetRoot ||
    sourceRoot.startsWith(targetRoot + path.sep) ||
    targetRoot.startsWith(sourceRoot + path.sep)
  )
    throw new Error('来源与目标必须是互不包含的独立目录');
  if (
    await fs.stat(targetRoot).then(
      () => true,
      () => false,
    )
  )
    throw new Error('目标目录已存在，请使用新的隔离目录');
  const source = new DatabaseSync(path.join(sourceRoot, 'studio.sqlite'), { readOnly: true });
  let target: Store | undefined;
  try {
    assertCurrentWorkspace(source);
    const active = source
      .prepare("SELECT id,state FROM jobs WHERE state NOT IN ('succeeded','failed','cancelled')")
      .all();
    if (active.length) throw new Error(`来源仍有 ${active.length} 个未结束任务，不能切换活动数据`);
    const project = source
      .prepare("SELECT * FROM documents WHERE id=? AND kind='project'")
      .get(projectId);
    if (!project) throw new Error('保留项目不存在');
    const records = source.prepare('SELECT * FROM documents WHERE project_id=?').all(projectId);
    const ids = new Set(records.map((r) => String(r.id)));
    const versions = source
      .prepare('SELECT r.* FROM revisions r JOIN documents d ON d.id=r.id WHERE d.project_id=?')
      .all(projectId);
    // Workspace-owned voices stay globally owned. Preserve their fixed history, not a fake project.
    const jobs = source
      .prepare('SELECT * FROM jobs WHERE project_id=? OR project_id IS NULL')
      .all(projectId);
    const voiceMetadata = source.prepare('SELECT * FROM library_metadata').all();
    const voiceIds = new Set(voiceMetadata.map((r) => r.id));
    const libraryVersions = source
      .prepare('SELECT * FROM library_versions')
      .all()
      .filter((r) => voiceIds.has(r.id));
    if (jobs.some((j) => j.batch_id))
      throw new Error('保留项目参与跨项目批次，需要先核对批次的完整保留范围');
    const jobIds = new Set(jobs.map((j) => String(j.id)));
    const allIds = new Set(
      source
        .prepare('SELECT id FROM documents')
        .all()
        .map((r) => String(r.id)),
    );
    const external = new Set<string>();
    function inspect(value: unknown) {
      if (typeof value === 'string') {
        if (allIds.has(value) && !ids.has(value)) external.add(value);
      } else if (Array.isArray(value)) value.forEach(inspect);
      else if (value && typeof value === 'object') Object.values(value).forEach(inspect);
    }
    for (const row of versions) inspect(JSON.parse(String(row.document)));
    for (const row of jobs) {
      inspect(JSON.parse(String(row.input)));
      inspect(JSON.parse(String(row.output)));
    }
    if (external.size)
      throw new Error(
        `保留集合引用其他项目的 ${external.size} 个记录，必须先扩展精确依赖集合：${[...external].join(', ')}`,
      );
    prepareData(targetRoot);
    target = new Store(path.join(targetRoot, 'studio.sqlite'));
    const dependencyRows = source
      .prepare('SELECT * FROM dependencies')
      .all()
      .filter((r) => ids.has(String(r.consumer_id)));
    if (dependencyRows.some((r) => !ids.has(String(r.source_id))))
      throw new Error('依赖表包含保留集合外来源');
    function refersToRetained(value: unknown): boolean {
      if (typeof value === 'string') return ids.has(value) || jobIds.has(value);
      return !!value && typeof value === 'object' && Object.values(value).some(refersToRetained);
    }
    const events = source
      .prepare('SELECT * FROM events')
      .all()
      .filter((r) => {
        const data = JSON.parse(String(r.data));
        return (
          jobIds.has(String(r.job_id)) || data.projectId === projectId || refersToRetained(data)
        );
      });
    const rowsByTable: Record<string, any[]> = {
      library_items: source
        .prepare('SELECT * FROM library_items')
        .all()
        .filter((r) => voiceIds.has(r.id)),
      library_versions: libraryVersions,
      voice_folders: source
        .prepare(
          `WITH RECURSIVE tree AS (SELECT *,0 depth FROM voice_folders WHERE parent_id IS NULL UNION ALL SELECT f.*,t.depth+1 FROM voice_folders f JOIN tree t ON f.parent_id=t.id) SELECT id,parent_id,name,revision FROM tree ORDER BY depth,id`,
        )
        .all(),
      library_metadata: voiceMetadata,
      documents: records,
      revisions: versions,
      jobs,
      events,
      settings: source
        .prepare(
          "SELECT * FROM settings WHERE key IN ('comfy','discovery','maintenance','speech_allowance:workspace',?) OR key LIKE 'voice_probe:%'",
        )
        .all(`speech_allowance:project:${projectId}`),
      dependencies: dependencyRows,
      derivations: source.prepare('SELECT * FROM derivations WHERE project_id=?').all(projectId),
      proposal_applications: source
        .prepare('SELECT * FROM proposal_applications')
        .all()
        .filter((r) => ids.has(String(r.proposal_id))),
      apply_receipts: source
        .prepare('SELECT * FROM apply_receipts')
        .all()
        .filter((r) => {
          const result = JSON.parse(String(r.result));
          return (
            JSON.stringify(result).includes(projectId) ||
            [...ids].some((id) => JSON.stringify(result).includes(id))
          );
        }),
    };
    // Retain fixed connection history referenced by this project's documents/jobs.
    // DPAPI blobs remain encrypted and only work for the original Windows account.
    const retainedText = JSON.stringify([versions, jobs, libraryVersions, rowsByTable.settings]);
    const connectionRows = source
      .prepare('SELECT * FROM model_connections')
      .all()
      .filter((r) => retainedText.includes(String(r.id)));
    const connectionIds = new Set(connectionRows.map((r) => r.id));
    rowsByTable.model_connections = connectionRows;
    rowsByTable.model_connection_versions = source
      .prepare('SELECT * FROM model_connection_versions')
      .all()
      .filter((r) => connectionIds.has(r.id));
    const connectionText = JSON.stringify(rowsByTable.model_connection_versions);
    rowsByTable.model_secrets = source
      .prepare('SELECT * FROM model_secrets')
      .all()
      .filter((r) => connectionText.includes(String(r.id)));
    if (source.prepare("SELECT name FROM sqlite_master WHERE name='media_file_state'").get()) {
      const mediaPaths = new Set(
        versions
          .map((r) => JSON.parse(String(r.document)))
          .filter((d) => d.kind === 'asset')
          .map((d) => d.data.path),
      );
      rowsByTable.media_file_state = source
        .prepare('SELECT * FROM media_file_state')
        .all()
        .filter((r) => mediaPaths.has(r.path));
      rowsByTable.media_cleanup_batches = source
        .prepare('SELECT * FROM media_cleanup_batches WHERE project_id=?')
        .all(projectId);
    }
    target.transaction(() => {
      for (const [table, rows] of Object.entries(rowsByTable)) {
        if (!rows.length) continue;
        const columns = Object.keys(rows[0]);
        const insert = target!.db.prepare(
          `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
        );
        for (const row of rows) insert.run(...columns.map((c) => row[c]));
      }
      if (source.prepare("SELECT name FROM sqlite_master WHERE name='creation_heads'").get()) {
        const heads = source
          .prepare(
            'SELECT h.* FROM creation_heads h JOIN documents d ON d.id=h.episode_id WHERE d.project_id=?',
          )
          .all(projectId);
        for (const head of heads)
          target!.db
            .prepare('INSERT INTO creation_heads(episode_id,run_id,revision) VALUES(?,?,?)')
            .run(head.episode_id, head.run_id, head.revision);
        rowsByTable.creation_heads = heads;
      }
    });
    const assets = new Map<string, { path: string; sha256: string; bytes?: number }>();
    for (const row of libraryVersions) {
      const bundle = JSON.parse(String(row.bundle));
      if (bundle.kind === 'voice_media') assets.set(bundle.data.path, bundle.data);
    }
    for (const row of versions) {
      const doc = JSON.parse(String(row.document));
      if (doc.kind === 'asset' && doc.data.path) {
        const prior = assets.get(doc.data.path);
        if (prior && prior.sha256 !== doc.data.sha256)
          throw new Error('同一媒体路径存在不一致哈希');
        assets.set(doc.data.path, doc.data);
      }
    }
    const manifest = [];
    for (const asset of assets.values()) {
      const cleared = rowsByTable.media_file_state?.find(
        (r) => r.path === asset.path && r.status === 'cleared',
      );
      if (cleared) {
        const sourceFile = path.isAbsolute(cleared.backup)
          ? cleared.backup
          : inside(sourceRoot, cleared.backup);
        if ((await hashFile(sourceFile)) !== asset.sha256)
          throw new Error('已清理素材的备份哈希不匹配');
        const retained = `retained-media/${asset.sha256}${path.extname(asset.path)}`;
        await fs.mkdir(path.dirname(inside(targetRoot, retained)), { recursive: true });
        await fs.copyFile(sourceFile, inside(targetRoot, retained));
        target.db
          .prepare('UPDATE media_file_state SET backup=? WHERE path=?')
          .run(retained, asset.path);
        manifest.push({
          path: asset.path,
          sha256: asset.sha256,
          cleared: true,
          backup: retained,
          bytes: asset.bytes,
        });
        continue;
      }
      const sourceFile = inside(sourceRoot, asset.path),
        targetFile = inside(targetRoot, asset.path);
      if ((await hashFile(sourceFile)) !== asset.sha256)
        throw new Error(`来源媒体哈希不匹配：${asset.path}`);
      await fs.mkdir(path.dirname(targetFile), { recursive: true });
      await fs.copyFile(sourceFile, targetFile);
      if ((await hashFile(targetFile)) !== asset.sha256)
        throw new Error(`目标媒体哈希不匹配：${asset.path}`);
      manifest.push({
        path: asset.path,
        sha256: asset.sha256,
        bytes: (await fs.stat(targetFile)).size,
      });
    }
    const copiedJobs = target.db
      .prepare('SELECT id,input,prompt_id,output FROM jobs ORDER BY id')
      .all();
    const archivedJobLogs: Record<string, string> = {};
    for (const job of jobs) {
      const relative = `jobs/${job.id}`;
      const sourceDir = inside(sourceRoot, relative);
      if (
        await fs.stat(sourceDir).then(
          (s) => s.isDirectory(),
          () => false,
        )
      ) {
        await fs.cp(sourceDir, inside(targetRoot, relative), {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        const output = JSON.parse(String(job.output));
        const execution = String(output.executionDir || '').replaceAll('\\', '/');
        const marker = `/jobs/${job.id}/`;
        const markerIndex = execution.lastIndexOf(marker);
        const log =
          markerIndex >= 0
            ? `jobs/${job.id}/${execution.slice(markerIndex + marker.length)}/runner.log`
            : `jobs/${job.id}/runner.log`;
        if (
          await fs.stat(inside(targetRoot, log)).then(
            (s) => s.isFile(),
            () => false,
          )
        )
          archivedJobLogs[String(job.id)] = log;
      }
    }
    target.setSetting('archivedJobLogs', archivedJobLogs);
    for (const job of copiedJobs) {
      const old = jobs.find((j) => j.id === job.id)!;
      if (job.input !== old.input || job.prompt_id !== old.prompt_id || job.output !== old.output)
        throw new Error('任务输入、回执或输出发生变化');
    }
    if (
      target.db.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok' ||
      target.db.prepare('PRAGMA foreign_key_check').all().length
    )
      throw new Error('目标数据库一致性验证失败');
    target.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const report = {
      version: 1,
      projectId,
      createdAt: new Date().toISOString(),
      sourceRoot,
      targetRoot,
      counts: Object.fromEntries(Object.entries(rowsByTable).map(([k, v]) => [k, v.length])),
      assetFiles: manifest.length,
      assets: manifest,
      jobs: jobs.map((j) => ({ id: j.id, promptId: j.prompt_id, state: j.state })),
      sourceUnchanged: true,
      globalVoices: '全局声音身份、音频、目录及工作区任务完整保留；项目归属不变',
    };
    await fs.writeFile(
      path.join(targetRoot, 'retention-manifest.json'),
      JSON.stringify(report, null, 2),
    );
    return report;
  } finally {
    target?.db.close();
    source.close();
  }
}
