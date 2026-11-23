import fs from 'node:fs/promises';
import path from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { hashFile } from '../src/server/media.js';
import { config, inside, prepareData } from '../src/server/config.js';

const args = process.argv.slice(2);
if (args[0] === 'restore') {
  if (!args[1] || !args[2])
    throw new Error('用法：npm run backup -- restore <备份目录> <新的数据目录>');
  const source = path.resolve(args[1]),
    target = path.resolve(args[2]);
  try {
    await fs.stat(target);
    throw new Error('恢复目标必须不存在；不会覆盖已有工作区');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) {
    const input = inside(source, file.path);
    if ((await hashFile(input)) !== file.sha256) throw new Error(`备份校验失败：${file.path}`);
  }
  prepareData(target);
  for (const file of manifest.files) {
    const destination = inside(target, file.path);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(inside(source, file.path), destination);
  }
  const db = new DatabaseSync(path.join(target, 'studio.sqlite'));
  db.exec('DELETE FROM leases;');
  db.close();
  console.log(
    '已恢复到 ' + target + '。启动时设置 STUDIO_DATA_DIR；保留远端任务身份，不自动重发未知提交。',
  );
} else {
  prepareData(config.dataDir);
  const destination = path.resolve(
    args[0] || path.join(config.dataDir, 'backups', new Date().toISOString().replaceAll(':', '-')),
  );
  await fs.mkdir(destination, { recursive: false });
  const db = new DatabaseSync(path.join(config.dataDir, 'studio.sqlite'));
  const lock = db.prepare("SELECT value FROM settings WHERE key='media_cleanup_lock'").get();
  if (lock && JSON.parse(String(lock.value))) throw new Error('媒体清理尚未结束，请稍后备份');
  await backup(db, path.join(destination, 'studio.sqlite'));
  db.close();
  const snapshot = new DatabaseSync(path.join(destination, 'studio.sqlite'));
  const rows = snapshot
    .prepare("SELECT document FROM revisions WHERE json_extract(document,'$.kind')='asset'")
    .all();
  const paths = new Set(rows.map((r) => JSON.parse(String(r.document)).data.path as string));
  for (const r of snapshot.prepare('SELECT bundle FROM library_versions').all()) {
    const bundle = JSON.parse(String(r.bundle));
    if (bundle.kind === 'voice_media') paths.add(bundle.data.path);
  }
  // Submission receipts are recovery evidence; without them a restored unknown job cannot reconcile.
  for (const job of snapshot.prepare('SELECT id FROM jobs').all()) {
    const relative = `jobs/${job.id}`,
      directory = inside(config.dataDir, relative);
    if (
      !(await fs.stat(directory).then(
        (s) => s.isDirectory(),
        () => false,
      ))
    )
      continue;
    for (const entry of await fs.readdir(directory, { recursive: true, withFileTypes: true })) {
      if (entry.isFile())
        paths.add(
          path
            .relative(config.dataDir, path.join(entry.parentPath, entry.name))
            .replaceAll('\\', '/'),
        );
    }
  }
  const stored = snapshot
    .prepare("SELECT name FROM sqlite_master WHERE name='media_file_state'")
    .get()
    ? snapshot.prepare('SELECT * FROM media_file_state').all()
    : [];
  const bundled: string[] = [];
  for (const relative of paths) {
    const entry = stored.find((e) => e.path === relative && e.status === 'cleared');
    if (entry) {
      const input = path.isAbsolute(String(entry.backup))
        ? String(entry.backup)
        : inside(config.dataDir, String(entry.backup));
      if ((await hashFile(input)) !== entry.sha256) throw new Error('已清理素材的恢复备份校验失败');
      const retained = `retained-media/${entry.sha256}${path.extname(relative)}`;
      await fs.mkdir(path.dirname(inside(destination, retained)), { recursive: true });
      await fs.copyFile(input, inside(destination, retained));
      snapshot.prepare('UPDATE media_file_state SET backup=? WHERE path=?').run(retained, relative);
      bundled.push(retained);
      continue;
    }
    const output = inside(destination, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.copyFile(inside(config.dataDir, relative), output);
  }
  snapshot.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  snapshot.close();
  const files = [];
  for (const relative of new Set([
    'studio.sqlite',
    ...[...paths].filter((p) => !stored.some((e) => e.path === p && e.status === 'cleared')),
    ...bundled,
  ])) {
    const file = inside(destination, relative);
    files.push({
      path: relative,
      sha256: await hashFile(file),
      bytes: (await fs.stat(file)).size,
    });
  }
  await fs.writeFile(
    path.join(destination, 'manifest.json'),
    JSON.stringify({ version: 1, createdAt: new Date().toISOString(), files }, null, 2),
  );
  console.log('备份完成：' + destination + '（数据库与全部资产版本，含 SHA256 校验）');
}
