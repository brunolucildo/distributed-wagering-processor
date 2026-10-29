# 01 — Persistence and Concurrency

**Status:** Ready for implementation  
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

## 5. Persistence acceptance criteria

- Integration tests prove constraints reject duplicate wallets, duplicate external identities/keys, negative balances, duplicate ledger transactions, and duplicate reversals.
- Attempts to update/delete a ledger row fail at the database layer.
- Failure injection verifies wallet, transaction, ledger, inbox, and outbox writes roll back together.
- The required concurrent `80.00 BRL` bets against `100.00 BRL` leave one processed bet, one rejected bet, balance `20.00 BRL`, and exactly one debit entry.
- At least three independent application processes can run the concurrency test against the same database.
