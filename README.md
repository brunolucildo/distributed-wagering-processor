# Distributed Wagering Processor

A modular financial backend designed to preserve wallet and ledger correctness under duplicate requests, out-of-order delivery, concurrency, and retries.

> **Project status: Stage 5 implementation complete.** Prometheus metrics, a provider-identity extension point, cross-process financial-race tests, POSIX shutdown-timeout verification, and correlation propagation across HTTP, SQS, Outbox, and recovery are implemented. Workspace agents were visually confirmed as selectable in VS Code.

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
| Observability               | One-line JSON logs with correlation IDs; Prometheus text exposition per API/worker process |
| Local orchestration         | Docker Compose                                                                             |
| Tests                       | `bun test`; real PostgreSQL integration tests, including wager concurrency and idempotency |

## Required financial and processing behavior

These requirements guide the implementation. Domain rules, wallet persistence, HTTP and SQS wager processing, durable retries, recovery workers, and multi-process financial races are verified:

- Monetary input/output uses decimal strings with exactly two fractional digits, never JavaScript `number` for monetary arithmetic.
- The initial operational currency is BRL; cross-currency operations are rejected.
- Wallets are unique by `(playerId, currency)`, start at version 1, and cannot have negative balances.
- Positive openings create an internal `OPENING` transaction and matching credit ledger entry atomically; zero openings create neither.
- `BET` debits, `WIN` credits, and `LOSS` records an outcome without changing balance. `REFUND` and `ROLLBACK` reverse eligible references according to the domain specification.
- Each balance change commits with its immutable ledger entry. Ledger update/delete is prohibited.
- Stage 3 implements persistent idempotency and replay snapshots using PostgreSQL identity constraints and advisory locks.
- Stage 3 combines ordered transaction-identity locks, a row-level wallet lock, and database constraints for concurrent wager requests. Stage 5 verifies duplicate idempotency and competing same-wallet requests against two independently running API processes.
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
| GET    | `/metrics`                                                            | Implemented Prometheus text metrics for this process and dependency gauges         |

Authentication is not a scored challenge requirement. `ProviderIdentityPort` is wired into provider wager routes, but the default adapter intentionally does not authenticate. Integrate an external identity provider before exposing those routes to untrusted providers; do not treat `providerId` as authenticated identity. Health and metrics endpoints remain unauthenticated.

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
curl.exe --fail http://localhost:3000/metrics
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

Every process writes one JSON object per line to stdout/stderr (`timestamp`, `level`, `context`, `correlationId`, plus event fields such as `messageId`, `transactionId`, `walletId` and `providerId`); payload amounts are never logged. Liveness returns `{"status":"ok"}` without checking dependencies. Readiness returns `200` only when PostgreSQL and all configured SQS queues are reachable; otherwise it returns `503`. The default role is `api`. Set `WORKER_ROLE` to `wager-consumer`, `outbox-publisher`, `reference-reprocessor`, or `all` to run a worker process (the `all` role also serves HTTP). A worker stops receiving work on `SIGTERM`/`SIGINT`, finishes the current batch within `WORKER_SHUTDOWN_TIMEOUT_MS`, and leaves unfinished messages recoverable through visibility timeouts or leases.

Worker-only roles expose health endpoints without exposing the wagering API. Give each worker a distinct `WORKER_HEALTH_PORT` when running several processes:

```powershell
$env:WORKER_ROLE = "wager-consumer"; $env:WORKER_HEALTH_PORT = "3001"; bun run start:dev
$env:WORKER_ROLE = "outbox-publisher"; $env:WORKER_HEALTH_PORT = "3002"; bun run start:dev
$env:WORKER_ROLE = "reference-reprocessor"; $env:WORKER_HEALTH_PORT = "3003"; bun run start:dev
```

Wager queue messages use the `WagerTransactionRequested` envelope: `messageId`, optional UUID `correlationId`, `type`, `version: 1`, ISO `occurredAt`, and a `data` object containing the HTTP wager fields plus `idempotencyKey`. The consumer generates a correlation ID when absent; `OPENING` is rejected. FIFO group ID is `walletId`; PostgreSQL Inbox/idempotency are the correctness boundary.

Exhausted Outbox events remain `FAILED`. After reviewing the event, requeue one explicitly with `$env:OUTBOX_EVENT_ID = "<event-uuid>"; bun run outbox:replay`; this resets its retry counter and makes it eligible for publication.

### Database and wallet lifecycle

Run `bun run db:migrate` explicitly before starting the API. Startup connects to PostgreSQL but never changes the schema automatically. `bun run db:rollback` reverts the latest migration: the Stage 4 migration refuses to discard Inbox conflict-audit records; the initial schema can only be removed when all five base application tables are empty; the corrective finite-money migration removes only its constraints and preserves rows. Rolling back that correction removes its protection, so reapply it before resuming application writes. The same runner is available after build as `bun run dist\database\migrate.js up` (or `down`).

Persisted monetary amounts use `NUMERIC(38,2)`, support at most 36 integer digits, and remain decimal strings through MikroORM. The domain can calculate larger values, but API/ORM inputs reject overflow and excess scale without rounding. Arbitrary SQL still uses PostgreSQL's native scale rounding on assignment; non-finite values are blocked at the database boundary. Wallet creation requires `playerId` and `initialBalance` (`{ "amount": "100.00", "currency": "BRL" }`, uppercase ISO currency, decimal-string amount); successful creation returns `201` with `{ id, playerId, balance: { amount, currency }, version }`. Wager submissions return `{ transactionId, status, failureCode?, balance: { amount, currency }, idempotentReplay }`, and reconciliation returns `storedBalance`, `calculatedBalance` and `difference` as the same `{ amount, currency }` objects.

The new `RejectNonFiniteMoney` migration validates existing monetary values as well as future writes. If legacy `NaN` data exists, migration fails explicitly without rewriting balances or the immutable ledger; investigate and use a reviewed financial recovery procedure rather than silently deleting or editing audit records.

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType application/json -Body '{"playerId":"player-1","initialBalance":{"amount":"100.00","currency":"BRL"}}'
```

Use the returned wallet ID with `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?limit=50&cursor=...`, and `POST /wallets/:walletId/reconciliation`. Ledger ordering is ascending `(created_at, id)`; cursors are opaque and wallet-scoped. The default page size is 50, capped at 100. Reconciliation reports `difference` (stored minus calculated), `consistent`, and `checkedEntries` without repairing discrepancies. Reconciliation discrepancies and processing outcomes are exported as Prometheus metrics. Scrape `/metrics` on each API/worker process to collect its local counters; the endpoint refreshes the outbox backlog and SQS DLQ depth gauges. Authentication remains disabled; the default provider identity adapter is an explicit extension point, not security.

`bun run test:unit` does not require Docker. `bun test` and `bun run test:integration` require PostgreSQL, LocalStack, and a database user with `CREATEDB` (the Compose development user supports this). Tests create a uniquely named `stage2_test_*` database and temporary FIFO queues, then drop only those resources afterward. They never reset the development database. Optionally set `TEST_DATABASE_URL` to a separate PostgreSQL test server; the configured database is used only as the administrative connection for creating the temporary database.

## Development progress

| Stage                     | Status                                                                     |
| ------------------------- | -------------------------------------------------------------------------- |
| 0: Foundation             | Implemented; workspace agents visually confirmed in the VS Code picker     |
| 1: Domain                 | Recovered from local stash and validated                                   |
| 2: Persistence            | Delivered; finite-value and error-envelope corrections verified            |
| 3: API and idempotency    | Delivered and verified                                                     |
| 4: Messaging and recovery | Multi-process, crash/restart, redrive, and POSIX shutdown-timeout verified |
| 5: Operations and handoff | Delivered and verified                                                     |

The per-stage delivery log, verification evidence, audits and agent-role records are in [delivery history](./docs/plans/delivery-history.md).

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
- [Delivery history](./docs/plans/delivery-history.md)

The challenge brief is retained locally as `READMEChallenge.md` and excluded from Git. Required behavior remains represented in tracked documentation.

## Required final verification

1. **Verified in Stage 3:** Fifty identical concurrent HTTP submissions produce one financial effect.
2. **Verified in Stage 3:** Two concurrent `80.00 BRL` bets against `100.00 BRL` produce one success, one insufficient-funds rejection, final balance `20.00 BRL`, and one debit.
3. **Verified:** API, wager consumer, and Outbox publisher run as three independent processes against shared PostgreSQL/LocalStack dependencies; two publisher processes claim disjoint batches.
4. **Verified:** process death after Inbox commit/before SQS acknowledgement followed by redelivery preserves one financial effect.
5. **Verified:** process death after SQS accepts an Outbox event/before database confirmation is recovered after lease expiry; the event is safely republished and marked published. Five-receive redrive reaches the configured DLQ.
6. **Verified on POSIX:** shutdown timeout during an injected in-flight PostgreSQL transaction exits with code 1 and rolls back the transaction.
7. **Verified for wallet lifecycle:** Wallet reconciliation compares balances with ledger reconstruction without repair.
8. **Verified in Stage 5:** two independent API processes process a duplicated `1.00 BRL` bet once, then serialize two competing `80.00 BRL` bets against the remaining `99.00 BRL`; one succeeds, one is rejected, and the final `19.00 BRL` balance equals the reconstructed ledger balance. The Stage 3 race in item 2 is a separate test starting at `100.00 BRL`, with no preceding bet, so its final balance is `20.00 BRL`.

Unit mocks do not replace PostgreSQL/SQS integration, concurrency, and failure tests. Update this README with actual commands, results, limitations, and next-stage status after every stage.
