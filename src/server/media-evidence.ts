import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store, HttpError } from './db.js';
import { inside, config } from './config.js';
import { probeMedia, runProcess, ingestAsset } from './media.js';
import { derivationKey } from './migrations.js';
import { fileCleared } from './media-retention.js';
const active = new Map<string, Promise<any>>();
export async function extractFrameAsset(
  store: Store,
  root: string,
  id: string,
  revision: number,
  index: number | 'last',
) {
  const key = `${path.resolve(root)}:${id}:${revision}:${index}`;
  const running = active.get(key);
  if (running) return running;
  const operation = (async () => {
    const video = store.get(id, revision);
    if (video.kind !== 'asset' || video.data.mediaType !== 'video')
      throw new HttpError(400, '证据需要视频');
    let count = video.data.frameCount;
    if (index === 'last' && !count)
      count = (await probeMedia(inside(root, video.data.path))).frameCount;
    const frameIndex = index === 'last' ? count - 1 : index;
    if (!Number.isInteger(frameIndex) || frameIndex < 0)
      throw new HttpError(400, '证据帧越界或帧数不可用');
    const source = {
      jobId: video.data.jobId || null,
      media: { id: video.id, revision: video.revision },
      kind: index === 'last' ? 'last_frame' : 'review_frame',
      frameIndex,
      interval: null,
      parameters: {
        decoder: 'ffmpeg',
        selection: index === 'last' ? 'last-decoded-v1' : 'decoded-index-v1',
      },
    } as const;
    const identity = derivationKey(source);
    const prior = store.db
      .prepare('SELECT asset_id FROM derivations WHERE project_id=? AND identity=?')
      .get(video.projectId, identity);
    const sameFrame = store
      .list('asset', video.projectId)
      .find(
        (a) =>
          a.data.derivedSource?.media?.id === id &&
          a.data.derivedSource.media.revision === revision &&
          a.data.derivedSource.frameIndex === frameIndex &&
          ['review_frame', 'last_frame'].includes(a.data.derivedSource.kind) &&
          ['decoded-index-v1', 'last-decoded-v1'].includes(
            a.data.derivedSource.parameters?.selection,
          ),
      );
    if (prior || sameFrame) {
      const asset = prior ? store.get(String(prior.asset_id)) : sameFrame!;
      if (fileCleared(store, asset.data.path))
        throw new HttpError(410, '此证据文件已清理，请显式恢复');
      return asset;
    }
    const lease = `evidence:${video.projectId}:${id}:${revision}:${frameIndex}`,
      owner = randomUUID();
    const claimed = store.db
      .prepare(
        'INSERT INTO leases VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires=excluded.expires WHERE expires<?',
      )
      .run(lease, owner, Date.now() + 300000, Date.now());
    if (!claimed.changes) throw new HttpError(409, '此帧正在提取，请稍后查看');
    let dir: string | undefined;
    try {
      count ??= (await probeMedia(inside(root, video.data.path))).frameCount;
      if (!count || frameIndex >= count) throw new HttpError(400, '证据帧越界或帧数不可用');
      dir = inside(root, `jobs/evidence-${owner}`);
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, 'frame.png');
      await runProcess(
        config.ffmpeg,
        [
          '-y',
          '-v',
          'error',
          '-i',
          inside(root, video.data.path),
          '-vf',
          `select=eq(n\\,${frameIndex})`,
          '-frames:v',
          '1',
          '-update',
          '1',
          file,
        ],
        { timeout: 120000 },
      );
      return await ingestAsset(store, root, video.projectId, file, {
        name: index === 'last' ? '已生成尾帧' : `证据帧 ${frameIndex}`,
        category: index === 'last' ? 'keyframe' : 'review_frame',
        jobId: video.data.jobId,
        episodeId: video.parentId,
        sourceAssetIds: [video.id],
        derivedSource: source,
      });
    } finally {
      if (dir)
        await fs.rm(dir, { recursive: true, force: true }).catch((e) =>
          store.event(null, 'media_cleanup_warning', {
            projectId: video.projectId,
            path: dir,
            error: e.message,
          }),
        );
      store.db.prepare('DELETE FROM leases WHERE name=? AND owner=?').run(lease, owner);
    }
  })();
  active.set(key, operation);
  try {
    return await operation;
  } finally {
    active.delete(key);
  }
}
