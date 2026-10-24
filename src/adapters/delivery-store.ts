import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Attempt, AttemptCompletion, DeliveryRepository, Publication } from '../application/delivery';

export class DeliveryStore implements DeliveryRepository {
  constructor(private readonly db: Database.Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS delivery_attempts (
      id TEXT PRIMARY KEY, outboxId TEXT NOT NULL REFERENCES outbox(id),
      attemptNumber INTEGER NOT NULL, startedAt INTEGER NOT NULL, endedAt INTEGER,
      durationMs INTEGER, outcome TEXT NOT NULL DEFAULT 'started', errorCode TEXT,
      httpStatus INTEGER, UNIQUE(outboxId, attemptNumber)
    ); CREATE INDEX IF NOT EXISTS attempts_outbox ON delivery_attempts(outboxId, attemptNumber);`);
  }
  recoverInterrupted(now: number): number {
    return this.db.prepare(`UPDATE delivery_attempts SET endedAt=?, durationMs=max(0, ?-startedAt),
      outcome='interrupted_unknown', errorCode='DOWNSTREAM_INTERRUPTED' WHERE endedAt IS NULL`).run(now, now).changes;
  }
  heads(now: number, limit: number, afterVenue: string): Publication[] {
    return this.db.prepare<[number, string, number], Publication>(`SELECT o.id, o.venueId, o.sequence, o.payload,
      o.idempotencyKey, o.inboxId, o.requestId, i.sourceId FROM outbox o JOIN inbox i ON i.inboxId=o.inboxId
      WHERE o.state='pending' AND o.nextAttemptAt <= ? AND NOT EXISTS (
        SELECT 1 FROM outbox earlier WHERE earlier.venueId=o.venueId
          AND earlier.sequence<o.sequence AND earlier.state!='delivered')
      ORDER BY CASE WHEN o.venueId > ? THEN 0 ELSE 1 END, o.venueId LIMIT ?`).all(now, afterVenue, limit);
  }
  startAttempt(publication: Publication, now: number): Attempt {
    return this.db.transaction(() => {
      const last = this.db.prepare<[string], { count: number }>(
        'SELECT coalesce(max(attemptNumber),0) AS count FROM delivery_attempts WHERE outboxId=?').get(publication.id);
      const number = (last?.count ?? 0) + 1;
      if (!Number.isSafeInteger(number)) throw new Error('Attempt sequence exhausted');
      const attempt: Attempt = { id: randomUUID(), outboxId: publication.id, number, startedAt: now };
      this.db.prepare('INSERT INTO delivery_attempts(id,outboxId,attemptNumber,startedAt) VALUES (?,?,?,?)')
        .run(attempt.id, attempt.outboxId, attempt.number, now);
      return attempt;
    })();
  }
  finishAttempt(completion: AttemptCompletion): void {
    this.db.transaction(() => {
      const { attempt } = completion;
      this.db.prepare(`UPDATE delivery_attempts SET endedAt=?, durationMs=?, outcome=?, errorCode=?, httpStatus=?
        WHERE id=?`).run(completion.endedAt, Math.max(0, completion.endedAt - attempt.startedAt), completion.outcome,
        completion.errorCode, completion.httpStatus, attempt.id);
      this.db.prepare(`UPDATE outbox SET state=?, nextAttemptAt=?, lastErrorCode=?, lastHttpStatus=?, deliveredAt=? WHERE id=?`)
        .run(completion.state, completion.nextAttemptAt, completion.errorCode, completion.httpStatus,
          completion.state === 'delivered' ? new Date(completion.endedAt).toISOString() : null, attempt.outboxId);
    })();
  }
}
