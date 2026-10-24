import { EvidenceValidation, LatestReport, NormalizedPcm, Status, Venue } from './model';
import { isRecord } from './validation';

const fail = (): never => { throw new Error('Invalid persisted venue state'); };
function number(value: unknown): number { if (typeof value !== 'number' || !Number.isSafeInteger(value)) return fail(); return value; }
function nullableNumber(value: unknown): number | null { return value === null ? null : number(value); }
function string(value: unknown): string { if (typeof value !== 'string') return fail(); return value; }
function boolean(value: unknown): boolean { if (typeof value !== 'boolean') return fail(); return value; }
function status(value: unknown): Status { if (value !== 'Installed' && value !== 'Production' && value !== 'SuspectedMaintenance' && value !== 'Maintenance') return fail(); return value; }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : fail(); }
function strings(value: unknown): string[] { if (!Array.isArray(value)) return fail(); return value.map(string); }
function pcm(value: unknown): NormalizedPcm | null {
  if (value === null) return null;
  const data = record(value);
  const pcmStatus = data.status;
  if (pcmStatus !== null && pcmStatus !== 'pass' && pcmStatus !== 'fail' && pcmStatus !== 'inconclusive') return fail();
  const validation = record(data.evidenceValidation);
  let evidenceValidation: EvidenceValidation;
  if (validation.state === 'absent' || validation.state === 'valid') evidenceValidation = { state: validation.state };
  else if (validation.state === 'excluded' && validation.code === 'EVIDENCE_EXCLUDED') evidenceValidation = { state: 'excluded', code: 'EVIDENCE_EXCLUDED', reason: string(validation.reason) };
  else return fail();
  const evidence = data.evidence === null ? null : record(data.evidence);
  return { ran: boolean(data.ran), status: pcmStatus, reasons: strings(data.reasons), primaryReason: string(data.primaryReason), uploadFailed: boolean(data.uploadFailed), evidenceValidation, evidence: evidence === null ? null : { bucket: string(evidence.bucket), resultKey: string(evidence.resultKey), evidenceKeys: strings(evidence.evidenceKeys) } };
}
function report(value: unknown): LatestReport | null {
  if (value === null) return null;
  const data = record(value);
  if (data.trigger !== 'auto' && data.trigger !== 'manual') return fail();
  return { reportId: string(data.reportId), analyzedAt: string(data.analyzedAt), receivedAt: string(data.receivedAt), selfTest: { passed: boolean(record(data.selfTest).passed) }, trigger: data.trigger, pcm: pcm(data.pcm) };
}
export function parseVenueState(value: unknown): Venue {
  const data = record(value);
  if (data.mode !== 'automatic' && data.mode !== 'manual') return fail();
  const operator = data.operatorDecision === null ? null : record(data.operatorDecision);
  return { venueId: string(data.venueId), status: status(data.status), mode: data.mode, reason: string(data.reason), sequence: number(data.sequence), updatedAt: string(data.updatedAt), epoch: number(data.epoch), reportWatermark: nullableNumber(data.reportWatermark), calibrationWatermark: nullableNumber(data.calibrationWatermark), lastOperatorReceivedAt: nullableNumber(data.lastOperatorReceivedAt), latestReport: report(data.latestReport), operatorDecision: operator === null ? null : { commandId: string(operator.commandId), status: status(operator.status) } };
}
