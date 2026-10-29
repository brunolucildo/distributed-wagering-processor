# 02 — API and Idempotency

**Status:** Wallet and wagering routes, liveness, persistent idempotency, and the OpenAPI contract are delivered. Readiness and authentication remain unimplemented; multi-process behavior is not yet verified.
**Transport:** NestJS HTTP API. JSON monetary amounts are strings.

## 1. Endpoints

| Method and path                                                           | Behavior                                                                      |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST /wallets`                                                           | Create wallet; positive opening balance creates `OPENING` and ledger entry    |
| `GET /wallets/:walletId`                                                  | Return wallet balance and version                                             |
| `GET /wallets/:walletId/ledger?cursor=&limit=`                            | Return stable cursor-paginated ledger                                         |
| `GET /wagering/transactions/:transactionId`                               | Read by internal transaction ID                                               |
| `GET /providers/:providerId/wagering/transactions/:externalTransactionId` | Read by external identity                                                     |
| `POST /wagering/transactions`                                             | Validate and synchronously process or durably accept for reference resolution |
| `POST /wallets/:walletId/reconciliation`                                  | Compare materialized and ledger-derived balances; never mutate either         |
| `GET /health/live`                                                        | Process liveness                                                              |
| `GET /health/ready`                                                       | Dependencies required by the process are reachable                            |

`OPENING` is forbidden on the wagering submission endpoint. DTO validation rejects malformed identifiers, unsupported kinds/currencies, missing fields, non-positive wager amounts, invalid money strings, oversized inputs, and unexpected properties.

### Wallet contract delivered in Stage 2

- `POST /wallets` accepts exactly `{ playerId, currency, openingBalance }`; `playerId` is trimmed and limited to 1–200 characters, `currency` is validated as uppercase ISO-4217, and `openingBalance` is a non-negative two-decimal string within the persistence limit. The current HTTP string-size limit is 100 characters.
- IDs are generated as UUIDs internally. Creation returns `201` with `{ id, playerId, currency, balance, version }`; balance is a decimal string. Duplicate `(playerId, currency)` returns `409`, not an idempotent creation replay.
- The read route returns the same wallet shape. Ledger entries contain `id`, `walletId`, `transactionId`, `amount`, `currency`, `direction`, `balanceBefore`, `balanceAfter`, and `createdAt`, together with `nextCursor` (nullable).
- The reconciliation route returns `200` with `walletId`, `currency`, `storedBalance`, `calculatedBalance`, `difference` (stored minus calculated), `consistent`, and `checkedEntries`. It does not repair either data source.
- Wallet IDs in paths must be UUIDs. Missing wallets return `404`. The existing wallet exception filter is registered globally via `APP_FILTER`, so pre-controller parser errors and controller errors use `{ code, message }`.
- Authentication/authorization are not implemented; `providerId` is a validated business field, not authenticated identity, and no no-op guard claims to protect these routes. Add an authenticated provider identity integration before exposing the API beyond its intended environment.

## 2. Submission contract

`POST /wagering/transactions` requires the `Idempotency-Key` header and these business fields: `providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, and optional `referenceExternalTransactionId`.

The key is scoped to provider. The recommended value is `{providerId}:{externalTransactionId}`. Both the external identity and idempotency key are independently unique; disagreement between them is a conflict.

The canonical payload hash is SHA-256 over JSON containing only normalized business fields, with object keys sorted recursively and no insignificant whitespace. Include provider/external IDs, player/wallet, round/game, kind, money amount/currency, and optional reference. Exclude the idempotency header, timestamps, correlation IDs, and transport metadata. Persist the canonical hash with the transaction.

The checked-in OpenAPI contract is [openapi.yaml](../api/openapi.yaml). Runtime validation additionally caps identifiers and the idempotency key at 200 characters, money strings at 100 input characters, and cursors at 1024 characters.

## 3. Response semantics

The response body for a durable outcome contains `transactionId`, `status`, optional `failureCode`, the balance captured when processing completed (when available), and `idempotentReplay`.

| Outcome                                                         |                                                           HTTP status |
| --------------------------------------------------------------- | --------------------------------------------------------------------: |
| New processed transaction                                       |                                                                 `200` |
| New rejected business transaction                               |                                                                 `422` |
| New transaction persisted as `PENDING_REFERENCE`                |                                                                 `202` |
| Identical replay                                                | Return the original outcome status/body with `idempotentReplay: true` |
| Same key or external identity with different payload            |                                                                 `409` |
| Invalid HTTP contract                                           |                                                                 `400` |
| Unknown wallet on wager submission                              |                                            `404` (`WALLET_NOT_FOUND`) |
| Unknown transaction on read                                     |                                             `404` (`WAGER_NOT_FOUND`) |
| Unknown wallet on wallet routes / duplicate wallet creation     |                                                         `404` / `409` |
| Transient infrastructure failure without a known durable result |                                                                 `503` |

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
- [OpenAPI documentation](../api/openapi.yaml) describes request/response shapes, money string format, error codes, idempotency, and pagination.

## 8. Stage 3 verification (2026-10-29)

The 119-test / 404-assertion suite passes, including 16 wager HTTP/PostgreSQL integration tests. It verifies `200`, `202`, `400`, `404`, `409`, `422`, and `503` behavior; durable pending/rejected outcomes; response-snapshot replay; payload/identity conflict; the 50-identical-request and concurrent-bet cases; and provider/external and internal-ID reads. The full integration suite contains 47 PostgreSQL tests / 229 assertions.

The concurrency results cover concurrent HTTP requests to one Nest process, not multiple independently running API processes. Provider authentication, `/health/ready`, and OpenAPI UI serving are not implemented.

## 7. Wallet HTTP audit correction (2026-10-29)

Malformed JSON previously returned the default NestJS envelope before reaching the controller-scoped filter. The filter is now registered globally in the application module and maps HTTP `400` errors to `{ code: "INVALID_REQUEST", message: "Invalid request." }`. Real HTTP regression tests send malformed JSON to wallet creation and reconciliation, asserting exact status/body and absence of submitted payload data. Existing validated-body, conflict, missing-wallet and reconciliation behavior remains covered.
