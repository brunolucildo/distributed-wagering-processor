# 03 — Messaging and Recovery

**Status:** Stage 4 behavior is covered by PostgreSQL/LocalStack integration tests, including three independent application processes, two publisher processes, process-kill recovery at the commit/ACK and publish/confirm boundaries, and source-to-DLQ redrive. POSIX shutdown-timeout fault injection passed in Linux CI; the test is skipped on Windows because SIGTERM delivery is not catchable there.
**Broker:** AWS SQS API via LocalStack in local development.

## 1. Queues and message contracts

- Provision `wager-transactions.fifo` and `wager-transactions-dlq.fifo`; configure the source queue redrive policy for five receives before DLQ transfer.
- Set `MessageGroupId` to `walletId` and `MessageDeduplicationId` to the stable incoming `messageId`. FIFO deduplication is an optimization only; PostgreSQL remains the correctness boundary.
- Validate envelope version, message ID, type, timestamp, and business payload before processing. Reject `OPENING` from the external message contract.
- The incoming envelope is `WagerTransactionRequested`: `{ messageId, correlationId?, type, version: 1, occurredAt, data }`; optional `correlationId` must be a UUID. The consumer generates one when absent. `data` contains the wager submission fields plus `idempotencyKey`.
- Queue handlers and HTTP controllers invoke the same application use case.
- Outbox events are published to a configured FIFO integration-events queue. The event envelope includes event ID/type/version, aggregate ID, correlation ID, optional causation ID, occurred time, and JSON-safe data. Money values are strings.
- The correlation ID is preserved from the HTTP request or SQS envelope through Outbox events, pending-reference recovery, structured processing logs, and DLQ message attributes.

## 2. Inbox and consumer behavior

The inbox key is `(consumerName, messageId)` and stores a hash of the received payload.

1. Start a database transaction and insert/claim the inbox record.
2. If a completed inbox record with the same hash exists, commit the no-op and acknowledge.
3. If the ID exists with a different hash, record a permanent message-contract failure and route it to the DLQ; never silently treat it as a duplicate.
4. Invoke the shared wagering use case, persist the inbox completion and all applicable financial/outbox writes atomically.
5. Acknowledge only after commit.

Failure before commit leaves the message retryable. The implementation uses one transaction manager for Inbox, wager, wallet, ledger, response snapshot, and Outbox writes. Duplicate delivery with the same hash is a no-op; a different hash is saved in `inbox_message_conflicts`, sent to DLQ, and never overwrites the original Inbox row. A process-kill test confirms that death after commit but before acknowledgement is recovered by redelivery without a second financial effect.

## 3. Retry and shutdown policy

- SQS visibility timeout: 60 seconds; extend visibility while work is active if necessary.
- Source queue redrive limit: five receives, then DLQ.
- Domain rejection is a committed terminal result and is acknowledged; it is not retried.
- Transient database or broker-independent processing failures roll back and are retried by SQS. Do not acknowledge before a durable outcome.
- Invalid/unparseable envelopes and permanent contract failures go to DLQ with sanitized diagnostics.
- A worker handles `SIGTERM` by stopping new receives, finishing in-flight work within the grace period, and allowing unfinished messages to become visible again.
- Readiness is false when a worker cannot reach a required dependency.
- Worker-only roles expose health endpoints without exposing the wagering API; configure a unique `WORKER_HEALTH_PORT` per process.

## 4. Transactional outbox

The outbox row is inserted in the same SQL transaction as the financial result. Required events:

- `WagerTransactionProcessed` for processed operations, including `LOSS`;
- `WagerTransactionRejected` for business rejections;
- `WalletBalanceChanged` only when the balance changes;
- `WagerTransactionPendingReference` when a required reference is absent.

The publisher claims due rows in a short database transaction using `FOR UPDATE SKIP LOCKED`, writes a persistent lease, commits, then publishes to SQS outside the database transaction. Successful publication marks the row published. A crashed publisher's lease expires after 60 seconds. Lease claims must be safe across multiple publisher processes.

On publish failure, increment attempts and schedule exponential backoff starting at 1 second, capped at 5 minutes, with jitter. After 10 failed publish attempts, retain the outbox row as failed and emit a structured error log. Prometheus metrics were added in Stage 5; alerting policies are not defined by this project and must be configured by deployment operators. Explicit replay uses `OUTBOX_EVENT_ID` and `bun run outbox:replay`, resetting attempts and scheduling the event immediately. Publishing can be duplicated if the process crashes after SQS accepts a message but before the database marks it published, so consumers deduplicate by `eventId`.

## 5. Pending-reference worker

- A missing required or supplied reference is persisted as `PENDING_REFERENCE` without a balance change or ledger entry.
- Schedule a durable next-attempt time; do not rely on in-memory timers.
- Retry after 1, 2, 4, 8, 16, 32, and 60 seconds; continue at 60-second intervals up to 20 attempts or a 24-hour age limit, whichever occurs first.
- Claim due rows with `FOR UPDATE SKIP LOCKED` and a recoverable 60-second lease. Lock and revalidate the transaction/reference/wallet before applying.
- On resolved valid reference, apply the normal processing transaction and emit the normal processed/balance events.
- On a resolved but invalid reference, reject with the appropriate stable domain failure code.
- If attempts or age limit is exhausted while the reference is absent, transition to `REJECTED` with `REFERENCE_NOT_FOUND` and enqueue the rejection event atomically.
- Concurrent reprocessors must not process a pending transaction more than once.

## 6. Messaging acceptance criteria

- Integration tests use LocalStack and real PostgreSQL, not only mocks. They verify duplicate delivery, conflicting message ID payload, DLQ delivery, dependency readiness, two publisher processes claiming disjoint batches, explicit failed-event replay, pending-reference recovery, retry-limit expiry, and three concurrently running API/consumer/publisher processes.
- Process-kill tests confirm recovery after commit-before-ACK and publish-before-confirm, including duplicate-safe financial state and persisted Outbox completion after restart. A transient database trigger verifies the five-receive source-to-DLQ redrive policy.
- The shutdown-timeout test holds a PostgreSQL transaction open and verifies process exit and rollback. It is skipped on Windows because its SIGTERM injection requires POSIX process semantics; it passed in Linux Bun CI as recorded in the Stage 5 verification evidence.
