# 04 — Operations and Verification

**Status:** API/worker roles, readiness, Stage 4 messaging/recovery, Prometheus metrics, a provider-identity extension point, cross-process wager/idempotency races, POSIX shutdown-timeout fault injection, and correlation propagation are implemented. The read-only reliability review is complete and its findings were corrected. Authentication is intentionally not enabled. The visual VS Code agent-picker confirmation from Stage 0 remains unverified.

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
- `GET /metrics` returns Prometheus text exposition for the current process. Scrape every API/worker instance; counters are not shared across processes.
- HTTP requests accept an optional UUID `X-Correlation-Id`; absent or invalid values are replaced with a generated UUID and returned in the response header. SQS wager envelopes accept optional `correlationId`, generating one when absent. IDs flow to Outbox events, pending-reference retries, structured logs, and DLQ message attributes.
- Metrics include transaction outcomes, replays/conflicts, Inbox duplicates, consumer/database/Outbox retries, app-routed dead letters and approximate SQS DLQ depth, PostgreSQL lock conflicts, processing latency, outbox pending count/oldest age, and reconciliation mismatches.
- Scrapes refresh the Outbox and SQS gauges from their dependencies; a failed database or SQS query returns an error instead of presenting a success-shaped stale response.
- Reconciliation must report, log, and metric discrepancies; never silently alter balances or ledger entries.
- Provider wager routes use `ProviderIdentityPort`; the default adapter is explicitly unauthenticated. A production IdP integration remains out of scope.

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

Evidence covers same-request and competing-bet HTTP races within one Nest process, plus duplicate-idempotency and competing hot-wallet requests across two independent API processes. Three independent API/consumer/publisher roles and two concurrent publisher processes are also verified.

Tests that mock PostgreSQL/SQS may supplement, but must not replace, the integration and concurrency tests above.

## 5. Delivery and completion checks

- `bun run test:unit` runs the unit/foundation tests without external infrastructure. `bun run test:integration` runs PostgreSQL integration tests, including the HTTP wagering concurrency cases; `bun test` discovers all suites and requires PostgreSQL.
- Docker Compose starts PostgreSQL and LocalStack; start application roles separately with the documented Bun entrypoint.
- Ubuntu CI runs lint, formatting, type-check, build, and the full PostgreSQL/LocalStack test suite, including POSIX-only shutdown fault injection.
- Database migrations apply cleanly to an empty database and pass down/up validation.
- `README.md` documents prerequisites, environment setup, Compose, queues, migrations, process startup, HTTP examples, and test commands.
- `ARCHITECTURE.md` matches implemented behavior and records deviations/trade-offs.
- No monetary calculation uses `number`; no ledger mutation path exists; no event is published before its originating commit.

## 6. Current verification boundary (2026-10-30)

The full suite ran **144 tests / 516 assertions** in a Linux Bun 1.4.4 container: all passed, including the POSIX shutdown-timeout fault-injection test. Lint, source/test and documentation formatting, type-check, and build also passed. Ubuntu CI is configured to repeat the complete gates.

The integration harness provisions uniquely named temporary databases and queues; it does not reset the configured development database. The shutdown-timeout test injects a blocked database transaction and verifies process exit/rollback under POSIX SIGTERM. A separate two-API-process test races duplicate idempotency and competing hot-wallet requests and reconstructs the final ledger balance.

Readiness is implemented for PostgreSQL and configured SQS queues. `/metrics` exports the specified counters and gauges per process, including Outbox lag and approximate SQS DLQ depth. Provider wager routes have an explicit identity port, but its default adapter does not authenticate. Integration tests verify custom and generated correlation IDs across HTTP and SQS, Outbox records, and pending-reference recovery.

Docker Compose starts PostgreSQL and LocalStack, not application roles. Run the API/workers with the documented Bun entrypoint and unique `WORKER_HEALTH_PORT` values. Stage 5 is complete; authentication remains an accepted documented non-goal, and the Stage 0 visual VS Code agent-picker check is still unverified.
