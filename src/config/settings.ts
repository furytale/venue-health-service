import { registerAs } from '@nestjs/config';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
type Environment = Readonly<Record<string, string | undefined>>;
const MAX_TIMER = 86_400_000;

export function loadSettings(env: Environment) {
  const numeric = (key: string, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER, integer = true): number => {
    const raw = env[key];
    const value = raw === undefined ? fallback : Number(raw);
    if (raw?.trim() === '' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
      throw new Error(`Invalid configuration: ${key}`);
    }
    return value;
  };
  const required = (key: string): string => {
    const value = env[key];
    if (!value?.trim()) throw new Error(`Missing configuration: ${key}`);
    return value;
  };
  const downstreamUrl = required('DOWNSTREAM_URL');
  let url: URL;
  try { url = new URL(downstreamUrl); } catch { throw new Error('Invalid configuration: DOWNSTREAM_URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid configuration: DOWNSTREAM_URL');
  const sqlitePath = env.SQLITE_PATH ?? './data/venue-health.sqlite';
  if (!sqlitePath.trim() || sqlitePath.includes('\0') || (env.NODE_ENV === 'production' && sqlitePath === ':memory:')) throw new Error('Invalid configuration: SQLITE_PATH');
  const baseDelayMs = numeric('RETRY_BASE_DELAY_MS', 1000, 1);
  const maxDelayMs = numeric('RETRY_MAX_DELAY_MS', 60000, baseDelayMs, Math.floor(Number.MAX_SAFE_INTEGER / 2));
  const failureWindowMs = numeric('PCM_FAILURE_WINDOW_DAYS', 7, Number.MIN_VALUE, Number.MAX_SAFE_INTEGER / 86_400_000, false) * 86_400_000;
  const failureMinSpanMs = numeric('PCM_FAILURE_MIN_SPAN_HOURS', 24, Number.MIN_VALUE, failureWindowMs / 3_600_000, false) * 3_600_000;
  if (!Number.isFinite(failureWindowMs) || !Number.isFinite(failureMinSpanMs) || failureWindowMs <= 0 || failureMinSpanMs <= 0) throw new Error('Invalid configuration: policy durations');
  const buckets = (env.EVIDENCE_ALLOWED_BUCKETS ?? 'venue-logs').split(',');
  if (buckets.some(bucket => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(bucket))) throw new Error('Invalid configuration: EVIDENCE_ALLOWED_BUCKETS');
  const level = env.LOG_LEVEL ?? 'info';
  if (level !== 'debug' && level !== 'info' && level !== 'warn' && level !== 'error' && level !== 'fatal') throw new Error('Invalid configuration: LOG_LEVEL');
  const apiKey = required('DOWNSTREAM_API_KEY');
  if (/[^\x20-\x7e]/.test(apiKey)) throw new Error('Invalid configuration: DOWNSTREAM_API_KEY');
  return Object.freeze({
    http: Object.freeze({port: numeric('PORT', 3000, 1, 65535), bodyLimitBytes: numeric('HTTP_BODY_LIMIT_BYTES', 262144, 1), historyMaxPageSize: numeric('HISTORY_MAX_PAGE_SIZE', 100, 50, 1000)}),
    storage: Object.freeze({path: sqlitePath, busyTimeoutMs: numeric('SQLITE_BUSY_TIMEOUT_MS', 1000, 1, 10000), retryDelayMs: numeric('STORAGE_RETRY_DELAY_MS', 1000, 1, MAX_TIMER)}),
    downstream: Object.freeze({baseUrl: url.toString().replace(/\/$/, ''), apiKey, timeoutMs: numeric('DOWNSTREAM_TIMEOUT_MS', 5000, 1, MAX_TIMER), concurrency: numeric('DOWNSTREAM_CONCURRENCY', 4, 1, 32), errorExcerptBytes: numeric('DOWNSTREAM_ERROR_EXCERPT_BYTES', 1024, 0, 16384)}),
    inbox: Object.freeze({pollIntervalMs: numeric('INBOX_POLL_INTERVAL_MS', 100, 1, MAX_TIMER), batchSize: numeric('INBOX_BATCH_SIZE', 25, 1, 1000)}),
    outbox: Object.freeze({pollIntervalMs: numeric('OUTBOX_POLL_INTERVAL_MS', 200, 1, MAX_TIMER), batchSize: numeric('OUTBOX_BATCH_SIZE', 25, 1, 1000)}),
    retry: Object.freeze({baseDelayMs, maxDelayMs, jitterRatio: numeric('RETRY_JITTER_RATIO', .2, 0, .9, false)}),
    policy: Object.freeze({failureThreshold: numeric('PCM_FAILURE_THRESHOLD', 3, 2), failureWindowMs, failureMinSpanMs}),
    validation: Object.freeze({jsonMaxDepth: numeric('JSON_MAX_DEPTH', 32, 1, 128), maxPcmReasons: numeric('MAX_PCM_REASONS', 32, 1), evidenceAllowedBuckets: Object.freeze(buckets), evidenceMaxKeys: numeric('EVIDENCE_MAX_KEYS', 20, 0), evidenceMaxKeyBytes: numeric('EVIDENCE_MAX_KEY_BYTES', 1024, 1)}),
    shutdownTimeoutMs: numeric('SHUTDOWN_TIMEOUT_MS', 10000, 1, MAX_TIMER),
    logLevel: level,
  });
}
export type Settings = ReturnType<typeof loadSettings>;
export const settingsFactory = registerAs('settings', () => loadSettings(process.env));
