# Project Specifications and Delivery Plans

This documentation translates the challenge requirements and `ARCHITECTURE.md` into implementation-ready specifications and staged delivery work.

## Specifications

| Document                                                                      | Scope                                                                             |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [00 — Domain and Financial Rules](./specs/00-domain-and-financial-rules.md)   | Money, wallets, wager lifecycle, ledger, reversals, invariants                    |
| [01 — Persistence and Concurrency](./specs/01-persistence-and-concurrency.md) | PostgreSQL schema guarantees, migrations, transaction boundaries, locking         |
| [02 — API and Idempotency](./specs/02-api-and-idempotency.md)                 | HTTP contracts, validation, canonical payload hashing, response semantics         |
| [OpenAPI contract](./api/openapi.yaml)                                        | Machine-readable wallet, wagering, ledger, reconciliation, and liveness endpoints |
| [03 — Messaging and Recovery](./specs/03-messaging-and-recovery.md)           | SQS, Inbox, Outbox, retries, DLQ, pending references                              |
| [04 — Operations and Verification](./specs/04-operations-and-verification.md) | Configuration, health, observability, test and completion criteria                |

## Delivery plan

- [Implementation Roadmap](./plans/implementation-roadmap.md) — ordered stages, dependencies, deliverables, and exit criteria.
- [Agent-Assisted Development Workflow](./plans/agent-assisted-development.md) — available custom workspace agents, bounded delegation, orchestration, and recorded validation.

## Document conventions

- The original challenge brief is retained locally as untracked `READMEChallenge.md`; its required behavior is represented in these tracked specs and the root `README.md`. The root README describes actual delivery/setup, while `ARCHITECTURE.md` distinguishes the target design from current implementation and open gaps.
- These specifications resolve implementation-level choices where the source documents leave them open. If a specification conflicts with the challenge, the challenge takes precedence and the documents must be reconciled before implementation.
- **MUST** and **MUST NOT** indicate requirements. **SHOULD** indicates a strong default that may be changed only with a documented reason.
- Specs are approved for implementation planning, not evidence that the behavior has already been implemented.
- Changes to the implemented behavior must be reflected in the relevant specification and `ARCHITECTURE.md`.
- Custom coding agents are development tooling only; they are not part of the wagering processor runtime.

## Current validation

Stage 5 now includes Prometheus metrics, a provider-identity extension point, cross-process duplicate/hot-wallet tests, Ubuntu CI, verified POSIX shutdown-timeout behavior, and correlation propagation across HTTP, SQS, Outbox, and recovery. Final Linux Bun 1.4.4 validation evidence is recorded in the [implementation roadmap](./plans/implementation-roadmap.md). A read-only reliability review found and verified fixes for two low-severity issues. Authentication remains disabled; the separate visual VS Code agent-picker confirmation remains unverified. The [database finite-value](./specs/01-persistence-and-concurrency.md#6-delivery-evidence-and-audit-corrections-2026-10-29) and [malformed-JSON envelope](./specs/02-api-and-idempotency.md#7-wallet-http-audit-correction-2026-10-29) gaps are closed with regression tests.
