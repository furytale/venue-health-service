import { ApplicationError, StorageError, ValidationError } from '../domain/errors';
import type { Message, ValidationConfig, PolicyResult } from '../domain/model';
import { LifecyclePolicy } from '../domain/policy';
import { validateMessage, validateVenueId } from '../domain/validation';
import type { AdmissionResult, Clock, CoreRepository, DiagnosticLogger, InboxRecord } from './ports';
import { errorClassName, errorDiagnostic } from './error-diagnostic';

export class AdmissionUseCase {
  constructor(private readonly repository: CoreRepository, private readonly clock: Clock, private readonly logger?: DiagnosticLogger) {}
  execute(message: Message, requestId: string): AdmissionResult {
    const started = this.clock.now();
    const result = this.repository.admit(message, requestId, new Date(started).toISOString());
    this.logger?.info(result.duplicate ? 'admission_duplicate' : 'admission_accepted', {
      component: 'admission', requestId, inboxId: result.inboxId, sourceId: message.sourceId,
      venueId: message.venueId, kind: message.kind, durationMs: this.clock.now() - started,
    });
    return result;
  }
}
export interface ProcessingFaults { beforeCommit?(inbox: InboxRecord): void }
export class ProcessInboxUseCase {
  private lastVenue = '';
  constructor(
    private readonly repository: CoreRepository,
    private readonly policy: LifecyclePolicy,
    private readonly validation: ValidationConfig,
    private readonly clock: Clock,
    private readonly logger?: DiagnosticLogger,
    private readonly faults?: ProcessingFaults,
  ) {}
  runBatch(limit: number): number {
    const heads = this.repository.eligibleHeads(limit, this.lastVenue);
    let processed = 0;
    for (const inbox of heads) {
      const started = this.clock.now();
      const at = new Date(started).toISOString();
      const correlation = { component: 'inbox', inboxId: inbox.inboxId, requestId: inbox.requestId, sourceId: inbox.sourceId, venueId: inbox.venueId };
      let evaluation: { decision: PolicyResult; inputs: Record<string, unknown> };
      try {
        evaluation = this.repository.transaction(() => {
          const raw: unknown = JSON.parse(inbox.canonical);
          const message = validateMessage(inbox.kind, raw, this.validation);
          const venue = this.repository.loadVenue(inbox.venueId);
          const failures = venue && message.kind === 'report'
            ? this.repository.failureTimes(inbox.venueId, venue.epoch, this.policy.failureQuery(message.analyzedAtMs)) : [];
          const decision = this.policy.evaluate(venue, message, { receivedAt: inbox.receivedAt, processedAt: at }, failures);
          this.repository.commitProcessing(inbox, message, decision, at);
          this.faults?.beforeCommit?.(inbox);
          return { decision, inputs: {
            kind: message.kind, previousStatus: venue?.status ?? null, previousMode: venue?.mode ?? null,
            previousEpoch: venue?.epoch ?? 0, windowFailureSampleCount: failures.length,
            analyzedAt: message.kind === 'report' ? message.analyzedAt : undefined,
            selfTestPassed: message.kind === 'report' ? message.selfTestPassed : undefined,
            pcmStatus: message.kind === 'report' ? message.pcm?.status ?? null : undefined,
            pcmReason: message.kind === 'report' ? message.pcm?.primaryReason ?? null : undefined,
          } };
        });
      } catch (error) {
        if (error instanceof StorageError) throw error;
        const code = error instanceof ApplicationError ? error.code : 'PROCESSING_ERROR';
        const errorName = errorClassName(error);
        this.repository.blockInbox(inbox, code, at, { errorName });
        this.logger?.error('inbox_blocked', { ...correlation, errorCode: code, errorName, diagnostic: errorDiagnostic(error), durationMs: this.clock.now() - started });
        this.lastVenue = inbox.venueId;
        continue;
      }
      const result = evaluation.decision;
      this.logger?.debug?.('policy_evaluated', { ...correlation, ...evaluation.inputs,
        outcome: result.outcome, status: result.venue.status, mode: result.venue.mode,
        epoch: result.venue.epoch, publicationCount: result.publications.length });
      processed += 1;
      this.logger?.info('decision_committed', { ...correlation, outcome: result.outcome, sequences: result.publications.map(item => item.payload.sequence), durationMs: this.clock.now() - started });
      if (result.outcome.startsWith('ignored_')) this.logger?.warn('input_ignored', { ...correlation, outcome: result.outcome });
      if (result.venue.latestReport?.pcm?.evidenceValidation.state === 'excluded' && result.observation) {
        this.logger?.warn('evidence_excluded', { ...correlation, reason: result.venue.latestReport.pcm.evidenceValidation.reason });
      }
      this.lastVenue = inbox.venueId;
    }
    return processed;
  }
}
export class QueryUseCase {
  constructor(private readonly repository: CoreRepository, private readonly maxHistoryPageSize = 100) {}
  venue(venueId: string): unknown { return this.repository.venueView(validateVenueId(venueId)); }
  history(venueId: string, after = 0, limit = 50): unknown {
    validateVenueId(venueId);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > this.maxHistoryPageSize) {
      throw new ValidationError('Invalid history pagination');
    }
    return this.repository.historyView(venueId, after, limit);
  }
  message(inboxId: string): unknown {
    if (inboxId.length < 1 || inboxId.length > 128) throw new ValidationError('Invalid inbox ID');
    return this.repository.messageView(inboxId);
  }
}
export class RecoveryUseCase {
  constructor(private readonly repository: CoreRepository, private readonly clock: Clock, private readonly logger?: DiagnosticLogger) {}
  execute(kind: 'inbox' | 'outbox', id: string, reason: string): void {
    if (!reason.trim() || reason.length > 512) throw new ValidationError('Recovery reason must contain 1–512 characters');
    if (!id || id.length > 128) throw new ValidationError('Invalid recovery target ID');
    this.repository.recover(kind, id, reason, new Date(this.clock.now()).toISOString());
    this.logger?.info('recovery_recorded', { component: 'recovery', target: kind, targetId: id });
  }
}
