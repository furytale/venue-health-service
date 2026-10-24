import { existsSync } from 'node:fs';
import { DatabaseStore } from './adapters/sqlite';
import { RecoveryUseCase } from './application/core';
import { ApplicationError } from './domain/errors';
import { JsonLogger } from './adapters/logger';

function recover(): void {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const [kind, id, flag, reason, ...extra] = process.argv.slice(2);
  if ((kind !== 'inbox' && kind !== 'outbox') || !id || flag !== '--reason' || reason === undefined || extra.length) {
    throw new Error('Usage: npm run recover -- inbox|outbox <id> --reason "cause fixed" (service must be stopped)');
  }
  const path = process.env.SQLITE_PATH ?? './data/venue-health.sqlite';
  if (!path.trim() || path === ':memory:' || path.includes('\0')) throw new Error('Recovery requires a durable SQLITE_PATH');
  if (!existsSync(path)) throw new Error('Recovery database does not exist');
  const rawTimeout = process.env.SQLITE_BUSY_TIMEOUT_MS;
  const busyTimeoutMs = rawTimeout === undefined ? 1000 : Number(rawTimeout);
  if (rawTimeout?.trim() === '' || !Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 10000) throw new Error('Invalid SQLITE_BUSY_TIMEOUT_MS');
  const logger = new JsonLogger();
  const store = new DatabaseStore(path, busyTimeoutMs);
  try { new RecoveryUseCase(store, { now: () => Date.now() }, logger).execute(kind, id, reason); }
  finally { store.close(); }
}
try { recover(); } catch (error) {
  const message = error instanceof ApplicationError || (error instanceof Error && !('code' in error)) ? error.message : 'Recovery failed; storage unavailable or target invalid';
  new JsonLogger().error('recovery_failed', { component: 'recovery', message });
  process.exitCode = 1;
}
