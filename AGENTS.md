# Venue Health Service — Agent Instructions

## Purpose and authority

Build a small, reliable service whose author can explain and change it live. Prioritize observable behavior and the assignment's remaining time over architectural ceremony.

- Read `SPEC.md` before implementation. It defines the complete implementation contract: API, lifecycle policy, ordering, delivery, configuration defaults, assumptions, and acceptance criteria. This file defines engineering practices.
- Consult the original product brief when available; its absence from the repository must not block work against SPEC. Surface material conflicts without silently changing agreed behavior or weakening tests.
- Follow the current authorized task. Resolve routine implementation choices autonomously; ask only about material ambiguity that the agreed sources cannot resolve.
- Keep code, comments, documentation, and repository deliverables in English. Discuss progress in the user's preferred language.

## Architecture and code structure

- Use TypeScript, NestJS, SQLite, and `better-sqlite3`. Run one process with HTTP admission, background inbox processing, and background outbox delivery. Background components are not separate processes or worker threads.
- Use a light hexagonal structure: domain models/policy, application use cases/ports, and HTTP/SQLite/downstream adapters. Nest modules compose dependencies. Keep domain and application logic independent of Nest, SQL, HTTP request objects, and environment access.
- Use cohesive classes for use cases, policies, repositories, and adapters. Prefer explicit constructor injection and composition. Small pure helpers and plain typed immutable data are welcome; avoid closure chains, service locators, global mutable state, and inheritance for incidental reuse.
- Keep controllers thin: validate/map input, invoke a use case, map its result. Keep SQL in persistence adapters and downstream transport in a dedicated client.
- Define interfaces at useful boundaries, including persistence, transport, and time. Use explicit Nest injection tokens where necessary. Do not create an interface, base class, or directory for every trivial operation.
- Model venue identity and state explicitly. Distinguish DTOs, domain models, and persistence rows where responsibilities differ; map at boundaries. Do not introduce an ORM or duplicate entity hierarchy merely for decorators.
- Give repository ports focused operations required by use cases. Use prepared statements. All repositories participating in one atomic operation must share one connection and transaction scope; a small transaction runner/UoW is sufficient. Repositories must not independently commit pieces of that operation.
- Keep schema initialization/versioning explicit and preserve existing data. Avoid generic repository frameworks, custom DI, universal rule engines, unnecessary CQRS/event buses, and unrelated RunVero/Foundation or client code.
- Respect SPEC non-goals. Do not add infrastructure, UI, authentication, deployment manifests, metrics endpoints, or implemented multi-replica coordination. Describe future multi-replica changes in documentation only.

## Types, validation, and errors

- Enable strict TypeScript. Use named contracts and discriminated unions for meaningful outcomes. Treat untrusted input and caught errors as `unknown`; narrow them without `any`, unchecked casts, or assertions that bypass validation.
- Preserve supplied upstream fields and downstream method/path/payload/headers. Do not make optional extensions required. Keep source time, receipt time, ingestion order, publication sequence, and attempt number distinct.
- Before acknowledgement, validate core input shape, required fields, enums, UTC timestamps, and bounds according to SPEC. Avoid meaning-changing coercions. Keep evidence validation separate so invalid evidence can be excluded without rejecting an otherwise valid signal where specified.
- Bound request and read sizes. Parameterize SQL; validate and encode downstream path segments. Never accept a client-provided destination URL or interpolate untrusted input into filesystem paths or log formats.
- Use a small framework-independent `ApplicationError` base class extending `Error`, with stable code/category, safe message, and optional internal cause/context. Add subclasses for useful behavioral distinctions, not individual message strings.
- Map errors to HTTP in one adapter exception filter. Domain/application errors must not extend Nest `HttpException`. Preserve infrastructure causes internally; do not classify every database exception as transient or expose SQL/stack traces in responses.
- Represent expected duplicate, stale, and lifecycle outcomes explicitly rather than as exceptions. Classify downstream outcomes explicitly; apply retry decisions in the delivery use case according to SPEC.
- Catch only to translate, recover, persist an outcome, or terminate safely. Log at the handling boundary, not every rethrow. Never swallow failures or turn failed admission into success. Responses include stable error codes and request identifiers.

## Typed configuration

- Use `@nestjs/config` and `ConfigModule` with grouped typed configuration factories. Read environment variables only at configuration/bootstrap boundaries. Inject required settings; pass plain typed policy settings to domain classes.
- Keep operational settings configurable: HTTP port/limits, SQLite path/busy timeout, downstream URL/key/timeout/concurrency, polling intervals/batch sizes, retry delays/jitter, shutdown deadline, log level, evidence restrictions, and the numeric policy settings identified in SPEC.
- Validate resolved configuration at startup, including factory output: finite numbers, explicit units, ranges, required values, and cross-field constraints. TypeScript generics alone do not validate configuration. Fail clearly without printing secrets.
- Document defaults and behavior in SPEC, setup in README, and provide a secret-free `.env.example`. Use explicit units such as `pollIntervalMs`; real keys belong in environment variables or ignored local configuration.
- Load a stable startup snapshot; no hot reload. Configuration changes must not rewrite existing outbox payloads or silently replay history. Protocol contracts, idempotency, and transaction guarantees are not optional configuration switches.

## Durability and processing

- A successful admission response requires a committed inbox write. Use durable uniqueness and SPEC payload-identity rules for deduplication. Admission and background processing are separate transactions; acknowledgement promises receipt, not completed processing or delivery.
- Process each inbox message atomically: persist its outcome, relevant observations, venue state, history, and outbox publications, then mark it processed in that same transaction. Accepted messages remain recoverable after failures.
- Keep SQLite transactions short and synchronous. Never `await`, sleep, fetch, or perform downstream IO inside a `better-sqlite3` transaction callback. Background scheduling does not make synchronous SQLite calls nonblocking.
- Configure WAL and `synchronous=FULL`, handle busy/storage failures, and preserve durable files across restart. Keep storage outages distinguishable from invalid messages; never acknowledge unsaved work or discard accepted messages to clear an error.
- Give processors explicit start/stop lifecycle management. Prevent overlapping runs, bound batches, and yield between batches. Preserve the per-venue order and blocking rules in SPEC.
- Persist the state needed to resume work and correlate decisions. Do not depend on an in-memory timer, Promise, or request context as the sole record of accepted work.

## Outbox delivery and recovery

- Persist immutable publication payloads and idempotency keys when creating the outbox record. Retries resend that publication, never a payload rebuilt from current venue state.
- Send outside transactions. Preserve per-venue ordering, allow bounded concurrency across venues, and apply finite request timeouts. Persist retry eligibility and follow SPEC backoff, jitter, and `Retry-After` behavior.
- Keep logical publications separate from delivery attempts. Timeout or interruption means an unknown remote outcome, not proof that nothing was applied.
- If downstream succeeds but local acknowledgement cannot be saved, retain the publication for idempotent retry. Pause new dispatch while reliable delivery-state updates are unavailable.
- Preserve terminal failures and their diagnostics under SPEC blocking semantics. Never silently skip, delete, or mutate a failed publication to advance the queue. A maximum retry delay is not an attempt limit; do not silently abandon transient failures.
- On normal shutdown, stop admitting/starting new work and drain in-flight work within the configured deadline. On startup, recover unfinished work from persisted state. Do not promise that graceful shutdown runs on a forced kill.

## Security and diagnostics

- Validate evidence against SPEC bucket, namespace, exact venue-segment, and size rules. Exclude invalid evidence as specified; do not repair ambiguous paths into different keys. Do not fetch evidence or claim path validation proves authorization or object existence.
- Write structured JSON diagnostics to stdout/stderr independently of SQLite. Keep durable business audit and delivery-attempt records in SQLite; the logger must remain usable when the database fails.
- Include timestamp, level, event, component, and available request/message/venue/publication/attempt identifiers. Persist causal identifiers across queued work and restart; request-local context alone is insufficient.
- Log meaningful outcomes and failures. Use configurable debug detail for policy inputs and retry decisions; avoid empty-poll noise. Never log secrets, authorization headers, or arbitrary complete bodies. Bound untrusted values and downstream error excerpts at every log level.
- Handle expected request/job errors at their boundaries. For an unhandled fatal exception, attempt a minimal diagnostic write and exit nonzero rather than continuing in an undefined state. No final-log guarantee is possible for SIGKILL, power loss, or every memory failure.

## Testing and verification

Use the smallest meaningful suite that demonstrates SPEC and its failure guarantees. Prioritize behavior over coverage quotas.

- Use table-driven policy tests for lifecycle examples and meaningful threshold, recovery, manual-control, and incomplete-signal boundaries.
- Use real SQLite integration tests for concurrent duplicate admission, stale-message handling, atomic rollback, and durable inbox/state/history/outbox relationships. Use temporary on-disk databases for recovery.
- Provide a controllable HTTP downstream fake covering success, delay, timeout, connection/5xx failures, rate limiting, permanent rejection, ordering, and response loss after remote application. Delivery integration tests exercise actual HTTP transport.
- Verify acknowledgement only after durable admission, restart before inbox processing, rollback during processing, and idempotent retry after remote success with failed local acknowledgement. Use actual process termination/restart for claimed crash coverage; reopening a connection is not equivalent to a killed process.
- Compactly test malformed inputs, unsafe evidence, configured limits, invalid startup configuration, and observable error mapping. Do not test trivial constructors, getters, decorators, private methods, or framework internals.
- Inject time and randomness where needed. Prefer deterministic scheduling controls over long sleeps, while retaining targeted real-process/transport checks. Do not mock away the SQLite guarantees under test or duplicate assertions across every layer.
- Run focused checks during development; finish with type checking, build, and the relevant full suite. Repeat only after changes, failures, or unresolved concerns. Do not hide races with retries, loosen assertions, or disable failing tests.
- If time prevents coverage, preserve existing checks and identify the exact untested failure behavior in README. Never report an untested guarantee as verified.

## Execution and handoff

- Respect the remaining portion of the assignment's total four-hour budget, including prior work; a new session does not restart it. Stop at the user's stated deadline and record unfinished work honestly.
- Work in small complete increments with meaningful intermediate commits. Preserve history without squashing or fabricated commits. Preserve unrelated changes; pin dependencies with the lockfile and document the supported runtime.
- Keep planning lightweight. Maintain README with actual build/run/test commands and the required explanations of omissions and untested failures. Avoid extra planning artifacts without a concrete need.
- Maintain `AI-LOG.md` and genuine available session transcripts in `transcripts/`. A summary is not a transcript. Never invent missing conversations or test output; identify redactions and exclude secrets.
- Keep secrets, runtime database/WAL files, generated logs, dependencies, and disposable build output out of git. Ignoring durable files is not permission to delete them. Follow the user's repository visibility and publishing instructions without incidental access changes.
- Before handoff, compare behavior with SPEC. Report implemented behavior, checks actually run, failures, omissions, and material limitations. Do not claim production readiness, implemented multi-replica support, or protection against loss of the local disk.
