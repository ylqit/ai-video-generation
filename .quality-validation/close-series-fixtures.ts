import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Store } from '../src/server/db.js';
const target = path.resolve('../docs/architecture/2026-11-23-series-validation/evidence');
const records = [];
for (const name of ['browser/OFFLINE_REHEARSAL.json']) {
  const manifest = JSON.parse(await fs.readFile(path.join(target, name), 'utf8'));
  assert.equal(manifest.realModelCalls, 0);
  assert.equal(manifest.workerStarted, false);
  assert.ok(path.basename(manifest.root).startsWith('studio-series-rehearsal-'));
  const store = new Store(path.join(manifest.root, 'studio.sqlite'));
  const jobs = store.jobs(manifest.projectId);
  const runIds = new Set(manifest.rows.map((r: any) => r.runId));
  assert.equal(jobs.length, 10);
  for (const job of jobs) {
    assert.equal(job.kind, 'creative');
    assert.ok(['queued', 'cancelled'].includes(job.state));
    assert.ok(runIds.has(job.input.context?.runId));
    assert.equal(job.promptId, null);
    assert.deepEqual(job.output, {});
  }
  records.push({ root: manifest.root, jobsBefore: jobs.map(j => ({ id: j.id, state: j.state, remoteId: j.promptId, output: j.output })), reason: 'Fixture cancellation omitted context.runId; no Worker ever started and no request executed', action: 'Cancel only these isolated fixture creative jobs', finalState: 'cancelled' });
  for (const job of jobs) if (job.state === 'queued') store.patchJob(job.id, { state: 'cancelled' });
  assert.ok(store.jobs(manifest.projectId).every(j => j.state === 'cancelled'));
  store.close();
}
await fs.writeFile(path.join(target, 'FIXTURE_CLEANUP.json'), JSON.stringify({ date: '2026-11-23', browserServiceStopped: true, records }, null, 2));
console.log('Cancelled isolated, unexecuted fixture jobs; recorded original queue states');
