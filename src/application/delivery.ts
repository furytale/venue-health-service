import { errorDiagnostic, type ErrorDiagnostic } from './error-diagnostic';

export interface Publication {
  id: string;
  venueId: string;
  sequence: number;
  payload: string;
  idempotencyKey: string;
  inboxId: string;
  requestId: string;
  sourceId: string;
}
export interface Attempt {
  id: string;
  outboxId: string;
  number: number;
  startedAt: number;
}
export type TransportResult =
  | { kind: 'response'; status: number; retryAfter: string | null }
  | { kind: 'unknown'; code: 'DOWNSTREAM_TIMEOUT' | 'DOWNSTREAM_NETWORK_ERROR' | 'DOWNSTREAM_INTERRUPTED' };
export interface DownstreamClient {
  send(publication: Publication, signal: AbortSignal): Promise<TransportResult>;
}
export interface AttemptCompletion {
  attempt: Attempt;
  endedAt: number;
  state: 'pending' | 'delivered' | 'blocked';
  outcome: string;
  errorCode: string | null;
  httpStatus: number | null;
  nextAttemptAt: number;
}
export interface DeliveryRepository {
  recoverInterrupted(now: number): number;
  heads(now: number, limit: number, afterVenue: string): Publication[];
  startAttempt(publication: Publication, now: number): Attempt;
  finishAttempt(completion: AttemptCompletion): void;
}
export interface DeliveryConfig {
  concurrency: number;
  batchSize: number;
  pollIntervalMs: number;
  storageRetryDelayMs: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
  retryJitterRatio: number;
}
export type DeliveryLogger = (level: 'debug' | 'info' | 'warn' | 'error', event: string,
  fields: Record<string, string | number | null | ErrorDiagnostic>) => void;

/** One dispatcher per process; durable attempt records survive loss of the in-memory guards. */
export class DeliveryDispatcher {
  private running = false;
  private active: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly controllers = new Set<AbortController>();
  private readonly inFlight = new Set<string>();
  private readonly unsaved = new Map<string, AttemptCompletion>();
  private pausedUntil = 0;
  private storageOutage = false;
  private cursor = '';
  private stopping = false;
  constructor(
    private readonly repository: DeliveryRepository,
    private readonly client: DownstreamClient,
    private readonly config: DeliveryConfig,
    private readonly clock: () => number = Date.now,
    private readonly random: () => number = Math.random,
    private readonly log: DeliveryLogger = () => undefined,
  ) {}

  start(): void {
    if (this.running) return;
    const interrupted = this.repository.recoverInterrupted(this.clock());
    if (interrupted) this.log('warn', 'delivery.attempts_interrupted', { count: interrupted });
    this.running = true;
    this.stopping = false;
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runOnce().then(() => this.schedule(this.config.pollIntervalMs)).catch(error => {
        this.pauseStorage(error);
        this.schedule(this.config.storageRetryDelayMs);
      });
    }, delay);
  }

  runOnce(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopping || this.clock() < this.pausedUntil) return Promise.resolve();
    this.active = this.cycle().finally(() => { this.active = null; });
    return this.active;
  }

  private async cycle(): Promise<void> {
    // Retry the exact known outcome locally before starting any further network work.
    try {
      for (const [id, completion] of this.unsaved) {
        this.repository.finishAttempt(completion);
        this.unsaved.delete(id);
        this.storageRecovered();
      }
      const heads = this.repository.heads(this.clock(), Math.min(this.config.batchSize, this.config.concurrency), this.cursor);
      const work: Promise<void>[] = [];
      for (const publication of heads) {
        if (this.stopping || this.inFlight.has(publication.venueId)) continue;
        let attempt: Attempt;
        try {
          attempt = this.repository.startAttempt(publication, this.clock());
          this.storageRecovered();
        } catch (error) {
          this.pauseStorage(error);
          break;
        }
        this.cursor = publication.venueId;
        this.inFlight.add(publication.venueId);
        work.push(this.deliver(publication, attempt));
      }
      await Promise.all(work);
    } catch (error) {
      this.pauseStorage(error);
    }
  }

  private pauseStorage(error: unknown): void {
    if (!this.storageOutage) this.log('error', 'delivery.storage_unavailable', { diagnostic: errorDiagnostic(error) });
    this.storageOutage = true;
    this.pausedUntil = this.clock() + this.config.storageRetryDelayMs;
  }

  private storageRecovered(): void {
    if (this.storageOutage) this.log('info', 'delivery.storage_recovered', {});
    this.storageOutage = false;
    this.pausedUntil = 0;
  }

  private async deliver(publication: Publication, attempt: Attempt): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    const fields = { outboxId: publication.id, venueId: publication.venueId, sequence: publication.sequence,
      requestId: publication.requestId, inboxId: publication.inboxId, sourceId: publication.sourceId, attemptId: attempt.id, attemptNumber: attempt.number };
    try {
      const result = await this.client.send(publication, controller.signal);
      const completion = this.classify(attempt, result);
      this.unsaved.set(attempt.id, completion);
      try {
        this.repository.finishAttempt(completion);
        this.unsaved.delete(attempt.id);
        this.storageRecovered();
      } catch (error) {
        this.pauseStorage(error);
      }
      const saved = !this.unsaved.has(attempt.id);
      this.log(!saved || completion.state === 'blocked' ? 'error' : completion.state === 'delivered' ? 'info' : 'warn',
        saved ? `delivery.${completion.state}` : 'delivery.outcome_unsaved', { ...fields, remoteOutcome: completion.outcome, errorCode: completion.errorCode,
          httpStatus: completion.httpStatus, nextAttemptAt: completion.nextAttemptAt,
          durationMs: completion.endedAt - attempt.startedAt, outcomePersisted: saved ? 1 : 0 });
    } finally {
      this.controllers.delete(controller);
      this.inFlight.delete(publication.venueId);
    }
  }

  private classify(attempt: Attempt, result: TransportResult): AttemptCompletion {
    const endedAt = this.clock();
    const common = { attempt, endedAt, nextAttemptAt: 0 };
    if (result.kind === 'response' && result.status >= 200 && result.status < 300)
      return { ...common, state: 'delivered', outcome: 'delivered', errorCode: null, httpStatus: result.status };
    if (result.kind === 'response' && result.status !== 429 && result.status < 500) {
      const code = result.status >= 400 ? 'DOWNSTREAM_REJECTED' : 'UNEXPECTED_DOWNSTREAM_RESPONSE';
      return { ...common, state: 'blocked', outcome: code, errorCode: code, httpStatus: result.status };
    }
    if (result.kind === 'response' && result.status >= 600)
      return { ...common, state: 'blocked', outcome: 'UNEXPECTED_DOWNSTREAM_RESPONSE',
        errorCode: 'UNEXPECTED_DOWNSTREAM_RESPONSE', httpStatus: result.status };
    const cap = Math.min(this.config.retryMaxDelayMs, this.config.retryBaseDelayMs * 2 ** Math.min(52, attempt.number - 1));
    const localDelay = Math.ceil(cap * (1 - this.config.retryJitterRatio + this.config.retryJitterRatio * this.random()));
    let delay = localDelay;
    let retryAfterMs: number | null = null;
    if (result.kind === 'response' && result.status === 429) {
      const seconds = result.retryAfter !== null && /^\d+$/.test(result.retryAfter) ? Number(result.retryAfter) : NaN;
      const ms = seconds * 1000;
      if (Number.isSafeInteger(ms) && ms >= 0 && Number.isSafeInteger(endedAt + ms) && endedAt + ms <= 8.64e15) {
        retryAfterMs = ms;
        delay = Math.max(delay, ms);
      }
      else this.log('warn', 'delivery.invalid_retry_after', { attemptId: attempt.id });
    }
    this.log('debug', 'delivery.retry_scheduled', { attemptId: attempt.id, attemptNumber: attempt.number,
      localDelayMs: localDelay, retryAfterMs, delayMs: delay, nextAttemptAt: endedAt + delay });
    const code = result.kind === 'unknown' ? result.code : result.status === 429 ? 'DOWNSTREAM_RATE_LIMITED' : 'DOWNSTREAM_UNAVAILABLE';
    return { ...common, state: 'pending', outcome: code, errorCode: code,
      httpStatus: result.kind === 'response' ? result.status : null, nextAttemptAt: endedAt + delay };
  }

  async stop(timeoutMs: number): Promise<void> {
    this.running = false;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.active) {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([this.active, new Promise<void>(resolve => {
        deadline = setTimeout(() => {
          for (const controller of this.controllers) controller.abort();
          resolve();
        }, timeoutMs);
      })]);
      if (deadline) clearTimeout(deadline);
      // Abort settles the HTTP client immediately; permit its final synchronous writes.
      if (this.active) await this.active;
    }
    for (const [id, completion] of this.unsaved) {
      try { this.repository.finishAttempt(completion); this.unsaved.delete(id); }
      catch (error) { this.log('error', 'delivery.shutdown_unsaved_outcome', { attemptId: id, diagnostic: errorDiagnostic(error) }); break; }
    }
  }
}
