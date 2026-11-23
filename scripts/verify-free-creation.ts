import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/db.js';
import { StudioService } from '../src/server/service.js';
import { prepareData } from '../src/server/config.js';
import { ingestAsset, hashFile } from '../src/server/media.js';

const input = process.argv[2];
if (!input)
  throw new Error(
    'Provide an existing synthetic video; this verification creates no model requests.',
  );
const root = path.resolve('.artifacts/free-migration-' + Date.now());
prepareData(root);
const store = new Store(path.join(root, 'studio.sqlite'));
const project = new StudioService(store).createProject({
  title: 'Migration fixture',
  mode: 'short',
  brief: '',
});
const chapter = store.create(
  'chapter',
  project.id,
  { title: 'Original story', content: 'Visible actions, not observed media.' },
  project.id,
);
store.update(chapter.id, 1, { ...chapter.data, content: 'Current story' });
const media = await ingestAsset(store, root, project.id, path.resolve(input), {
  name: 'Synthetic fixture',
  category: 'reference',
});
const job = store.createJob(
  'generation',
  project.id,
  null,
  {
    offlineFixture: true,
    assets: [{ asset: media }],
    segment: { id: 'old', duration: 5 },
    templateVersion: 'historical-fixture',
  },
  'migration-recovery-fixture',
);
store.patchJob(job.id, {
  state: 'unknown',
  promptId: 'preserved-remote-identity',
  output: { message: 'Unknown acceptance; do not repeat' },
});
const run = store.create(
  'assistant_run',
  project.id,
  { version: 1, state: 'active', receipts: [{ key: 'historical' }] },
  project.id,
);
const frozen = JSON.stringify(store.job(job.id)),
  oldRevision = JSON.stringify(store.get(chapter.id, 1));
const beforeHash = await hashFile(path.join(root, media.data.path));
store.db.close();
const args = ['--import', 'tsx', 'scripts/migrate-free-creation.ts', root];
const preview = JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf8' }));
assert.equal(preview.activeJobs.length, 1);
const applied = execFileSync(process.execPath, [...args, '--apply'], { encoding: 'utf8' });
const migrated = new Store(path.join(root, 'studio.sqlite'));
assert.equal(JSON.stringify(migrated.job(job.id)), frozen);
assert.equal(JSON.stringify(migrated.get(chapter.id, 1)), oldRevision);
assert.equal(migrated.get(run.id).data.state, 'paused');
assert.equal(migrated.list('canvas', project.id).length, 1);
assert.equal(migrated.list('generation_review').length, 0);
assert.equal(await hashFile(path.join(root, media.data.path)), beforeHash);
migrated.db.close();
const dirs = await fs.readdir(path.join(root, 'backups'));
assert.equal(dirs.length, 1);
const backup = path.join(root, 'backups', dirs[0]);
const restored = path.join(root, 'restored-original');
execFileSync(
  process.execPath,
  ['--import', 'tsx', 'scripts/backup.ts', 'restore', backup, restored],
  { encoding: 'utf8' },
);
const original = new Store(path.join(restored, 'studio.sqlite'));
assert.equal(JSON.stringify(original.job(job.id)), frozen);
assert.equal(original.list('canvas', project.id).length, 0);
assert.equal(original.get(run.id).data.state, 'active');
assert.equal(await hashFile(path.join(restored, media.data.path)), beforeHash);
original.db.close();
const result = {
  root,
  backup,
  restored,
  activeJob: job.id,
  mediaSha256: beforeHash,
  checks: [
    'preview',
    'full backup',
    'explicit apply',
    'original task and revision unchanged',
    'media hash unchanged',
    'restore original records',
  ],
  paidRequests: 0,
};
await fs.writeFile(path.join(root, 'VERIFICATION.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
