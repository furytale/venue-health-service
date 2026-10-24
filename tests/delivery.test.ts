import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseStore } from '../src/adapters/sqlite';
import { DeliveryStore } from '../src/adapters/delivery-store';
import { HttpDownstreamClient } from '../src/adapters/downstream';
import { DeliveryDispatcher, type DeliveryConfig } from '../src/application/delivery';
import { FakeDownstream } from '../tools/fake-downstream';
import { AdmissionUseCase, ProcessInboxUseCase } from '../src/application/core';
import { LifecyclePolicy } from '../src/domain/policy';
import { validateMessage } from '../src/domain/validation';
import type { ValidationConfig } from '../src/domain/model';

const config: DeliveryConfig = { concurrency: 4, batchSize: 25, pollIntervalMs: 10, storageRetryDelayMs: 100,
  retryBaseDelayMs: 100, retryMaxDelayMs: 1000, retryJitterRatio: 0 };
function seed(store: DatabaseStore, venueId: string, count: number): void {
  const inboxId = `inbox-${venueId}`;
  store.db.prepare('INSERT INTO inbox(inboxId,kind,sourceId,venueId,canonical,requestId,receivedAt) VALUES(?,?,?,?,?,?,?)')
    .run(inboxId, 'operator', venueId, venueId, '{}', 'request-1', '2026-01-01T00:00:00.000Z');
  for (let sequence = 1; sequence <= count; sequence++) {
    const payload = JSON.stringify({ status: 'Installed', reason: `reason-${sequence}`, sequence });
    store.db.prepare('INSERT INTO outbox(id,venueId,sequence,payload,idempotencyKey,inboxId,requestId,createdAt) VALUES(?,?,?,?,?,?,?,?)')
      .run(`${venueId}-${sequence}`, venueId, sequence, payload, `${venueId}:${sequence}`, inboxId, 'request-1', '2026-01-01T00:00:00.000Z');
  }
}
function state(store: DatabaseStore, id: string): { state: string; nextAttemptAt: number; lastErrorCode: string | null } {
  const row = store.db.prepare<[string], { state: string; nextAttemptAt: number; lastErrorCode: string | null }>(
    'SELECT state,nextAttemptAt,lastErrorCode FROM outbox WHERE id=?').get(id);
  assert.ok(row); return row;
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'venue-delivery-'));
  const path = join(dir, 'service.sqlite');
  const store = new DatabaseStore(path);
  const repository = new DeliveryStore(store.db);
  const fake = new FakeDownstream('fake-development-key');
  const url = await fake.listen();
  const client = new HttpDownstreamClient({ baseUrl: url, apiKey: 'fake-development-key', timeoutMs: 250 });
  let now = Date.parse('2026-01-01T00:00:00Z');
  const clock = () => now;
  const dispatcher = new DeliveryDispatcher(repository, client, config, clock, () => 0);
  return { dir, path, store, repository, fake, client, clock, dispatcher, advance: (ms: number) => { now += ms; },
    close: async () => { await dispatcher.stop(100); if (store.db.open) store.close(); await fake.close(); rmSync(dir, { recursive: true }); } };
}

test('apply-then-drop retries identical publication/key once remotely, and does not overtake', async () => {
  const f = await fixture();
  try {
    seed(f.store, 'A', 2); seed(f.store, 'B', 1);
    f.fake.script('A', 1, [{ kind: 'apply-drop' }]);
    await f.dispatcher.runOnce();
    assert.equal(state(f.store, 'A-1').state, 'pending');
    assert.equal(state(f.store, 'B-1').state, 'delivered');
    assert.equal(f.fake.requests.filter(item => item.venueId === 'A').length, 1);
    await f.dispatcher.runOnce();
    assert.equal(f.fake.requests.filter(item => item.venueId === 'A').length, 1);
    f.advance(100); await f.dispatcher.runOnce(); await f.dispatcher.runOnce();
    assert.deepEqual(f.fake.history.filter(item => item.venueId === 'A').map(item => item.sequence), [1, 2]);
    assert.deepEqual(f.fake.requests.filter(item => item.venueId === 'A').map(item => item.key), ['A:1', 'A:1', 'A:2']);
    const attempts = f.store.db.prepare('SELECT outcome FROM delivery_attempts WHERE outboxId=? ORDER BY attemptNumber').all('A-1');
    assert.deepEqual(attempts, [{ outcome: 'DOWNSTREAM_NETWORK_ERROR' }, { outcome: 'delivered' }]);
  } finally { await f.close(); }
});

test('Retry-After beyond local cap survives reopen and never blocks another venue', async () => {
  const f = await fixture();
  let reopened: DatabaseStore | undefined;
  try {
    seed(f.store, 'A', 2); seed(f.store, 'B', 1);
    f.fake.script('A', 1, [{ kind: 'status', status: 429, retryAfter: '3600', stallBody: true }]);
    await f.dispatcher.runOnce();
    const due = state(f.store, 'A-1').nextAttemptAt;
    assert.equal(due, f.clock() + 3600000);
    assert.equal(state(f.store, 'B-1').state, 'delivered');
    f.store.close(); reopened = new DatabaseStore(f.path);
    const repository = new DeliveryStore(reopened.db);
    repository.recoverInterrupted(f.clock());
    const dispatcher = new DeliveryDispatcher(repository, f.client, config, f.clock, () => 0);
    f.advance(3599999); await dispatcher.runOnce();
    assert.equal(f.fake.requests.filter(item => item.venueId === 'A').length, 1);
    f.advance(1); await dispatcher.runOnce(); await dispatcher.runOnce();
    assert.equal(state(reopened, 'A-2').state, 'delivered');
    await dispatcher.stop(100);
  } finally { reopened?.close(); await f.close(); }
});

test('terminal rejection blocks successors; offline requeue retains identity and attempt history', async () => {
  const f = await fixture();
  try {
    seed(f.store, 'A', 4); seed(f.store, 'B', 2);
    f.fake.script('A', 2, [{ kind: 'status', status: 422, stallBody: true }]);
    await f.dispatcher.runOnce(); await f.dispatcher.runOnce(); await f.dispatcher.runOnce();
    assert.equal(state(f.store, 'A-2').state, 'blocked');
    assert.equal(state(f.store, 'A-3').state, 'pending');
    assert.equal(state(f.store, 'B-2').state, 'delivered');
    assert.deepEqual(f.fake.requests.filter(item => item.venueId === 'A').map(item => item.sequence), [1, 2]);
    const before = f.store.db.prepare('SELECT payload,idempotencyKey,sequence FROM outbox WHERE id=?').get('A-2');
    f.store.recover('outbox', 'A-2', 'fake rejection corrected', new Date(f.clock()).toISOString());
    assert.deepEqual(f.store.db.prepare('SELECT payload,idempotencyKey,sequence FROM outbox WHERE id=?').get('A-2'), before);
    await f.dispatcher.runOnce(); await f.dispatcher.runOnce(); await f.dispatcher.runOnce();
    assert.deepEqual(f.fake.history.filter(item => item.venueId === 'A').map(item => item.sequence), [1, 2, 3, 4]);
    assert.deepEqual(f.store.db.prepare('SELECT outcome FROM delivery_attempts WHERE outboxId=? ORDER BY attemptNumber').all('A-2'),
      [{ outcome: 'DOWNSTREAM_REJECTED' }, { outcome: 'delivered' }]);
  } finally { await f.close(); }
});

test('failed local acknowledgement pauses dispatch, then saves retained remote success without another send', async () => {
  const f = await fixture();
  try {
    seed(f.store, 'A', 2);
    f.store.db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE ON outbox WHEN NEW.state='delivered' BEGIN SELECT RAISE(ABORT,'injected acknowledgement failure'); END");
    await f.dispatcher.runOnce();
    assert.equal(state(f.store, 'A-1').state, 'pending');
    assert.equal(f.fake.history.length, 1);
    await f.dispatcher.runOnce();
    assert.equal(f.fake.requests.length, 1);
    assert.deepEqual(f.store.db.prepare('SELECT outcome,endedAt FROM delivery_attempts').all(), [{ outcome: 'started', endedAt: null }]);
    f.store.db.exec('DROP TRIGGER fail_ack');
    f.advance(100); await f.dispatcher.runOnce();
    assert.equal(f.fake.requests.filter(item => item.sequence === 1).length, 1);
    assert.equal(state(f.store, 'A-1').state, 'delivered');
    assert.equal(state(f.store, 'A-2').state, 'delivered');
  } finally { await f.close(); }
});

test('restart after remote success and failed local acknowledgement retries same key once remotely', async () => {
  const f = await fixture();
  let reopened: DatabaseStore | undefined;
  try {
    seed(f.store, 'A', 1);
    f.store.db.exec("CREATE TRIGGER fail_ack BEFORE UPDATE ON outbox BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    await f.dispatcher.runOnce();
    assert.equal(f.fake.history.length, 1);
    f.store.db.exec('DROP TRIGGER fail_ack');
    f.store.close(); reopened = new DatabaseStore(f.path);
    const repository = new DeliveryStore(reopened.db);
    assert.equal(repository.recoverInterrupted(f.clock()), 1);
    const dispatcher = new DeliveryDispatcher(repository, f.client, config, f.clock, () => 0);
    await dispatcher.runOnce();
    assert.equal(f.fake.history.length, 1);
    assert.deepEqual(f.fake.requests.map(item => item.key), ['A:1', 'A:1']);
    assert.equal(state(reopened, 'A-1').state, 'delivered');
    assert.deepEqual(reopened.db.prepare('SELECT outcome FROM delivery_attempts ORDER BY attemptNumber').all(),
      [{ outcome: 'interrupted_unknown' }, { outcome: 'delivered' }]);
    await dispatcher.stop(100);
  } finally { reopened?.close(); await f.close(); }
});

test('attempt-start storage failure prevents transport', async () => {
  const f = await fixture();
  try {
    seed(f.store, 'A', 1);
    f.store.db.exec("CREATE TRIGGER fail_start BEFORE INSERT ON delivery_attempts BEGIN SELECT RAISE(ABORT,'injected failure'); END");
    const events: string[] = [];
    const dispatcher = new DeliveryDispatcher(f.repository, f.client, config, f.clock, () => 0, (_level, event) => events.push(event));
    await dispatcher.runOnce();
    f.advance(100); await dispatcher.runOnce();
    assert.equal(events.filter(event => event === 'delivery.storage_unavailable').length, 1);
    assert.equal(events.filter(event => event === 'delivery.storage_recovered').length, 0);
    assert.equal(f.fake.requests.length, 0);
    assert.equal(state(f.store, 'A-1').state, 'pending');
    f.store.db.exec('DROP TRIGGER fail_start'); f.advance(100); await dispatcher.runOnce();
    assert.equal(state(f.store, 'A-1').state, 'delivered');
    assert.equal(events.filter(event => event === 'delivery.storage_recovered').length, 1);
    await dispatcher.stop(100);
  } finally { await f.close(); }
});

test('50 venue backlog survives one hour outage and drains each venue in order', async () => {
  const f = await fixture();
  try {
    const validation: ValidationConfig = { jsonMaxDepth: 32, maxPcmReasons: 32, evidenceAllowedBuckets: ['venue-logs'], evidenceMaxKeys: 20, evidenceMaxKeyBytes: 1024 };
    const clock = { now: f.clock };
    const admission = new AdmissionUseCase(f.store, clock);
    const processor = new ProcessInboxUseCase(f.store, new LifecyclePolicy({ failureThreshold: 3, failureWindowMs: 7 * 86400000, failureMinSpanMs: 86400000 }), validation, clock);
    for (let i = 0; i < 50; i++) {
      const accepted = admission.execute(validateMessage('operator', { commandId: `command-${i}`, venueId: `V${i}`, status: 'Maintenance' }, validation), `request-${i}`);
      assert.equal(accepted.accepted, true);
      f.fake.script(`V${i}`, 1, [{ kind: 'status', status: 503 }]);
    }
    const reader = new DatabaseStore(f.path);
    assert.equal(reader.db.prepare<[], { n: number }>('SELECT count(*) AS n FROM inbox').get()?.n, 50);
    reader.close();
    assert.equal(processor.runBatch(25), 25);
    assert.equal(processor.runBatch(25), 25);
    for (let pass = 0; pass < 13; pass++) await f.dispatcher.runOnce();
    assert.equal(f.fake.history.length, 0);
    assert.equal(f.fake.requests.length, 50);
    f.advance(3600000);
    for (let pass = 0; pass < 26; pass++) await f.dispatcher.runOnce();
    assert.equal(f.fake.history.length, 100);
    assert.equal(f.store.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM inbox WHERE state='processed'").get()?.n, 50);
    for (const publication of f.fake.history) {
      const payload: unknown = JSON.parse(publication.payload);
      assert.deepEqual(payload, publication.sequence === 1
        ? { status: 'Installed', reason: 'INITIAL_INSTALLATION', sequence: 1 }
        : { status: 'Maintenance', reason: 'OPERATOR_DECISION', sequence: 2 });
    }
    for (let i = 0; i < 50; i++) assert.deepEqual(f.fake.history.filter(item => item.venueId === `V${i}`).map(item => item.sequence), [1, 2]);
    assert.equal(f.store.db.prepare<[], { n: number }>("SELECT count(*) AS n FROM outbox WHERE state!='delivered'").get()?.n, 0);
  } finally { await f.close(); }
});

test('timeout, network failure, malformed Retry-After use backoff; redirects are terminal', async () => {
  const f = await fixture();
  try {
    for (const venue of ['Timeout', 'Network', 'Rate', 'Redirect']) seed(f.store, venue, 1);
    f.fake.script('Timeout', 1, [{ kind: 'delay', delayMs: 500 }]);
    f.fake.script('Network', 1, [{ kind: 'disconnect' }]);
    f.fake.script('Rate', 1, [{ kind: 'status', status: 429, retryAfter: '-1' }]);
    f.fake.script('Redirect', 1, [{ kind: 'status', status: 302 }]);
    await f.dispatcher.runOnce();
    assert.equal(state(f.store, 'Timeout-1').lastErrorCode, 'DOWNSTREAM_TIMEOUT');
    assert.equal(state(f.store, 'Network-1').lastErrorCode, 'DOWNSTREAM_NETWORK_ERROR');
    assert.equal(state(f.store, 'Rate-1').nextAttemptAt, f.clock() + 100);
    assert.equal(state(f.store, 'Redirect-1').lastErrorCode, 'UNEXPECTED_DOWNSTREAM_RESPONSE');
    f.advance(100); await f.dispatcher.runOnce();
    assert.equal(f.fake.history.length, 3);
  } finally { await f.close(); }
});

test('one-slot dispatcher rotates venues despite an older noisy backlog', async () => {
  const f = await fixture();
  try {
    seed(f.store, 'A', 5); seed(f.store, 'B', 1);
    const dispatcher = new DeliveryDispatcher(f.repository, f.client, { ...config, concurrency: 1, batchSize: 1 }, f.clock, () => 0);
    await dispatcher.runOnce(); await dispatcher.runOnce();
    assert.deepEqual(f.fake.history.map(item => `${item.venueId}:${item.sequence}`), ['A:1', 'B:1']);
    await dispatcher.stop(100);
  } finally { await f.close(); }
});

test('missing or unrepresentable Retry-After falls back; jitter and exponential cap never expire retries', async () => {
  const f = await fixture();
  try {
    for (const venue of ['Missing', 'Huge', 'Date']) seed(f.store, venue, 1);
    f.fake.script('Missing', 1, [{ kind: 'status', status: 429 }]);
    f.fake.script('Huge', 1, [{ kind: 'status', status: 429, retryAfter: '99999999999999999999999' }]);
    f.fake.script('Date', 1, [{ kind: 'status', status: 429, retryAfter: 'Wed, 21 Oct 2026 07:28:00 GMT' }]);
    await f.dispatcher.runOnce();
    for (const venue of ['Missing', 'Huge', 'Date']) assert.equal(state(f.store, `${venue}-1`).nextAttemptAt, f.clock() + 100);
    seed(f.store, 'Retry', 1);
    f.fake.script('Retry', 1, Array.from({ length: 8 }, () => ({ kind: 'status', status: 503 })));
    const dispatcher = new DeliveryDispatcher(f.repository, f.client, { ...config, retryJitterRatio: .2 }, f.clock, () => 0);
    for (const delay of [80, 160, 320, 640, 800, 800, 800, 800]) {
      await dispatcher.runOnce();
      assert.equal(state(f.store, 'Retry-1').state, 'pending');
      assert.equal(state(f.store, 'Retry-1').nextAttemptAt, f.clock() + delay);
      f.advance(delay);
    }
    await dispatcher.runOnce();
    assert.equal(state(f.store, 'Retry-1').state, 'delivered');
    assert.equal(f.fake.history.filter(item => item.venueId === 'Retry').length, 1);
    await dispatcher.stop(100);
  } finally { await f.close(); }
});

test('bounded shutdown aborts a stalled request and restart resumes the persisted publication', { timeout: 3000 }, async () => {
  const f = await fixture();
  let reopened: DatabaseStore | undefined;
  try {
    seed(f.store, 'A', 1);
    f.fake.script('A', 1, [{ kind: 'delay', delayMs: 60000 }]);
    const requested = f.fake.nextRequest();
    const cycle = f.dispatcher.runOnce();
    await requested;
    const started = performance.now();
    await f.dispatcher.stop(20);
    await cycle;
    assert.ok(performance.now() - started < 1000, 'shutdown must not await the stalled downstream response');
    assert.equal(state(f.store, 'A-1').state, 'pending');
    assert.equal(state(f.store, 'A-1').lastErrorCode, 'DOWNSTREAM_INTERRUPTED');
    assert.deepEqual(f.store.db.prepare('SELECT outcome FROM delivery_attempts').all(), [{ outcome: 'DOWNSTREAM_INTERRUPTED' }]);
    f.store.close(); reopened = new DatabaseStore(f.path);
    const repository = new DeliveryStore(reopened.db);
    const dispatcher = new DeliveryDispatcher(repository, f.client, config, f.clock, () => 0);
    await dispatcher.runOnce();
    assert.equal(f.fake.requests.length, 1);
    f.advance(100); await dispatcher.runOnce();
    assert.equal(state(reopened, 'A-1').state, 'delivered');
    assert.equal(f.fake.history.length, 1);
    assert.deepEqual(f.fake.requests.map(item => item.key), ['A:1', 'A:1']);
    await dispatcher.stop(100);
  } finally { reopened?.close(); await f.close(); }
});
