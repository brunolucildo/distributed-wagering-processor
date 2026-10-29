# 03 — Messaging and Recovery

**Status:** Ready for implementation  
**Broker:** AWS SQS API via LocalStack in local development.

## 1. Queues and message contracts

- Provision `wager-transactions.fifo` and `wager-transactions-dlq.fifo`; configure the source queue redrive policy for five receives before DLQ transfer.
- Set `MessageGroupId` to `walletId` and `MessageDeduplicationId` to the stable incoming `messageId`. FIFO deduplication is an optimization only; PostgreSQL remains the correctness boundary.
- Validate envelope version, message ID, type, timestamp, and business payload before processing. Reject `OPENING` from the external message contract.
- Queue handlers and HTTP controllers invoke the same application use case.
- Outbox events are published to a configured FIFO integration-events queue. The event envelope includes event ID/type/version, aggregate ID, correlation ID, optional causation ID, occurred time, and JSON-safe data. Money values are strings.

## 2. Inbox and consumer behavior

The inbox key is `(consumerName, messageId)` and stores a hash of the received payload.

1. Start a database transaction and insert/claim the inbox record.
2. If a completed inbox record with the same hash exists, commit the no-op and acknowledge.
3. If the ID exists with a different hash, record a permanent message-contract failure and route it to the DLQ; never silently treat it as a duplicate.
4. Invoke the shared wagering use case, persist the inbox completion and all applicable financial/outbox writes atomically.
5. Acknowledge only after commit.

Failure before commit leaves the message retryable. Process death after commit but before acknowledgement is safe because the next delivery finds the completed inbox record and financial idempotency identity.

## 3. Retry and shutdown policy

- SQS visibility timeout: 60 seconds; extend visibility while work is active if necessary.
- Source queue redrive limit: five receives, then DLQ.
- Domain rejection is a committed terminal result and is acknowledged; it is not retried.
- Transient database or broker-independent processing failures roll back and are retried by SQS. Do not acknowledge before a durable outcome.
- Invalid/unparseable envelopes and permanent contract failures go to DLQ with sanitized diagnostics.
- A worker handles `SIGTERM` by stopping new receives, finishing in-flight work within the grace period, and allowing unfinished messages to become visible again.
- Readiness is false when a worker cannot reach a required dependency.

## 4. Transactional outbox

The outbox row is inserted in the same SQL transaction as the financial result. Required events:

- `WagerTransactionProcessed` for processed operations, including `LOSS`;
- `WagerTransactionRejected` for business rejections;
- `WalletBalanceChanged` only when the balance changes;
- `WagerTransactionPendingReference` when a required reference is absent.

The publisher claims due rows in a short database transaction using `FOR UPDATE SKIP LOCKED`, writes a persistent lease, commits, then publishes to SQS outside the database transaction. Successful publication marks the row published. A crashed publisher's lease expires after 60 seconds. Lease claims must be safe across multiple publisher processes.

On publish failure, increment attempts and schedule exponential backoff starting at 1 second, capped at 5 minutes, with jitter. After 10 failed publish attempts, retain the outbox row as failed, emit an alert/log/metric, and require operational replay; never delete it. Publishing can be duplicated if the process crashes after SQS accepts a message but before the database marks it published, so consumers deduplicate by `eventId`.

## 5. Pending-reference worker

- A missing required or supplied reference is persisted as `PENDING_REFERENCE` without a balance change or ledger entry.
- Schedule a durable next-attempt time; do not rely on in-memory timers.
- Retry after 1, 2, 4, 8, 16, 32, and 60 seconds; continue at 60-second intervals up to 20 attempts or a 24-hour age limit, whichever occurs first.
- Claim due rows with `FOR UPDATE SKIP LOCKED` and a recoverable lease. Lock and revalidate the transaction/reference/wallet before applying.
- On resolved valid reference, apply the normal processing transaction and emit the normal processed/balance events.
- On a resolved but invalid reference, reject with the appropriate stable domain failure code.
- If attempts or age limit is exhausted while the reference is absent, transition to `REJECTED` with `REFERENCE_NOT_FOUND` and enqueue the rejection event atomically.
- Concurrent reprocessors must not process a pending transaction more than once.

## 6. Messaging acceptance criteria

- Integration tests use LocalStack or an equivalent real SQS-compatible container, not only mocks.
- Verify duplicate delivery, conflicting message ID payload, commit-before-ack crash recovery, visibility/retry/DLQ behavior, graceful shutdown, and inbox atomicity.
- Run two outbox publishers and prove no event is permanently lost; duplicate publication remains safe.
- Verify pending-reference recovery and expiration survive worker/process restarts.
