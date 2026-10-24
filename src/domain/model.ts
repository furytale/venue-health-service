export type Kind = 'report' | 'calibration' | 'operator';
export type Status = 'Installed' | 'Production' | 'SuspectedMaintenance' | 'Maintenance';
export type Mode = 'automatic' | 'manual';
export interface Evidence { bucket: string; resultKey: string; evidenceKeys: string[] }
export type EvidenceValidation = { state: 'absent' } | { state: 'valid' } | { state: 'excluded'; code: 'EVIDENCE_EXCLUDED'; reason: string };
export interface NormalizedPcm {
  ran: boolean;
  status: 'pass' | 'fail' | 'inconclusive' | null;
  reasons: string[];
  primaryReason: string;
  uploadFailed: boolean;
  evidence: Evidence | null;
  evidenceValidation: EvidenceValidation;
}
interface MessageBase { kind: Kind; sourceId: string; venueId: string; canonicalPayload: string }
export interface ReportMessage extends MessageBase {
  kind: 'report'; analyzedAt: string; analyzedAtMs: number; trigger: 'auto' | 'manual';
  selfTestPassed: boolean; pcm: NormalizedPcm | null;
}
export interface CalibrationMessage extends MessageBase { kind: 'calibration'; approvedAt: string; approvedAtMs: number }
export interface OperatorMessage extends MessageBase { kind: 'operator'; status: Status; issuedAt?: string }
export type Message = ReportMessage | CalibrationMessage | OperatorMessage;
export interface LatestReport {
  reportId: string; analyzedAt: string; receivedAt: string; selfTest: { passed: boolean };
  trigger: 'auto' | 'manual'; pcm: NormalizedPcm | null;
}
export interface Venue {
  venueId: string; status: Status; mode: Mode; reason: string; sequence: number; updatedAt: string;
  epoch: number; reportWatermark: number | null; calibrationWatermark: number | null;
  lastOperatorReceivedAt: number | null; latestReport: LatestReport | null;
  operatorDecision: { commandId: string; status: Status } | null;
}
export interface FailureObservation { analyzedAtMs: number; epoch: number; eligible: boolean }
export interface PublicationPayload {
  status: Status; reason: string; sequence: number;
  pcm?: { analyzedAt: string; bucket: string; result: string; evidence: string[]; uploadFailed: boolean };
}
export interface PublicationDecision {
  payload: PublicationPayload; previousStatus: Status | null; previousReason: string | null; mode: Mode;
}
export interface PolicyConfig { failureThreshold: number; failureWindowMs: number; failureMinSpanMs: number }
export interface ValidationConfig {
  jsonMaxDepth: number; maxPcmReasons: number; evidenceAllowedBuckets: readonly string[];
  evidenceMaxKeys: number; evidenceMaxKeyBytes: number;
}
export interface ProcessingMetadata { receivedAt: string; processedAt: string }
export interface PolicyResult {
  venue: Venue; outcome: 'applied' | 'observed' | 'ignored_stale' | 'ignored_before_operator';
  publications: PublicationDecision[]; observation: FailureObservation | null;
}
