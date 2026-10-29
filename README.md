# Distributed Wagering Processor

A modular financial backend designed to preserve wallet and ledger correctness under duplicate requests, out-of-order delivery, concurrency, and retries.

> **Project status: Stage 2 implemented and validated.** The checkout contains the foundation, pure financial domain, PostgreSQL schema, atomic wallet creation, wallet/ledger queries, and read-only reconciliation. Transactional wagering processing, persistent replay handling, and messaging workers remain future work.

## Technology

| Area | Choice |
|---|---|
| Runtime and package manager | Bun 1.x |
| Language | Strict TypeScript |
| HTTP framework | NestJS |
| Database | PostgreSQL |
| ORM and migrations | MikroORM |
| Monetary arithmetic | Exact `bigint` minor units behind `Money`, with decimal-string input/output |
| Messaging | AWS SQS API via LocalStack |
| Local orchestration | Docker Compose |
| Tests | `bun test`; real PostgreSQL integration tests; wagering/messaging concurrency tests planned |

## Required financial and processing behavior

These requirements guide the implementation. Pure domain rules and wallet persistence are implemented; the end-to-end wagering and messaging guarantees below still depend on Stages 3–4:

- Monetary input/output uses decimal strings with exactly two fractional digits, never JavaScript `number` for monetary arithmetic.
- The initial operational currency is BRL; cross-currency operations are rejected.
- Wallets are unique by `(playerId, currency)`, start at version 1, and cannot have negative balances.
- Positive openings create an internal `OPENING` transaction and matching credit ledger entry atomically; zero openings create neither.
- `BET` debits, `WIN` credits, and `LOSS` records an outcome without changing balance. `REFUND` and `ROLLBACK` reverse eligible references according to the domain specification.
- Each balance change commits with its immutable ledger entry. Ledger update/delete is prohibited.
- Stage 3 will implement persistent idempotency and replay snapshots using the identity constraints created in Stage 2.
- Stage 3 will combine row-level wallet locks with database constraints for wagering concurrency across instances; FIFO and in-memory state are not correctness mechanisms.
- Stage 4 will implement persistent Inbox handling that acknowledges SQS only after commit, and transactional Outbox publication after commit.
- Stage 4 will implement durable missing-reference scheduling, retries, and auditable expiry.
- Reconciliation reports discrepancies without silently repairing balances.

## API surface

The four wallet routes and liveness are implemented. Wagering routes and readiness remain planned.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/wallets` | Create wallet and opening records |
| GET | `/wallets/:walletId` | Read balance and version |
| GET | `/wallets/:walletId/ledger` | Stable cursor pagination |
| GET | `/wagering/transactions/:transactionId` | Read by internal identity |
| GET | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Read by provider identity |
| POST | `/wagering/transactions` | Submit with `Idempotency-Key` |
| POST | `/wallets/:walletId/reconciliation` | Compare materialized and ledger balances |
| GET | `/health/live` | Implemented process liveness |
| GET | `/health/ready` | Planned dependency readiness |

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

Liveness returns `{"status":"ok"}` without checking dependencies. Wagering endpoints, readiness, and workers remain future stages.

### Database and wallet lifecycle

Run `bun run db:migrate` explicitly before starting the API. Startup connects to PostgreSQL but never changes the schema automatically. `bun run db:rollback` reverts the latest migration only when all five application tables are empty; it deliberately refuses to discard financial or reliability data. The same runner is available after build as `bun run dist/database/migrate.js up` (or `down`).

Persisted monetary amounts use `NUMERIC(38,2)`, support at most 36 integer digits, and remain decimal strings through MikroORM. The domain can calculate larger values, but persistence rejects overflow and excess scale without rounding. Wallet creation requires `playerId`, `currency` (uppercase ISO code), and `openingBalance` (decimal string).

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:3000/wallets -ContentType application/json -Body '{"playerId":"player-1","currency":"BRL","openingBalance":"100.00"}'
```

Use the returned wallet ID with `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger?limit=50&cursor=...`, and `POST /wallets/:walletId/reconciliation`. Ledger ordering is ascending `(created_at, id)`; cursors are opaque and wallet-scoped. The default page size is 50, capped at 100. Reconciliation returns `storedBalance`, `calculatedBalance`, `difference` (stored minus calculated), `consistent`, and `checkedEntries`, without repairing discrepancies. HTTP discrepancies are logged and counted in a process-local counter; metrics export remains Stage 5 work. Authentication remains unimplemented.

`bun run test:unit` does not require Docker. `bun test` and `bun run test:integration` require real PostgreSQL and a database user with `CREATEDB` (the Compose development user supports this). Tests create a uniquely named `stage2_test_*` database and drop only that database afterward. They never reset the development database. Optionally set `TEST_DATABASE_URL` to a separate PostgreSQL test server; the configured database is used only as the administrative connection for creating the temporary database.

## Development progress

| Stage | Status |
|---|---|
| 0: Foundation | Implemented; visual VS Code agent selection remains unverified |
| 1: Domain | Recovered from local stash and validated |
| 2: Persistence | Implemented and verified against real PostgreSQL |
| 3: API and idempotency | Not started |
| 4: Messaging and recovery | Not started |
| 5: Operations and handoff | Not started |

Stage 1 recovery restored `Money`, immutable wallet and ledger entities, wager lifecycle and operation/reference/reversal rules, domain errors, integration event envelopes, and two domain test files. The recovery preserved the current Stage 0 foundation and both existing stashes.

Stage 1 conformance verification passed 72 tests (175 assertions): 67 domain tests and five foundation tests. Regressions cover invalid internal openings, blank supplied references, and failure codes on non-failure states. Ledger reconstruction explicitly includes `OPENING` exactly once.

Stage 2 verification passed **92 tests across five files (268 assertions)**, including **20 real PostgreSQL integration tests**. Lint, type-check, build, and formatting passed. Integration coverage includes empty-schema migration up/down/up, populated-data rollback refusal, wallet creation races, exact maximum persisted money, overflow/excess-scale rejection, identity/reversal uniqueness, ledger foreign keys/equations/immutability (including `TRUNCATE`), atomic opening rollback, tied-timestamp pagination, page-size defaults/caps, and read-only reconciliation. An injected failure also verifies that a single MikroORM transaction rolls back wallet, transaction, ledger, Inbox, and Outbox writes together; this is infrastructure coverage, not an implemented wagering or SQS pipeline.

Both `bun run db:migrate` and the compiled migration runner were exercised; repeating `up` was a no-op. The compiled API connected to PostgreSQL, answered liveness, and returned the expected `404` on a missing-wallet query. The temporary smoke-test API was stopped afterward. PostgreSQL and LocalStack remain running. Wager-processing locks, retries, replay snapshots, and multi-process financial concurrency are Stage 3 work; Inbox/Outbox workers remain Stage 4 work.

Git attributes now enforce LF for text files, including the Linux queue initialization script and Prettier-managed source files. After normalization and a LocalStack restart, `/_localstack/init/ready` reported the script `SUCCESSFUL`, all three expected queues were listed, and both Compose services were healthy. Earlier PostgreSQL connectivity and HTTP liveness checks were not repeated in this conformance pass.

Workspace agents are in `.github/agents/`: Domain Engineer, Test Engineer, and Reliability Reviewer. Their files and invocations were previously checked, but selection in the VS Code Chat picker requires a visual check with the Copilot harness selected. Agents are development tools, not runtime dependencies.

For Stage 2, one bounded implementation agent owned only database mappings, migration, configuration, and CLI. The orchestrator reviewed and tightened the schema, implemented application ports/repositories and HTTP wiring, authored the integration tests, and ran the validation above. No agent independently guaranteed financial correctness. AJV 8 is an explicit runtime dependency to satisfy the MikroORM migration toolchain's optional peer dependency under Bun hoisting; relying on ESLint's AJV 6 caused module resolution to fail.

## Documentation

- [Architecture](./ARCHITECTURE.md)
- [Specifications index](./docs/README.md)
- [Domain and financial rules](./docs/specs/00-domain-and-financial-rules.md)
- [Persistence and concurrency](./docs/specs/01-persistence-and-concurrency.md)
- [API and idempotency](./docs/specs/02-api-and-idempotency.md)
- [Messaging and recovery](./docs/specs/03-messaging-and-recovery.md)
- [Operations and verification](./docs/specs/04-operations-and-verification.md)
- [Implementation roadmap](./docs/plans/implementation-roadmap.md)
- [Agent-assisted workflow](./docs/plans/agent-assisted-development.md)

The challenge brief is retained locally as `READMEChallenge.md` and excluded from Git. Required behavior remains represented in tracked documentation.

## Required final verification

1. Fifty concurrent deliveries produce one financial effect.
2. Two concurrent `80.00 BRL` bets against `100.00 BRL` produce one success, one insufficient-funds rejection, final balance `20.00 BRL`, and one debit.
3. At least three application processes operate against shared dependencies.
4. Crash after commit before acknowledgement is safe on redelivery.
5. Multiple publishers, pending-reference recovery, and restarts preserve financial correctness.
6. Wallet balances match ledger reconstruction.

Unit mocks do not replace PostgreSQL/SQS integration, concurrency, and failure tests. Update this README with actual commands, results, limitations, and next-stage status after every stage.
