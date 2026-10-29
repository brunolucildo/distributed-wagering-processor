# 01 — Persistence and Concurrency

**Status:** Stage 2 schema/wallet lifecycle delivered; finite-money and HTTP audit corrections verified (see section 6). Wagering concurrency is Stage 3 work.
**Source of truth:** PostgreSQL.

## 1. Tables and durable constraints

The initial schema contains `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages`, and `outbox_messages`.

Required database guarantees:

- `wallets`: primary key; unique `(player_id, currency)`; non-negative `balance`; `version >= 1`.
- `wager_transactions`: unique `(provider_id, external_transaction_id)`; unique `(provider_id, idempotency_key)`; foreign key to wallet; non-negative amount; valid kind/status constraints; reference lookup index on `(provider_id, external_transaction_id)`.
- `wallet_ledger_entries`: foreign keys to wallet and transaction; unique `transaction_id`; exact numeric amount and before/after values; non-negative amount; valid direction; indexes supporting stable wallet ledger pagination.
- `inbox_messages`: unique `(consumer_name, message_id)` and payload hash.
- `outbox_messages`: event identity primary key; status/lease/retry fields and an index for due unpublished rows.
- `PENDING_REFERENCE` transactions have an index supporting due-time scans.

The ledger MUST be append-only at the database boundary, not just in domain code. Add a PostgreSQL trigger that rejects `UPDATE` and `DELETE` on ledger rows. The migration owner may remove the trigger/table in a down migration; normal application roles must not have a bypass path. Database owners remain an operational trust boundary.

`NUMERIC` columns MUST have an explicit precision and scale sufficient for the documented transaction limits. API/domain amounts stay strings; ORM mapping MUST not convert persisted values through JavaScript `number`.

The Stage 2 persistence limit is `NUMERIC(38,2)`: at most 36 integer digits and two fractional digits, up to `999999999999999999999999999999999999.99`. Domain arithmetic remains arbitrary-size; API/ORM inputs outside this range or with excess scale are rejected, not rounded. ORM mappings preserve decimal strings. Arbitrary SQL bypasses that mapping: PostgreSQL rounds excess scale on assignment to `NUMERIC(38,2)`. Monetary columns MUST reject non-finite values at the database boundary as well; the corrective migration enforces this, as recorded in section 6. Ledger timestamps use millisecond precision (`timestamptz(3)`) so `(created_at, id)` cursors round-trip exactly through JavaScript `Date`.

## 2. Atomic transaction boundary

One application operation uses one PostgreSQL transaction for all applicable writes:

1. claim/check external identity and idempotency;
2. resolve wallet and lock it;
3. resolve and validate reference and reversal uniqueness;
4. persist transaction status;
5. persist wallet/version and ledger entry when balance changes;
6. persist inbox completion for SQS input;
7. append required outbox event(s).

Any unexpected persistence or infrastructure error rolls back all writes. The application MUST acknowledge an SQS delivery only after commit. Business rejections are durable terminal transaction outcomes and commit without changing wallet balance or adding a ledger entry.

## 3. Concurrency policy

- Use PostgreSQL row-level pessimistic locking (`SELECT ... FOR UPDATE`) on the wallet being changed. Wallets remain independently processable.
- Acquire locks in a stable order: idempotency/transaction identity first, then wallet, then referenced transaction/reversal constraint. If multiple wallets are ever involved, lock by wallet ID in sorted order.
- Database unique constraints arbitrate concurrent creation and duplicate submissions. A uniqueness conflict is resolved by reloading the winning row and comparing its payload hash; unexpected database failures are surfaced.
- Use a unique reversal-reference constraint (or equivalent transactional database enforcement) so two concurrent reversals cannot both apply.
- Retry deadlocks and serialization/transient database failures a bounded number of times (3 attempts, with short jittered delay). Retrying MUST reuse the same idempotency identity. Exhaustion returns a retryable infrastructure error; it does not create a terminal transaction outcome.
- The wallet row lock and non-negative `CHECK` constraint are both required; neither is replaced by in-process locks or SQS FIFO.

## 4. Migrations

- Use versioned MikroORM migrations with `up` and `down` methods.
- Each migration MUST have a safe, executable down migration. Data-destructive rollback is not acceptable for the initial schema; if a future change cannot safely restore data, it must be split or explicitly gated and reviewed before implementation.
- Validate both upgrade from an empty database and downgrade/upgrade round trips in integration tests.
- Never edit an already-applied migration to change deployed behavior; add a new migration.

The initial `down` migration takes exclusive locks and refuses to drop the schema if any of the five application tables contains data. Its supported rollback is an empty-schema rollback; financial data must not be discarded. Integration tests use uniquely named temporary databases and never reset the configured development database.

## 5. Persistence acceptance criteria

- Integration tests prove constraints reject duplicate wallets, duplicate external identities/keys, negative balances, duplicate ledger transactions, and duplicate reversals.
- Attempts to update/delete a ledger row fail at the database layer.
- Failure injection verifies wallet, transaction, ledger, inbox, and outbox writes roll back together.
- The required concurrent `80.00 BRL` bets against `100.00 BRL` leave one processed bet, one rejected bet, balance `20.00 BRL`, and exactly one debit entry.
- At least three independent application processes can run the concurrency test against the same database.

## 6. Delivery evidence and audit corrections (2026-10-29)

The current suite passes 103 tests / 309 assertions, including 31 real PostgreSQL integration tests. It covers the Stage 2 constraints, atomic wallet opening, cursor pagination, reconciliation, empty-schema up/down/up and refusal to downgrade the populated initial schema. A five-table failure-injection test covers the SQL transaction mechanism only. Sections 2–3 and the concurrent-wager/multi-process acceptance criteria still require the Stage 3 use case.

The audit found that `NaN` bypassed the original non-negative/positive and ledger-equation checks. The new `RejectNonFiniteMoney` migration adds explicit finite-value checks to `wallets.balance`, `wager_transactions.amount`, and ledger `amount`, `balance_before`, `balance_after`, without modifying the applied initial migration. Regression tests prove SQL rejection of `NaN` and infinities and preservation of valid maximum amounts.

The corrective `up` validates existing data and fails atomically on invalid legacy rows, leaving migration history and financial data unchanged. It never silently repairs or deletes ledger records. Its `down` drops only the added constraints, preserving populated tables; this intentionally removes the additional defense, so reapply it before resuming writes. Both populated corrective down/up and the full empty-schema down/up are tested. The malformed-JSON correction in spec 02 is also covered by real HTTP regression tests. Both audit gaps are closed.
