# Delivery history

Per-stage delivery notes moved out of the README so it stays a setup and operations guide. The README links here; the normative behavior lives in [the specifications](../README.md).

Stage 1 recovery restored `Money`, immutable wallet and ledger entities, wager lifecycle and operation/reference/reversal rules, domain errors, integration event envelopes, and two domain test files. The recovery preserved the current Stage 0 foundation and both existing stashes.

Stage 1 conformance verification passed 72 tests (175 assertions): 67 domain tests and five foundation tests. Regressions cover invalid internal openings, blank supplied references, and failure codes on non-failure states. Ledger reconstruction explicitly includes `OPENING` exactly once.

Stage 2 verification passed **92 tests across five files (268 assertions)** at that stage. Current migrations include Stage 4 recovery leases and durable Inbox conflict audit records. The Stage 4 migration is covered by empty-schema up/down/up and populated conflict-record rollback refusal tests.

At the Stage 2 checkpoint, both `bun run db:migrate` and the compiled migration runner were exercised; repeating `up` was a no-op. The compiled API connected to PostgreSQL, answered liveness, and returned the expected `404` on a missing-wallet query. The temporary smoke-test API was stopped afterward. Wager-processing locks, retries, and replay snapshots followed in Stage 3; Inbox/Outbox workers followed in Stage 4.

### Conformance revalidation — 2026-10-29

The existing **92 tests / 268 assertions** and lint, type-check, build, format and Compose configuration checks pass after switching TypeScript to `module: Node16` / `moduleResolution: Node16`. Without `"type": "module"` in the package, this preserves CommonJS output and the Bun runtime; the verified local compiler is TypeScript 5.9.3, not certification of TypeScript 6/7.

Additional probes used isolated temporary databases, not development data. They identified two gaps in the earlier implementation, now corrected with regression coverage:

1. **Database money defense:** the new `RejectNonFiniteMoney` migration blocks non-finite wallet balances, wager amounts and ledger monetary columns without modifying the applied initial migration. Tests cover SQL `NaN`/infinities, populated down/up preservation, and refusal to migrate invalid legacy data without rewriting it.
2. **HTTP error contract:** the existing exception filter is registered globally with `APP_FILTER`. Malformed JSON now returns `400` with exactly `{ "code": "INVALID_REQUEST", "message": "Invalid request." }`, without echoing the submitted payload.

A real refused PostgreSQL connection was also checked through the wallet repository/filter and returned a sanitized `503` as intended. LocalStack still reports successful initialization and all three FIFO queues, including 60-second visibility and five-receive redrive on the source queue.

The Stage 2 correction suite passed **103 tests / 309 assertions**, including **31 real PostgreSQL integration tests**, plus lint, type-check, build and formatting. The corrective migration was applied to the local development database and repeating `up` was a no-op. Both audit gaps are closed.

### Stage 3 delivery — 2026-10-29

The Stage 3 API validates and normalizes wager requests, hashes canonical business fields, and serializes identity/idempotency with ordered PostgreSQL transaction advisory locks before locking the wallet row. Transaction, wallet/version, ledger entry, response snapshot, and integration Outbox event(s) commit atomically. Replays return the original status and balance snapshot; conflicts return `409`. Transient database failures are retried up to three attempts.

Real PostgreSQL/HTTP tests cover all wager outcomes and references, durable business rejection, 50 identical concurrent submissions with one financial effect, the `80.00 BRL` race against `100.00 BRL`, concurrent cross-kind reversals, replay after the wallet changes, and rollback on injected Outbox failure. The validated `Stage3WagerIdentity` migration was applied to the configured development database; a second `bun run db:migrate` made no changes. Integration tests confirm currency-mismatch rejections persist without changing the balance and prevent an unsafe migration rollback.

Verification: **119 tests / 404 assertions** across six files, including **47 PostgreSQL integration tests / 229 assertions**; `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run format:check` pass. The API contract is recorded in [OpenAPI](./docs/api/openapi.yaml).

Boundaries at Stage 3: the concurrency tests used one Nest application with concurrent HTTP requests against PostgreSQL; they did not prove operation across three independent application processes. Stage 4 has since added the asynchronous consumers and recovery workers.

### Stage 4 delivery — 2026-10-29

The `wager-consumer` role validates `WagerTransactionRequested` envelopes, persists the Inbox record and shared wager use case in one SQL transaction, extends SQS visibility during work, and deletes messages only after commit. Same-ID/different-payload deliveries are audited and routed to the DLQ. The Outbox publisher uses `SKIP LOCKED` claims and 60-second leases, retries with exponential backoff and jitter, and retains exhausted events for explicit `outbox:replay`. The reference reprocessor claims durable leases, follows the 1/2/4/8/16/32/60-second schedule, and processes or expires pending references atomically. Worker-only roles expose health endpoints without exposing wager HTTP routes; `WORKER_HEALTH_PORT` must be unique per process.

Stage 4 verification ran **136 tests / 461 assertions across seven files**: 135 passed and one POSIX-only shutdown-timeout test was skipped on Windows. The **14 Stage 4 integration cases** use PostgreSQL and LocalStack; 13 passed. Coverage includes three independent API/consumer/publisher processes; two publisher processes claiming disjoint batches; process death after Inbox commit/before ACK and Outbox publish/before confirmation; restart recovery without duplicate financial effects; five-receive source-to-DLQ redrive; readiness, Inbox conflicts, publication retry/replay, and pending-reference recovery/expiry. `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run format:check` pass. The validated `Stage4MessagingWorkers` migration was applied to the configured development database; a subsequent migration run was a no-op. No data was reset.

Boundary: the shutdown-timeout test holds a PostgreSQL transaction open and checks process termination/rollback, but was skipped on Windows because subprocess SIGTERM is not delivered as a catchable POSIX signal. Run it in POSIX CI before claiming that shutdown-timeout fault injection is verified. Authentication and exported metrics remain outside Stage 4.

### Stage 5 implementation — 2026-10-30

Added a Prometheus `/metrics` endpoint to API and worker roles. Per-process counters cover wager outcomes/replays/conflicts, Inbox duplicates, consumer/database/Outbox retries, application DLQ routing, PostgreSQL lock conflicts, wager latency, and reconciliation discrepancies. Scrapes refresh gauges for pending/leased Outbox count and oldest age plus the approximate configured SQS DLQ depth. Metrics are process-local; scrape every instance. The dependency is `@prometheus-io/client`.

Provider wager submit/read routes now depend on an explicit `ProviderIdentityPort`; the default `UnconfiguredProviderIdentityAdapter` preserves the challenge's unauthenticated choice. If an adapter returns an authenticated provider, access to a different `providerId` is rejected. No authentication is enabled until a real external IdP adapter is configured.

Integration coverage now starts two independent API processes with a `100.00 BRL` wallet. It first submits the same `1.00 BRL` bet through both processes, asserting one financial effect, then races two `80.00 BRL` bets. The first bet leaves `99.00 BRL`; the competing requests produce one accepted and one rejected result, leaving `19.00 BRL`, which matches the reconstructed ledger balance. Added Ubuntu CI to run lint, formatting, type-check, build and the complete PostgreSQL/LocalStack test suite. The POSIX SIGTERM timeout/fault-injection test passed in a Linux Bun 1.4.4 container.

Correlation IDs are accepted and validated from the optional `X-Correlation-Id` HTTP header; otherwise the API generates one and returns it on the response. SQS wager envelopes accept an optional UUID and generate one when absent. The same ID is retained on Outbox events and across pending-reference recovery, and is included in relevant structured logs and DLQ message attributes. Integration tests verify supplied and generated IDs end to end.

The read-only Reliability Reviewer identified two low-severity issues in retry metrics and test port allocation. Retry metrics now increment only after a lease-owned update succeeds; the multi-process test allocates its second port after the first API is listening. Both fixes were independently rechecked. Final Linux validation evidence and the agent-role record are in the [roadmap](./docs/plans/implementation-roadmap.md) and [agent-assisted workflow](./docs/plans/agent-assisted-development.md). The three workspace agents were visually confirmed in the VS Code picker and individually activated; authentication remains intentionally disabled.

Git attributes enforce LF for text files, including the Linux queue initialization script and Prettier-managed source files. During the earlier Stage 1 correction pass, normalization and a LocalStack restart produced `SUCCESSFUL` initialization, all three queues and healthy Compose services. That earlier pass did not repeat PostgreSQL connectivity or HTTP liveness; compiled API/database checks were subsequently exercised in Stage 2 and this revalidation.

Workspace agents are in `.github/agents/`: Domain Engineer, Test Engineer, and Reliability Reviewer. Their files and invocations were previously checked, but selection in the VS Code Chat picker requires a visual check with the Copilot harness selected. Agents are development tools, not runtime dependencies.

For Stage 2, one bounded implementation agent owned only database mappings, migration, configuration, and CLI. The orchestrator reviewed and tightened the schema, implemented application ports/repositories and HTTP wiring, authored the integration tests, and ran the validation above. No agent independently guaranteed financial correctness. AJV 8 is an explicit runtime dependency to satisfy the MikroORM migration toolchain's optional peer dependency under Bun hoisting; relying on ESLint's AJV 6 caused module resolution to fail.

## Challenge conformance pass — 2026-11-09

A line-by-line review against the challenge brief closed these gaps:

- **HTTP contract:** `POST /wallets` takes `initialBalance: { amount, currency }`; wallet, wager and reconciliation responses return `{ amount, currency }` objects (`balance`, `storedBalance`, `calculatedBalance`, `difference`) instead of bare decimal strings. `Money.toJSON()` now returns `MoneyProps` and `Money.from(props)` was added. Response snapshots persisted by earlier builds used `walletBalance`; they are not migrated, so replaying such a row returns a body without `balance`.
- **Integration events:** `IntegrationEvent<T>` is an abstract class with one concrete subclass per event (`WagerTransactionProcessed`, `WagerTransactionRejected`, `WalletBalanceChanged`, `WagerTransactionPendingReference`), each with a `from(...)` factory. Event `data` carries `MoneyProps`; `WalletBalanceChanged` now includes `direction`, `money`, `balanceBefore`, `balanceAfter` and `walletVersion`.
- **Messaging domain:** `InboxMessage` and `OutboxMessage` classes (`receive`/`enqueue`/`rehydrate`, `markProcessed`, `markPublished`, `scheduleRetry`, `isDue`) now own the Inbox replay/conflict decision and the Outbox backoff schedule instead of SQL strings in the workers. The publisher reads the database clock when scheduling retries.
- **Logging:** `JsonLogger` replaces the default Nest logger, so each log is exactly one JSON line and carries the ambient `correlationId` unless the event sets one.
- **Tests:** 159 passed, 1 skipped (the POSIX-only SIGTERM test, run by Ubuntu CI) and 0 failed across 11 files, using real PostgreSQL and LocalStack. New unit tests cover event serialization, `Money` wire format, Inbox/Outbox transitions and the logger.

Known limitation left as-is: a transient failure in the SQS consumer returns the message through the queue's fixed 60-second visibility timeout and the five-receive redrive, not an exponential delay. Changing the visibility per receive count would alter the redrive test's timing assumptions and was not attempted.
