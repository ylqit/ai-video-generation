import path from 'node:path';
import fs from 'node:fs';
try {
  process.loadEnvFile();
} catch (e: any) {
  if (e.code !== 'ENOENT') throw e;
}
export const config = {
  host: process.env.STUDIO_HOST || '127.0.0.1',
  port: Number(process.env.STUDIO_PORT || 4310),
  dataDir: path.resolve(process.env.STUDIO_DATA_DIR || '.data'),
  comfyUrl:
    process.env.STUDIO_COMFY_URL || 'https://mt5rd5ob-1t07x7b9-8188.ahrestapi.gpufree.cn:8443',
  ffmpeg: process.env.STUDIO_FFMPEG || 'ffmpeg',
  ffprobe: process.env.STUDIO_FFPROBE || 'ffprobe',
};
export function prepareData(root: string) {
  for (const name of ['assets', 'jobs', 'incoming', 'backups'])
    fs.mkdirSync(path.join(root, name), { recursive: true });
}
export function inside(root: string, relative: string) {
  const p = path.resolve(root, relative);
  if (p === path.resolve(root) || !p.startsWith(path.resolve(root) + path.sep))
    throw new Error('文件必须位于素材目录内');
  return p;
}
