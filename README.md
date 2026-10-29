# Distributed Wagering Processor

A modular financial backend designed to preserve wallet and ledger correctness under duplicate requests, out-of-order delivery, concurrency, and retries.

> **Project status: Stage 4 worker flows verified with PostgreSQL and LocalStack.** Tests cover three independent API/consumer/publisher processes, two publisher processes, crash/restart boundaries, and source-to-DLQ redrive. Shutdown-timeout fault injection remains to be run on POSIX.

## Technology

| Area                        | Choice                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------ |
| Runtime and package manager | Bun 1.x                                                                                    |
| Language                    | Strict TypeScript; Node16 module/resolution mode (current output remains CommonJS)         |
| HTTP framework              | NestJS                                                                                     |
| Database                    | PostgreSQL                                                                                 |
| ORM and migrations          | MikroORM                                                                                   |
| Monetary arithmetic         | Exact `bigint` minor units behind `Money`, with decimal-string input/output                |
| Messaging                   | AWS SQS API via LocalStack                                                                 |
| Local orchestration         | Docker Compose                                                                             |
| Tests                       | `bun test`; real PostgreSQL integration tests, including wager concurrency and idempotency |

## Required financial and processing behavior

These requirements guide the implementation. Domain rules, wallet persistence, HTTP and SQS wager processing, durable retries, recovery workers, and the three-process workflow are verified. Cross-process hot-wallet/idempotency races and POSIX shutdown-timeout fault injection remain open:

- Monetary input/output uses decimal strings with exactly two fractional digits, never JavaScript `number` for monetary arithmetic.
- The initial operational currency is BRL; cross-currency operations are rejected.
- Wallets are unique by `(playerId, currency)`, start at version 1, and cannot have negative balances.
- Positive openings create an internal `OPENING` transaction and matching credit ledger entry atomically; zero openings create neither.
- `BET` debits, `WIN` credits, and `LOSS` records an outcome without changing balance. `REFUND` and `ROLLBACK` reverse eligible references according to the domain specification.
- Each balance change commits with its immutable ledger entry. Ledger update/delete is prohibited.
- Stage 3 implements persistent idempotency and replay snapshots using PostgreSQL identity constraints and advisory locks.
- Stage 3 combines ordered transaction-identity locks, a row-level wallet lock, and database constraints for concurrent wager requests. The HTTP race cases run in one API process; concurrent same-wallet/idempotency races across API and SQS worker processes remain unverified. Stage 4 separately verifies the three-role process workflow and its crash-recovery paths.
- Stage 4 consumes FIFO wager messages through a transactional Inbox and acknowledges only after a durable result or DLQ delivery.
- Stage 4 publishes committed Outbox events using recoverable leases, retries, and explicit replay of exhausted events.
- Stage 4 reprocesses and expires missing references using durable scheduling and leases.
- Reconciliation reports discrepancies without silently repairing balances.

## API surface

Wallet and wagering routes, liveness, and dependency readiness are implemented.

| Method | Endpoint                                                              | Purpose                                                                            |
| ------ | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| POST   | `/wallets`                                                            | Implemented: create wallet and opening records                                     |
| GET    | `/wallets/:walletId`                                                  | Implemented: read balance and version                                              |
| GET    | `/wallets/:walletId/ledger`                                           | Implemented: stable cursor pagination                                              |
| GET    | `/wagering/transactions/:transactionId`                               | Implemented: read durable state by internal identity                               |
| GET    | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Implemented: read by provider identity                                             |
| POST   | `/wagering/transactions`                                              | Implemented: submit with `Idempotency-Key`, replay, conflict, and durable outcomes |
| POST   | `/wallets/:walletId/reconciliation`                                   | Implemented: compare materialized and ledger balances                              |
| GET    | `/health/live`                                                        | Implemented process liveness                                                       |
| GET    | `/health/ready`                                                       | Implemented PostgreSQL and SQS dependency readiness                                |

Authentication is not a scored challenge requirement. If added, use an external identity provider rather than a custom password store. Health endpoints remain unauthenticated.

## Local setup

Prerequisites: Bun 1.x and Docker Desktop with Docker Compose.

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
docker compose up -d
bun run db:migrate
bun run start:dev
```

Do not overwrite an existing `.env` without preserving its configuration. Sample database/AWS credentials are local-only.

If dependency files are missing after a successful Bun install, the fresh-cache workaround verified with Bun 1.4.4 is:

```powershell
bun install --force --frozen-lockfile --cache-dir "$env:LOCALAPPDATA\Bun\stage0-clean-cache" --backend=copyfile
```

LocalStack provisions `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, and `integration-events.fifo`. The source queue uses a 60-second visibility timeout and a five-receive redrive limit.

```powershell
curl.exe --fail http://localhost:3000/health/live
docker compose ps
docker compose logs localstack
bun test
bun run test:unit
bun run test:integration
bun run lint
bun run typecheck
bun run build
bun run format:check
```

Liveness returns `{"status":"ok"}` without checking dependencies. Readiness returns `200` only when PostgreSQL and all configured SQS queues are reachable; otherwise it returns `503`. The default role is `api`. Set `WORKER_ROLE` to `wager-consumer`, `outbox-publisher`, `reference-reprocessor`, or `all` to run a worker process (the `all` role also serves HTTP). A worker stops receiving work on `SIGTERM`/`SIGINT`, finishes the current batch within `WORKER_SHUTDOWN_TIMEOUT_MS`, and leaves unfinished messages recoverable through visibility timeouts or leases.

Worker-only roles expose health endpoints without exposing the wagering API. Give each worker a distinct `WORKER_HEALTH_PORT` when running several processes:

```powershell
$env:WORKER_ROLE = "wager-consumer"; $env:WORKER_HEALTH_PORT = "3001"; bun run start:dev
$env:WORKER_ROLE = "outbox-publisher"; $env:WORKER_HEALTH_PORT = "3002"; bun run start:dev
$env:WORKER_ROLE = "reference-reprocessor"; $env:WORKER_HEALTH_PORT = "3003"; bun run start:dev
```

Wager queue messages use the `WagerTransactionRequested` envelope: `messageId`, `type`, `version: 1`, ISO `occurredAt`, and a `data` object containing the HTTP wager fields plus `idempotencyKey`. `OPENING` is rejected. FIFO group ID is `walletId`; PostgreSQL Inbox/idempotency are the correctness boundary.

Exhausted Outbox events remain `FAILED`. After reviewing the event, requeue one explicitly with `$env:OUTBOX_EVENT_ID = "<event-uuid>"; bun run outbox:replay`; this resets its retry counter and makes it eligible for publication.

### Database and wallet lifecycle

Run `bun run db:migrate` explicitly before starting the API. Startup connects to PostgreSQL but never changes the schema automatically. `bun run db:rollback` reverts the latest migration: the Stage 4 migration refuses to discard Inbox conflict-audit records; the initial schema can only be removed when all five base application tables are empty; the corrective finite-money migration removes only its constraints and preserves rows. Rolling back that correction removes its protection, so reapply it before resuming application writes. The same runner is available after build as `bun run dist\database\migrate.js up` (or `down`).

Persisted monetary amounts use `NUMERIC(38,2)`, support at most 36 integer digits, and remain decimal strings through MikroORM. The domain can calculate larger values, but API/ORM inputs reject overflow and excess scale without rounding. Arbitrary SQL still uses PostgreSQL's native scale rounding on assignment; non-finite values are blocked at the database boundary. Wallet creation requires `playerId`, `currency` (uppercase ISO code), and `openingBalance` (decimal string); successful creation returns `201` with `{ id, playerId, currency, balance, version }`.

The new `RejectNonFiniteMoney` migration validates existing monetary values as well as future writes. If legacy `NaN` data exists, migration fails explicitly without rewriting balances or the immutable ledger; investigate and use a reviewed financial recovery procedure rather than silently deleting or editing audit records.

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType application/json -Body '{"playerId":"player-1","currency":"BRL","openingBalance":"100.00"}'
```

Use the returned wallet ID with `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?limit=50&cursor=...`, and `POST /wallets/:walletId/reconciliation`. Ledger ordering is ascending `(created_at, id)`; cursors are opaque and wallet-scoped. The default page size is 50, capped at 100. Reconciliation returns `storedBalance`, `calculatedBalance`, `difference` (stored minus calculated), `consistent`, and `checkedEntries`, without repairing discrepancies. HTTP discrepancies are logged and counted in a process-local counter; metrics export remains Stage 5 work. Authentication remains unimplemented.

`bun run test:unit` does not require Docker. `bun test` and `bun run test:integration` require PostgreSQL, LocalStack, and a database user with `CREATEDB` (the Compose development user supports this). Tests create a uniquely named `stage2_test_*` database and temporary FIFO queues, then drop only those resources afterward. They never reset the development database. Optionally set `TEST_DATABASE_URL` to a separate PostgreSQL test server; the configured database is used only as the administrative connection for creating the temporary database.

## Development progress

| Stage                     | Status                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------- |
| 0: Foundation             | Implemented; visual VS Code agent selection remains unverified                          |
| 1: Domain                 | Recovered from local stash and validated                                                |
| 2: Persistence            | Delivered; finite-value and error-envelope corrections verified                         |
| 3: API and idempotency    | Delivered and verified                                                                  |
| 4: Messaging and recovery | Multi-process, crash/restart, and redrive verified; POSIX shutdown-timeout test remains |
| 5: Operations and handoff | Not started                                                                             |

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

Authentication and an authenticated provider identity-extension point, exported metrics, and application containers remain outstanding delivery work; they are not current guarantees. No clean dependency reinstall or visual VS Code agent-picker check was performed during this correction.

Git attributes enforce LF for text files, including the Linux queue initialization script and Prettier-managed source files. During the earlier Stage 1 correction pass, normalization and a LocalStack restart produced `SUCCESSFUL` initialization, all three queues and healthy Compose services. That earlier pass did not repeat PostgreSQL connectivity or HTTP liveness; compiled API/database checks were subsequently exercised in Stage 2 and this revalidation.

Workspace agents are in `.github/agents/`: Domain Engineer, Test Engineer, and Reliability Reviewer. Their files and invocations were previously checked, but selection in the VS Code Chat picker requires a visual check with the Copilot harness selected. Agents are development tools, not runtime dependencies.

For Stage 2, one bounded implementation agent owned only database mappings, migration, configuration, and CLI. The orchestrator reviewed and tightened the schema, implemented application ports/repositories and HTTP wiring, authored the integration tests, and ran the validation above. No agent independently guaranteed financial correctness. AJV 8 is an explicit runtime dependency to satisfy the MikroORM migration toolchain's optional peer dependency under Bun hoisting; relying on ESLint's AJV 6 caused module resolution to fail.

## Documentation

- [Architecture](./ARCHITECTURE.md)
- [Specifications index](./docs/README.md)
- [Domain and financial rules](./docs/specs/00-domain-and-financial-rules.md)
- [Persistence and concurrency](./docs/specs/01-persistence-and-concurrency.md)
- [API and idempotency](./docs/specs/02-api-and-idempotency.md)
- [OpenAPI contract](./docs/api/openapi.yaml)
- [Messaging and recovery](./docs/specs/03-messaging-and-recovery.md)
- [Operations and verification](./docs/specs/04-operations-and-verification.md)
- [Implementation roadmap](./docs/plans/implementation-roadmap.md)
- [Agent-assisted workflow](./docs/plans/agent-assisted-development.md)

The challenge brief is retained locally as `READMEChallenge.md` and excluded from Git. Required behavior remains represented in tracked documentation.

## Required final verification

1. **Verified in Stage 3:** Fifty identical concurrent HTTP submissions produce one financial effect.
2. **Verified in Stage 3:** Two concurrent `80.00 BRL` bets against `100.00 BRL` produce one success, one insufficient-funds rejection, final balance `20.00 BRL`, and one debit.
3. **Verified:** API, wager consumer, and Outbox publisher run as three independent processes against shared PostgreSQL/LocalStack dependencies; two publisher processes claim disjoint batches.
4. **Verified:** process death after Inbox commit/before SQS acknowledgement followed by redelivery preserves one financial effect.
5. **Verified:** process death after SQS accepts an Outbox event/before database confirmation is recovered after lease expiry; the event is safely republished and marked published. Five-receive redrive reaches the configured DLQ.
6. **Pending POSIX CI:** shutdown timeout during an injected in-flight PostgreSQL transaction; this subprocess SIGTERM test is skipped on Windows.
7. **Verified for wallet lifecycle:** Wallet reconciliation compares balances with ledger reconstruction without repair.

Unit mocks do not replace PostgreSQL/SQS integration, concurrency, and failure tests. Update this README with actual commands, results, limitations, and next-stage status after every stage.
