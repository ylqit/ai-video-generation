import { retainWorkspace } from '../src/server/workspace-retention.js';
const [source, target, projectId] = process.argv.slice(2);
if (!source || !target || !projectId)
  throw new Error(
    '用法：npx tsx scripts/retain-workspace.ts <已备份数据目录> <新数据目录> <保留项目 ID>',
  );
const report = await retainWorkspace(source, target, projectId);
console.log(
  JSON.stringify(
    {
      projectId: report.projectId,
      counts: report.counts,
      assetFiles: report.assetFiles,
      targetRoot: report.targetRoot,
    },
    null,
    2,
  ),
);
