# 02 — API and Idempotency

**Status:** Ready for implementation  
**Transport:** NestJS HTTP API. JSON monetary amounts are strings.

## 1. Endpoints

| Method and path | Behavior |
|---|---|
| `POST /wallets` | Create wallet; positive opening balance creates `OPENING` and ledger entry |
| `GET /wallets/:walletId` | Return wallet balance and version |
| `GET /wallets/:walletId/ledger?cursor=&limit=` | Return stable cursor-paginated ledger |
| `GET /wagering/transactions/:transactionId` | Read by internal transaction ID |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Read by external identity |
| `POST /wagering/transactions` | Validate and synchronously process or durably accept for reference resolution |
| `POST /wallets/:walletId/reconciliation` | Compare materialized and ledger-derived balances; never mutate either |
| `GET /health/live` | Process liveness |
| `GET /health/ready` | Dependencies required by the process are reachable |

`OPENING` is forbidden on the wagering submission endpoint. DTO validation rejects malformed identifiers, unsupported kinds/currencies, missing fields, non-positive wager amounts, invalid money strings, oversized inputs, and unexpected properties.

## 2. Submission contract

`POST /wagering/transactions` requires the `Idempotency-Key` header and these business fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, and optional `referenceExternalTransactionId`.

The key is scoped to provider. The recommended value is `{providerId}:{externalTransactionId}`. Both the external identity and idempotency key are independently unique; disagreement between them is a conflict.

The canonical payload hash is SHA-256 over JSON containing only normalized business fields, with object keys sorted recursively and no insignificant whitespace. Include provider/external IDs, player/wallet, round/game, kind, money amount/currency, and optional reference. Exclude the idempotency header, timestamps, correlation IDs, and transport metadata. Persist the canonical hash with the transaction.

## 3. Response semantics

The response body for a durable outcome contains `transactionId`, `status`, optional `failureCode`, the balance captured when processing completed (when available), and `idempotentReplay`.

| Outcome | HTTP status |
|---|---:|
| New processed transaction | `200` |
| New rejected business transaction | `422` |
| New transaction persisted as `PENDING_REFERENCE` | `202` |
| Identical replay | Return the original outcome status/body with `idempotentReplay: true` |
| Same key or external identity with different payload | `409` |
| Invalid HTTP contract | `400` |
| Wallet/resource does not exist for a read or creation conflict | `404` / `409` respectively |
| Transient infrastructure failure without a known durable result | `503` |

The original response snapshot, including the balance at the original processing point, must be persisted or deterministically recoverable. A replay must not substitute the wallet's current balance. If commit outcome is uncertain, clients retry with the same key.

## 4. Read and pagination behavior

- Transaction reads expose the durable state and stable failure code, not internal stack traces.
- Ledger pages are ordered by `(created_at, id)` and use an opaque cursor encoding the last returned tuple. `limit` defaults to 50 and is capped at 100.
- Reconciliation returns stored balance, calculated balance, difference, consistency, and number of checked entries. A discrepancy is logged and counted as a metric; the endpoint does not repair it.
- Read endpoints do not expose secrets or unredacted internal payloads.

## 5. Security and error representation

- Health endpoints are unauthenticated as required by the challenge.
- Authentication may remain unimplemented; document that choice and retain an explicit guard/identity extension point. Do not present a no-op guard as production security.
- Use a consistent JSON error envelope containing a stable machine-readable code and human-readable message. Do not expose SQL, stack traces, credentials, or raw provider payloads.
- `503` responses are retryable with the same idempotency key. A persisted `REJECTED` outcome is not retryable as a new transaction.

## 6. API acceptance criteria

- Contract tests cover every status mapping, invalid payloads, `OPENING` rejection, replay response snapshots, payload conflict, and concurrent duplicate submissions.
- OpenAPI documentation describes request/response shapes, money string format, error codes, idempotency, and pagination.
