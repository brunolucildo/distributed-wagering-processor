# 02 — API and Idempotency

**Status:** Wallet and wagering routes, liveness/readiness, Prometheus metrics, persistent idempotency, the OpenAPI contract, and an injectable provider identity extension point are delivered. Authentication remains disabled by the explicit unconfigured adapter. Duplicate idempotency and competing same-wallet races are tested across two separate API processes.
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
- Authentication/authorization are not enabled; `providerId` remains a business field, not authenticated identity. Provider wager routes call `ProviderIdentityPort`; the default `UnconfiguredProviderIdentityAdapter` returns no authenticated identity, and the API must not be presented as protected. Replace it with an external IdP adapter before exposing provider routes to untrusted callers.

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
- Authentication may remain unimplemented; `ProviderIdentityPort` is the explicit extension point and its default adapter does not authenticate. Do not present this as production security.
- `/metrics` is unauthenticated and exports operational data only; scrape each process separately.
- Use a consistent JSON error envelope containing a stable machine-readable code and human-readable message. Do not expose SQL, stack traces, credentials, or raw provider payloads.
- `503` responses are retryable with the same idempotency key. A persisted `REJECTED` outcome is not retryable as a new transaction.

## 6. API acceptance criteria

- Contract tests cover every status mapping, invalid payloads, `OPENING` rejection, replay response snapshots, payload conflict, and concurrent duplicate submissions.
- [OpenAPI documentation](../api/openapi.yaml) describes request/response shapes, money string format, error codes, idempotency, and pagination.

## 8. Stage 3 and Stage 4 process verification (2026-10-29)

The 119-test / 404-assertion suite passes, including 16 wager HTTP/PostgreSQL integration tests. It verifies `200`, `202`, `400`, `404`, `409`, `422`, and `503` behavior; durable pending/rejected outcomes; response-snapshot replay; payload/identity conflict; the 50-identical-request and concurrent-bet cases; and provider/external and internal-ID reads. The full integration suite contains 47 PostgreSQL tests / 229 assertions.

The Stage 3 wager-concurrency results cover concurrent HTTP requests to one Nest process. Stage 4 separately proves the API/consumer/publisher process topology and crash-recovery paths. Stage 5 adds cross-process wager/idempotency races and an explicit provider identity port. `/health/ready` checks PostgreSQL and configured SQS queues. Provider authentication and OpenAPI UI serving are not implemented.

## 9. Stage 5 identity and metrics verification (2026-10-30)

Provider submit and external-identity read routes invoke `ProviderIdentityPort`, compare any returned authenticated provider with the requested provider ID, and reject mismatches. Unit tests cover the unconfigured adapter, matching identity, and mismatch rejection. The default adapter is deliberately unauthenticated; production authentication is still a separate external-IdP integration.

`GET /metrics` is specified in OpenAPI and emits Prometheus exposition. It is implemented on API and worker roles and exports wager outcomes/replays/conflicts, Inbox duplicates, retry sources, application DLQ routing and approximate DLQ depth, PostgreSQL lock conflicts, wager latency, Outbox pending count/age, and reconciliation discrepancies. Metrics are process-local and require scraping every process.

## 7. Wallet HTTP audit correction (2026-10-29)

Malformed JSON previously returned the default NestJS envelope before reaching the controller-scoped filter. The filter is now registered globally in the application module and maps HTTP `400` errors to `{ code: "INVALID_REQUEST", message: "Invalid request." }`. Real HTTP regression tests send malformed JSON to wallet creation and reconciliation, asserting exact status/body and absence of submitted payload data. Existing validated-body, conflict, missing-wallet and reconciliation behavior remains covered.
