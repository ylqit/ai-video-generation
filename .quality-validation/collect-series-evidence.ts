import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Store } from '../src/server/db.js';
import { generationDigest } from '../src/server/h3-guided.js';
const target = path.resolve('../docs/architecture/2026-11-23-series-validation/evidence');
const json = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const write = async (file: string, data: unknown) => fs.writeFile(path.join(target, file), JSON.stringify(data, null, 2));
const hash = async (file: string) => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const rehearsal = await json(path.join(target, 'OFFLINE_REHEARSAL.json'));
const pack = await json(path.join(target, 'REAL_VALIDATION_PREPARATION.json'));
assert.equal(rehearsal.rows.length, 10);
assert.equal(rehearsal.realModelCalls, 0);
assert.equal(rehearsal.generationJobs + rehearsal.imageJobs + rehearsal.confirmedCanon + rehearsal.formalReleases, 0);
assert.equal(rehearsal.rows[0].rendered.metadata.frameCount, 7200);
assert.equal(rehearsal.rows[0].rendered.reusedParts, 50);
assert.equal(await hash(path.join(target, 'five-minute-offline.mp4')), rehearsal.rows[0].rendered.sha256);
assert.equal(pack.cases.length, 38);
assert.equal(pack.executionAuthorization, 'none');
const browser = await json(path.join(target, 'browser/OFFLINE_REHEARSAL.json'));
const store = new Store(path.join(browser.root, 'studio.sqlite'));
const jobs = store.jobs(browser.projectId);
assert.equal(jobs.filter(j => ['generation', 'image'].includes(j.kind)).length, 0);
assert.ok(jobs.every(j => j.state === 'cancelled'));
const series = store.get(browser.seriesId);
const episodes = store.list('episode', browser.projectId);
assert.equal(episodes.length, 10);
const third = episodes.find(e => e.id === series.data.production.slots[2].episodeId)!;
assert.equal(third.data.seriesProduction.runtime.targetFrames, 8640);
await write('browser/BROWSER_VERIFICATION.json', {
  date: '2026-11-23', root: browser.root, projectId: browser.projectId,
  origin: 'http://127.0.0.1:4386', isolation: 'No Worker; media and creative generation POST routes forbidden',
  actions: ['requirements and consumed subject bindings', 'second episode hypothetical status', 'manual season input/prepare/save/compare/apply', 'missing source rejected then supplied', 'concurrent plan v14→v15 preserves unsaved 8-episode draft', 'third episode explicitly overridden to 360 seconds with old 300-second basis warning', 'source title indexing and save', '38-case experimental prepare/save with blockers'],
  proposals: store.list('series_proposal', browser.projectId).map(p => ({ id: p.id, adopted: p.data.adopted, valid: p.data.valid, title: p.data.result?.title })),
  seriesRevision: series.revision, episodes: episodes.length, thirdEpisodeFrames: 8640,
  creativeJobs: jobs.length, creativeStates: [...new Set(jobs.map(j => j.state))], imageJobs: 0, videoJobs: 0, realModelRequests: 0,
  formalReleases: store.list('episode_release', browser.projectId).length,
  fixtureCleanup: 'FIXTURE_CLEANUP.json; queued, unexecuted preparation jobs explicitly cancelled after correcting the fixture filter',
  browserServiceStopped: true,
  expectedError: 'One HTTP 400 for sourceEntryIds not present in fixed context; corrected by selecting the source index',
  limitations: ['Synthetic adoption doubles only', 'No real image, sound or video quality claims', 'API-only future experiment binding verified offline; browser only prepared/saved the unready pack'],
});
store.close();
const organizers = pack.cases.map((c: any) => ({ ...c, blindCode: generationDigest({ id: rehearsal.experiment.id, caseId: c.id }).slice(0, 12) }));
await write('EXPERIMENT_ORGANIZER_INDEX.json', organizers);
const csv = (rows: unknown[][]) => String.fromCharCode(0xfeff) + rows.map(row => row.map(v => '"' + String(v ?? '').replaceAll('"', '""') + '"').join(',')).join(String.fromCharCode(13,10));
await fs.writeFile(path.join(target, 'OBSERVATION_TEMPLATE.csv'), csv([
  ['blindCode', 'check', 'status', 'mediaId', 'mediaRevision', 'startFrame', 'endFrame', 'inspection', 'notes', 'reviewId', 'reviewRevision', 'selectionId', 'reviewSeconds'],
  ...organizers.sort((a: any, b: any) => a.blindCode.localeCompare(b.blindCode)).flatMap((c: any) => c.checks.map((check: string) => [c.blindCode, check, 'unreviewed', '', '', '', '', ['sound_join', 'unexpected_voice'].includes(check) ? 'audio' : '', '', '', '', '', ''])),
]));
await fs.writeFile(path.join(target, 'TEXT_REVIEW_TEMPLATE.csv'), csv([
  ['caseId', 'fixedInputStatus', 'modelVersion', 'jobId', 'completeText', 'sourceFidelity', 'visibleAction', 'causality', 'episodeCapacity', 'timingAssessment', 'reviewSeconds', 'notes'],
  ...pack.textCases.map((id: string) => [id, 'pending_exact_input_and_model', '', '', 'unreviewed', 'unreviewed', 'unreviewed', 'unreviewed', 'unreviewed', 'unreviewed', '', 'No request authorized']),
]));
const historical = await json(path.join(target, 'HISTORICAL_INPUT_INVENTORY.json'));
for (const file of historical) assert.equal(await hash(file.path), file.sha256);
const logs = { tests: 'series-regression-complete.log', build: 'series-build-delivery.log', format: 'series-format-delivery.log', diff: 'series-diff-check.log', rehearsal: 'series-rehearsal-delivery.log' };
const tests = await fs.readFile(path.join('.quality-validation', logs.tests), 'utf8');
assert.match(tests, /tests 309/); assert.match(tests, /pass 309/); assert.match(tests, /fail 0/);
const build = await fs.readFile(path.join('.quality-validation', logs.build), 'utf8');
assert.match(build, /built in/); assert.doesNotMatch(build, /error TS/);
assert.match(await fs.readFile(path.join('.quality-validation', logs.format), 'utf8'), /All matched files use Prettier/);
for (const [name, file] of Object.entries(logs)) await fs.copyFile(path.join('.quality-validation', file), path.join(target, name + '-final.log'));
async function files(dir: string): Promise<string[]> {
  return (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).map(e => e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]))).flat();
}
const source = [...await files('src'), 'scripts/verify-series-creation.ts', 'tests/series-creation.test.ts', 'tests/fixtures/workspace.ts', 'tests/model-platform.test.ts', 'tests/model-execution.test.ts', 'tests/creation.test.ts'];
await write('SOURCE_SNAPSHOT.json', await Promise.all(source.map(async file => ({ file: path.resolve(file), sha256: await hash(file) }))));
const linkErrors: unknown[] = [];
for (const file of (await files(path.dirname(target))).filter(f => f.endsWith('.md'))) {
  const text = await fs.readFile(file, 'utf8');
  for (const match of text.matchAll(/\]\(([^\s)]+)\)/g)) {
    const link = match[1];
    if (/^(https?:|#)/.test(link)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(link.split('#')[0]));
    if (resolved.endsWith('FINAL_VERIFICATION.json')) continue;
    try { await fs.access(resolved); } catch { linkErrors.push({ file, link }); }
  }
}
await write('DOCUMENT_LINKS.json', { checked: true, errors: linkErrors });
assert.equal(linkErrors.length, 0);
await write('FINAL_VERIFICATION.json', {
  date: '2026-11-23', branch: 'feature/series-production-validation',
  tests: { baseline: 295, added: 14, total: 309, passed: 309, failed: 0, skipped: 0, exitCode: 0 },
  build: { typecheck: 'passed', client: 'passed', server: 'passed', exitCode: 0, existingWarning: 'Vite chunks larger than 500 kB' },
  format: 'passed', diffCheck: { exitCode: 0, notice: 'Existing LF/CRLF conversion warnings, no whitespace errors' },
  rehearsal: { episodesWithRequirements: 10, fullStructuredEpisodeRehearsals: 1, otherHypotheticalDrafts: 9, frames: 7200, seconds: 300, resolution: [1024,576], fps: 24, codecs: ['h264','aac'], recoveredParts: 50, actualMovieQualityVerified: false },
  experiments: { plannedVideoCases: 38, requestedSecondsLimit: 380, plannedTextCases: 8, paidImageRequests: 0, realRequests: 0, readyToSubmit: false, authorization: 'none', missing: ['reviewed assets', 'actual production model and node/workflow verification', 'exact approved experimental writing inputs', 'price evidence', 'future paid execution authorization'] },
  historicalFilesRehashed: historical.length, legacyTaskRecompiles: 0, productionDatabaseWrites: 0, productionWorkerStarted: false,
  browserRecord: 'browser/BROWSER_VERIFICATION.json', newMedia: 'synthetic only',
});
console.log(JSON.stringify({ tests: 309, realRequests: 0, output: target, historicalHashes: historical.length, sourceFiles: source.length }));
