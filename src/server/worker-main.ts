import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { config, prepareData } from './config.js';
import { Store } from './db.js';
import { Worker } from './worker.js';
prepareData(config.dataDir);
const store = new Store(path.join(config.dataDir, 'studio.sqlite'));
const worker = new Worker(store, config.dataDir);
process.on('SIGINT', () => worker.stop());
process.on('SIGTERM', () => worker.stop());
console.log('Studio Worker 已启动，文字 / 云端 / 媒体独立调度；数据目录：' + config.dataDir);
while (!worker.stopped) {
  try {
    await worker.tick(false);
  } catch (e) {
    console.error('Worker:', e);
  }
  await setTimeout(1000);
}
await worker.drain();
store.release(worker.owner);
store.close();
