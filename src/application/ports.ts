import type { Kind, Message, Venue, PolicyResult, FailureObservation } from '../domain/model';

export interface Clock { now(): number }
export interface DiagnosticLogger {
  debug?(event: string, fields?: Record<string, unknown>): void;
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}
export interface InboxRecord {
  inboxId: string; kind: Kind; sourceId: string; venueId: string;
  canonical: string; requestId: string; receivedAt: string; ingestOrder: number;
  state: 'pending' | 'processed' | 'blocked'; outcome: string | null;
  errorCode: string | null; processedAt: string | null;
}
export interface AdmissionResult { inboxId: string; accepted: true; duplicate: boolean; requestId: string }
export interface CoreRepository {
  transaction<T>(operation: () => T): T;
  admit(message: Message, requestId: string, receivedAt: string): AdmissionResult;
  eligibleHeads(limit: number, afterVenue: string): InboxRecord[];
  loadVenue(venueId: string): Venue | null;
  failureTimes(venueId: string, epoch: number, window: { from: number; to: number; limit: number }): FailureObservation[];
  commitProcessing(inbox: InboxRecord, message: Message, result: PolicyResult, processedAt: string): void;
  blockInbox(inbox: InboxRecord, errorCode: string, at: string, context: { errorName: string }): void;
  venueView(venueId: string): unknown;
  historyView(venueId: string, after: number, limit: number): unknown;
  messageView(inboxId: string): unknown;
  recover(kind: 'inbox' | 'outbox', id: string, reason: string, at: string): void;
}
