import test from 'node:test';
import assert from 'node:assert/strict';
import { LifecyclePolicy } from '../src/domain/policy';
import { FailureObservation, Kind, PolicyResult, ValidationConfig, Venue } from '../src/domain/model';
import { canonicalJson, validateMessage } from '../src/domain/validation';
import { ValidationError } from '../src/domain/errors';
import { parseVenueState } from '../src/domain/decode';

const validation: ValidationConfig = { jsonMaxDepth: 32, maxPcmReasons: 32, evidenceAllowedBuckets: ['venue-logs'], evidenceMaxKeys: 20, evidenceMaxKeyBytes: 1024 };
const day = 86_400_000;
const start = Date.parse('2026-10-01T00:00:00Z');
const iso = (offset: number): string => new Date(start + offset).toISOString();
function report(id: string, offset = 0, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { reportId: id, venueId: 'V1', analyzedAt: iso(offset), trigger: 'auto', selfTest: { passed: true }, ...extra };
}
function failed(id: string, offset: number, reason = 'PCM_CAMERA_MOVEMENT', extra: Record<string, unknown> = {}): Record<string, unknown> {
  return report(id, offset, { pcm: { ran: true, status: 'fail', primaryReason: reason }, ...extra });
}
class Harness {
  venue: Venue | null = null;
  observations: FailureObservation[] = [];
  private readonly policy = new LifecyclePolicy({ failureThreshold: 3, failureWindowMs: 7 * day, failureMinSpanMs: day });
  apply(kind: Kind, body: unknown, receivedAt = iso(0)): PolicyResult {
    const result = this.policy.evaluate(this.venue, validateMessage(kind, body, validation), { receivedAt, processedAt: receivedAt }, this.observations);
    this.venue = result.venue;
    if (result.observation) this.observations.push(result.observation);
    return result;
  }
  activate(): PolicyResult { return this.apply('calibration', { eventId: 'cal-1', venueId: 'V1', approvedAt: iso(0) }); }
}

test('first report creates only Installed; first human input publishes Installed then its decision', () => {
  const reportResult = new Harness().apply('report', failed('first', 0, 'PCM_CAMERA_MOVEMENT', { selfTest: { passed: false } }));
  assert.equal(reportResult.venue.status, 'Installed');
  assert.equal(reportResult.publications.length, 1);
  assert.equal(reportResult.observation?.eligible, false);
  for (const [kind, body, expected] of [
    ['calibration', { eventId: 'cal', venueId: 'V1', approvedAt: iso(0) }, 'Production'],
    ['operator', { commandId: 'cmd', venueId: 'V1', status: 'Maintenance' }, 'Maintenance'],
  ] satisfies [Kind, unknown, string][]) {
    const result = new Harness().apply(kind, body);
    assert.deepEqual(result.publications.map(item => [item.payload.sequence, item.payload.status]), [[1, 'Installed'], [2, expected]]);
    assert.equal(result.publications[0]?.payload.pcm, undefined);
  }
});

test('PCM threshold combines reasons, includes minimum span/window boundaries, and survives passes', () => {
  const h = new Harness(); h.activate();
  assert.equal(h.apply('report', failed('a', 0)).venue.status, 'SuspectedMaintenance');
  assert.equal(h.apply('report', report('pass', day / 4, { pcm: { ran: true, status: 'pass' } })).venue.status, 'Production');
  assert.equal(h.apply('report', failed('b', day / 2, 'PCM_CAMERA_BAD_FOCUS_CRITICAL')).venue.status, 'SuspectedMaintenance');
  assert.equal(h.apply('report', failed('c', day, 'SOME_OTHER_REASON')).venue.status, 'Maintenance');
  const boundary = new Harness(); boundary.activate();
  boundary.apply('report', failed('a', 0)); boundary.apply('report', failed('b', day));
  assert.equal(boundary.apply('report', failed('c', 7 * day)).venue.status, 'Maintenance');
  const outside = new Harness(); outside.activate();
  outside.apply('report', failed('a', 0)); outside.apply('report', failed('b', day));
  assert.equal(outside.apply('report', failed('c', 7 * day + 1)).venue.status, 'SuspectedMaintenance');
});

test('same-night bursts do not escalate and incomplete PCM never proves recovery', () => {
  const h = new Harness(); h.activate();
  for (let i = 0; i < 5; i++) assert.equal(h.apply('report', failed(`f${i}`, i * 1000)).venue.status, 'SuspectedMaintenance');
  for (const [index, extra] of [{}, { pcm: { ran: false, status: 'pass' } }, { pcm: { ran: true, status: 'inconclusive' } }].entries()) {
    assert.equal(h.apply('report', report(`neutral${index}`, day + index, extra)).venue.status, 'SuspectedMaintenance');
  }
  assert.equal(h.apply('report', report('healthy', 2 * day, { pcm: { ran: true, status: 'pass' } })).venue.status, 'Production');
});

test('hardware failure takes precedence, PCM still counts, and Maintenance reason remains latched on health', () => {
  const h = new Harness(); h.activate();
  const hardware = h.apply('report', failed('hw', 0, 'PCM_CAMERA_MOVEMENT', { selfTest: { passed: false } }));
  assert.equal(hardware.venue.status, 'Maintenance'); assert.equal(hardware.venue.reason, 'SELF_TEST_FAILED');
  assert.equal(hardware.observation?.eligible, true);
  const healthy = h.apply('report', report('healthy', day, { pcm: { ran: true, status: 'pass' } }));
  assert.equal(healthy.venue.reason, 'SELF_TEST_FAILED'); assert.equal(healthy.publications.length, 0);
  const later = h.apply('report', failed('later', 30 * day, 'PCM_CAMERA_BAD_FOCUS'));
  assert.equal(later.venue.status, 'Maintenance'); assert.equal(later.venue.reason, 'PCM_CAMERA_BAD_FOCUS');
});

test('all manual statuses stay pinned; reports still advance watermarks, but do not count', () => {
  for (const status of ['Installed', 'Production', 'SuspectedMaintenance', 'Maintenance']) {
    const h = new Harness();
    h.apply('operator', { commandId: 'pin', venueId: 'V1', status });
    const result = h.apply('report', failed('bad', day, 'PCM_CAMERA_MOVEMENT', { selfTest: { passed: false } }));
    assert.equal(result.venue.status, status); assert.equal(result.venue.reason, 'OPERATOR_DECISION');
    assert.equal(result.venue.reportWatermark, start + day); assert.equal(result.observation?.eligible, false);
    assert.equal(result.publications.length, 0);
    assert.equal(h.apply('operator', { commandId: 'pin-again', venueId: 'V1', status }).publications.length, 1);
  }
});

test('calibration releases manual control, resets epoch, preserves watermarks and blocks late approvals', () => {
  const h = new Harness(); h.activate();
  h.apply('report', failed('a', day)); h.apply('report', failed('b', 2 * day));
  h.apply('operator', { commandId: 'pin', venueId: 'V1', status: 'Maintenance' }, iso(3 * day));
  const cutoff = h.apply('calibration', { eventId: 'late', venueId: 'V1', approvedAt: iso(2 * day) });
  assert.equal(cutoff.outcome, 'ignored_before_operator'); assert.equal(cutoff.venue.mode, 'manual');
  assert.equal(cutoff.venue.calibrationWatermark, start + 2 * day);
  const reset = h.apply('calibration', { eventId: 'new', venueId: 'V1', approvedAt: iso(4 * day) });
  assert.equal(reset.venue.mode, 'automatic'); assert.equal(reset.venue.status, 'Production');
  assert.equal(reset.venue.reportWatermark, start + 2 * day);
  assert.equal(h.apply('report', failed('c', 5 * day)).venue.status, 'SuspectedMaintenance');
  assert.equal(h.apply('report', failed('stale', 2 * day)).outcome, 'ignored_stale');
});

test('equal source instants are stale even with different timestamp spelling; calibration reset may avoid publication', () => {
  const h = new Harness(); h.activate();
  const reset = h.apply('calibration', { eventId: 'next', venueId: 'V1', approvedAt: iso(day) });
  assert.equal(reset.publications.length, 0); assert.equal(reset.venue.epoch, 2);
  h.apply('report', report('first', day));
  const equal = h.apply('report', { ...report('equal', day), analyzedAt: '2026-10-02T00:00:00Z' });
  assert.equal(equal.outcome, 'ignored_stale'); assert.equal(equal.venue.latestReport?.reportId, 'first');
  assert.equal(h.apply('calibration', { eventId: 'equal', venueId: 'V1', approvedAt: iso(day) }).outcome, 'ignored_stale');
});

test('publication identity follows decision tuple, and safe PCM belongs only to its triggering report', () => {
  const h = new Harness(); h.activate();
  const evidence = { bucket: 'venue-logs', resultKey: 'pcm/results/date=2026-10-01/V1/result.json', evidenceKeys: ['pcm/evidence/date=2026-10-01/V1/image.jpg'] };
  const first = h.apply('report', report('a', 0, { pcm: { ran: true, status: 'fail', primaryReason: 'PCM_CAMERA_MOVEMENT', evidence } }));
  assert.deepEqual(first.publications[0]?.payload.pcm, { analyzedAt: iso(0), bucket: evidence.bucket, result: evidence.resultKey, evidence: evidence.evidenceKeys, uploadFailed: false });
  assert.equal(h.apply('report', failed('same', 1000)).publications.length, 0);
  const changed = h.apply('report', failed('changed', 2000, 'PCM_CAMERA_BAD_FOCUS'));
  assert.equal(changed.publications.length, 1); assert.equal(changed.publications[0]?.payload.pcm, undefined);
  const hardware = h.apply('report', report('hardware', 3000, { selfTest: { passed: false }, pcm: { ran: true, status: 'fail', evidence } }));
  assert.equal(hardware.publications[0]?.payload.pcm, undefined);
  assert.equal(first.publications[0]?.payload.reason, 'PCM_CAMERA_MOVEMENT');
});

test('canonical identity retains unknown fields, arrays and invalid evidence while ignoring object key order', () => {
  const first = { ...report('a'), extension: { z: null, a: [1, 2] }, pcm: { ran: true, status: 'fail', evidence: null } };
  const reordered = { pcm: first.pcm, extension: { a: [1, 2], z: null }, ...report('a') };
  assert.equal(validateMessage('report', first, validation).canonicalPayload, validateMessage('report', reordered, validation).canonicalPayload);
  assert.notEqual(canonicalJson(first, 32), canonicalJson({ ...first, extension: { z: null, a: [2, 1] } }, 32));
  assert.notEqual(canonicalJson(first, 32), canonicalJson({ ...first, pcm: { ran: true, status: 'fail' } }, 32));
});

test('core malformed inputs and calendar errors reject without coercion', () => {
  const bad = [
    { venueId: '../V1' }, { reportId: ' a' }, { reportId: 'x\n' }, { analyzedAt: '2026-02-30T00:00:00Z' },
    { analyzedAt: '2026-10-01T24:00:00Z' }, { analyzedAt: '2026-10-01T00:00:00+00:00' },
    { selfTest: { passed: 'true' } }, { trigger: 'scheduled' }, { pcm: null }, { pcm: { ran: true } },
    { pcm: { ran: false, status: null } }, { pcm: { ran: false, reasons: null } },
    { pcm: { ran: false, uploadFailed: null } }, { pcm: { ran: true, status: 'fail', primaryReason: 'bad reason' } },
  ];
  for (const extra of bad) assert.throws(() => validateMessage('report', report('a', 0, extra), validation), ValidationError);
  assert.throws(() => validateMessage('operator', { commandId: 'a', venueId: 'V1', status: 'Production', issuedAt: null }, validation), ValidationError);
  assert.throws(() => validateMessage('report', report('a', 0, { extension: { nested: { deep: 1 } } }), { ...validation, jsonMaxDepth: 3 }), ValidationError);
  assert.throws(() => validateMessage('report', report('a', 0, { pcm: { ran: false, reasons: ['A', 'B'] } }), { ...validation, maxPcmReasons: 1 }), ValidationError);
});

test('unsafe evidence is excluded whole without changing valid core signal or upload flag', () => {
  const good = { bucket: 'venue-logs', resultKey: 'pcm/results/date=2026-10-01/V1/result.json', evidenceKeys: ['pcm/evidence/date=2026-10-01/V1/image.jpg'] };
  const bad: unknown[] = [null, {}, { ...good, bucket: 'other' }, { ...good, evidenceKeys: ['pcm/evidence/date=2026-10-01/V10/image.jpg'] },
    ...['../result.json', 'pcm/results/date=2026-02-30/V1/result.json', 'pcm/results/date=2026-10-01/V1/../result.json', 'pcm/results/date=2026-10-01/V1/%2e.json', 'pcm/results/date=2026-10-01/V1/result.json?x', 'pcm/results/date=2026-10-01/V1//result.json'].map(resultKey => ({ ...good, resultKey })),
  ];
  for (const value of bad) {
    const result = validateMessage('report', report('a', 0, { pcm: { ran: true, status: 'fail', evidence: value } }), validation);
    assert.equal(result.kind, 'report');
    if (result.kind !== 'report') throw new Error('Expected report');
    assert.equal(result.pcm?.evidence, null); assert.equal(result.pcm?.evidenceValidation.state, 'excluded');
    assert.equal(result.pcm?.status, 'fail'); assert.equal(result.pcm?.uploadFailed, false);
  }
  for (const limits of [{ ...validation, evidenceMaxKeys: 0 }, { ...validation, evidenceMaxKeyBytes: 10 }]) {
    const result = validateMessage('report', report('a', 0, { pcm: { ran: true, status: 'fail', evidence: good } }), limits);
    if (result.kind !== 'report') throw new Error('Expected report');
    assert.equal(result.pcm?.evidence, null);
  }
  const result = validateMessage('report', report('a', 0, { pcm: { ran: true, status: 'fail', reasons: ['Z', 'A', 'A'], evidence: { ...good, evidenceKeys: [...good.evidenceKeys, ...good.evidenceKeys] } } }), validation);
  if (result.kind !== 'report') throw new Error('Expected report');
  assert.equal(result.pcm?.primaryReason, 'A'); assert.deepEqual(result.pcm?.reasons, ['Z', 'A']);
  assert.deepEqual(result.pcm?.evidence?.evidenceKeys, good.evidenceKeys);
});

test('persisted venue decoder preserves state and rejects damaged storage shapes', () => {
  const h = new Harness(); h.activate(); h.apply('report', failed('a', 0));
  const value: unknown = JSON.parse(JSON.stringify(h.venue));
  assert.deepEqual(parseVenueState(value), h.venue);
  assert.throws(() => parseVenueState({ ...h.venue, sequence: '2' }), /Invalid persisted/);
});

test('earliest bounded failure sample preserves escalation count and span', () => {
  const h = new Harness(); const active = h.activate().venue;
  for (const times of [[], [9 * day], [9 * day, 9 * day + 1], [3 * day, 8 * day, 9 * day, 9 * day + 1], [9 * day + 1, 9 * day + 2, 9 * day + 3]]) {
    const policy = new LifecyclePolicy({ failureThreshold: 3, failureWindowMs: 7 * day, failureMinSpanMs: day });
    const message = validateMessage('report', failed('sample', 10 * day), validation);
    const all = times.map(time => ({ analyzedAtMs: start + time, epoch: active.epoch, eligible: true }));
    const query = policy.failureQuery(start + 10 * day);
    const sampled = all.filter(item => item.analyzedAtMs >= query.from && item.analyzedAtMs <= query.to).sort((a, b) => a.analyzedAtMs - b.analyzedAtMs).slice(0, query.limit);
    assert.deepEqual(policy.evaluate(active, message, { receivedAt: iso(10 * day), processedAt: iso(10 * day) }, sampled), policy.evaluate(active, message, { receivedAt: iso(10 * day), processedAt: iso(10 * day) }, all));
  }
});

test('maximum policy window safely saturates at year 0000 without unsafe subtraction', () => {
  const policy = new LifecyclePolicy({ failureThreshold: 2, failureWindowMs: Number.MAX_SAFE_INTEGER, failureMinSpanMs: day });
  const earliest = Date.parse('0000-01-01T00:00:00Z');
  const latest = Date.parse('9999-12-31T23:59:59.999Z');
  for (const instant of [earliest, start, latest]) {
    const query = policy.failureQuery(instant);
    assert.equal(query.from, earliest); assert.equal(query.to, instant);
    assert.ok(Number.isSafeInteger(query.from));
  }
  const active = new Harness().activate().venue;
  const first = validateMessage('report', { ...failed('earliest', 0), analyzedAt: '0000-01-01T00:00:00Z' }, validation);
  const initial = policy.evaluate(active, first, { receivedAt: iso(0), processedAt: iso(0) }, []);
  assert.equal(initial.venue.status, 'SuspectedMaintenance');
  const last = validateMessage('report', { ...failed('latest', 0), analyzedAt: '9999-12-31T23:59:59.999Z' }, validation);
  assert.ok(initial.observation);
  const escalated = policy.evaluate(initial.venue, last, { receivedAt: iso(0), processedAt: iso(0) }, [initial.observation]);
  assert.equal(escalated.venue.status, 'Maintenance');
});
