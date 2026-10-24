import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CoreRepository, InboxRecord, AdmissionResult } from '../application/ports';
import type { Message, Venue, PolicyResult, FailureObservation } from '../domain/model';
import { parseVenueState } from '../domain/decode';
import { ConflictError, NotFoundError, StorageError, ValidationError } from '../domain/errors';

const storageCodes = ['SQLITE_BUSY', 'SQLITE_LOCKED', 'SQLITE_IOERR', 'SQLITE_FULL', 'SQLITE_CANTOPEN', 'SQLITE_READONLY', 'SQLITE_CORRUPT', 'SQLITE_NOTADB', 'SQLITE_PROTOCOL', 'SQLITE_NOMEM'];
export function isStorageFailure(error: unknown): boolean {
  if (error instanceof StorageError) return true;
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return false;
  const actualCode = error.code;
  return storageCodes.some(code => actualCode === code || actualCode.startsWith(`${code}_`));
}
function storageBoundary<T>(work: () => T): T {
  try { return work(); } catch (error) {
    if (error instanceof StorageError) throw error;
    if (isStorageFailure(error)) throw new StorageError(error);
    throw error;
  }
}
export class DatabaseStore implements CoreRepository {
  readonly db: Database.Database;
  constructor(path: string, busyTimeoutMs = 1000) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { timeout: busyTimeoutMs });
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    const version: unknown = this.db.pragma('user_version', { simple: true });
    if (version !== 0 && version !== 1) throw new Error('Unsupported SQLite schema version');
    if (version === 0) this.db.transaction(() => {
      this.db.exec(`
        CREATE TABLE inbox (
          ingestOrder INTEGER PRIMARY KEY AUTOINCREMENT,
          inboxId TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('report','calibration','operator')),
          sourceId TEXT NOT NULL, venueId TEXT NOT NULL, canonical TEXT NOT NULL,
          requestId TEXT NOT NULL, receivedAt TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processed','blocked')),
          outcome TEXT, errorCode TEXT, processedAt TEXT, UNIQUE(kind,sourceId)
        );
        CREATE INDEX inbox_venue_pending ON inbox(venueId,state,ingestOrder);
        CREATE TABLE venues (venueId TEXT PRIMARY KEY, stateJson TEXT NOT NULL);
        CREATE TABLE observations (
          inboxId TEXT PRIMARY KEY REFERENCES inbox(inboxId), venueId TEXT NOT NULL,
          epoch INTEGER NOT NULL, analyzedAt INTEGER, eligibleFailure INTEGER NOT NULL,
          outcome TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX observation_failures ON observations(venueId,epoch,eligibleFailure,analyzedAt);
        CREATE TABLE history (
          cursor INTEGER PRIMARY KEY AUTOINCREMENT, venueId TEXT NOT NULL,
          inboxId TEXT REFERENCES inbox(inboxId), sequence INTEGER, type TEXT NOT NULL,
          at TEXT NOT NULL, data TEXT NOT NULL
        );
        CREATE INDEX history_venue_cursor ON history(venueId,cursor);
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY, venueId TEXT NOT NULL, sequence INTEGER NOT NULL,
          payload TEXT NOT NULL, idempotencyKey TEXT NOT NULL UNIQUE,
          inboxId TEXT NOT NULL REFERENCES inbox(inboxId), requestId TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','delivered','blocked')),
          nextAttemptAt INTEGER NOT NULL DEFAULT 0, lastErrorCode TEXT, lastHttpStatus INTEGER,
          createdAt TEXT NOT NULL, deliveredAt TEXT, UNIQUE(venueId,sequence)
        );
        CREATE INDEX outbox_venue_sequence ON outbox(venueId,sequence,state);
        PRAGMA user_version = 1;
      `);
    })();
  }
  close(): void { this.db.close(); }
  private requireOpen(): void { if (!this.db.open) throw new StorageError(); }
  transaction<T>(operation: () => T): T { this.requireOpen(); return storageBoundary(() => this.db.transaction(operation).immediate()); }
  admit(message: Message, requestId: string, receivedAt: string): AdmissionResult {
    return this.transaction(() => {
      const existing = this.db.prepare<[string, string], { inboxId: string; canonical: string }>(
        'SELECT inboxId,canonical FROM inbox WHERE kind=? AND sourceId=?').get(message.kind, message.sourceId);
      if (existing) {
        if (existing.canonical !== message.canonicalPayload) throw new ConflictError();
        return { requestId, inboxId: existing.inboxId, accepted: true, duplicate: true };
      }
      const inboxId = randomUUID();
      const inserted = this.db.prepare('INSERT INTO inbox(inboxId,kind,sourceId,venueId,canonical,requestId,receivedAt) VALUES(?,?,?,?,?,?,?)')
        .run(inboxId, message.kind, message.sourceId, message.venueId, message.canonicalPayload, requestId, receivedAt);
      if (!Number.isSafeInteger(inserted.lastInsertRowid)) throw new Error('Ingestion order exhausted');
      return { requestId, inboxId, accepted: true, duplicate: false };
    });
  }
  eligibleHeads(limit: number, afterVenue: string): InboxRecord[] {
    this.requireOpen();
    return storageBoundary(() => this.db.prepare<[string, number], InboxRecord>(`
      SELECT i.* FROM inbox i
      WHERE i.state='pending' AND NOT EXISTS (
        SELECT 1 FROM inbox earlier WHERE earlier.venueId=i.venueId
        AND earlier.state!='processed' AND earlier.ingestOrder<i.ingestOrder)
      ORDER BY CASE WHEN i.venueId>? THEN 0 ELSE 1 END,i.venueId LIMIT ?
    `).all(afterVenue, limit));
  }
  loadVenue(venueId: string): Venue | null {
    this.requireOpen();
    return storageBoundary(() => {
      const row = this.db.prepare<[string], { stateJson: string }>('SELECT stateJson FROM venues WHERE venueId=?').get(venueId);
      if (!row) return null;
      try {
        const value: unknown = JSON.parse(row.stateJson);
        return parseVenueState(value);
      } catch (error) { throw new StorageError(error); }
    });
  }
  failureTimes(venueId: string, epoch: number, window: { from: number; to: number; limit: number }): FailureObservation[] {
    return storageBoundary(() => this.db.prepare<[string, number, number, number, number], { analyzedAt: number; epoch: number }>(
      'SELECT analyzedAt,epoch FROM observations WHERE venueId=? AND epoch=? AND eligibleFailure=1 AND analyzedAt>=? AND analyzedAt<=? ORDER BY analyzedAt LIMIT ?')
      .all(venueId, epoch, window.from, window.to, window.limit).map(row => ({ analyzedAtMs: row.analyzedAt, epoch: row.epoch, eligible: true })));
  }
  commitProcessing(inbox: InboxRecord, message: Message, result: PolicyResult, processedAt: string): void {
    if (!this.db.inTransaction) throw new Error('Processing writes require the shared transaction');
    const venue = result.venue;
    this.db.prepare('INSERT INTO venues(venueId,stateJson) VALUES(?,?) ON CONFLICT(venueId) DO UPDATE SET stateJson=excluded.stateJson')
      .run(venue.venueId, JSON.stringify(venue));
    const observation = result.observation;
    if (observation) this.db.prepare('INSERT INTO observations(inboxId,venueId,epoch,analyzedAt,eligibleFailure,outcome,data) VALUES(?,?,?,?,?,?,?)')
      .run(inbox.inboxId, inbox.venueId, observation.epoch, observation.analyzedAtMs, observation.eligible ? 1 : 0, result.outcome, JSON.stringify(venue.latestReport));
    this.appendHistory(inbox.venueId, inbox.inboxId, null, 'observation', processedAt, {
      kind: inbox.kind, sourceId: inbox.sourceId, requestId: inbox.requestId, outcome: result.outcome,
      analyzedAt: message.kind === 'report' ? message.analyzedAt : undefined,
      approvedAt: message.kind === 'calibration' ? message.approvedAt : undefined,
      issuedAt: message.kind === 'operator' ? message.issuedAt : undefined,
      latestReport: result.observation ? venue.latestReport : undefined,
      operatorDecision: inbox.kind === 'operator' ? venue.operatorDecision : undefined,
    });
    for (const publication of result.publications) {
      const sequence = publication.payload.sequence;
      this.db.prepare(`INSERT INTO outbox(id,venueId,sequence,payload,idempotencyKey,inboxId,requestId,createdAt) VALUES(?,?,?,?,?,?,?,?)`)
        .run(randomUUID(), inbox.venueId, sequence, JSON.stringify(publication.payload), `${inbox.venueId}:${sequence}`, inbox.inboxId, inbox.requestId, processedAt);
      this.appendHistory(inbox.venueId, inbox.inboxId, sequence, 'publication', processedAt, {
        previousStatus: publication.previousStatus, previousReason: publication.previousReason,
        status: publication.payload.status, reason: publication.payload.reason, mode: publication.mode,
        requestId: inbox.requestId, sourceId: inbox.sourceId,
      });
    }
    this.db.prepare("UPDATE inbox SET state='processed',outcome=?,errorCode=NULL,processedAt=? WHERE inboxId=? AND state='pending'")
      .run(result.outcome, processedAt, inbox.inboxId);
  }
  private appendHistory(venueId: string, inboxId: string | null, sequence: number | null, type: string, at: string, data: unknown): void {
    const inserted = this.db.prepare('INSERT INTO history(venueId,inboxId,sequence,type,at,data) VALUES(?,?,?,?,?,?)')
      .run(venueId, inboxId, sequence, type, at, JSON.stringify(data));
    if (!Number.isSafeInteger(inserted.lastInsertRowid)) throw new Error('History cursor exhausted');
  }
  blockInbox(inbox: InboxRecord, errorCode: string, at: string, context: { errorName: string }): void {
    this.transaction(() => {
      this.db.prepare("UPDATE inbox SET state='blocked',errorCode=? WHERE inboxId=? AND state='pending'").run(errorCode, inbox.inboxId);
      this.appendHistory(inbox.venueId, inbox.inboxId, null, 'processing_blocked', at, { errorCode, errorName: context.errorName, sourceId: inbox.sourceId, requestId: inbox.requestId });
    });
  }
  venueView(venueId: string): unknown {
    return this.transaction(() => {
      const totals = this.db.prepare<[string], { count: number; pending: number; lastAcceptedAt: string | null; lastProcessedAt: string | null }>(`
        SELECT count(*) AS count,coalesce(sum(state!='processed'),0) AS pending,max(receivedAt) AS lastAcceptedAt,max(processedAt) AS lastProcessedAt
        FROM inbox WHERE venueId=?`).get(venueId);
      const venue = this.loadVenue(venueId);
      if (!venue && (!totals || totals.count === 0)) throw new NotFoundError();
      const blocked = this.db.prepare<[string], { inboxId: string }>("SELECT inboxId FROM inbox WHERE venueId=? AND state='blocked' ORDER BY ingestOrder LIMIT 1").get(venueId);
      const head = this.db.prepare<[string], { id: string; state: string; sequence: number; lastErrorCode: string | null; lastHttpStatus: number | null; nextAttemptAt: number }>(
        "SELECT id,state,sequence,lastErrorCode,lastHttpStatus,nextAttemptAt FROM outbox WHERE venueId=? AND state!='delivered' ORDER BY sequence LIMIT 1").get(venueId);
      const delivery = this.db.prepare<[string], { outstanding: number; lastDeliveredSequence: number }>(`
        SELECT coalesce(sum(state!='delivered'),0) AS outstanding,coalesce(max(CASE WHEN state='delivered' THEN sequence ELSE 0 END),0) AS lastDeliveredSequence
        FROM outbox WHERE venueId=?`).get(venueId);
      return {
        venueId, status: venue?.status ?? null, mode: venue?.mode ?? null, reason: venue?.reason ?? null,
        sequence: venue?.sequence ?? 0, updatedAt: venue?.updatedAt ?? null, latestReport: venue?.latestReport ?? null,
        processing: {
          state: blocked ? 'blocked' : (totals?.pending ?? 0) > 0 ? 'pending' : 'ready',
          pendingCount: totals?.pending ?? 0, blockedInboxId: blocked?.inboxId ?? null,
          lastAcceptedAt: totals?.lastAcceptedAt ?? null, lastProcessedAt: totals?.lastProcessedAt ?? null,
        },
        delivery: {
          lastDeliveredSequence: delivery?.lastDeliveredSequence ?? 0, outstandingCount: delivery?.outstanding ?? 0,
          headOutboxId: head?.id ?? null, headState: head?.state ?? null,
          blockedSequence: head?.state === 'blocked' ? head.sequence : null,
          lastErrorCode: head?.lastErrorCode ?? null, lastHttpStatus: head?.lastHttpStatus ?? null,
          nextAttemptAt: head ? new Date(head.nextAttemptAt).toISOString() : null,
        },
      };
    });
  }
  historyView(venueId: string, after: number, limit: number): unknown {
    return this.transaction(() => {
      this.venueView(venueId);
      const rows = this.db.prepare<[string, number, number], { cursor: number; inboxId: string | null; sequence: number | null; type: string; at: string; data: string }>(
        'SELECT cursor,inboxId,sequence,type,at,data FROM history WHERE venueId=? AND cursor>? ORDER BY cursor LIMIT ?').all(venueId, after, limit + 1);
      const items = rows.slice(0, limit).map(row => {
        const data: unknown = JSON.parse(row.data);
        return { cursor: row.cursor, inboxId: row.inboxId, sequence: row.sequence, type: row.type, at: row.at, data };
      });
      return { items, nextCursor: rows.length > limit ? items[items.length - 1]?.cursor ?? null : null };
    });
  }
  messageView(inboxId: string): unknown {
    return this.transaction(() => {
      const row = this.db.prepare<[string], InboxRecord>('SELECT * FROM inbox WHERE inboxId=?').get(inboxId);
      if (!row) throw new NotFoundError();
      const publications = this.db.prepare<[string], { sequence: number }>('SELECT sequence FROM outbox WHERE inboxId=? ORDER BY sequence').all(inboxId);
      return {
        inboxId: row.inboxId, kind: row.kind, sourceId: row.sourceId, venueId: row.venueId,
        receivedAt: row.receivedAt, ingestOrder: row.ingestOrder, state: row.state,
        outcome: row.outcome, errorCode: row.errorCode, processedAt: row.processedAt,
        publicationSequences: publications.map(item => item.sequence),
      };
    });
  }
  recover(kind: 'inbox' | 'outbox', id: string, reason: string, at: string): void {
    this.transaction(() => {
      const row = kind === 'inbox'
        ? this.db.prepare<[string], { venueId: string; state: string; inboxId: string; sequence: null; errorCode: string | null }>(
          'SELECT venueId,state,inboxId,NULL AS sequence,errorCode FROM inbox WHERE inboxId=?').get(id)
        : this.db.prepare<[string], { venueId: string; state: string; inboxId: string; sequence: number; errorCode: string | null }>(
          'SELECT venueId,state,inboxId,sequence,lastErrorCode AS errorCode FROM outbox WHERE id=?').get(id);
      if (!row) throw new NotFoundError();
      if (row.state !== 'blocked') throw new ValidationError('Recovery target must be blocked');
      this.appendHistory(row.venueId, row.inboxId, row.sequence, 'recovery', at, { target: kind, id, reason, previousErrorCode: row.errorCode });
      if (kind === 'inbox') this.db.prepare("UPDATE inbox SET state='pending' WHERE inboxId=?").run(id);
      else this.db.prepare("UPDATE outbox SET state='pending',nextAttemptAt=? WHERE id=?").run(Date.parse(at), id);
    });
  }
}
