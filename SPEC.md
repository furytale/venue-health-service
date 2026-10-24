# Venue Health Service — Specification

Version: 1.0. Language: English. Target repository: `furytale/venue-health-service`.

This is the implementation contract derived from the supplied Pixellot product brief and the author's design decisions. “Must” describes required behavior, not a claim that it has already been implemented or tested. Record implementation gaps and actual verification in README. `AGENTS.md` governs engineering practice; `CODEX_PROMPT.md` starts implementation.

## 1. Scope and chosen architecture

Build one TypeScript/NestJS service with a local SQLite database using `better-sqlite3`. It receives device reports, engineering calibration approvals, and operator decisions; maintains venue lifecycle status and explanatory history; exposes read APIs; and reliably publishes decisions to the given downstream HTTP API.

A venue is the sports location/system identified by `venueId`, not a separately identified individual camera. This contract provides no camera ID or multi-camera aggregation rules.

Run three logical components in one application process:

1. HTTP admission validates a message and durably inserts it into an inbox before acknowledging it.
2. An inbox processor applies policy outside the incoming request and atomically writes observations, state, history, outbox publications, and the processed marker.
3. An outbox dispatcher delivers persisted publications over HTTP and records attempts separately.

Background components use bounded, non-overlapping polling cycles with explicit start/stop management. They are not additional OS processes or worker threads. SQLite calls are synchronous and can briefly block Node's event loop; batch limits and short transactions bound this work. Network waits are asynchronous and never occur inside a SQLite transaction.

Use class-based application use cases, constructor injection, cohesive Nest modules, a framework-independent domain policy, focused repository ports/SQLite adapters, and a downstream client. A small transaction runner shares one connection/transaction across participating repositories. No ORM is required.

Non-goals: UI, authentication, cloud services, external database servers, message brokers, deployment manifests, metrics endpoints, production tracing infrastructure, and implemented multi-instance coordination. The controllable downstream fake is local test/development tooling and may run as a separate process. The recovery CLI is an offline maintenance command.

The total assignment budget is four hours including prior analysis. Do not treat a new CLI session as a fresh four-hour allowance. Stop at the actual deadline and document unfinished behavior.

## 2. HTTP API

All request/response bodies are JSON. Timestamps emitted by this service are UTC ISO 8601 strings. Generate a new server `requestId` for each HTTP attempt and return it as `x-request-id`. A retry has a new request ID but retains the original inbox identity.

| Method and path | Purpose | Successful response |
| --- | --- | --- |
| `POST /api/reports` | Receive a device report | `202` after durable admission |
| `POST /api/calibrations` | Receive a calibration approval | `202` after durable admission |
| `POST /api/operator-decisions` | Receive an operator command | `202` after durable admission |
| `GET /api/venues/:venueId` | Read effective state, diagnostics, and queue progress | `200`, or `404` for a completely unknown venue |
| `GET /api/venues/:venueId/history?after=0&limit=50` | Read ordered audit history | `200` with cursor pagination |
| `GET /api/messages/:inboxId` | Inspect one admission/processing result | `200`, or `404` |

Admission response:

```json
{
  "requestId": "server-request-id",
  "inboxId": "stable-server-receipt-id",
  "accepted": true,
  "duplicate": false
}
```

Senders ignore response bodies; any `2xx` means received. A duplicate returns the same `inboxId`, `duplicate: true`, and `202`, even if processing is blocked. Acceptance does not promise completed processing or delivery.

Errors use `{ "error": { "code": "...", "message": "...", "requestId": "..." } }`. Optional validation details may identify bounded field paths and rules, never raw values, SQL, secrets, or stacks.

| Condition | HTTP/code |
| --- | --- |
| Malformed JSON or invalid core DTO | `400 / VALIDATION_ERROR` |
| Same message identity with a different valid JSON payload | `409 / MESSAGE_ID_CONFLICT` |
| Body over the configured byte limit | `413 / PAYLOAD_TOO_LARGE` |
| Unsupported request content type | `415 / UNSUPPORTED_MEDIA_TYPE` |
| Unknown read resource | `404 / NOT_FOUND` |
| Admission/read cannot access reliable storage | `503 / STORAGE_UNAVAILABLE` |
| Unexpected request-processing bug | `500 / INTERNAL_ERROR` |

Admission is validation-first: malformed inputs may receive `400` before identity conflict checking. Do not respond with a client error for a temporary storage failure; upstream treats every `4xx` as final. Downstream downtime must not cause incoming requests to fail while local admission storage remains usable.

### 2.1 Input contracts

Device report example (the shape is supplied by the brief):

```json
{
  "reportId": "9f1c2e3a-0b47-4d6e-9d2a-5a1e8c7b4f10",
  "venueId": "V1",
  "analyzedAt": "2026-10-20T01:15:00Z",
  "trigger": "auto",
  "selfTest": { "passed": true },
  "pcm": {
    "ran": true,
    "status": "fail",
    "primaryReason": "PCM_CAMERA_MOVEMENT",
    "reasons": ["PCM_CAMERA_MOVEMENT", "PCM_CAMERA_BAD_FOCUS"],
    "uploadFailed": false,
    "evidence": {
      "bucket": "venue-logs",
      "resultKey": "pcm/results/date=2026-10-20/V1/01-15-00.json",
      "evidenceKeys": ["pcm/evidence/date=2026-10-20/V1/01-15-00/movement_0_blend.jpg"]
    }
  }
}
```

Calibration approval:

```json
{ "eventId": "cal-7d2f", "venueId": "V1", "approvedAt": "2026-10-20T09:00:00Z" }
```

Operator decision:

```json
{ "commandId": "cmd-31aa", "venueId": "V1", "status": "Maintenance" }
```

`reportId`, `eventId`, and `commandId` are strings of 1–128 printable ASCII characters, without leading/trailing whitespace. They need not be UUIDs. `venueId` matches `[A-Za-z0-9][A-Za-z0-9_-]{0,127}` so it is one unambiguous storage/path segment. These bounds are explicit API assumptions.

Required fields are those shown outside optional PCM data. `trigger` is exactly `auto` or `manual`; `selfTest.passed` is boolean. Operator status is one of the four statuses in section 5. Required timestamps must be valid calendar timestamps in `YYYY-MM-DDTHH:mm:ss[.SSS]Z` form, allowing 1–3 fractional digits. Compare parsed instants, not lexical representations. Do not coerce strings into booleans or silently repair invalid dates. Device time is not rejected merely because it differs from server time.

PCM rules:

- Omitted `pcm` means the camera check did not run. Explicit `pcm: null` is invalid.
- When present, `pcm` is an object and `ran` is a required boolean. If `ran=true`, `status` is required and is `pass`, `fail`, or `inconclusive`. If `ran=false`, status may be omitted; a supplied status must still be a valid enum but has no health effect.
- `primaryReason`, `reasons`, and `uploadFailed` are optional. Supplied values must have the correct types; `null` is invalid. Default `reasons` to an empty array and `uploadFailed` to false for normalized processing.
- Reason codes match `[A-Z][A-Z0-9_]{0,127}`. Known codes are `PCM_CAMERA_MOVEMENT`, `PCM_CAMERA_BAD_FOCUS`, `PCM_CAMERA_BAD_FOCUS_CRITICAL`, and `PCM_CAMERA_LOW_PIXEL_UTILIZATION`. Accept other syntactically valid codes as diagnostic extensions; their names do not introduce new policy transitions.
- Preserve the original bounded reason list in the accepted payload; normalize duplicate reasons for diagnostics. For a failed PCM, choose `primaryReason` if provided, otherwise the lexically smallest reason, otherwise `PCM_FAILED`. A primary reason need not already be in the list; include it in normalized diagnostics.
- Reasons attached to a pass/inconclusive/not-run result are diagnostic metadata only. `uploadFailed` never changes a health result.
- Evidence is optional and handled separately under section 4, including malformed evidence shapes.

Accept and retain bounded unknown JSON fields in the original inbox payload, but do not interpret or forward them. The same rule applies to nested objects; unknown fields may contain JSON null. Known optional core/PCM fields may be omitted but do not accept null. Evidence is an exception: malformed evidence, including null, is excluded under section 4 rather than rejecting the core report. An optional operator `issuedAt` extension, when supplied, must be a valid UTC timestamp; store it only as diagnostic metadata and never use it to reorder commands.

### 2.2 Read semantics

Read the following fields from a consistent local snapshot:

- `venueId`, `status`, `mode` (`automatic` or `manual`), `reason`, current publication `sequence`, and `updatedAt` for the current decision.
- `latestReport`: normalized latest applicable report ID, analyzed/received times, self-test, PCM outcome/reasons/upload status, and evidence validation result; null if no report was processed. A stale report does not replace this snapshot.
- `processing`: `state` (`ready`, `pending`, or `blocked`), pending count, blocked inbox ID if any, `lastAcceptedAt`, and `lastProcessedAt`.
- `delivery`: last delivered sequence, outstanding count, `headOutboxId`, `headState`, blocked sequence if any, `lastErrorCode`, `lastHttpStatus`, and the head's next eligible attempt time. Head fields are null when nothing is outstanding. These identifiers make the offline recovery command usable without inspecting SQLite directly. Delivery progress is separate from processing progress.

If an inbox row exists for a new venue but initial processing has not committed, return `200` with `status`, `mode`, `reason`, and `updatedAt` null, `sequence: 0`, and pending/blocked processing information. Null is not a fifth lifecycle status. Return `404` only when neither accepted messages nor materialized venue state exist.

History returns `{ items, nextCursor }`, ordered by a stable increasing audit cursor. `after` is exclusive; default limit is 50 and the configurable maximum is 100. Invalid pagination is `400`. History exposes processed observations (including stale/ignored outcomes), publications with previous/new status and reason, and recorded recovery actions, linked by inbox ID and publication sequence. An accepted but unprocessed venue has an empty history. A wholly unknown venue is `404`. Underlying tables may be projected into this view without duplicating every payload.

`GET /api/messages/:inboxId` returns kind, source ID, venue ID, first received time/order, processing state (`pending`, `processed`, `blocked`), processing outcome/error code, processed time, and resulting publication sequences. Do not expose the raw untrusted body, secrets, or internal stack. Reads may initially return the old venue state immediately after `202`.

## 3. Durable admission and idempotency

Message identity is globally unique within its kind: `(report, reportId)`, `(calibration, eventId)`, or `(operator, commandId)`. Include `venueId` in the compared payload, not in the uniqueness key.

After bounded JSON/core validation, compare canonical JSON of the original body before evidence stripping or unknown-field removal: recursively sort object keys, preserve array order, and serialize parsed JSON values. Whitespace/object-key order are immaterial; array order and actual values are material. Store the canonical payload or its digest plus the original payload. Hashing must not replace retaining the accepted message. Limit nesting depth to avoid unbounded canonicalization work.

Use a database unique constraint and transaction, not a read-then-insert check without uniqueness. Ten concurrent identical requests must create one inbox row and eventually one processing effect. A committed duplicate is successful even if the original response was lost. No downstream call or policy evaluation is needed to acknowledge admission.

Persist a server inbox ID, first `receivedAt`, first request ID, kind/source ID, venue ID, payload, and monotonically increasing `ingestOrder`. Duplicates must not replace these first-admission values or extend the effective ordering position. The server-generated receipt order, not HTTP connection start order, determines command ordering.

## 4. Evidence safety

Evidence is an untrusted storage pointer. It is not downloaded or turned into a signed URL by this service. Only validated evidence can appear in outgoing PCM data or public read views.

Accept the entire evidence block only when all conditions hold:

- It is an object with string `bucket` and `resultKey`, and an array of string `evidenceKeys` (an empty array is allowed).
- Bucket is an exact member of `EVIDENCE_ALLOWED_BUCKETS` (default `venue-logs`).
- Keys are relative slash-separated ASCII paths made of segments matching `[A-Za-z0-9_=.-]+`. Reject empty segments, `.` or `..` segments, leading/trailing slash, backslashes, percent encoding, control characters, URL schemes, query/fragment syntax, and all other characters. Do not decode, trim, or normalize a rejected key into a different key.
- Result key has exactly `pcm/results/date=YYYY-MM-DD/{venueId}/{filename}.json`. Evidence keys have `pcm/evidence/date=YYYY-MM-DD/{venueId}/{one-or-more-safe-segments}`. Date segments must be valid dates; do not infer ownership from a substring. The venue segment must exactly equal the report's `venueId`.
- Key byte lengths and evidence-key count are within configured limits. Duplicate valid keys may be deduplicated for forwarding. Date equality with the report timestamp or with other keys is not required; the brief does not specify that invariant.

If any evidence condition fails, exclude the entire evidence block, accept the otherwise-valid health report, and record a bounded diagnostic such as `EVIDENCE_EXCLUDED` with a reason code. Do not change the PCM result or manufacture `uploadFailed=true`. The bounded original payload may remain in private durable storage for identity/audit, but it must never bypass validation on publication or reads. A body exceeding the total HTTP limit is still rejected with `413`.

Matching a venue segment does not authenticate the sender or prove object existence. Those guarantees are unavailable within the assignment's no-authentication scope.

## 5. Lifecycle policy

Statuses are exactly `Installed`, `Production`, `SuspectedMaintenance`, and `Maintenance`. Control mode is a separate field, not another status. A new venue starts as automatic `Installed` during processing of its first valid accepted message.

### 5.1 Human inputs

An applicable operator command sets its requested status, sets `mode=manual`, and publishes the decision even if the status is unchanged. Its reason is `OPERATOR_DECISION`; retain the command ID and requested status as the explanation. Every manual status, including Production, is pinned against device-driven changes. Device reports still update diagnostics/watermarks, making hardware failures visible even during manual Production.

An applicable calibration approval sets automatic Production with reason `CALIBRATION_APPROVED`, releases manual control and any maintenance latch, and starts a new diagnostic epoch. A manual command setting Production also starts a new epoch but remains manual. Other manual commands do not reset the epoch. Human resets retain all history and source-time watermarks.

### 5.2 Automatic report decisions

First apply freshness checks in section 6. A fresh report always updates latest diagnostics. The following precedence then applies:

| Condition | Effective behavior |
| --- | --- |
| Manual control | Preserve status and decision reason |
| Automatic Installed | Preserve Installed with `INITIAL_INSTALLATION`; record diagnostics |
| Automatic active venue and `selfTest.passed=false` | Set Maintenance with `SELF_TEST_FAILED`, immediately |
| Automatic active venue, self-test passes, PCM ran and failed | Apply the PCM escalation rule below |
| Automatic SuspectedMaintenance, self-test passes, PCM ran and passed | Set Production with `CHECKS_PASSED` |
| Automatic Maintenance and otherwise healthy/incomplete report | Keep Maintenance and its decision reason; only diagnostics improve |
| Other healthy/incomplete report | Preserve current decision |

“Active” here includes Production, SuspectedMaintenance, and Maintenance. Hardware self-test failure has precedence over PCM failure; it is distinct from an image-quality warning. `PCM_CAMERA_BAD_FOCUS_CRITICAL` behaves like any PCM failure; its name alone does not require immediate Maintenance.

PCM escalation counts fresh, unique reports with `pcm.ran=true` and `pcm.status=fail`, processed while automatic and outside Installed, within the current diagnostic epoch. Count all PCM reasons together and include both trigger types. An otherwise eligible PCM failure also counts when self-test fails, but immediate hardware Maintenance with reason `SELF_TEST_FAILED` has precedence.

For an incoming applicable PCM failure at device time `t`, consider eligible failures with `t - PCM_FAILURE_WINDOW_DAYS <= analyzedAt <= t` (inclusive boundaries). Escalation holds when both:

1. Count is at least `PCM_FAILURE_THRESHOLD` (default 3).
2. Latest minus earliest failure time in that window is at least `PCM_FAILURE_MIN_SPAN_HOURS` (default 24).

The default window is seven days. Before the threshold, automatic Production/SuspectedMaintenance becomes or remains SuspectedMaintenance. At the threshold it becomes Maintenance. Automatic Maintenance never downgrades because a later window contains fewer failures; it requires a human action.

A new applicable PCM failure with a passing self-test sets the main reason to its selected PCM reason, including when status is already Maintenance. An earlier hardware cause remains in history; latest diagnostics separately show whether hardware now passes. A successful report must not change a latched Maintenance reason to `CHECKS_PASSED`.

Passes do not erase rolling-window failures. Absent PCM, `ran=false`, and inconclusive results neither count as failure nor prove recovery. Time passing alone never changes status; no scheduled lifecycle recalculation is needed. Monthly recurrence remains discoverable in history but is not escalated by the seven-day policy. The minimum span is a noise guard, not a count of distinct calendar nights.

Reports observed in manual mode or Installed do not contribute to the automatic failure count. An epoch reset excludes earlier observations from future counting without deleting them. Configuration changes affect subsequent evaluations against retained eligible observations; they do not replay prior decisions or rewrite publications.

## 6. Ordering, clocks, and late input

Within a venue, process the lowest unprocessed `ingestOrder` first. A blocked inbox head prevents successors of that venue from applying. Different venues can progress independently.

Maintain separate report and calibration time watermarks:

- A report is fresh only when its `analyzedAt` is strictly greater than the report watermark, or the watermark is absent. Otherwise persist a processed `ignored_stale` outcome without changing diagnostics, counts, or lifecycle. Equal time means the first admitted/processed report wins.
- Advance the report watermark for every fresh processed report, including Installed/manual observations. Never reset it during recovery.
- A calibration must have `approvedAt` strictly greater than the calibration watermark. Otherwise process it as `ignored_stale`.
- For a newer calibration, advance its watermark even when the operator cutoff below prevents application.
- A calibration with `approvedAt <= receivedAt` of the latest already-processed operator command is `ignored_before_operator`. It cannot release that manual decision. Compare against that command's original first-admission server time, not processing time or a later retry.
- Operator commands have no mandatory source timestamp. Apply them by first-admission order. `issuedAt` does not alter this rule.

Explicit clock assumption: Engineering Tool's `approvedAt` uses trustworthy UTC comparable to the service clock. This assumption enables the operator cutoff; it is a design choice, not an upstream guarantee. Device clocks are not assumed synchronized. Never compare device `analyzedAt` with server receipt time or calibration time to declare a report stale.

Known limit: a previously unseen report created before a human reset may arrive afterward with an `analyzedAt` newer than our report watermark. It will be processed in the new epoch if otherwise eligible. Existing fields cannot distinguish that case reliably. Similarly, true creation order of delayed operator commands cannot be recovered. Strong cross-source chronology would require upstream epochs/revisions or reliable causal metadata; this implementation does not add mandatory fields or claim that guarantee.

## 7. Publications and explanations

Assign an increasing per-venue publication `sequence`, beginning at 1. It identifies a committed decision revision, including the explicitly chosen same-status publications below, not only a change of the status enum.

Publish when:

- The venue's initial Installed decision is created (`INITIAL_INSTALLATION`).
- Effective status, main decision reason, or control mode changes.
- A new applicable operator command is processed, even if status/mode/reason are unchanged.

Do not publish for duplicates, stale/ignored inputs, an identical automatic decision, or new evidence/diagnostic details alone. Applying a calibration with an unchanged decision tuple still resets the epoch and records the approval in audit history but does not require another identical publication. Fresh device diagnostics under manual control never replace `OPERATOR_DECISION`.

For a first calibration or operator input, commit initial Installed (sequence 1) followed by the applicable human decision (sequence 2) in the same processing transaction. For a first device report, Installed remains and only sequence 1 is published. Publication creation, sequence allocation, state changes, and history must be atomic.

Persist immutable downstream payloads at publication time. If the triggering decision came from a PCM failure or PCM-based recovery and that report has valid evidence, attach that report's PCM data. Omit PCM for initial installation, hardware-only, operator, and calibration decisions, or when no safe evidence exists. Do not forward unrelated historical evidence or refresh a queued publication from newer diagnostics.

The supplied downstream contract is fixed:

```http
PUT {DOWNSTREAM_URL}/api/systems/{venueId}/status
x-api-key: {DOWNSTREAM_API_KEY}
idempotency-key: {venueId}:{sequence}
content-type: application/json
```

```json
{
  "status": "SuspectedMaintenance",
  "reason": "PCM_CAMERA_MOVEMENT",
  "sequence": 2,
  "pcm": {
    "analyzedAt": "2026-10-20T01:15:00Z",
    "bucket": "venue-logs",
    "result": "pcm/results/date=2026-10-20/V1/01-15-00.json",
    "evidence": ["pcm/evidence/date=2026-10-20/V1/01-15-00/movement_0_blend.jpg"],
    "uploadFailed": false
  }
}
```

Map upstream `resultKey` to downstream `result`, and `evidenceKeys` to `evidence`. Send no extra internal fields such as mode, inbox ID, or attempt number in the downstream body. Encode the validated venue path segment; the destination base URL is configuration, never input-controlled.

## 8. Persistence and atomic processing

Use WAL, `synchronous=FULL`, foreign keys, prepared statements, an explicit busy timeout, and non-destructive versioned schema initialization. Durability assumes the local database/WAL and underlying storage remain available and honor synchronization; replication and recovery after loss of the disk are outside scope.

Persist these logical records (tables may be combined where responsibilities remain clear): inbox admissions and processing outcomes; venue state/mode/epoch/watermarks/last operator receipt time; report observations used for diagnostics/counting; append-only decision/audit history; outbox publications; delivery attempts; recovery actions. Enforce unique source identities and unique `(venueId, sequence)` publications.

Each inbox processing transaction:

1. Reads the eligible head and current venue state.
2. Creates initial Installed if needed.
3. Checks freshness/cutoffs, records the observation/outcome, and applies policy.
4. Writes the resulting state, history, and immutable outbox records.
5. Marks the inbox item processed and commits all effects together.

No HTTP, asynchronous wait, sleep, or network operation is allowed inside the synchronous transaction callback. A failure before commit rolls back every effect, including the processed marker and sequence allocation. A crash after commit must not repeat the business effect.

On an unexpected message-specific processing error, roll back, then use a separate short transaction to mark that accepted inbox item blocked with a safe error code and internal diagnostic context. Preserve the original body. Do not automatically turn a deterministic bug into an endless retry loop. Busy/I/O/storage failures are not poison messages: pause affected database work and retry after the configured storage delay. If recording a blocked state also fails, leave the message recoverable and pause; never pretend the failure record was saved.

Select eligible venue heads in a bounded round-robin pass (oldest eligible head first is a suitable initial order). Process at most one head per venue per pass and yield between batches; continue the rotation across batches instead of restarting at the same first venues every poll. Determine each venue's earliest unprocessed head first, then exclude blocked heads before applying batch limits, so a blocked or noisy venue cannot monopolize processing. Inbox processing is synchronous and sequential in this one process; HTTP admission and downstream requests remain independently scheduled.

## 9. Outbox delivery and retry

Persist outbox states `pending`, `delivered`, and `blocked`. In this single process, an in-memory per-venue in-flight guard plus a durable attempt-start record is sufficient; no separate durable lease or `sending` state is required.

Only the lowest not-delivered sequence of a venue may be dispatched. Never have more than one in-flight request per venue. Allow bounded concurrency across venues. First determine each venue's earliest not-delivered head, then filter for pending/due/not-in-flight heads before applying candidate batch limits; never filter away an earlier blocked head to select its successor. Continue fair rotation across batches. Waiting or blocked heads must not hide eligible work from other venues.

Persist an attempt-start record before issuing HTTP; if this write fails, do not send. Give each attempt its own ID, monotonic attempt number, start/end times, duration, and outcome; keep the publication's idempotency key stable. Enforce a finite request deadline and bound/omit response-body reads so a slow/huge error body cannot hold a worker indefinitely. Classify a received final status and Retry-After from headers before reading any optional diagnostic body. A known 422 or 429 must not become a generic network retry because its body stalls or fails; a 2xx requires no body to count as successful. Cancel/truncate optional body reads within the deadline. Disable automatic redirects; never forward the API key to a redirected destination.

| Result | Action |
| --- | --- |
| Any `2xx` | Atomically mark delivered and finish the attempt |
| `429` | Retry no earlier than the valid `Retry-After` delay and local backoff |
| `5xx`, timeout, connection/network failure | Persist a retry schedule |
| Other `4xx` | Mark this publication blocked; retain successors |
| `3xx` or an unexpected final protocol response | Block as `UNEXPECTED_DOWNSTREAM_RESPONSE`; do not follow redirects |

For retry number `n` starting at 1 after the first failed attempt, let `cap = min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2^(n-1))` with a bounded exponent. Compute `localDelay = ceil(cap * (1 - RETRY_JITTER_RATIO + RETRY_JITTER_RATIO * u))`, where `u` is uniform in `[0,1]`. Inject clock/random sources for deterministic tests.

`Retry-After` is a nonnegative integer number of seconds under the given contract. For a valid, representable value, wait `max(localDelay, Retry-After * 1000)`; do not shorten it to the local backoff cap. Missing, malformed, or unrepresentable values use local backoff and emit a warning. Persist `nextAttemptAt` before releasing the venue for future dispatch. Never rely only on an in-memory timer. Transient retries have no attempt-count expiry and never discard the publication.

A timeout before a final HTTP status means an unknown remote outcome. If downstream accepted a publication but its response was lost, retry with the same payload/key. If the remote success is known but the local delivered marker cannot commit, pause dispatch until reliable delivery-state writes are restored; the still-undelivered publication is retried safely with the same key. Failure to persist any attempt outcome, retry schedule, or blocked marker also pauses new dispatch; retain the known result in memory for a local persistence retry while the process survives. A crash before that write leaves an interrupted/unknown attempt, so restart may resend the same publication. Do not claim network exactly-once delivery; the downstream's stated idempotency contract prevents duplicate application.

On startup, unfinished attempt-start records become interrupted/unknown diagnostics. Their undelivered publications remain eligible for retry subject to persisted scheduling. Do not permanently strand work in an in-memory or unrecovered `processing`/`sending` state. Delivered items are never resent as new publications.

## 10. Recovery and shutdown

Provide an offline CLI invoked as:

```text
npm run recover -- inbox <inboxId> --reason "cause fixed"
npm run recover -- outbox <outboxId> --reason "downstream configuration corrected"
```

Operational precondition: stop the service before invoking the CLI, then restart it. This is not a concurrently running administrative API or a multi-process coordination feature. Document this precondition clearly.

Require a nonempty bounded reason (1–512 characters), verify the target exists and is blocked, and atomically append a recovery action plus return it to pending/eligible state. Retain all previous errors/attempts and original message/publication identities. Requeue must not edit payload, sequence, source timestamps, or idempotency keys, and must not bypass an earlier blocked head. Wrong target/state is a clear nonzero CLI error.

A requeue is useful only after the underlying cause is corrected. A permanently unacceptable `422` payload cannot be repaired through this command. If downstream cannot be made to accept it, that venue remains blocked. The supplied contract cannot guarantee both delivery of every revision and progress past a revision that will never be accepted. No skip, payload editing, resequencing, or generic repair console is implemented.

On SIGTERM/SIGINT, stop accepting new requests and starting jobs, allow in-flight work to finish within `SHUTDOWN_TIMEOUT_MS`, abort remaining network work, and close storage after safe final writes where possible. A forced exit may lose the last diagnostic log, but committed pending work must resume after restart. A fatal uncaught exception warrants best-effort stderr logging and nonzero process exit, not continued operation in an undefined state.

## 11. Configuration

Use `@nestjs/config` with grouped typed settings. Parse and validate environment values and resolved factory output once at startup. Components receive validated values; domain policy receives plain typed settings. Keep secrets out of source control and configuration/error dumps. `.env.example` contains placeholders; no hot reload or remote configuration service is required.

| Environment variable | Default | Constraint / meaning |
| --- | --- | --- |
| `PORT` | `3000` | Integer 1–65535 |
| `SQLITE_PATH` | `./data/venue-health.sqlite` | Nonempty durable file path; production mode must not use `:memory:` |
| `SQLITE_BUSY_TIMEOUT_MS` | `1000` | Integer 1–10000; synchronous wait is kept bounded |
| `STORAGE_RETRY_DELAY_MS` | `1000` | Positive integer |
| `DOWNSTREAM_URL` | Required | Absolute HTTP(S) base URL, no credentials/query/fragment; localhost HTTP is allowed for fake |
| `DOWNSTREAM_API_KEY` | Required | Nonempty secret; fake uses a development-only value |
| `DOWNSTREAM_TIMEOUT_MS` | `5000` | Positive integer |
| `DOWNSTREAM_CONCURRENCY` | `4` | Integer 1–32, across different venues |
| `INBOX_POLL_INTERVAL_MS` | `100` | Positive integer |
| `INBOX_BATCH_SIZE` | `25` | Integer 1–1000 |
| `OUTBOX_POLL_INTERVAL_MS` | `200` | Positive integer |
| `OUTBOX_BATCH_SIZE` | `25` | Integer 1–1000; bounds candidate heads inspected per pass |
| `RETRY_BASE_DELAY_MS` | `1000` | Positive integer |
| `RETRY_MAX_DELAY_MS` | `60000` | Integer at least base delay; does not cap a valid Retry-After |
| `RETRY_JITTER_RATIO` | `0.2` | Finite number from 0 through 0.9 |
| `PCM_FAILURE_THRESHOLD` | `3` | Integer at least 2 |
| `PCM_FAILURE_WINDOW_DAYS` | `7` | Positive finite number |
| `PCM_FAILURE_MIN_SPAN_HOURS` | `24` | Positive finite number, no greater than window hours |
| `HTTP_BODY_LIMIT_BYTES` | `262144` | Positive integer |
| `JSON_MAX_DEPTH` | `32` | Integer 1–128 |
| `MAX_PCM_REASONS` | `32` | Positive integer; core DTO array bound |
| `EVIDENCE_ALLOWED_BUCKETS` | `venue-logs` | Comma-separated, nonempty exact bucket names |
| `EVIDENCE_MAX_KEYS` | `20` | Nonnegative integer |
| `EVIDENCE_MAX_KEY_BYTES` | `1024` | Positive integer |
| `HISTORY_MAX_PAGE_SIZE` | `100` | Integer 50–1000 |
| `DOWNSTREAM_ERROR_EXCERPT_BYTES` | `1024` | Integer 0–16384; zero disables retention |
| `SHUTDOWN_TIMEOUT_MS` | `10000` | Positive integer |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `fatal` |

All integer/time arithmetic must remain within safe representable bounds. Polling, storage-retry, downstream-timeout, and shutdown delays passed directly to timers must be no greater than 86400000 ms; reject larger configured values. Persist distant retry eligibility as a deadline and check it through bounded polling rather than passing a large Retry-After directly to a timer. Reject invalid configuration before serving requests. Policy values are intentionally tunable; status names, fixed HTTP contracts, uniqueness rules, and transactional guarantees are not configuration switches. Keep a stable snapshot for each process; changed settings apply on restart to subsequent processing only.

## 12. Logging and diagnosis

Write structured JSON logs to stdout/stderr independently of SQLite. Durable audit/attempt state belongs in SQLite; do not make diagnostic logging depend on the failing store. A shell/process runner may capture logs into a file; this service does not need a file-rotation subsystem.

Log timestamp, level, stable event name, component, and available `requestId`, `inboxId`, source message ID, `venueId`, publication sequence/outbox ID, and attempt ID. Persist original causal identifiers so correlation survives both queue boundaries and restart. A retry request has its own request ID linked to the original inbox ID. Request-local AsyncLocalStorage alone is insufficient for this chain.

Info: startup/shutdown, accepted/duplicate admissions, committed decisions, successful deliveries, explicit recovery. Warn: validation/evidence exclusion, stale/conflicting input, retryable delivery failures. Error: blocked work and storage failures. Debug: bounded decision inputs, counts, ignored reasons, and scheduling details. Log empty polls only if explicitly diagnosing the polling mechanism, not by default. Avoid repeating the same outage stack on every poll; log failure entry/recovery and individual relevant attempts.

Log request/processing/delivery durations for investigation. Exclude API keys, authorization headers, raw arbitrary request bodies, and unbounded downstream bodies at every log level. Prefer status/error codes; any configured excerpt must be truncated and sanitized/redacted. Internal error causes/stacks stay in controlled diagnostic logs, not public API responses. A stored audit failure does not substitute for an independent log when SQLite is unavailable.

This is correlation-based diagnosis, not a complete distributed trace across external services. No guarantee is made that SIGKILL, power loss, or every OOM permits a final log.

## 13. Acceptance tests and controllable fake

Use a compact table-driven policy suite plus meaningful real-SQLite/HTTP integration tests. No coverage-percentage target or tests for trivial getters, decorators, or framework internals. Inject time/randomness; do not wait seven real days, an hour of downtime, or 30 real seconds in ordinary tests.

The fake must implement the exact downstream method/path/headers, idempotent duplicate acceptance, per-venue sequence checking, and an ordered applied-history store. It must allow scripted per-venue/sequence responses: success, `429` with Retry-After, selected permanent `4xx`, `5xx`, delayed response, connection failure, and applying a publication before dropping its response. Fault scripts act before normal application unless explicitly configured for apply-then-drop. A retry of an already-applied key normally returns `2xx` without a second effect.

Provide `npm run fake:downstream` for a local runnable fake and a programmatic test interface for deterministic scripts and history inspection. A small shared implementation is sufficient; no fake UI or separate framework. Document the actual scenario configuration interface and development key in README.

| Acceptance area | Required observable checks |
| --- | --- |
| Initial admission | First report leaves Installed; first calibration/operator creates ordered initial Installed plus human decision |
| PCM behavior | One failure warns; three qualifying failures escalate; same-night burst under minimum span does not; mixed reasons count together; pass does not erase window; boundaries are inclusive |
| Recovery/manual control | Healthy report restores only automatic SuspectedMaintenance; Maintenance requires human action; manual Production and Maintenance survive bad/good device reports; calibration releases manual control and resets epoch without resetting watermarks |
| Incomplete/hardware data | Absent/not-run/inconclusive PCM is neutral; self-test failure immediately escalates an automatic active venue; Installed/manual behavior takes precedence; critical/upload flags do not invent transitions |
| Explanation/publication | Same decision avoids duplicate notification; changed reason and new operator command publish; healthy diagnostics do not overwrite a latched Maintenance reason |
| Input/deduplication | Ten simultaneous identical admissions create one effect; reordered JSON keys still duplicate; same ID/different body conflicts; core invalidity rejects while unsafe evidence is excluded |
| Ordering | Out-of-order/equal-time reports are ignored; late calibration cannot undo a later operator decision under the clock assumption; latest manual/Installed reports still advance watermarks |
| Storage boundaries | No successful admission before commit; injected processing failure rolls back state/history/outbox/marker together; a blocked venue does not block another; storage outage is not classified as a poison message |
| Process restart | At least one real child-process termination after acknowledged admission followed by restart against the same on-disk DB completes delivery; exercise rollback/fault points separately and describe any crash window not directly killed/tested |
| Downstream outage/order | Simulate one-hour outage with a controlled clock and backlog from 50 venues; accepted work survives and each venue drains in sequence after recovery |
| Rate limiting | No early retry before valid Retry-After; other venues progress; missing/invalid header uses backoff; retry time survives restart |
| Unknown remote outcome | Apply-then-drop and local acknowledgement-write failure lead to same-key retry and one remote application |
| Terminal rejection | Sequence 2 rejected with 422 blocks 3/4 for that venue; another venue delivers; offline requeue retains identity/history and resumes only if the cause is corrected |
| Read/config/security | Pending first venue is visible with null status; unknown venue is 404; pagination bounds, invalid startup config, safe error mapping, bucket/venue/path/key-count checks |

One scenario may establish multiple guarantees. Run focused checks while implementing and type checking, build, and the relevant full suite once at completion. Never claim that transaction exception injection proves every SIGKILL/power-loss scenario. README must explicitly answer which failure behavior is not covered by tests, grounded in actual results.

## 14. Three replicas: design only

Do not run three independent SQLite files behind a load balancer: they would disagree on deduplication, venue state, and publication sequence. A shared SQLite file on network storage is not the proposed scaling strategy.

A future design uses a shared transactional database with global identity uniqueness, per-venue state serialization/locking or optimistic version checks, and the same atomic state/history/outbox transaction. Workers claim work through durable leases; keep one effective publisher per venue, recover expired claims, and retain downstream idempotency. Account for an old publisher continuing after lease expiry through fencing/ownership checks; leases alone do not prove ordered delivery. A broker is optional, not a replacement for transactional admission/publication guarantees.

This also requires shared operational visibility, coordinated migrations, backup/restore, authentication/authorization, and a deliberate policy for queue backpressure and retention. These are documented future changes, not implementation tasks here.

## 15. Limits and handoff

Chosen limits: no authentication or evidence-existence verification; device clock resets/skew can make source-time ordering unreliable; Engineering Tool clock trust is assumed; previously unseen pre-reset reports and delayed operator commands have the ordering limits in section 6; a permanent downstream rejection may require external contract repair; local disk loss and unlimited backlog are not solved. Retain accepted/audit/publication records for this exercise; no automated deletion or retention job is added.

These open production questions do not block the first implementation: upstream epoch/version support, authority of timestamps, remediation contract for permanently rejected publications, evidence authorization, storage capacity/retention, and multi-replica delivery fencing.

Deliver working source, lockfile, `.env.example`, controllable fake, tests, README with actual build/run/test/recovery commands and the two required omission/test-gap answers, `AI-LOG.md`, and genuine available session transcripts under `transcripts/`. A summary is not a transcript; identify unavailable sessions or redactions rather than inventing them. Keep meaningful git history without squashing. Preserve the user's repository visibility setting. This SPEC defines intended behavior; completion and test claims belong to the implementation handoff.
