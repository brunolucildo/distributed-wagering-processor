# 04 — Operations and Verification

**Status:** API/worker roles, readiness, Stage 4 messaging/recovery, and a three-process API/consumer/publisher workflow are implemented and covered by PostgreSQL/LocalStack tests. The shutdown-timeout fault-injection test is skipped on Windows and needs POSIX CI. Exported metrics, authenticated provider identity (or a code-level identity extension point), and cross-process wager/idempotency race tests remain open.

## 1. Runtime processes

The repository is one modular NestJS application with independently runnable roles from the same codebase:

- API process;
- SQS wager consumer;
- outbox publisher;
- pending-reference reprocessor.

Roles may share a worker process if each responsibility can be independently started, stopped, and observed. Docker Compose provisions PostgreSQL and LocalStack only; start application roles separately with Bun and `WORKER_ROLE`. The integration suite has exercised separate API, consumer, and publisher processes. No production credentials are committed.

## 2. Configuration

Configuration is environment-driven and validated at startup. At minimum define:

- `NODE_ENV`, `PORT`, `DATABASE_URL`;
- SQS endpoint, region, credentials for local use, and queue names;
- worker role and worker-health/API ports;
- bounded graceful-shutdown timeout;
- retry and lease policies defined in the messaging implementation.

The current environment schema does not expose a configurable receive batch size, log level, or metrics port. Do not document these as supported runtime settings until implemented.

Defaults must be safe for local development and must not silently mask missing required production configuration. Log redacted effective configuration at startup.

## 3. Health and observability

- `GET /health/live` reports process liveness without dependency checks.
- `GET /health/ready` checks PostgreSQL and all three configured SQS queues (`wager`, `DLQ`, and integration events), returning `503` if any dependency check fails.
- Worker and recovery paths emit structured JSON event logs with identifiers where available; correlation identifiers are not consistently propagated across all surfaces.
- Reconciliation discrepancies are logged and counted in a process-local counter. There is no exported metrics endpoint yet.
- Required exported metrics remain outstanding: transaction outcomes, replays/conflicts, consumer retries/DLQ, lock/deadlock retries, processing latency, outbox pending count/oldest age, and reconciliation mismatches.
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

Evidence currently covers the same-request and competing-bet HTTP races within one Nest process, plus independent API/consumer/publisher roles and two concurrent publisher processes. A race of duplicate/conflicting financial requests across distinct API/consumer processes is not yet demonstrated.

Tests that mock PostgreSQL/SQS may supplement, but must not replace, the integration and concurrency tests above.

## 5. Delivery and completion checks

- `bun run test:unit` runs the unit/foundation tests without external infrastructure. `bun run test:integration` runs PostgreSQL integration tests, including the HTTP wagering concurrency cases; `bun test` discovers all suites and requires PostgreSQL.
- Docker Compose starts the required local dependencies and application roles from a clean checkout.
- Database migrations apply cleanly to an empty database and pass down/up validation.
- `README.md` documents prerequisites, environment setup, Compose, queues, migrations, process startup, HTTP examples, and test commands.
- `ARCHITECTURE.md` matches implemented behavior and records deviations/trade-offs.
- No monetary calculation uses `number`; no ledger mutation path exists; no event is published before its originating commit.

## 6. Current verification boundary (2026-10-29)

The current full suite ran **136 tests / 461 assertions**: 135 passed and the POSIX-only shutdown-timeout test was skipped on Windows. The 14 Stage 4 PostgreSQL/LocalStack integration cases cover separate API/consumer/publisher processes, two publishers claiming disjoint batches, Inbox commit-before-ACK and Outbox publish-before-confirm crash/restart recovery, and five-receive source-to-DLQ redrive, in addition to the earlier readiness, inbox, retry, and pending-reference cases. Lint, type-check, build, and format checks pass with Node16 module resolution.

The integration harness provisions uniquely named temporary databases and queues; it does not reset the configured development database. The shutdown-timeout test injects a blocked database transaction and checks process exit/rollback, but requires POSIX SIGTERM semantics and was not executed on Windows. The Stage 3 HTTP race tests still use one Nest process; multi-process financial race behavior remains unverified even though the three-role workflow is verified.

Readiness is implemented for PostgreSQL and configured SQS queues. Reconciliation discrepancy monitoring is a structured log plus process-local counter, not an exported metric. The project does not yet expose the required metrics endpoint, nor does it wire an authenticated provider identity or a code-level identity extension point. The database finite-value checks and malformed-JSON error-envelope corrections remain covered by regression tests.

Docker Compose starts PostgreSQL and LocalStack, not application roles. Run the API/workers with the documented Bun entrypoint and unique `WORKER_HEALTH_PORT` values. Keep the challenge-level gaps above visible until tests or code close them.
