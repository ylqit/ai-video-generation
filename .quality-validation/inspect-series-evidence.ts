import fs from 'node:fs/promises';
import path from 'node:path';
import { Store } from '../src/server/db.js';
const b = JSON.parse(await fs.readFile('../docs/architecture/2026-11-23-series-validation/evidence/browser/OFFLINE_REHEARSAL.json', 'utf8'));
const store = new Store(path.join(b.root, 'studio.sqlite'));
console.log(JSON.stringify(store.jobs(b.projectId).map(j => ({id:j.id, kind:j.kind, state:j.state, createdAt:j.createdAt, updatedAt:j.updatedAt, creationRunId:j.input.creationRunId, operation:j.input.operation, remoteId:j.remoteId, output:j.output, error:j.error})),null,2));
store.close();
