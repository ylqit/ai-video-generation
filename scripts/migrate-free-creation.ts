import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/server/db.js';
import {
  previewFreeCreationMigration,
  applyFreeCreationMigration,
} from '../src/server/free-creation-migration.js';

const directory = process.argv[2];
if (!directory)
  throw new Error(
    '用法：node --import tsx scripts/migrate-free-creation.ts <数据目录> [--apply]；默认仅预览',
  );
const root = path.resolve(directory),
  file = path.join(root, 'studio.sqlite');
await fs.access(file);
const store = new Store(file);
try {
  const preview = previewFreeCreationMigration(store);
  if (!process.argv.includes('--apply')) console.log(JSON.stringify(preview, null, 2));
  else {
    if (store.db.prepare('SELECT name FROM leases WHERE expires>?').get(Date.now()))
      throw new Error('请先停止服务与 Worker');
    await fs.mkdir(path.join(root, 'backups'), { recursive: true });
    const destination = path.join(root, 'backups', 'before-free-creation-' + Date.now());
    // Existing backup owns the full revision/media/remote-receipt closure and hashes.
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', destination], {
      cwd: process.cwd(),
      env: { ...process.env, STUDIO_DATA_DIR: root },
      stdio: 'inherit',
    });
    const result = applyFreeCreationMigration(store, preview.digest);
    console.log(
      JSON.stringify(
        { backup: destination, ...result, databaseVersion: 6, paidRequests: 0 },
        null,
        2,
      ),
    );
  }
} finally {
  store.db.close();
}
