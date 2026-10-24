import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createService } from '../src/app';
import { loadSettings } from '../src/config/settings';
import { isRecord } from '../src/domain/validation';

function record(value: unknown): Record<string, unknown> { assert.ok(isRecord(value)); return value; }
async function body(response: Response): Promise<Record<string, unknown>> { const value: unknown = await response.json(); return record(value); }
const report = { reportId: 'r1', venueId: 'V1', analyzedAt: '2026-10-20T00:00:00Z', trigger: 'auto', selfTest: { passed: true } };
async function fixture(t: TestContext, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'venue-http-'));
  const path = join(dir, 'state.sqlite');
  const service = await createService(loadSettings({ DOWNSTREAM_URL: 'http://127.0.0.1:1', DOWNSTREAM_API_KEY: 'test-key', SQLITE_PATH: path, LOG_LEVEL: 'fatal', INBOX_POLL_INTERVAL_MS: '86400000', OUTBOX_POLL_INTERVAL_MS: '86400000', ...extra }));
  await service.start(0);
  t.after(async () => { await service.stop(); rmSync(dir, { recursive: true, force: true }); });
  const baseUrl = await service.app.getUrl();
  const post = (value: unknown, path = '/api/reports') => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { service, path, baseUrl, post };
}

test('HTTP admits ten concurrent duplicates durably once, preserves first receipt, and processes once', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 10 }, () => f.post(report)));
  assert.deepEqual(responses.map(response => response.status), Array(10).fill(202));
  const receipts = await Promise.all(responses.map(body));
  assert.equal(new Set(receipts.map(receipt => receipt.inboxId)).size, 1);
  assert.equal(receipts.filter(receipt => receipt.duplicate === false).length, 1);
  assert.equal(new Set(responses.map(response => response.headers.get('x-request-id'))).size, 10);
  for (const [index, response] of responses.entries()) assert.equal(receipts[index]?.requestId, response.headers.get('x-request-id'));
  const independent = new Database(f.path, { readonly: true });
  try {
    const count = independent.prepare<[], { count: number }>('SELECT count(*) AS count FROM inbox').get();
    assert.equal(count?.count, 1, '202 is observable only after the independent connection sees the committed inbox row');
  } finally { independent.close(); }
  const pending = await body(await fetch(`${f.baseUrl}/api/venues/V1`));
  assert.equal(pending.status, null); assert.equal(pending.sequence, 0); assert.equal(record(pending.processing).state, 'pending');
  assert.deepEqual((await body(await fetch(`${f.baseUrl}/api/venues/V1/history`))).items, []);
  assert.equal(f.service.processor.runBatch(25), 1);
  assert.equal(f.service.processor.runBatch(25), 0);
  const state = await body(await fetch(`${f.baseUrl}/api/venues/V1`));
  assert.equal(state.status, 'Installed'); assert.equal(state.sequence, 1);
  const message = await body(await fetch(`${f.baseUrl}/api/messages/${String(receipts[0]?.inboxId)}`));
  assert.equal(message.state, 'processed'); assert.deepEqual(message.publicationSequences, [1]);
  assert.equal('canonical' in message, false);
  const reordered = await f.post({ selfTest: report.selfTest, trigger: report.trigger, analyzedAt: report.analyzedAt, venueId: report.venueId, reportId: report.reportId });
  assert.equal(reordered.status, 202); assert.equal((await body(reordered)).duplicate, true);
  const conflict = await f.post({ ...report, venueId: 'V2' });
  assert.equal(conflict.status, 409); assert.equal(record((await body(conflict)).error).code, 'MESSAGE_ID_CONFLICT');
});

test('HTTP rejects invalid inputs with safe stable codes and request correlation', async t => {
  const f = await fixture(t, { HTTP_BODY_LIMIT_BYTES: '512' });
  const cases: [string, RequestInit, number, string][] = [
    ['/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }, 400, 'VALIDATION_ERROR'],
    ['/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...report, selfTest: { passed: 'true' } }) }, 400, 'VALIDATION_ERROR'],
    ['/api/reports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...report, extra: 'x'.repeat(512) }) }, 413, 'PAYLOAD_TOO_LARGE'],
    ['/api/reports', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(report) }, 415, 'UNSUPPORTED_MEDIA_TYPE'],
    ['/api/venues/missing', {}, 404, 'NOT_FOUND'],
    ['/unknown-route', {}, 404, 'NOT_FOUND'],
    ['/api/messages/missing', {}, 404, 'NOT_FOUND'],
    ['/api/venues/missing/history', {}, 404, 'NOT_FOUND'],
    ['/api/venues/V1/history?after=-1', {}, 400, 'VALIDATION_ERROR'],
    ['/api/venues/V1/history?limit=101', {}, 400, 'VALIDATION_ERROR'],
    ['/api/venues/V1/history?limit=0', {}, 400, 'VALIDATION_ERROR'],
    ['/api/venues/V1/history?after=9007199254740992', {}, 400, 'VALIDATION_ERROR'],
  ];
  for (const [path, init, expectedStatus, expectedCode] of cases) {
    const response = await fetch(`${f.baseUrl}${path}`, init);
    assert.equal(response.status, expectedStatus, path);
    const error = record((await body(response)).error);
    assert.equal(error.code, expectedCode); assert.equal(error.requestId, response.headers.get('x-request-id'));
    assert.equal('stack' in error, false); assert.equal('sql' in error, false);
  }
});

test('HTTP storage write failure returns 503 without admitting work; unsafe evidence remains private', async t => {
  const f = await fixture(t);
  f.service.store.db.pragma('query_only = ON');
  const unavailable = await f.post(report);
  assert.equal(unavailable.status, 503); assert.equal(record((await body(unavailable)).error).code, 'STORAGE_UNAVAILABLE');
  assert.equal(f.service.store.db.prepare<[], { count: number }>('SELECT count(*) AS count FROM inbox').get()?.count, 0);
  f.service.store.db.pragma('query_only = OFF');
  const unsafe = { ...report, pcm: { ran: true, status: 'fail', evidence: { bucket: 'private-secret', resultKey: '../unsafe', evidenceKeys: [] } } };
  const accepted = await f.post(unsafe); assert.equal(accepted.status, 202);
  f.service.processor.runBatch(25);
  const state = await body(await fetch(`${f.baseUrl}/api/venues/V1`));
  const pcm = record(record(state.latestReport).pcm);
  assert.equal(pcm.evidence, null); assert.equal(record(pcm.evidenceValidation).state, 'excluded');
  const publicHistory = await body(await fetch(`${f.baseUrl}/api/venues/V1/history?limit=1`));
  assert.ok(Array.isArray(publicHistory.items)); assert.equal(publicHistory.items.length, 1);
  assert.equal(typeof publicHistory.nextCursor, 'number');
  const next = await body(await fetch(`${f.baseUrl}/api/venues/V1/history?after=${String(publicHistory.nextCursor)}&limit=1`));
  assert.ok(Array.isArray(next.items)); assert.equal(next.items.length, 1);
  assert.equal(next.nextCursor, null);
  assert.equal(JSON.stringify(state).includes('private-secret'), false);
  assert.equal(JSON.stringify(publicHistory).includes('../unsafe'), false);
  const saved = f.service.store.db.prepare<[], { canonical: string }>('SELECT canonical FROM inbox').get();
  assert.ok(saved?.canonical.includes('private-secret'), 'Original evidence is retained privately for identity');
});
