import { ValidationError } from './errors';
import { Evidence, EvidenceValidation, Kind, Message, NormalizedPcm, Status, ValidationConfig } from './model';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function object(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(`${field} must be an object`);
  return value;
}
function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ValidationError(`${field} must be boolean`);
  return value;
}
function identity(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^[\x20-\x7e]{1,128}$/.test(result) || result.trim() !== result) throw new ValidationError(`${field} must be bounded printable ASCII`);
  return result;
}
export function validateVenueId(value: unknown): string {
  const result = text(value, 'venueId');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(result)) throw new ValidationError('Invalid venueId');
  return result;
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function utcTimestamp(value: unknown, field: string): string {
  const result = text(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(result)) throw new ValidationError(`${field} must be a UTC timestamp`);
  const date = new Date(result);
  const normalized = result.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) throw new ValidationError(`${field} must be a valid calendar timestamp`);
  return result;
}
function reason(value: unknown): string {
  const result = text(value, 'pcm reason');
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(result)) throw new ValidationError('Invalid PCM reason code');
  return result;
}
function status(value: unknown): Status {
  if (value !== 'Installed' && value !== 'Production' && value !== 'SuspectedMaintenance' && value !== 'Maintenance') throw new ValidationError('Invalid status');
  return value;
}
export function canonicalJson(value: unknown, maxDepth: number): string {
  const encode = (item: unknown, depth: number): string => {
    if (depth > maxDepth) throw new ValidationError('JSON nesting limit exceeded');
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map(child => encode(child, depth + 1)).join(',')}]`;
    if (isRecord(item)) return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(',')}}`;
    throw new ValidationError('Body must contain JSON values');
  };
  return encode(value, 1);
}
function evidence(value: unknown, supplied: boolean, venueId: string, config: ValidationConfig): { evidence: Evidence | null; evidenceValidation: EvidenceValidation } {
  if (!supplied) return { evidence: null, evidenceValidation: { state: 'absent' } };
  const excluded = (reason: string): { evidence: null; evidenceValidation: EvidenceValidation } => ({ evidence: null, evidenceValidation: { state: 'excluded', code: 'EVIDENCE_EXCLUDED', reason } });
  if (!isRecord(value) || typeof value.bucket !== 'string' || typeof value.resultKey !== 'string' || !Array.isArray(value.evidenceKeys) || !value.evidenceKeys.every((key: unknown) => typeof key === 'string')) return excluded('INVALID_SHAPE');
  if (!config.evidenceAllowedBuckets.includes(value.bucket)) return excluded('BUCKET_NOT_ALLOWED');
  if (value.evidenceKeys.length > config.evidenceMaxKeys) return excluded('TOO_MANY_KEYS');
  const validKey = (key: string, type: 'results' | 'evidence'): boolean => {
    // All allowed characters are ASCII: string length equals byte length here.
    if (key.length > config.evidenceMaxKeyBytes || !/^[A-Za-z0-9_=./-]+$/.test(key)) return false;
    const parts = key.split('/');
    if (parts.some(part => !/^[A-Za-z0-9_=.-]+$/.test(part) || part === '.' || part === '..')) return false;
    if (parts[0] !== 'pcm' || parts[1] !== type || parts[3] !== venueId || parts.length < 5) return false;
    const date = parts[2];
    if (!date || !date.startsWith('date=') || !validDate(date.slice(5))) return false;
    if (type === 'results' && (parts.length !== 5 || !/^.+\.json$/.test(parts[4] ?? ''))) return false;
    return true;
  };
  if (!validKey(value.resultKey, 'results') || !value.evidenceKeys.every((key: string) => validKey(key, 'evidence'))) return excluded('INVALID_KEY');
  return { evidence: { bucket: value.bucket, resultKey: value.resultKey, evidenceKeys: [...new Set<string>(value.evidenceKeys)] }, evidenceValidation: { state: 'valid' } };
}
function pcm(value: unknown, venueId: string, config: ValidationConfig): NormalizedPcm {
  const input = object(value, 'pcm');
  const ran = boolean(input.ran, 'pcm.ran');
  let pcmStatus: NormalizedPcm['status'] = null;
  if ('status' in input || ran) {
    if (input.status !== 'pass' && input.status !== 'fail' && input.status !== 'inconclusive') throw new ValidationError('Invalid pcm.status');
    pcmStatus = input.status;
  }
  let reasons: string[] = [];
  if ('reasons' in input) {
    if (!Array.isArray(input.reasons) || input.reasons.length > config.maxPcmReasons) throw new ValidationError('Invalid pcm.reasons');
    reasons = input.reasons.map(reason);
  }
  const primaryReason = 'primaryReason' in input ? reason(input.primaryReason) : [...reasons].sort()[0] ?? 'PCM_FAILED';
  if ('primaryReason' in input) reasons.push(primaryReason);
  return { ran, status: pcmStatus, reasons: [...new Set(reasons)], primaryReason, uploadFailed: 'uploadFailed' in input ? boolean(input.uploadFailed, 'pcm.uploadFailed') : false, ...evidence(input.evidence, 'evidence' in input, venueId, config) };
}
export function validateMessage(kind: Kind, body: unknown, config: ValidationConfig): Message {
  const canonicalPayload = canonicalJson(body, config.jsonMaxDepth);
  const input = object(body, 'body');
  const venueId = validateVenueId(input.venueId);
  if (kind === 'operator') {
    const result: Message = { kind, sourceId: identity(input.commandId, 'commandId'), venueId, canonicalPayload, status: status(input.status) };
    if ('issuedAt' in input) result.issuedAt = utcTimestamp(input.issuedAt, 'issuedAt');
    return result;
  }
  if (kind === 'calibration') {
    const approvedAt = utcTimestamp(input.approvedAt, 'approvedAt');
    return { kind, sourceId: identity(input.eventId, 'eventId'), venueId, canonicalPayload, approvedAt, approvedAtMs: Date.parse(approvedAt) };
  }
  const analyzedAt = utcTimestamp(input.analyzedAt, 'analyzedAt');
  if (input.trigger !== 'auto' && input.trigger !== 'manual') throw new ValidationError('Invalid trigger');
  return { kind, sourceId: identity(input.reportId, 'reportId'), venueId, canonicalPayload, analyzedAt, analyzedAtMs: Date.parse(analyzedAt), trigger: input.trigger, selfTestPassed: boolean(object(input.selfTest, 'selfTest').passed, 'selfTest.passed'), pcm: 'pcm' in input ? pcm(input.pcm, venueId, config) : null };
}
