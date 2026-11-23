import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { upgradeModelDatabase } from '../src/server/migrations.js';
import { hashFile } from '../src/server/media.js';

const directory = process.argv[2];
if (!directory)
  throw new Error('用法：npm run migrate:models -- <已停止服务的数据目录>；先运行完整媒体备份');
const root = path.resolve(directory);
const file = path.join(root, 'studio.sqlite');
await fs.access(file);
const db = new DatabaseSync(file);
try {
  if (Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 4)
    throw new Error('仅迁移 v4 数据库；没有修改数据');
  if (db.prepare('SELECT name FROM leases WHERE expires>?').get(Date.now()))
    throw new Error('服务仍持有租约，请停止服务');
  const backupPath = path.join(root, `studio-v4-before-models-${Date.now()}.sqlite`);
  await backup(db, backupPath);
  await fs.writeFile(backupPath + '.sha256', await hashFile(backupPath));
  upgradeModelDatabase(db);
  console.log(
    JSON.stringify(
      { version: 5, root, backupPath, media: '原位置保留，未重新编译历史任务' },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
