import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { loadSettings } from '../src/config/settings';
const required = { DOWNSTREAM_URL: 'http://127.0.0.1:4000', DOWNSTREAM_API_KEY: 'fake-development-key' };

test('configuration defaults and snapshot groups are validated and immutable', () => {
  const config = loadSettings(required);
  assert.equal(config.http.port, 3000); assert.equal(config.downstream.timeoutMs, 5000);
  assert.equal(config.policy.failureThreshold, 3); assert.equal(config.policy.failureWindowMs, 7 * 86400000);
  assert.equal(config.policy.failureMinSpanMs, 86400000); assert.equal(config.retry.jitterRatio, .2);
  assert.ok(Object.isFrozen(config)); assert.ok(Object.isFrozen(config.validation)); assert.ok(Object.isFrozen(config.validation.evidenceAllowedBuckets));
  const minimum = loadSettings({ ...required, RETRY_JITTER_RATIO: '0', EVIDENCE_MAX_KEYS: '0', DOWNSTREAM_ERROR_EXCERPT_BYTES: '0', INBOX_POLL_INTERVAL_MS: '86400000' });
  assert.equal(minimum.validation.evidenceMaxKeys, 0); assert.equal(minimum.retry.jitterRatio, 0);
});

test('configuration rejects missing values, invalid limits, URL secrets, timer overflow and cross-field contradictions', () => {
  assert.throws(() => loadSettings({}), /configuration/);
  const invalid: Record<string, string>[] = [
    { DOWNSTREAM_URL: 'not-a-url' }, { DOWNSTREAM_API_KEY: '' }, { DOWNSTREAM_API_KEY: 'key\nsecret' }, { DOWNSTREAM_URL: 'file:///tmp/test' },
    { DOWNSTREAM_URL: 'http://name:secret@localhost:4000' }, { DOWNSTREAM_URL: 'http://localhost:4000?secret=x' }, { DOWNSTREAM_URL: 'http://localhost:4000#fragment' },
    { PORT: '0' }, { PORT: '65536' }, { PORT: '1.5' }, { PORT: 'NaN' }, { PORT: '' },
    { SQLITE_PATH: '' }, { SQLITE_PATH: ':memory:', NODE_ENV: 'production' }, { SQLITE_BUSY_TIMEOUT_MS: '10001' },
    { DOWNSTREAM_CONCURRENCY: '33' }, { INBOX_BATCH_SIZE: '0' }, { OUTBOX_BATCH_SIZE: '1001' },
    { RETRY_BASE_DELAY_MS: '2000', RETRY_MAX_DELAY_MS: '1000' }, { RETRY_JITTER_RATIO: '1' },
    { PCM_FAILURE_THRESHOLD: '1' }, { PCM_FAILURE_WINDOW_DAYS: '0' }, { PCM_FAILURE_WINDOW_DAYS: '1', PCM_FAILURE_MIN_SPAN_HOURS: '25' },
    { JSON_MAX_DEPTH: '129' }, { EVIDENCE_ALLOWED_BUCKETS: '' }, { EVIDENCE_ALLOWED_BUCKETS: 'venue-logs,' }, { EVIDENCE_MAX_KEYS: '-1' },
    { HISTORY_MAX_PAGE_SIZE: '49' }, { HTTP_BODY_LIMIT_BYTES: '0' }, { DOWNSTREAM_ERROR_EXCERPT_BYTES: '16385' }, { LOG_LEVEL: 'trace' },
    ...['STORAGE_RETRY_DELAY_MS', 'DOWNSTREAM_TIMEOUT_MS', 'INBOX_POLL_INTERVAL_MS', 'OUTBOX_POLL_INTERVAL_MS', 'SHUTDOWN_TIMEOUT_MS'].map(key => ({ [key]: '86400001' })),
  ];
  for (const extra of invalid) assert.throws(() => loadSettings({ ...required, ...extra }), /configuration/, Object.keys(extra).join(','));
});


test('invalid startup configuration exits nonzero before starting HTTP and never logs a supplied key', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ...required, PORT: '0', DOWNSTREAM_API_KEY: 'must-never-appear-in-output' },
  });
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /configuration_invalid/);
  assert.match(result.stderr, /PORT/);
  const fatalLine = result.stderr.split('\n').find(line => line.includes('"event":"fatal_exception"'));
  assert.ok(fatalLine);
  assert.match(fatalLine, /settings\.ts:\d+:\d+/);
  assert.doesNotMatch(fatalLine, /Invalid configuration|must-never-appear-in-output/);
  assert.doesNotMatch(result.stdout + result.stderr, /service_started|must-never-appear-in-output/);
  const failedSink = spawnSync(process.execPath, ['--import', 'tsx', '-e',
    "require('./src/adapters/logger').JsonLogger.prototype.log = () => { throw new Error('sink unavailable'); }; require('./src/main');"], {
    cwd: process.cwd(), encoding: 'utf8', timeout: 10000,
    env: { ...process.env, ...required, PORT: '0' },
  });
  assert.equal(failedSink.status, 1, 'A failed best-effort diagnostic write must still terminate nonzero');
  assert.equal(failedSink.signal, null, 'Fatal termination must not wait for the subprocess timeout');
});
