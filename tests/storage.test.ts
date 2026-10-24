import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseStore } from '../src/adapters/sqlite';
import { AdmissionUseCase, ProcessInboxUseCase, QueryUseCase, RecoveryUseCase } from '../src/application/core';
import { LifecyclePolicy } from '../src/domain/policy';
import { validateMessage } from '../src/domain/validation';
import { ConflictError, NotFoundError, StorageError, ValidationError } from '../src/domain/errors';
import type { Kind, ValidationConfig } from '../src/domain/model';

const validation: ValidationConfig = { jsonMaxDepth: 32, maxPcmReasons: 32, evidenceAllowedBuckets: ['venue-logs'], evidenceMaxKeys: 20, evidenceMaxKeyBytes: 1024 };
const policy = new LifecyclePolicy({ failureThreshold: 3, failureWindowMs: 7 * 86400000, failureMinSpanMs: 86400000 });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'venue-storage-'));
  const path = join(dir, 'test.sqlite');
  let now = Date.parse('2026-10-24T12:00:00Z');
  const clock = { now: () => now++ };
  const store = new DatabaseStore(path);
  const admission = new AdmissionUseCase(store, clock);
  return { store, path, clock, admission, processor: new ProcessInboxUseCase(store, policy, validation, clock),
    admit(kind: Kind, body: unknown) { return admission.execute(validateMessage(kind, body, validation), `request-${clock.now()}`); },
    close() { if (store.db.open) store.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}
function report(reportId: string, venueId = 'V1', analyzedAt = '2026-10-24T01:00:00Z') {
  return { reportId, venueId, analyzedAt, trigger: 'auto', selfTest: { passed: true } };
}
function count(store: DatabaseStore, table: 'inbox' | 'venues' | 'history' | 'outbox' | 'observations'): number {
  const row = store.db.prepare<[], { count: number }>(`SELECT count(*) AS count FROM ${table}`).get();
  assert.ok(row); return row.count;
}

test('ten concurrent duplicate admissions commit one durable identity and one processing effect', async () => {
  const f = fixture();
  try {
    const outcomes = await Promise.all(Array.from({ length: 10 }, () => Promise.resolve().then(() => f.admit('report', report('same')))));
    assert.equal(outcomes.filter(item => !item.duplicate).length, 1);
    assert.equal(new Set(outcomes.map(item => item.inboxId)).size, 1);
    assert.equal(count(f.store, 'inbox'), 1);
    const first = outcomes[0]; assert.ok(first);
    const independent = new DatabaseStore(f.path);
    assert.equal(count(independent, 'inbox'), 1); independent.close();
    assert.equal(f.processor.runBatch(25), 1);
    assert.equal(f.processor.runBatch(25), 0);
    assert.equal(count(f.store, 'outbox'), 1);
    assert.equal(f.store.loadVenue('V1')?.status, 'Installed');
    const reordered = { selfTest: { passed: true }, trigger: 'auto', analyzedAt: '2026-10-24T01:00:00Z', venueId: 'V1', reportId: 'same' };
    assert.equal(f.admit('report', reordered).inboxId, first.inboxId);
    assert.throws(() => f.admit('report', { ...report('same'), venueId: 'V2' }), ConflictError);
  } finally { f.close(); }
});

test('failed durable admission does not return success or save an inbox row', () => {
  const f = fixture();
  try {
    f.store.db.pragma('query_only = ON');
    assert.throws(() => f.admit('report', report('failure')), StorageError);
    f.store.db.pragma('query_only = OFF');
    assert.equal(count(f.store, 'inbox'), 0);
  } finally { f.close(); }
});

test('first human decision atomically publishes installation then decision, recoverable after reopening', () => {
  const f = fixture();
  try {
    f.admit('calibration', { eventId: 'cal', venueId: 'V1', approvedAt: '2026-10-24T10:00:00Z' });
    f.store.close();
    const restarted = new DatabaseStore(f.path);
    const processor = new ProcessInboxUseCase(restarted, policy, validation, f.clock);
    assert.equal(processor.runBatch(25), 1);
    assert.equal(restarted.loadVenue('V1')?.status, 'Production');
    const rows = restarted.db.prepare<[], { sequence: number; payload: string; idempotencyKey: string }>('SELECT sequence,payload,idempotencyKey FROM outbox ORDER BY sequence').all();
    assert.deepEqual(rows.map(row => row.sequence), [1, 2]);
    assert.deepEqual(rows.map(row => row.idempotencyKey), ['V1:1', 'V1:2']);
    assert.equal(count(restarted, 'history'), 3);
    restarted.close();
  } finally { f.close(); }
});

test('exception before commit rolls back every business effect and blocks only the failing venue', () => {
  const f = fixture();
  try {
    const first = f.admit('operator', { commandId: 'bad', venueId: 'V1', status: 'Maintenance' });
    f.admit('operator', { commandId: 'successor', venueId: 'V1', status: 'Production' });
    f.admit('report', report('good', 'V2'));
    const errors: unknown[] = [];
    const processor = new ProcessInboxUseCase(f.store, policy, validation, f.clock, {
      info() {}, warn() {}, error(event, fields) { errors.push({ event, ...fields }); },
    }, {
      beforeCommit(inbox) {
        if (inbox.sourceId === 'bad') {
          const error = new TypeError('injected processing defect: private-diagnostic-secret');
          error.name = 'private-error-name-secret';
          throw error;
        }
      },
    });
    assert.equal(processor.runBatch(25), 1);
    assert.equal(f.store.loadVenue('V1'), null);
    assert.equal(f.store.loadVenue('V2')?.status, 'Installed');
    assert.equal(count(f.store, 'outbox'), 1);
    assert.equal(count(f.store, 'observations'), 1);
    assert.equal(processor.runBatch(25), 0);
    assert.match(JSON.stringify(errors), /storage\.test\.ts:\d+:\d+/);
    assert.match(JSON.stringify(errors), /inbox_blocked/);
    assert.doesNotMatch(JSON.stringify(errors), /private-diagnostic-secret|private-error-name-secret/);
    const publicState = JSON.stringify([f.store.messageView(first.inboxId), f.store.historyView('V1', 0, 100)]);
    assert.match(publicState, /PROCESSING_ERROR/);
    assert.match(publicState, /TypeError/);
    assert.doesNotMatch(publicState, /private-diagnostic-secret|private-error-name-secret|storage\.test\.ts|diagnostic|frames|internalCause/);
    const recovery = new RecoveryUseCase(f.store, f.clock);
    recovery.execute('inbox', first.inboxId, 'fault injection removed');
    assert.equal(f.processor.runBatch(25), 1);
    assert.equal(f.processor.runBatch(25), 1);
    assert.equal(f.store.loadVenue('V1')?.sequence, 3);
    assert.equal(f.store.loadVenue('V1')?.status, 'Production');
    const audit = f.store.db.prepare<[], { type: string }>("SELECT type FROM history WHERE venueId='V1' ORDER BY cursor").all();
    assert.equal(audit[0]?.type, 'processing_blocked');
    assert.equal(audit[1]?.type, 'recovery');
  } finally { f.close(); }
});

test('storage failure leaves accepted head pending rather than poisoning it', () => {
  const f = fixture();
  try {
    f.admit('report', report('r1'));
    f.store.db.pragma('query_only = ON');
    assert.throws(() => f.processor.runBatch(25), StorageError);
    f.store.db.pragma('query_only = OFF');
    const row = f.store.db.prepare<[], { state: string }>('SELECT state FROM inbox').get();
    assert.equal(row?.state, 'pending');
    assert.equal(count(f.store, 'venues'), 0);
    assert.equal(f.processor.runBatch(25), 1);
  } finally { f.close(); }
});

test('freshness is strict and late calibration preserves operator control', () => {
  const f = fixture();
  try {
    f.admit('report', report('first'));
    f.admit('report', report('equal'));
    f.admit('report', report('older', 'V1', '2026-10-23T01:00:00Z'));
    f.admit('operator', { commandId: 'op', venueId: 'V1', status: 'Production' });
    f.admit('calibration', { eventId: 'late', venueId: 'V1', approvedAt: '2026-10-24T10:00:00Z' });
    for (let i = 0; i < 5; i++) f.processor.runBatch(25);
    const venue = f.store.loadVenue('V1'); assert.ok(venue);
    assert.equal(venue.mode, 'manual');
    assert.equal(venue.latestReport?.reportId, 'first');
    assert.equal(venue.reportWatermark, Date.parse('2026-10-24T01:00:00Z'));
    assert.equal(venue.calibrationWatermark, Date.parse('2026-10-24T10:00:00Z'));
    const outcomes = f.store.db.prepare<[], { outcome: string }>('SELECT outcome FROM inbox ORDER BY ingestOrder').all().map(row => row.outcome);
    assert.deepEqual(outcomes, ['observed', 'ignored_stale', 'ignored_stale', 'applied', 'ignored_before_operator']);
    assert.equal(count(f.store, 'outbox'), 2);
  } finally { f.close(); }
});

test('pending reads, message privacy, pagination and recovery state checks are observable', () => {
  const f = fixture();
  try {
    const accepted = f.admit('report', { ...report('r'), privateField: 'not-public' });
    const query = new QueryUseCase(f.store);
    const pending = query.venue('V1');
    assert.match(JSON.stringify(pending), /"status":null/);
    assert.match(JSON.stringify(pending), /"state":"pending"/);
    assert.deepEqual(query.history('V1'), { items: [], nextCursor: null });
    assert.doesNotMatch(JSON.stringify(query.message(accepted.inboxId)), /privateField|not-public|canonical/);
    assert.throws(() => query.venue('unknown'), NotFoundError);
    assert.throws(() => query.history('V1', 0, 101), ValidationError);
    assert.throws(() => new RecoveryUseCase(f.store, f.clock).execute('inbox', accepted.inboxId, 'not blocked'), ValidationError);
    f.processor.runBatch(25);
    const history: unknown = query.history('V1', 0, 1);
    assert.match(JSON.stringify(history), /"nextCursor":1/);
  } finally { f.close(); }
});

test('a real SQLite deferred constraint rejects commit before admission can return success', () => {
  const f = fixture();
  try {
    f.store.db.exec(`
      CREATE TABLE guard_parent(id TEXT PRIMARY KEY);
      CREATE TABLE admission_guard(parentId TEXT REFERENCES guard_parent(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_admission_commit AFTER INSERT ON inbox BEGIN
        INSERT INTO admission_guard(parentId) VALUES('missing-parent');
      END;
    `);
    assert.throws(() => f.admit('report', report('commit-failure')), /FOREIGN KEY constraint failed/);
    assert.equal(count(f.store, 'inbox'), 0);
    assert.equal(f.store.db.inTransaction, false);
    f.store.db.exec('DROP TRIGGER fail_admission_commit');
    assert.equal(f.admit('report', report('commit-failure')).duplicate, false);
  } finally { f.close(); }
});

test('SQLite outbox-write failure rolls back state and sequence; recovery retains errors and identities', () => {
  const f = fixture();
  try {
    const first = f.admit('operator', { commandId: 'op1', venueId: 'V1', status: 'Maintenance' });
    f.admit('operator', { commandId: 'op2', venueId: 'V1', status: 'Production' });
    f.store.db.exec(`CREATE TRIGGER fail_outbox BEFORE INSERT ON outbox BEGIN SELECT RAISE(ABORT,'injected outbox failure'); END;`);
    assert.equal(f.processor.runBatch(25), 0);
    assert.equal(count(f.store, 'venues'), 0);
    assert.equal(count(f.store, 'outbox'), 0);
    const blocked = f.store.db.prepare<[string], { state: string; canonical: string; requestId: string; ingestOrder: number; errorCode: string }>('SELECT * FROM inbox WHERE inboxId=?').get(first.inboxId);
    assert.ok(blocked); assert.equal(blocked.state, 'blocked');
    assert.equal(f.processor.runBatch(25), 0);
    f.store.db.exec('DROP TRIGGER fail_outbox');
    new RecoveryUseCase(f.store, f.clock).execute('inbox', first.inboxId, 'write fault removed');
    const recovered = f.store.db.prepare<[string], { canonical: string; requestId: string; ingestOrder: number; errorCode: string }>('SELECT * FROM inbox WHERE inboxId=?').get(first.inboxId);
    assert.ok(recovered);
    for (const key of ['canonical', 'requestId', 'ingestOrder', 'errorCode'] as const) assert.equal(recovered[key], blocked[key]);
    assert.equal(f.processor.runBatch(25), 1);
    assert.equal(f.store.loadVenue('V1')?.sequence, 2);
    assert.equal(f.processor.runBatch(25), 1);
    assert.equal(f.store.loadVenue('V1')?.sequence, 3);
    const recovery = f.store.db.prepare<[], { data: string }>("SELECT data FROM history WHERE type='recovery'").get();
    assert.ok(recovery); assert.match(recovery.data, /PROCESSING_ERROR/);
    assert.equal(f.admit('operator', { commandId: 'op1', venueId: 'V1', status: 'Maintenance' }).inboxId, first.inboxId);
  } finally { f.close(); }
});

test('bounded inbox rotation progresses beyond noisy old venues and excludes blocked heads', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10; i++) f.admit('operator', { commandId: `busy-${i}`, venueId: 'busy', status: 'Production' });
    f.admit('report', report('other', 'other'));
    assert.equal(f.processor.runBatch(1), 1);
    assert.equal(f.processor.runBatch(1), 1);
    // The next head of the noisy venue must not displace another venue from this rotation.
    assert.equal(f.store.loadVenue('other')?.status, 'Installed');
    const query = new QueryUseCase(f.store);
    f.store.close();
    assert.throws(() => query.venue('busy'), StorageError);
  } finally { f.close(); }
});

test('offline recovery CLI rejects wrong targets/states and requeues a blocked outbox without changing identity', () => {
  const f = fixture();
  try {
    f.admit('operator', { commandId: 'recover', venueId: 'V1', status: 'Maintenance' });
    f.processor.runBatch(25);
    f.store.db.prepare("UPDATE outbox SET state='blocked',lastErrorCode='DOWNSTREAM_REJECTED',lastHttpStatus=422 WHERE sequence=1").run();
    const before = f.store.db.prepare<[], { id: string; payload: string; idempotencyKey: string; sequence: number }>('SELECT id,payload,idempotencyKey,sequence FROM outbox ORDER BY sequence LIMIT 1').get();
    assert.ok(before);
    f.store.close();
    const cli = (...args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'src/recover.ts', ...args], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, SQLITE_PATH: f.path }, timeout: 10000,
    });
    const missing = cli('outbox', 'missing', '--reason', 'test');
    assert.equal(missing.status, 1); assert.match(missing.stderr, /recovery_failed/);
    const badReason = cli('outbox', before.id, '--reason', ' ');
    assert.equal(badReason.status, 1);
    const successful = cli('outbox', before.id, '--reason', 'downstream corrected');
    assert.equal(successful.status, 0, successful.stderr);
    assert.match(successful.stdout, /recovery_recorded/);
    const wrongState = cli('outbox', before.id, '--reason', 'already pending');
    assert.equal(wrongState.status, 1);
    const reopened = new DatabaseStore(f.path);
    try {
      const after = reopened.db.prepare<[string], { id: string; payload: string; idempotencyKey: string; sequence: number; state: string; lastErrorCode: string }>('SELECT * FROM outbox WHERE id=?').get(before.id);
      assert.ok(after); assert.equal(after.state, 'pending');
      for (const key of ['id', 'payload', 'idempotencyKey', 'sequence'] as const) assert.equal(after[key], before[key]);
      assert.equal(after.lastErrorCode, 'DOWNSTREAM_REJECTED');
      const audit = reopened.db.prepare<[], { data: string }>("SELECT data FROM history WHERE type='recovery'").all();
      assert.equal(audit.length, 1); assert.match(audit[0]?.data ?? '', /downstream corrected/);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test('real SQLite writer contention is a storage outage, with pending work retained for retry', () => {
  const f = fixture();
  const competing = new DatabaseStore(f.path);
  try {
    f.admit('report', report('accepted-before-lock'));
    f.store.db.pragma('busy_timeout = 1');
    competing.db.exec('BEGIN IMMEDIATE');
    assert.throws(() => f.admit('report', report('not-accepted')), StorageError);
    assert.throws(() => f.processor.runBatch(25), StorageError);
    competing.db.exec('ROLLBACK');
    assert.equal(count(f.store, 'inbox'), 1);
    const pending = f.store.db.prepare<[], { state: string }>('SELECT state FROM inbox').get();
    assert.equal(pending?.state, 'pending');
    assert.equal(f.processor.runBatch(25), 1);
  } finally {
    if (competing.db.inTransaction) competing.db.exec('ROLLBACK');
    competing.close(); f.close();
  }
});

test('SQLite observation lookup preserves inclusive window failures across a passing report', () => {
  const f = fixture();
  try {
    f.admit('calibration', { eventId: 'start', venueId: 'V1', approvedAt: '2026-10-16T00:00:00Z' });
    const checks = [
      { id: 'a', at: '2026-10-17T00:00:00Z', status: 'fail' },
      { id: 'healthy', at: '2026-10-18T00:00:00Z', status: 'pass' },
      { id: 'b', at: '2026-10-20T00:00:00Z', status: 'fail' },
      { id: 'c', at: '2026-10-24T00:00:00Z', status: 'fail' },
    ];
    for (const check of checks) f.admit('report', {
      ...report(check.id, 'V1', check.at), pcm: { ran: true, status: check.status, reasons: ['PCM_CAMERA_MOVEMENT'] },
    });
    for (let i = 0; i < 5; i++) assert.equal(f.processor.runBatch(25), 1);
    assert.equal(f.store.loadVenue('V1')?.status, 'Maintenance');
    assert.equal(f.store.loadVenue('V1')?.reason, 'PCM_CAMERA_MOVEMENT');
    assert.equal(f.store.loadVenue('V1')?.sequence, 6);
    assert.equal(count(f.store, 'observations'), 4);
    assert.equal(count(f.store, 'outbox'), 6);
  } finally { f.close(); }
});

test('corrupt persisted venue data is unavailable storage, not a poison classification of new work', () => {
  const f = fixture();
  try {
    f.admit('report', report('first'));
    f.processor.runBatch(25);
    f.admit('report', report('next', 'V1', '2026-10-25T01:00:00Z'));
    f.store.db.prepare('UPDATE venues SET stateJson=? WHERE venueId=?').run('{broken', 'V1');
    assert.throws(() => new QueryUseCase(f.store).venue('V1'), StorageError);
    assert.throws(() => f.processor.runBatch(25), StorageError);
    const row = f.store.db.prepare<[], { state: string }>("SELECT state FROM inbox WHERE sourceId='next'").get();
    assert.equal(row?.state, 'pending');
    assert.equal(count(f.store, 'outbox'), 1);
  } finally { f.close(); }
});

test('a post-commit diagnostic failure cannot manufacture a blocked business outcome', () => {
  const f = fixture();
  try {
    f.admit('report', report('diagnostic-failure'));
    const logger = {
      info() { throw new Error('diagnostic sink unavailable'); },
      warn() {}, error() {},
    };
    const processor = new ProcessInboxUseCase(f.store, policy, validation, f.clock, logger);
    assert.throws(() => processor.runBatch(25), /diagnostic sink unavailable/);
    assert.equal(f.store.db.prepare<[], { state: string }>('SELECT state FROM inbox').get()?.state, 'processed');
    assert.equal(count(f.store, 'outbox'), 1);
    assert.equal(f.store.db.prepare<[], { count: number }>("SELECT count(*) AS count FROM history WHERE type='processing_blocked'").get()?.count, 0);
  } finally { f.close(); }
});

test('admission never exposes an ingestion order beyond safe integer bounds', () => {
  const f = fixture();
  try {
    f.admit('report', report('existing'));
    f.store.db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='inbox'").run(Number.MAX_SAFE_INTEGER);
    assert.throws(() => f.admit('report', report('unsafe-order')), /Ingestion order exhausted/);
    assert.equal(count(f.store, 'inbox'), 1);
  } finally { f.close(); }
});
