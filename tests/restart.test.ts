import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { FakeDownstream } from '../tools/fake-downstream';
import { isRecord } from '../src/domain/validation';

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No TCP test port');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function started(child: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => { clean(); reject(new Error(`Child failed to start: ${output}`)); }, 8000);
    const onData = (data: Buffer): void => {
      output = (output + data.toString('utf8')).slice(-16000);
      if (output.includes('"event":"service_started"')) { clean(); resolve(); }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => { clean(); reject(new Error(`Child exited during startup (${code}, ${signal}): ${output}`)); };
    const onError = (error: Error): void => { clean(); reject(error); };
    const clean = (): void => { clearTimeout(timeout); child.stdout.off('data', onData); child.stderr.off('data', onData); child.off('exit', onExit); child.off('error', onError); };
    child.stdout.on('data', onData); child.stderr.on('data', onData); child.once('exit', onExit); child.once('error', onError);
  });
  // Drain diagnostics so a child never blocks on a full pipe during the test.
  child.stdout.resume(); child.stderr.resume();
}
async function terminate(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): Promise<NodeJS.Signals | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.signalCode;
  return new Promise((resolve, reject) => {
    child.once('exit', (_code, receivedSignal) => resolve(receivedSignal));
    child.once('error', reject);
    child.kill(signal);
  });
}
async function eventually(check: () => Promise<boolean>, description: string): Promise<void> {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(description);
}

test('real SIGKILL after HTTP acknowledgement preserves pending admission and restart completes ordered delivery', { timeout: 20000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'venue-crash-'));
  const path = join(dir, 'state.sqlite');
  const fake = new FakeDownstream('fake-development-key');
  const downstream = await fake.listen();
  const port = await unusedPort();
  const children: ChildProcessWithoutNullStreams[] = [];
  let diagnostics = '';
  let lastState: unknown;
  t.after(async () => {
    for (const child of children) await terminate(child, 'SIGKILL');
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const launch = (pollInterval: string): ChildProcessWithoutNullStreams => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), SQLITE_PATH: path, DOWNSTREAM_URL: downstream,
        DOWNSTREAM_API_KEY: 'fake-development-key', INBOX_POLL_INTERVAL_MS: pollInterval,
        OUTBOX_POLL_INTERVAL_MS: '10', DOWNSTREAM_TIMEOUT_MS: '500', LOG_LEVEL: 'info', SHUTDOWN_TIMEOUT_MS: '2000' },
    });
    const retain = (data: Buffer): void => { diagnostics = (diagnostics + data.toString('utf8')).slice(-16000); };
    child.stdout.on('data', retain); child.stderr.on('data', retain);
    children.push(child); return child;
  };
  const first = launch('86400000');
  await started(first);
  const response = await fetch(`http://127.0.0.1:${port}/api/operator-decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'crash-command', venueId: 'CrashVenue', status: 'Production' }),
  });
  assert.equal(response.status, 202);
  const receipt: unknown = await response.json();
  assert.ok(isRecord(receipt)); assert.equal(typeof receipt.inboxId, 'string');
  assert.equal(await terminate(first, 'SIGKILL'), 'SIGKILL');
  assert.equal(fake.history.length, 0, 'First process had acknowledged but never processed the admission');
  const independent = new Database(path, { readonly: true });
  try {
    assert.equal(independent.prepare<[string], { state: string }>('SELECT state FROM inbox WHERE inboxId=?').get(String(receipt.inboxId))?.state, 'pending');
    assert.equal(independent.prepare<[], { count: number }>('SELECT count(*) AS count FROM venues').get()?.count, 0);
  } finally { independent.close(); }
  const second = launch('10');
  await started(second);
  await eventually(async () => {
    const current = await fetch(`http://127.0.0.1:${port}/api/venues/CrashVenue`);
    const value: unknown = await current.json();
    lastState = value;
    return isRecord(value) && isRecord(value.delivery) && value.delivery.lastDeliveredSequence === 2;
  }, 'Restart did not deliver both committed publications').catch(error => { throw new Error(`${String(error)}; state=${JSON.stringify(lastState)}; logs=${diagnostics}`); });
  assert.deepEqual(fake.history.map(item => [item.venueId, item.sequence, item.key]), [['CrashVenue', 1, 'CrashVenue:1'], ['CrashVenue', 2, 'CrashVenue:2']]);
  const inspected = await fetch(`http://127.0.0.1:${port}/api/messages/${String(receipt.inboxId)}`);
  const message: unknown = await inspected.json(); assert.ok(isRecord(message));
  assert.equal(message.state, 'processed'); assert.deepEqual(message.publicationSequences, [1, 2]);
  const duplicate = await fetch(`http://127.0.0.1:${port}/api/operator-decisions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ commandId: 'crash-command', venueId: 'CrashVenue', status: 'Production' }),
  });
  const duplicateReceipt: unknown = await duplicate.json(); assert.ok(isRecord(duplicateReceipt));
  assert.equal(duplicate.status, 202); assert.equal(duplicateReceipt.inboxId, receipt.inboxId); assert.equal(duplicateReceipt.duplicate, true);
  await terminate(second, 'SIGTERM');
});
