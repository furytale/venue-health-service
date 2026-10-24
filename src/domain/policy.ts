const MIN_REPORT_TIME_MS = -62_167_219_200_000; // 0000-01-01T00:00:00Z, the earliest accepted four-digit year.

import { FailureObservation, Message, PolicyConfig, PolicyResult, ProcessingMetadata, PublicationDecision, PublicationPayload, ReportMessage, Status, Venue } from './model';

export class LifecyclePolicy {
  constructor(private readonly config: PolicyConfig) {}

  // The earliest threshold-1 prior failures suffice: the incoming failure supplies
  // the final count and the earliest retained time determines the minimum span.
  failureQuery(analyzedAtMs: number): { from: number; to: number; limit: number } {
    const from = analyzedAtMs <= MIN_REPORT_TIME_MS + this.config.failureWindowMs
      ? MIN_REPORT_TIME_MS : analyzedAtMs - this.config.failureWindowMs;
    return { from, to: analyzedAtMs, limit: this.config.failureThreshold - 1 };
  }

  evaluate(current: Venue | null, message: Message, meta: ProcessingMetadata, failures: readonly FailureObservation[]): PolicyResult {
    const venue: Venue = current ? { ...current } : {
      venueId: message.venueId, status: 'Installed', mode: 'automatic', reason: 'INITIAL_INSTALLATION',
      sequence: 0, updatedAt: meta.processedAt, epoch: 0, reportWatermark: null, calibrationWatermark: null,
      lastOperatorReceivedAt: null, latestReport: null, operatorDecision: null,
    };
    const publications: PublicationDecision[] = [];
    let observation: FailureObservation | null = null;
    const publish = (previousStatus: Status | null, previousReason: string | null, report?: ReportMessage): void => {
      if (!Number.isSafeInteger(venue.sequence + 1)) throw new Error('Publication sequence exhausted');
      venue.sequence += 1;
      venue.updatedAt = meta.processedAt;
      const payload: PublicationPayload = { status: venue.status, reason: venue.reason, sequence: venue.sequence };
      if (report?.pcm?.evidence) {
        payload.pcm = { analyzedAt: report.analyzedAt, bucket: report.pcm.evidence.bucket, result: report.pcm.evidence.resultKey, evidence: [...report.pcm.evidence.evidenceKeys], uploadFailed: report.pcm.uploadFailed };
      }
      publications.push({ payload, previousStatus, previousReason, mode: venue.mode });
    };
    if (!current) publish(null, null);
    const result = (outcome: PolicyResult['outcome']): PolicyResult => ({ venue, outcome, publications, observation });
    const previousStatus = venue.status;
    const previousReason = venue.reason;
    const previousMode = venue.mode;
    let attachReport: ReportMessage | undefined;
    let force = false;
    if (message.kind === 'operator') {
      venue.status = message.status;
      venue.mode = 'manual';
      venue.reason = 'OPERATOR_DECISION';
      venue.lastOperatorReceivedAt = Date.parse(meta.receivedAt);
      venue.operatorDecision = { commandId: message.sourceId, status: message.status };
      if (message.status === 'Production') venue.epoch += 1;
      force = true;
    } else if (message.kind === 'calibration') {
      if (venue.calibrationWatermark !== null && message.approvedAtMs <= venue.calibrationWatermark) return result('ignored_stale');
      venue.calibrationWatermark = message.approvedAtMs;
      if (venue.lastOperatorReceivedAt !== null && message.approvedAtMs <= venue.lastOperatorReceivedAt) return result('ignored_before_operator');
      venue.status = 'Production';
      venue.mode = 'automatic';
      venue.reason = 'CALIBRATION_APPROVED';
      venue.operatorDecision = null;
      venue.epoch += 1;
    } else {
      if (venue.reportWatermark !== null && message.analyzedAtMs <= venue.reportWatermark) return result('ignored_stale');
      venue.reportWatermark = message.analyzedAtMs;
      venue.latestReport = {
        reportId: message.sourceId, analyzedAt: message.analyzedAt, receivedAt: meta.receivedAt,
        selfTest: { passed: message.selfTestPassed }, trigger: message.trigger, pcm: message.pcm,
      };
      const automaticActive = venue.mode === 'automatic' && venue.status !== 'Installed';
      const pcmFailed = message.pcm?.ran === true && message.pcm.status === 'fail';
      observation = { analyzedAtMs: message.analyzedAtMs, epoch: venue.epoch, eligible: automaticActive && pcmFailed };
      if (!automaticActive) return result('observed');
      if (!message.selfTestPassed) {
        venue.status = 'Maintenance';
        venue.reason = 'SELF_TEST_FAILED';
      } else if (pcmFailed && message.pcm) {
        const windowStart = this.failureQuery(message.analyzedAtMs).from;
        const times = failures.filter(item => item.eligible && item.epoch === venue.epoch && item.analyzedAtMs >= windowStart && item.analyzedAtMs <= message.analyzedAtMs).map(item => item.analyzedAtMs);
        times.push(message.analyzedAtMs);
        const earliest = times.reduce((minimum, time) => Math.min(minimum, time), message.analyzedAtMs);
        const escalated = times.length >= this.config.failureThreshold && message.analyzedAtMs - earliest >= this.config.failureMinSpanMs;
        if (venue.status !== 'Maintenance') venue.status = escalated ? 'Maintenance' : 'SuspectedMaintenance';
        venue.reason = message.pcm.primaryReason;
        attachReport = message;
      } else if (venue.status === 'SuspectedMaintenance' && message.pcm?.ran && message.pcm.status === 'pass') {
        venue.status = 'Production';
        venue.reason = 'CHECKS_PASSED';
        attachReport = message;
      }
    }
    if (!Number.isSafeInteger(venue.epoch)) throw new Error('Diagnostic epoch exhausted');
    if (force || previousStatus !== venue.status || previousReason !== venue.reason || previousMode !== venue.mode) publish(previousStatus, previousReason, attachReport);
    return result(message.kind === 'report' && publications.length === 0 ? 'observed' : 'applied');
  }
}
