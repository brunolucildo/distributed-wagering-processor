# 00 — Domain and Financial Rules

**Status:** Pure domain implemented and tested (Stage 1); durable/application guarantees are tracked in specs 01–03.
**Scope:** Pure domain behavior and financial outcomes, independent of NestJS, MikroORM, PostgreSQL, and SQS.

## 1. Money

- `Money` MUST be immutable and store an exact decimal representation. Monetary arithmetic MUST NOT convert amounts to JavaScript `number`.
- External and serialized amounts MUST be decimal strings with exactly two fractional digits. Exponential notation, whitespace-only values, `NaN`, infinities, excess precision, and negative amounts in incoming wager contracts are invalid.
- Externally submitted wager amounts MUST be greater than zero. Wallet opening may use zero; it does not create an opening transaction or ledger entry.
- Currency MUST be an uppercase ISO-4217 code. The initial operational configuration supports `BRL`; the domain MUST reject arithmetic and wallet operations across different currencies.
- Parsing MUST reject invalid input rather than round it. Arithmetic results MUST preserve two decimal places.
- `Money.zero(currency)` is valid. Negative values may be produced internally by `negate()` but MUST NOT be accepted as wager amounts.

## 2. Wallet and ledger

- A wallet is uniquely identified by `(playerId, currency)`, starts at version `1`, and cannot have a negative balance.
- Version increases by exactly one for each persisted balance change and does not change for balance-neutral operations such as `LOSS`.
- A wallet opening with a positive initial balance creates one internal `OPENING` transaction and one credit ledger entry atomically. A zero-balance opening creates neither.
- Each balance-changing transaction creates exactly one ledger entry for its wallet. `LOSS` and rejected transactions create none.
- A ledger entry is immutable and records amount, direction, wallet, transaction, before/after balances, and timestamp. It is valid only when `before + amount = after` for credits or `before - amount = after` for debits, in the same currency.
- The stored wallet balance MUST equal the signed sum of all its ledger entries, including the `OPENING` credit when present, starting from zero. Equivalently, it equals its opening balance plus the signed sum of subsequent entries, excluding `OPENING`. The opening MUST NOT be counted twice. Reconciliation reports discrepancies and never repairs them automatically.

## 3. Wager identity and lifecycle

Kinds: `OPENING`, `BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`. `OPENING` is internal and MUST NOT be accepted by HTTP or SQS input.

Statuses:

| Status | Meaning | Terminal |
|---|---|---|
| `PENDING` | Accepted and ready to apply | No |
| `PENDING_REFERENCE` | Waiting for the referenced operation | No |
| `PROCESSED` | Applied or recorded as a no-balance result | Yes |
| `REJECTED` | Permanent domain/business rule rejection | Yes |
| `FAILED` | Permanent processing failure that cannot be retried | Yes |

Allowed transitions:

| From | To | Condition |
|---|---|---|
| New | `PENDING` | Valid operation with no unresolved required reference |
| New | `PENDING_REFERENCE` | A required or supplied reference does not yet exist |
| `PENDING` | `PROCESSED` | Domain operation succeeds |
| `PENDING` | `REJECTED` | A business rule fails |
| `PENDING` | `PENDING_REFERENCE` | A required or supplied reference is not available at processing time |
| `PENDING_REFERENCE` | `PROCESSED` | Reference appears and all rules succeed |
| `PENDING_REFERENCE` | `REJECTED` | Reference expires or a resolved reference violates a business rule |
| Non-terminal | `FAILED` | Only for a permanent, transaction-specific processing failure classified as non-retryable |

All terminal states are immutable. Transitions not listed above are programming errors. `FAILED` is not a label for exhausted retries: transient infrastructure errors MUST NOT be persisted as `FAILED`, and retry exhaustion alone does not make an error permanent. A permanent failure must be durably recorded when the database is available.

Only `REJECTED` and `FAILED` carry a failure code; `PENDING`, `PENDING_REFERENCE`, and `PROCESSED` MUST NOT carry one. Every supplied reference identifier must be non-blank, including optional `WIN` references. The internal `OPENING` factory requires non-blank identifiers and a positive amount; zero opening is represented by the wallet without a transaction.

The external transaction identity is `(providerId, externalTransactionId)`. An idempotency key is unique within a provider. The same key and same canonical business payload is a replay; the same key with a different payload is a conflict. Reusing an external transaction identity with a different key is also a conflict.

## 4. Operation rules

| Kind | Balance effect | Ledger |
|---|---|---|
| `BET` | Debit wager amount; insufficient funds reject | One debit |
| `WIN` | Credit wager amount | One credit |
| `LOSS` | No change | None |
| `REFUND` | Credit the referenced bet amount | One credit |
| `ROLLBACK` | Apply the exact inverse of the referenced operation | One entry if the reference affected balance |

- `REFUND` and `ROLLBACK` require `referenceExternalTransactionId`.
- `WIN` does not require a reference. If supplied, it MUST resolve to a processed `BET` for the same provider, player, wallet, currency, and round; an unresolved supplied reference is persisted as `PENDING_REFERENCE`.
- `REFUND` may reference only a processed `BET`.
- `ROLLBACK` may reference a processed `BET`, `WIN`, or `REFUND`. Rolling back a `LOSS` is invalid because it has no balance effect.
- A reference must match provider, player, wallet, currency, and round. Reversal amount must exactly equal the referenced transaction amount.
- A transaction may be directly reversed at most once, regardless of reversal kind. Enforce this rule durably and atomically; concurrent reversals must not both succeed.
- A `ROLLBACK` of a `REFUND` reverses that refund. It does not make the original bet eligible for a second refund.
- A reversal that would make the wallet balance negative is rejected with a distinct `REVERSAL_WOULD_OVERDRAW` failure code. Insufficient funds for `BET` uses `INSUFFICIENT_FUNDS`.
- Recommended stable failure codes: `INVALID_TRANSACTION`, `PERMANENT_PROCESSING_FAILURE`, `WALLET_NOT_FOUND`, `WALLET_MISMATCH`, `CURRENCY_MISMATCH`, `INSUFFICIENT_FUNDS`, `REFERENCE_NOT_FOUND`, `REFERENCE_INVALID`, `REFERENCE_ALREADY_REVERSED`, `REVERSAL_AMOUNT_MISMATCH`, `REVERSAL_WOULD_OVERDRAW`.
- Domain rehydration reconstructs persisted values without replaying creation or transition validation.

## 5. Domain acceptance criteria

- Unit tests cover exact decimal parsing and arithmetic, currency mismatch, transition validity, all operation effects, reversal chains, overdraw prevention, and terminal-state immutability.
- Property-style or table-driven tests verify the ledger balance equation and wallet/ledger consistency for each balance-changing operation.
