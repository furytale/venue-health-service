# Venue Health Service

A single-process TypeScript/NestJS service with durable SQLite admission, asynchronous lifecycle processing, and ordered HTTP publication. `SPEC.md` is the external contract; `AGENTS.md` defines implementation practices.

## Run locally

Use Node **24.12.0** (`nvm use`); package engines permit Node 22.14+, but this implementation session verifies Node 24.12.0 only.

```sh
nvm use
npm ci
cp .env.example .env
npm run build
```

In one terminal:

```sh
npm run fake:downstream
```

In another terminal:

```sh
npm start
# Or, during development:
npm run dev
```

The service listens on `127.0.0.1:3000`; the fake listens on `127.0.0.1:4000`. The example API key is `development-only-key`, used only by the local fake. Set a real downstream key through the environment. `.env`, SQLite/WAL files, dependencies, generated logs and build output are ignored. Do not remove the database to clear a failure.

```sh
curl -i http://127.0.0.1:3000/api/calibrations \
  -H 'content-type: application/json' \
  -d '{"eventId":"cal-1","venueId":"V1","approvedAt":"2026-10-24T10:00:00Z"}'
curl http://127.0.0.1:3000/api/venues/V1
curl 'http://127.0.0.1:3000/api/venues/V1/history?after=0&limit=50'
# Copy inboxId from the admission response:
curl http://127.0.0.1:3000/api/messages/INBOX_ID
```

A `202` means the inbox transaction committed. Processing and delivery may still be pending. The first calibration creates Installed sequence 1, then automatic Production sequence 2, atomically. Every request receives a fresh `x-request-id`. Exact payload retries return the original inbox ID; conflicting reuse of a source identity returns `409`. JSON object-key order does not affect identity, but array order and unknown fields do.

## Implementation boundaries

- `src/domain`: framework-independent validation, evidence safety, models and lifecycle policy.
- `src/application`: class-based admission, processing, reads, recovery and delivery; repository and transport ports.
- `src/adapters`: prepared SQLite statements, HTTP controllers/filter, downstream transport and JSON diagnostics.
- `src/config`: validated, grouped immutable settings loaded through Nest ConfigModule.
- `src/app.ts`: application composition and non-overlapping background lifecycle; `src/main.ts`: process startup/signals.

One SQLite connection uses WAL, `synchronous=FULL`, foreign keys, and a bounded busy timeout. The schema has an explicit version and refuses unsupported versions. Inbox identity is unique by kind/source ID; publications are unique by venue/sequence and idempotency key. Each inbox transaction commits state, observations, audit, immutable publications and its processed marker together. No network operation or `await` occurs inside that transaction.

Inbox and outbox workers rotate through venue heads, using bounded batches. A blocked head retains its successors. Other venues continue. Source report and calibration watermarks are independent; manual decisions pin every status. Calibration releases manual control and resets the diagnostic epoch without resetting watermarks. Eligible failure lookup uses the configured time window and only the earliest observations needed to decide threshold and minimum span; original observations remain retained.

Only the earliest undelivered publication of each venue is sent, with bounded concurrency between venues. Every send has a committed attempt-start record and a finite timeout. HTTP 2xx completes delivery; network errors, timeouts, 5xx and 429 schedule persisted retries. Other 4xx and redirects block the head. Redirects are never followed. Response bodies are intentionally not read or retained: final status and Retry-After are classified from headers, including when a body stalls.

Retries preserve the exact payload and `{venueId}:{sequence}` key. They use capped exponential backoff with configurable jitter; a valid integer-seconds Retry-After can exceed the local cap. Transient retries have no attempt limit. A received remote result whose local write fails is retained in memory while dispatch pauses for storage recovery. A restart records unfinished attempts as `interrupted_unknown` and may resend the same publication. One remote application depends on the downstream idempotency contract; network delivery itself is not exactly once.

## Offline recovery

**Stop the service before running recovery; restart it afterward.** The CLI does not enforce a multi-process lock. Obtain IDs from the venue read's `processing.blockedInboxId` or `delivery.headOutboxId`.

```sh
npm run recover -- inbox INBOX_ID --reason "cause fixed"
npm run recover -- outbox OUTBOX_ID --reason "downstream configuration corrected"
```

The target must exist and be blocked, and the reason must contain 1–512 characters. Invalid invocations exit nonzero. Recovery atomically appends an audit action and requeues the original item. It preserves the payload, source/receipt identity, sequence, key and prior failure/attempt history. It cannot skip a blocked predecessor or repair an unacceptable payload. Correct the underlying cause before requeueing; a permanently rejected revision keeps that venue blocked.

## Configuration

Startup loads `.env` if present, with externally provided variables taking precedence, validates all resolved settings, and freezes the snapshot. No hot reload. Changes affect subsequent processing; existing publications are never rebuilt. The complete constraint descriptions are in SPEC section 11.

| Setting | Default |
| --- | --- |
| `PORT` | `3000` |
| `SQLITE_PATH` | `./data/venue-health.sqlite` |
| `SQLITE_BUSY_TIMEOUT_MS` / `STORAGE_RETRY_DELAY_MS` | `1000` / `1000` |
| `DOWNSTREAM_URL` / `DOWNSTREAM_API_KEY` | Required |
| `DOWNSTREAM_TIMEOUT_MS` / `DOWNSTREAM_CONCURRENCY` | `5000` / `4` |
| `INBOX_POLL_INTERVAL_MS` / `INBOX_BATCH_SIZE` | `100` / `25` |
| `OUTBOX_POLL_INTERVAL_MS` / `OUTBOX_BATCH_SIZE` | `200` / `25` |
| `RETRY_BASE_DELAY_MS` / `RETRY_MAX_DELAY_MS` / `RETRY_JITTER_RATIO` | `1000` / `60000` / `0.2` |
| `PCM_FAILURE_THRESHOLD` | `3` |
| `PCM_FAILURE_WINDOW_DAYS` / `PCM_FAILURE_MIN_SPAN_HOURS` | `7` / `24` |
| `HTTP_BODY_LIMIT_BYTES` / `JSON_MAX_DEPTH` | `262144` / `32` |
| `MAX_PCM_REASONS` | `32` |
| `EVIDENCE_ALLOWED_BUCKETS` | `venue-logs` |
| `EVIDENCE_MAX_KEYS` / `EVIDENCE_MAX_KEY_BYTES` | `20` / `1024` |
| `HISTORY_MAX_PAGE_SIZE` | `100` |
| `DOWNSTREAM_ERROR_EXCERPT_BYTES` | `1024`; excerpts intentionally omitted at all values |
| `SHUTDOWN_TIMEOUT_MS` | `10000` |
| `LOG_LEVEL` | `info` (`debug`, `info`, `warn`, `error`, `fatal`) |

Timers cannot exceed one day; distant retry eligibility is stored as a deadline and polled. Policy spans must fit their window. Production rejects `SQLITE_PATH=:memory:`. URLs cannot contain credentials, queries or fragments. Bucket configuration contains exact comma-separated bucket names. The service binds locally by design; no public exposure/authentication is provided.

## Controllable downstream fake

The fake checks PUT path, key, JSON fields, idempotency and contiguous per-venue sequence. Its applied history is in memory and survives service restarts while the fake remains running. Restarting the fake clears its history; use a fresh disposable service database for a fresh demonstration, or keep the fake running for recovery tests. Do not delete a real service database.

Environment: `FAKE_PORT=4000`, `FAKE_API_KEY=development-only-key`, optional `FAKE_SCRIPT=/path/to/scenarios.json`. A script maps `venueId:sequence` to actions consumed on successive requests:

```json
{
  "V1:1": [{"kind":"status","status":429,"retryAfter":"2"}],
  "V1:2": [{"kind":"apply-drop"}],
  "V2:1": [{"kind":"status","status":422}],
  "V3:1": [{"kind":"delay","delayMs":10000}],
  "V4:1": [{"kind":"disconnect"}],
  "V5:1": [{"kind":"status","status":503,"stallBody":true}]
}
```

```sh
FAKE_SCRIPT=/path/to/scenarios.json npm run fake:downstream
```

`apply-drop` applies the publication then disconnects before returning a response. Other faults occur before application. An exhausted script defaults to success. Already-applied identical keys return success without applying twice. Tests import `FakeDownstream`, call `script(venueId, sequence, actions)`, and inspect `history` and `requests`. There is no unauthenticated fake administration endpoint.

## Verification and remaining limits

```sh
npm run typecheck
npm run build
npm test
```

Initial implementation verification on Node 24.12.0, 2026-10-24:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | **48 passed, 0 failed, 0 skipped** |
| Compiled service + compiled fake smoke over HTTP | 202 admission, sequences 1/2 delivered, both SIGTERM exits 0 |
| `git diff --check` | Passed |
| Dependency install audit after patched override | 0 vulnerabilities reported |

The initial 48-test suite contains 14 policy/validation tests, 16 SQLite/recovery tests, 11 delivery tests, 3 HTTP tests, 3 configuration tests, and 1 real process-restart test. It uses temporary on-disk databases and actual HTTP sockets. The 50-venue outage scenario performs real validated admission and lifecycle processing before simulating one hour with a controlled clock; all 100 publications drain in per-venue order.

Diagnostic review follow-up verification (2026-10-24, Node 24.12.0): the focused serializer tests passed 3/3, focused HTTP/inbox/delivery/fatal regressions passed 4/4, and the added failed-logger fatal assertion passed. After the final relevant change, `npm run typecheck`, `npm run build`, and `node --import tsx --test tests/*.test.ts` passed: **52 tests, 0 failures, 0 skips** (the original 48 plus four focused diagnostic tests). The package test command is unchanged. Localhost tests required sandbox escalation after EPERM; `git diff --check` also passed. Earlier smoke/audit results above were not rerun for this diagnostic-only follow-up.

Run these scripts from the repository root. The transitive `multer` override selects the patched 2.5+ line; this service does not expose multipart uploads.

SIGINT/SIGTERM stops new admission/background cycles, drains in-flight delivery, then aborts remaining network work and closes storage within a bounded shutdown path. A final hard deadline exits nonzero if draining fails. SIGKILL has no final-write/log guarantee; committed work resumes when storage survives. Diagnostics are structured JSON independent of SQLite, with request/inbox/source/venue/publication/attempt correlation where available. Expected failures use safe codes; accepted bodies remain private in SQLite.

The subsequent diagnostic review fix adds a bounded `diagnostic` object to unexpected HTTP, blocked-inbox, storage-outage and fatal logs. It retains validated error name/code tokens and source filename/line/column locations, with both `cause` and `internalCause`: at most four nodes, three levels, four frames per node, 64-character name/code fields, 120-character locations, and less than 4096 serialized bytes. Exception messages, full stack headers, directories, function labels and arbitrary error properties are omitted; unrecognized stack formats may have no frames. Cycles/non-Error throws have fixed markers. These details never enter public responses or persistent audit records; audit error names use fixed classifications. Outage suppression is unchanged. Fatal logging remains a best-effort bounded write followed by exit 1, including if the logger throws, with no drain or final-log guarantee.

For three replicas, use a shared transactional database with global identity uniqueness, per-venue serialization, atomic state/outbox updates, durable worker leases and fencing. Independent SQLite files, or a shared network SQLite file, do not provide that design. Multi-replica deployment remains unimplemented.

## What did you choose not to build and why?

I left out a broker and distributed workers. One Node.js process and a [durable SQLite inbox/outbox](src/adapters/sqlite.ts) provide committed admission and keep each processing decision's state, history and publications in one transaction. This simplifies the exercise, but capacity and availability depend on one process and local storage. [Replica coordination remains a design](SPEC.md#14-three-replicas-design-only): independent SQLite instances cannot enforce global deduplication or per-venue publication order.

I kept the demonstration accessible through HTTP and the fake, without a UI, authentication or production deployment automation, to concentrate on processing guarantees. It therefore needs security and operational work before production. Structured correlated logs support local diagnosis without a tracing/metrics platform; they do not provide distributed traces or aggregate monitoring.

[Evidence validation](src/domain/validation.ts) checks buckets, paths, venue segments and limits without fetching objects. This avoids storage-service dependencies for health processing, but proves neither authorization nor object existence.

The [offline CLI](src/recover.ts) requeues unchanged blocked items after their cause is fixed. I omitted a generic edit/skip repair console because rewriting or skipping publications needs an explicit contract preserving ordering and identity; an unacceptable publication can still block its venue. The [transport](src/adapters/downstream.ts) also omits optional response-body excerpts: headers determine outcomes without waiting for a stalled body, at the cost of losing that diagnostic detail.

## Which failure behavior is not covered by your tests?

The [real SIGKILL test](tests/restart.test.ts) kills the service after durable admission and HTTP `202`, before inbox processing. Restarting the same database verifies pending work, ordered delivery and duplicate receipt identity.

Actual process termination has not been tested during admission or processing transactions, between admission commit and HTTP acknowledgement, after processing commit before dispatch, or between remote application and the local delivered marker. These gaps do not mean all corresponding behavior is untested: [SQLite tests](tests/storage.test.ts) inject transaction/commit failures, while [delivery tests](tests/delivery.test.ts) exercise failed acknowledgement writes, connection reopening and response loss over real HTTP. Reopening a database or dropping the fake's response is not killing the service.

Tests do not establish behavior under power loss, failed filesystem synchronization, a full or destroyed disk, physical I/O/filesystem corruption, OS OOM, or backup/restore. Malformed stored JSON tests do not simulate damaged storage. The local fake cannot verify the real downstream's idempotency; there is no exactly-once network-delivery or production-readiness claim. Long-duration load is also unqualified.

Separately, [clock/order assumptions](SPEC.md#6-ordering-clocks-and-late-input) limit what the input can establish: engineering UTC is trusted, device clock resets/skew can mislead watermarks, and timestamps cannot identify unseen pre-reset reports or reconstruct creation order for delayed operator commands.
