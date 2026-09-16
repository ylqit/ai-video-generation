import path from 'node:path';
import { config, prepareData } from './config.js';
import { Store } from './db.js';
import { createApp } from './app.js';
import { recoverInterruptedCleanup } from './media-retention.js';
prepareData(config.dataDir);
const store = new Store(path.join(config.dataDir, 'studio.sqlite'));
await recoverInterruptedCleanup(store, config.dataDir);
const server = createApp(store, config.dataDir).listen(config.port, config.host, () =>
  console.log(`序集创作台 API：http://${config.host}:${config.port}`),
);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.on(signal, () =>
    server.close(() => {
      store.close();
      process.exit(0);
    }),
  );
