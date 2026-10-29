# Distributed Wagering Processor

A financial backend for processing wagering transactions from multiple game providers. The system is designed to preserve wallet and ledger correctness when requests are duplicated, delivered out of order, processed concurrently, or retried after service failures.

> **Project status: Stage 0 in progress.** The Bun/NestJS foundation, validated configuration, liveness endpoint, development tooling, workspace agents, and local PostgreSQL/LocalStack definitions are being established. Business behavior is not implemented. Local container startup remains to be verified where Docker is available.

## Project goals

- Prevent duplicate credits and debits with persistent idempotency.
- Keep each wallet balance consistent with its immutable ledger.
- Prevent negative balances during concurrent processing across multiple application instances.
- Recover safely from duplicate/out-of-order SQS messages and process failures.
- Persist financial outcomes and event publication intent atomically.
- Make the design, trade-offs, run instructions, and verification results clear.

## Technology

| Area | Planned choice |
|---|---|
| Runtime and package manager | Bun 1.x |
| Language | TypeScript, strict mode |
| HTTP framework | NestJS |
| Database | PostgreSQL |
| ORM and migrations | MikroORM |
| Decimal arithmetic | `decimal.js`, behind the domain `Money` value object |
| Messaging | AWS SQS API via LocalStack |
| Local orchestration | Docker Compose |
| Tests | `bun test`, PostgreSQL and SQS-compatible containers for integration tests |

NestJS, TypeScript, Bun scripts, and startup configuration are being established in Stage 0. Persistence, messaging, and domain dependencies remain future-stage work.

## Financial and processing rules

- Monetary amounts are decimal strings with exactly two fractional digits. Monetary calculations must never use JavaScript `number`, `float`, or `double`.
- The initial operational currency is BRL; the domain validates currency consistently and rejects cross-currency operations.
- Wallets are unique by `(playerId, currency)`, start at version `1`, and cannot have a negative balance.
- A positive opening balance is recorded as an internal `OPENING` transaction and matching credit ledger entry. A zero opening balance creates neither.
- `BET` debits the wallet; `WIN` credits it; `LOSS` records an outcome without changing the balance; `REFUND` and `ROLLBACK` reverse eligible processed operations subject to the reference rules.
- A balance change and its ledger entry must commit together. Ledger entries are immutable and may not be updated or deleted.
- Idempotency is persisted in PostgreSQL. Replaying the same key and payload returns the original outcome; reusing a key with a different payload is a conflict.
- PostgreSQL row-level locking serializes balance-changing operations per wallet. Database constraints remain the final guard across instances; SQS FIFO and in-memory state are not correctness mechanisms.
- SQS handling uses a persistent Inbox and acknowledges only after commit. A transactional Outbox publishes events after commit and tolerates duplicate delivery.
- Missing references are stored durably and retried. Expired unresolved references become an auditable rejection.
- Reconciliation compares the materialized wallet balance with the ledger and reports discrepancies without silently repairing them.

## Planned API

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/wallets` | Create a wallet and record its opening balance, when positive |
| `GET` | `/wallets/:walletId` | Read wallet balance and version |
| `GET` | `/wallets/:walletId/ledger` | Read ledger entries using stable cursor pagination |
| `GET` | `/wagering/transactions/:transactionId` | Read a transaction by internal ID |
| `GET` | `/providers/:providerId/wagering/transactions/:externalTransactionId` | Read by provider transaction identity |
| `POST` | `/wagering/transactions` | Submit a wager with an `Idempotency-Key` header |
| `POST` | `/wallets/:walletId/reconciliation` | Compare stored and ledger-derived balances |
| `GET` | `/health/live` | Check process liveness |
| `GET` | `/health/ready` | Check dependencies required by the process |

Authentication is not a scored requirement of the challenge. If omitted, the decision and an explicit extension point will be documented; no custom password store or fake production security will be added. Health endpoints remain unauthenticated.

## Repository documentation

- [Architecture](./ARCHITECTURE.md) — proposed components, boundaries, and technical decisions.
- [Specifications and roadmap](./docs/README.md) — detailed requirements and staged delivery plan.
- [Domain and financial rules](./docs/specs/00-domain-and-financial-rules.md)
- [Persistence and concurrency](./docs/specs/01-persistence-and-concurrency.md)
- [API and idempotency](./docs/specs/02-api-and-idempotency.md)
- [Messaging and recovery](./docs/specs/03-messaging-and-recovery.md)
- [Operations and verification](./docs/specs/04-operations-and-verification.md)
- [Implementation roadmap](./docs/plans/implementation-roadmap.md)
- [Agent-assisted development workflow](./docs/plans/agent-assisted-development.md)

The challenge brief is retained locally as `READMEChallenge.md` and excluded from Git. The requirements needed to understand and run the project must remain documented in this tracked README and the linked documentation.

## AI-assisted development

Reusable VS Code workspace agents for bounded domain implementation, focused test authoring, and read-only reliability review are defined under `.github/agents/`. Orchestration begins with domain and test work in Stage 1 and continues selectively where tasks can be separated safely. The orchestrator remains responsible for integration, design decisions, and running verification. These agents are development tooling only and are not part of the application runtime. See the [agent-assisted workflow](./docs/plans/agent-assisted-development.md).

## Development progress

| Stage | Scope | Status |
|---|---|---|
| 0 | Project foundation and local development baseline | In progress |
| 1 | Domain model and unit tests | Not started |
| 2 | PostgreSQL persistence, migrations, wallets, and ledger | Not started |
| 3 | Wager processing, HTTP API, and idempotency | Not started |
| 4 | SQS, Inbox/Outbox, and recovery workers | Not started |
| 5 | Operations, end-to-end verification, and handoff | Not started |

At the end of **each stage**, update this README with the delivered behavior, actual setup/run/test commands, verification results, known limitations, and the next stage's status. Do not mark planned behavior as complete until it has working code and passing relevant tests.

## Local setup and commands

### Prerequisites

- Bun 1.x
- Docker with Docker Compose

### Start the local baseline

From the repository root, copy the local-only environment example, install the locked dependencies, start PostgreSQL and LocalStack, then run the API:

```powershell
Copy-Item .env.example .env
bun install --frozen-lockfile
docker compose up -d
bun run start:dev
```

The Compose stack provisions `wager-transactions.fifo`, `wager-transactions-dlq.fifo`, and `integration-events.fifo` in LocalStack. The wager queue has a 60-second visibility timeout and routes messages to the DLQ after five receives. The sample AWS credentials and database password are for local development only; do not use them in production.

Check process liveness at `http://localhost:3000/health/live`; the expected response is `{"status":"ok"}`. This endpoint checks only that the HTTP process is alive. Database/SQS readiness checks, migrations, and application workers are not implemented yet.

### Verification commands

```powershell
bun test
bun run lint
bun run typecheck
bun run format:check
bun run build
```

### Current Stage 0 verification

- `bun run typecheck`, `bun run build`, and `bun run format:check`: pass.
- `bun test`: 5 tests pass; `bun run lint`: pass after a temporary npm install populated the local dependency tree.
- `bun install --frozen-lockfile`: exits successfully, but a clean isolated Bun install left transitive modules such as `@eslint-community/eslint-utils` unavailable. The npm install was only used to validate the code and is not the documented setup path.
- `docker compose config --quiet`: pass. PostgreSQL and LocalStack started and reached healthy status; `pg_isready` succeeded, and LocalStack listed all three expected queues.
- `docker compose logs localstack`: confirmed the queue initialization script ran successfully after normalizing its line endings for the Linux container.
- `bun run start:dev` started the API, and `curl.exe --fail http://localhost:3000/health/live` returned `{"status":"ok"}`.

Stage 0 remains in progress until clean Bun installation and VS Code agent selection are verified.

## Verification requirements

The implementation must include unit tests, PostgreSQL and SQS-compatible integration tests, and real concurrency tests. Required scenarios include:

1. Fifty concurrent deliveries of one wager produce one financial effect.
2. Two concurrent `80.00 BRL` bets against a `100.00 BRL` balance produce one processed bet, one insufficient-funds rejection, a `20.00 BRL` final balance, and one debit ledger entry.
3. At least three application instances operate against shared dependencies.
4. A worker crash after database commit but before SQS acknowledgement remains safe on redelivery.
5. Multiple Outbox publishers, pending-reference recovery, and process restarts do not lose or duplicate financial effects.
6. Wallet balances match balances reconstructed from ledger entries.

No test or command is reported as passing until it has actually been run.
