# Project Specifications and Delivery Plans

This documentation translates the challenge requirements and `ARCHITECTURE.md` into implementation-ready specifications and staged delivery work.

## Specifications

| Document | Scope |
|---|---|
| [00 — Domain and Financial Rules](./specs/00-domain-and-financial-rules.md) | Money, wallets, wager lifecycle, ledger, reversals, invariants |
| [01 — Persistence and Concurrency](./specs/01-persistence-and-concurrency.md) | PostgreSQL schema guarantees, migrations, transaction boundaries, locking |
| [02 — API and Idempotency](./specs/02-api-and-idempotency.md) | HTTP contracts, validation, canonical payload hashing, response semantics |
| [03 — Messaging and Recovery](./specs/03-messaging-and-recovery.md) | SQS, Inbox, Outbox, retries, DLQ, pending references |
| [04 — Operations and Verification](./specs/04-operations-and-verification.md) | Configuration, health, observability, test and completion criteria |

## Delivery plan

- [Implementation Roadmap](./plans/implementation-roadmap.md) — ordered stages, dependencies, deliverables, and exit criteria.
- [Agent-Assisted Development Workflow](./plans/agent-assisted-development.md) — planned custom workspace agents, bounded delegation, orchestration, and validation rules.

## Document conventions

- The challenge `README.md` defines required behavior; `ARCHITECTURE.md` defines the proposed design.
- These specifications resolve implementation-level choices where the source documents leave them open. If a specification conflicts with the challenge, the challenge takes precedence and the documents must be reconciled before implementation.
- **MUST** and **MUST NOT** indicate requirements. **SHOULD** indicates a strong default that may be changed only with a documented reason.
- Specs are approved for implementation planning, not evidence that the behavior has already been implemented.
- Changes to the implemented behavior must be reflected in the relevant specification and `ARCHITECTURE.md`.
- Custom coding agents are development tooling only; they are not part of the wagering processor runtime.
