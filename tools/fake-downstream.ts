import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { EventEmitter, once } from 'node:events';

export type FakeAction =
  | { kind: 'status'; status: number; retryAfter?: string; stallBody?: boolean }
  | { kind: 'delay'; delayMs: number }
  | { kind: 'disconnect' }
  | { kind: 'apply-drop' };
export interface AppliedPublication { venueId: string; sequence: number; key: string; payload: string }
export interface FakeRequest { venueId: string; sequence: number; key: string }
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function validPcm(value: unknown): boolean {
  return isObject(value) && typeof value.analyzedAt === 'string' && typeof value.bucket === 'string' &&
    typeof value.result === 'string' && typeof value.uploadFailed === 'boolean' && Array.isArray(value.evidence) &&
    value.evidence.every(item => typeof item === 'string') &&
    Object.keys(value).every(key => ['analyzedAt', 'bucket', 'result', 'evidence', 'uploadFailed'].includes(key));
}

/** In-memory local development fake. Remote idempotency state intentionally lives across client restarts. */
export class FakeDownstream {
  readonly history: AppliedPublication[] = [];
  readonly requests: FakeRequest[] = [];
  private readonly events = new EventEmitter();
  private readonly applied = new Map<string, AppliedPublication>();
  private readonly scripts = new Map<string, FakeAction[]>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly server = createServer((req, res) => { void this.handle(req, res); });
  constructor(private readonly apiKey = 'development-only-key') {}
  async nextRequest(): Promise<void> { await once(this.events, 'request'); }
  script(venueId: string, sequence: number, actions: FakeAction[]): void {
    this.scripts.set(`${venueId}:${sequence}`, [...actions]);
  }
  async listen(port = 0): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fake failed to bind TCP address');
    return `http://127.0.0.1:${address.port}`;
  }
  async close(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close(error => error ? reject(error) : resolve()));
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const match = /^\/api\/systems\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})\/status$/.exec(req.url ?? '');
    if (req.method !== 'PUT' || !match) { res.writeHead(404).end(); return; }
    if (req.headers['x-api-key'] !== this.apiKey) { res.writeHead(401).end(); return; }
    if (req.headers['content-type'] !== 'application/json') { res.writeHead(415).end(); return; }
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      for await (const chunk of req) {
        if (!Buffer.isBuffer(chunk)) { res.writeHead(400).end(); return; }
        length += chunk.length;
        if (length > 262144) { res.writeHead(413).end(); return; }
        chunks.push(chunk);
      }
      const payload = Buffer.concat(chunks).toString('utf8');
      const value: unknown = JSON.parse(payload);
      if (!isObject(value) || !Number.isSafeInteger(value.sequence) || typeof value.sequence !== 'number' || value.sequence < 1 ||
          typeof value.status !== 'string' || !['Installed', 'Production', 'SuspectedMaintenance', 'Maintenance'].includes(value.status) ||
          typeof value.reason !== 'string' || (value.pcm !== undefined && !validPcm(value.pcm)) || Object.keys(value).some(key => !['status', 'reason', 'sequence', 'pcm'].includes(key))) {
        res.writeHead(422).end(); return;
      }
      const venueId = match[1];
      if (!venueId) { res.writeHead(400).end(); return; }
      const sequence = value.sequence;
      const key = `${venueId}:${sequence}`;
      if (req.headers['idempotency-key'] !== key) { res.writeHead(400).end(); return; }
      this.requests.push({ venueId, sequence, key });
      this.events.emit('request');
      const prior = this.applied.get(key);
      if (prior) { res.writeHead(prior.payload === payload ? 200 : 409).end(); return; }
      const action = this.scripts.get(key)?.shift();
      if (action?.kind === 'disconnect') { req.socket.destroy(); return; }
      if (action?.kind === 'status' && (action.status < 200 || action.status >= 300)) {
        res.writeHead(action.status, action.retryAfter === undefined ? {} : { 'retry-after': action.retryAfter });
        if (action.stallBody) res.flushHeaders(); else res.end();
        return;
      }
      if (action?.kind === 'delay') {
        await new Promise<void>(resolve => {
          const timer = setTimeout(() => { this.timers.delete(timer); resolve(); }, action.delayMs);
          this.timers.add(timer);
        });
        if (req.socket.destroyed) return;
      }
      const last = this.history.filter(item => item.venueId === venueId).at(-1)?.sequence ?? 0;
      if (sequence !== last + 1) { res.writeHead(409).end(); return; }
      const applied = { venueId, sequence, key, payload };
      this.applied.set(key, applied);
      this.history.push(applied);
      if (action?.kind === 'apply-drop') req.socket.destroy();
      else res.writeHead(action?.kind === 'status' ? action.status : 200).end();
    } catch {
      if (!res.headersSent) res.writeHead(400).end(); else res.destroy();
    }
  }
}

function parseAction(value: unknown): FakeAction {
  if (!isObject(value)) throw new Error('Invalid fake action');
  if (value.kind === 'disconnect' || value.kind === 'apply-drop') return { kind: value.kind };
  if (value.kind === 'delay' && typeof value.delayMs === 'number' && Number.isInteger(value.delayMs) && value.delayMs >= 0 && value.delayMs <= 86400000)
    return { kind: 'delay', delayMs: value.delayMs };
  if (value.kind === 'status' && typeof value.status === 'number' && Number.isInteger(value.status) && value.status >= 200 && value.status <= 599 &&
      (value.retryAfter === undefined || typeof value.retryAfter === 'string') &&
      (value.stallBody === undefined || typeof value.stallBody === 'boolean'))
    return { kind: 'status', status: value.status, ...(typeof value.retryAfter === 'string' ? { retryAfter: value.retryAfter } : {}),
      ...(typeof value.stallBody === 'boolean' ? { stallBody: value.stallBody } : {}) };
  throw new Error('Invalid fake action');
}

async function main(): Promise<void> {
  const fake = new FakeDownstream(process.env.FAKE_API_KEY ?? 'development-only-key');
  if (process.env.FAKE_SCRIPT) {
    const scripts: unknown = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
    if (!isObject(scripts)) throw new Error('FAKE_SCRIPT must contain an object keyed by venue:sequence');
    for (const [key, values] of Object.entries(scripts)) {
      const match = /^([A-Za-z0-9][A-Za-z0-9_-]{0,127}):([1-9][0-9]*)$/.exec(key);
      if (!match || !match[1] || !match[2] || !Array.isArray(values)) throw new Error('Invalid fake script entry');
      fake.script(match[1], Number(match[2]), values.map(parseAction));
    }
  }
  const port = Number(process.env.FAKE_PORT ?? 4000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FAKE_PORT');
  const url = await fake.listen(port);
  process.stdout.write(JSON.stringify({ timestamp: new Date().toISOString(), level: 'info', component: 'fake', event: 'fake.listening', url }) + '\n');
  const stop = (): void => { void fake.close().then(() => process.exit(0)); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
}
if (require.main === module) void main().catch(() => { process.stderr.write('Fake startup failed\n'); process.exitCode = 1; });
