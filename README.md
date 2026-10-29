# Distributed Wagering Processor

A modular financial backend designed to preserve wallet and ledger correctness under duplicate requests, out-of-order delivery, concurrency, and retries.

> **Project status: Stage 1 domain recovered and validated.** The checkout contains the Stage 0 foundation and the pure financial domain recovered selectively from a local stash. Persistence, message processing, and wagering HTTP endpoints remain future work.

## Technology

| Area | Choice |
|---|---|
| Runtime and package manager | Bun 1.x |
| Language | Strict TypeScript |
| HTTP framework | NestJS |
| Database | PostgreSQL |
| ORM and migrations (planned) | MikroORM |
| Monetary arithmetic | Exact `bigint` minor units behind `Money`, with decimal-string input/output |
| Messaging | AWS SQS API via LocalStack |
| Local orchestration | Docker Compose |
| Tests | `bun test`; real-container integration and concurrency tests planned |

## Required financial and processing behavior

These requirements guide the implementation. Pure domain rules are implemented; database, HTTP, and messaging guarantees are not yet implemented:

- Monetary input/output uses decimal strings with exactly two fractional digits, never JavaScript `number` for monetary arithmetic.
- The initial operational currency is BRL; cross-currency operations are rejected.
- Wallets are unique by `(playerId, currency)`, start at version 1, and cannot have negative balances.
- Positive openings create an internal `OPENING` transaction and matching credit ledger entry atomically; zero openings create neither.
- `BET` debits, `WIN` credits, and `LOSS` records an outcome without changing balance. `REFUND` and `ROLLBACK` reverse eligible references according to the domain specification.
- Each balance change commits with its immutable ledger entry. Ledger update/delete is prohibited.
- PostgreSQL persists idempotency. Replays return the original outcome; conflicting payloads or identities are rejected.
- Row-level wallet locks and database constraints protect concurrency across instances; FIFO and in-memory state are not correctness mechanisms.
- Persistent Inbox handling acknowledges SQS only after commit. Transactional Outbox publication happens after commit and tolerates duplicates.
- Missing references are stored durably, retried, and rejected audibly when expired.
- Reconciliation reports discrepancies without silently repairing balances.

## Planned API

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
bun run lint
bun run typecheck
bun run build
bun run format:check
```

Liveness returns `{"status":"ok"}` without checking dependencies. Persistence, migrations, wagering endpoints, readiness, and workers are not implemented.

## Development progress

| Stage | Status |
|---|---|
| 0: Foundation | Implemented; visual VS Code agent selection remains unverified |
| 1: Domain | Recovered from local stash and validated |
| 2: Persistence | Not started |
| 3: API and idempotency | Not started |
| 4: Messaging and recovery | Not started |
| 5: Operations and handoff | Not started |

Stage 1 recovery restored `Money`, immutable wallet and ledger entities, wager lifecycle and operation/reference/reversal rules, domain errors, integration event envelopes, and two domain test files. The recovery preserved the current Stage 0 foundation and both existing stashes.

Verification after recovery: `bun test` passed 62 tests across four files (162 assertions); `bun run lint`, `bun run typecheck`, `bun run build`, and `bun run format:check` passed. Of these, 57 tests cover the domain and five cover the foundation. The missing reversal-uniqueness-check guard and its regression test were recovered as well. Database-level atomic uniqueness and concurrency remain Stage 2 work.

Earlier Stage 0 verification also exercised container health, PostgreSQL connectivity, queue provisioning, and HTTP liveness; those infrastructure checks were not repeated as part of stash recovery.

Workspace agents are in `.github/agents/`: Domain Engineer, Test Engineer, and Reliability Reviewer. Their files and invocations were previously checked, but selection in the VS Code Chat picker requires a visual check with the Copilot harness selected. Agents are development tools, not runtime dependencies.

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
