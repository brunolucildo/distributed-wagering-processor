# 04 — Operations and Verification

**Status:** Foundation, Stage 2 persistence, and Stage 3 single-process HTTP/PostgreSQL verification delivered. SQS workers/recovery, readiness, exported metrics, and multi-process hardening remain planned.

## 1. Runtime processes

The repository is one modular NestJS application with independently runnable roles from the same codebase:

- API process;
- SQS wager consumer;
- outbox publisher;
- pending-reference reprocessor.

Roles may share a worker process if each responsibility can be independently started, stopped, and observed. Docker Compose provisions PostgreSQL and LocalStack plus the selected application roles. No production credentials are committed.

## 2. Configuration

Configuration is environment-driven and validated at startup. At minimum define:

- `NODE_ENV`, `PORT`, `DATABASE_URL`;
- SQS endpoint, region, credentials for local use, and queue names;
- worker role/enabled flags;
- receive batch size and graceful-shutdown timeout;
- retry/lease settings from the messaging specification;
- log level and metrics port.

Defaults must be safe for local development and must not silently mask missing required production configuration. Log redacted effective configuration at startup.

## 3. Health and observability

- `GET /health/live` reports process liveness without dependency checks.
- `GET /health/ready` checks PostgreSQL and any SQS dependency required by that process. Return non-success when a required dependency prevents its role from operating.
- Emit structured JSON logs with correlation, message, transaction, wallet, and provider identifiers when available. Do not log full financial payloads, credentials, tokens, or secrets.
- Expose metrics for transaction outcomes, replays/conflicts, consumer retries/DLQ, lock/deadlock retries, processing latency, outbox pending count/oldest age, and reconciliation mismatches.
- Reconciliation must report, log, and metric discrepancies; never silently alter balances or ledger entries.

## 4. Test layers

### Unit

Pure tests for Money, wallet and transaction transitions, ledger equations, operation rules, reversals, canonical hashing, and event serialization.

### Integration

Use real PostgreSQL and LocalStack/SQS-compatible containers to test migrations, constraints, API contracts, Inbox/Outbox atomicity, retry/DLQ, reference recovery, reconciliation, and restart behavior.

### Concurrency and failure

Required end-to-end scenarios:

1. One wager delivered 50 times concurrently causes one financial effect.
2. Two `80.00 BRL` bets against `100.00 BRL` produce one success, one insufficient-funds rejection, a `20.00 BRL` balance, and one debit.
3. Distinct wallets make progress concurrently.
4. At least three application processes operate against shared dependencies.
5. A worker stops after commit but before ack; redelivery remains safe.
6. Two publishers compete for outbox records.
7. A refund/rollback arrives before its reference.
8. Service restart preserves final consistency.
9. Temporary PostgreSQL/SQS unavailability produces safe retry and recovery.
10. Every scenario verifies wallet balance against a ledger reconstruction.

Tests that mock PostgreSQL/SQS may supplement, but must not replace, the integration and concurrency tests above.

## 5. Delivery and completion checks

- `bun run test:unit` runs the unit/foundation tests without external infrastructure. `bun run test:integration` runs PostgreSQL integration tests, including the HTTP wagering concurrency cases; `bun test` discovers all suites and requires PostgreSQL.
- Docker Compose starts the required local dependencies and application roles from a clean checkout.
- Database migrations apply cleanly to an empty database and pass down/up validation.
- `README.md` documents prerequisites, environment setup, Compose, queues, migrations, process startup, HTTP examples, and test commands.
- `ARCHITECTURE.md` matches implemented behavior and records deviations/trade-offs.
- No monetary calculation uses `number`; no ledger mutation path exists; no event is published before its originating commit.

## 6. Current verification boundary (2026-10-29)

The complete Stage 0–3 suite passes 119 tests / 404 assertions, including 47 real PostgreSQL integration tests / 229 assertions; lint, type-check, build and formatting also pass with Node16 module resolution. Compose currently starts dependencies only; the API is started with Bun, and worker roles are not implemented. LocalStack provisioning and queue attributes are checked, but no automated SQS delivery/recovery suite exists yet. The wager concurrency cases use one Nest process and do not verify three independent application processes.

Reconciliation uses structured log content and a process-local discrepancy counter; neither a metrics endpoint nor full JSON logging/correlation is delivered. PostgreSQL connection refusal was probed through the real repository and mapped to a sanitized `503` by the wallet filter. Both audit gaps from specs 01–02 are now corrected: finite-value checks protect all persisted monetary columns, and the global HTTP filter sanitizes malformed JSON into the stable `400` envelope. Regression tests cover these exact behaviors as well as safe migration rollback and refusal of invalid legacy data.
