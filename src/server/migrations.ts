import { createHash } from 'node:crypto';
import type { DerivedSource } from '../shared/domain.js';
import type { DatabaseSync } from 'node:sqlite';

export function derivationKey(source: DerivedSource) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...source,
        parameters: Object.fromEntries(
          Object.entries(source.parameters).sort(([a], [b]) => a.localeCompare(b)),
        ),
      }),
    )
    .digest('hex');
}
export const domainTables = `
CREATE TABLE library_items(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, name TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE library_versions(id TEXT NOT NULL,revision INTEGER NOT NULL,bundle TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE dependencies(source_id TEXT NOT NULL,source_revision INTEGER NOT NULL,consumer_id TEXT NOT NULL,consumer_revision INTEGER NOT NULL,purpose TEXT NOT NULL,PRIMARY KEY(source_id,source_revision,consumer_id,consumer_revision,purpose));
CREATE INDEX dependency_consumers ON dependencies(consumer_id,consumer_revision);
CREATE TABLE derivations(project_id TEXT NOT NULL,identity TEXT NOT NULL,asset_id TEXT NOT NULL,source TEXT NOT NULL,PRIMARY KEY(project_id,identity),FOREIGN KEY(asset_id) REFERENCES documents(id));
`;
export const workbenchTables = `
CREATE TABLE work_batches(id TEXT PRIMARY KEY,revision INTEGER NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,draft TEXT NOT NULL,confirmation_key TEXT UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE batch_manifests(batch_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,manifest TEXT NOT NULL,PRIMARY KEY(batch_id,revision));
CREATE TABLE batch_items(batch_id TEXT NOT NULL,item_id TEXT NOT NULL,position INTEGER NOT NULL,job_id TEXT UNIQUE,PRIMARY KEY(batch_id,item_id));
ALTER TABLE jobs ADD COLUMN batch_id TEXT;
ALTER TABLE jobs ADD COLUMN batch_item_id TEXT;
ALTER TABLE jobs ADD COLUMN hold_reason TEXT;
CREATE UNIQUE INDEX jobs_batch_item ON jobs(batch_id,batch_item_id) WHERE batch_id IS NOT NULL;
CREATE INDEX jobs_lookup ON jobs(project_id,state,created_at);
CREATE TABLE proposal_applications(proposal_id TEXT NOT NULL,change_id TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(proposal_id,change_id));
CREATE TABLE apply_receipts(key TEXT PRIMARY KEY,digest TEXT NOT NULL,result TEXT NOT NULL);
`;

const baseTables = `
CREATE TABLE documents(id TEXT PRIMARY KEY,kind TEXT NOT NULL,project_id TEXT NOT NULL,parent_id TEXT,revision INTEGER NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE INDEX documents_project ON documents(project_id,kind);
CREATE TABLE revisions(id TEXT NOT NULL,revision INTEGER NOT NULL,document TEXT NOT NULL,PRIMARY KEY(id,revision));
CREATE TABLE jobs(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,episode_id TEXT,kind TEXT NOT NULL,state TEXT NOT NULL,input TEXT NOT NULL,output TEXT NOT NULL DEFAULT '{}',prompt_id TEXT,error TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,job_id TEXT,kind TEXT NOT NULL,data TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE leases(name TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);`;

// This production release accepts only an empty database or the current V9 workspace.
// Historical databases must be opened with their matching offline program backup.
export function migrateDatabase(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 4) throw new Error('数据库来自更新版本，拒绝降级打开');
    if (version > 0 && version < 4)
      throw new Error('不支持旧数据库，请使用新的空数据目录；旧库只能用匹配的备份程序离线打开');
    if (version === 0) {
      db.exec(`${baseTables} ${domainTables} ${workbenchTables}
        CREATE TABLE media_file_state(path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, status TEXT NOT NULL, backup TEXT NOT NULL, batch_id TEXT NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE media_cleanup_batches(id TEXT PRIMARY KEY, project_id TEXT NOT NULL, manifest TEXT NOT NULL, created_at INTEGER NOT NULL);
        CREATE TABLE creation_heads(episode_id TEXT PRIMARY KEY REFERENCES documents(id),run_id TEXT NOT NULL REFERENCES documents(id),revision INTEGER NOT NULL CHECK(revision>0));
        CREATE INDEX documents_media ON documents(project_id,kind,json_extract(data,'$.category'),json_extract(data,'$.mediaType'),created_at,id);
        CREATE INDEX documents_job ON documents(project_id,kind,json_extract(data,'$.jobId'));
        CREATE INDEX documents_parent ON documents(project_id,kind,parent_id,created_at,id);
        CREATE INDEX jobs_creation ON jobs(project_id,json_extract(input,'$.creationRunId'),created_at);
        PRAGMA user_version=4;
      `);
    }
    assertCurrentWorkspace(db);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// Shared read-only boundary for startup and offline project retention.
export function assertCurrentWorkspace(db: DatabaseSync) {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 4)
    throw new Error('不支持旧数据库，请使用匹配的离线备份程序');
  const legacy = db
    .prepare(
      `
    SELECT id FROM documents WHERE
      (kind='creation_run' AND COALESCE(json_extract(data,'$.schemaVersion'),0)<>9)
      OR (kind='authoring_result' AND COALESCE(json_extract(data,'$.schemaVersion'),json_extract(data,'$.result.schemaVersion'),0)<>9)
    UNION ALL
    SELECT id FROM revisions WHERE
      (json_extract(document,'$.kind')='creation_run' AND COALESCE(json_extract(document,'$.data.schemaVersion'),0)<>9)
      OR (json_extract(document,'$.kind')='authoring_result' AND COALESCE(json_extract(document,'$.data.schemaVersion'),json_extract(document,'$.data.result.schemaVersion'),0)<>9)
    UNION ALL
    SELECT id FROM jobs WHERE
      json_extract(input,'$.authoringVersion')<>9
      OR (json_extract(input,'$.context.runId') IS NOT NULL AND COALESCE(json_extract(input,'$.context.schemaVersion'),0)<>9)
    LIMIT 1
  `,
    )
    .get();
  if (legacy) throw new Error('活动库含旧作者协议；请保留离线备份并建立新的 V9 空库');
}
