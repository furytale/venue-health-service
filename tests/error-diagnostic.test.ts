import test from 'node:test';
import assert from 'node:assert/strict';
import { errorDiagnostic } from '../src/application/error-diagnostic';
import { StorageError } from '../src/domain/errors';

const secret = 'private-diagnostic-secret';

test('diagnostics retain both cause forms, source codes and frame locations without exception messages', () => {
  const source = Object.assign(new Error(`${secret}\n    at /private/${secret}.js:1:1`), { code: 'SQLITE_IOERR_WRITE' });
  const standard = new Error(`SQL parameter ${secret}`, { cause: source });
  const wrapped = new StorageError(standard);
  const diagnostic = errorDiagnostic(wrapped);
  assert.equal(diagnostic.name, 'StorageError');
  assert.equal(diagnostic.code, 'STORAGE_UNAVAILABLE');
  assert.equal(diagnostic.internalCause?.cause?.code, 'SQLITE_IOERR_WRITE');
  assert.ok(diagnostic.frames.some(frame => /^error-diagnostic\.test\.ts:\d+:\d+$/.test(frame)));
  assert.ok(diagnostic.internalCause?.cause?.frames.some(frame => /^error-diagnostic\.test\.ts:\d+:\d+$/.test(frame)));
  const json = JSON.stringify(diagnostic);
  assert.doesNotMatch(json, /private-diagnostic-secret|SQL parameter|message|\/Users\//);
  assert.ok(Buffer.byteLength(json) < 4096);
});

test('diagnostics bound oversized branching/cyclic causes and ignore hostile names, stacks and arbitrary data', () => {
  const error = new Error(secret.repeat(100000));
  Object.assign(error, { code: secret.repeat(1000), toJSON() { throw new Error(secret); } });
  error.name = secret.repeat(1000);
  error.stack = `${error.name}: ${error.message}\n${'    at arbitrarySecretLabel (/private/project/worker.ts:12:34)\n'.repeat(1000)}`;
  const child = new Error(secret, { cause: error });
  Object.assign(error, { cause: child, internalCause: child });
  const result = errorDiagnostic(error);
  assert.equal(result.name, 'Error');
  assert.equal(result.frames.length, 4);
  assert.deepEqual(result.frames, Array(4).fill('worker.ts:12:34'));
  assert.equal(result.cause?.cause?.name, 'CircularCause');
  const json = JSON.stringify(result);
  assert.ok(Buffer.byteLength(json) < 4096);
  assert.doesNotMatch(json, /private-diagnostic-secret|arbitrarySecretLabel|\/private/);

  let chain: Error = new Error(secret);
  for (let i = 0; i < 100; i++) chain = Object.assign(new Error(secret, { cause: chain }), { internalCause: chain });
  const bounded = errorDiagnostic(chain);
  assert.equal(bounded.cause?.cause?.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded)) < 4096);
  assert.doesNotMatch(JSON.stringify(bounded), /private-diagnostic-secret/);
});

test('non-Error throws, revoked proxies, throwing accessors and nonstandard stacks serialize safely', () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = new Error(secret);
  for (const key of ['name', 'code', 'message', 'stack', 'cause', 'internalCause']) {
    Object.defineProperty(hostile, key, { get() { throw new Error(secret); } });
  }
  const custom = new Error(secret);
  custom.stack = `unrecognized header\n    at /private/${secret}.js:1:1`;
  for (const value of [null, undefined, secret, 1n, { message: secret, toJSON() { throw new Error(secret); } }, revoked.proxy, hostile, custom]) {
    const diagnostic = errorDiagnostic(value);
    assert.deepEqual(diagnostic.frames, []);
    assert.doesNotMatch(JSON.stringify(diagnostic), /private-diagnostic-secret/);
  }
});
