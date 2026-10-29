# Implementation Roadmap

**Status:** Stages 0–3 delivered and verified to their documented boundaries; Stages 4–5 not started. Stage 0's visual VS Code agent-picker check and multi-process behavior remain unverified.
**Approach:** Complete each stage's exit criteria before starting dependent work. Keep each stage reviewable and update the specs/architecture when an implementation decision changes.

Agent-assisted work follows [Agent-Assisted Development Workflow](./agent-assisted-development.md). Agents are introduced in Stage 0 and used selectively for independent, bounded work in later stages; the orchestrator remains responsible for integration and verification.

## Documentation gate for every stage

Before a stage is considered complete, update the root `README.md` to reflect what was delivered and verified in that stage. Include the current project status, exact setup/run/test commands that were exercised, relevant test outcomes, known limitations, and the next stage. Keep the challenge brief requirements represented in the tracked project documentation; never describe planned functionality as implemented.

## Stage 0 — Project foundation

**Goal:** Establish a reproducible Bun/NestJS project and local development baseline.

**Delivery status:** Foundation, health, local dependencies and FIFO provisioning are present and tested. The clean-install workaround was verified previously; it was not re-executed during the 2026-10-29 revalidation. Visual selection of the custom agents in the VS Code picker remains unverified, so that exit check is still open.

**Work**

- Initialize strict TypeScript, Bun scripts, NestJS bootstrap, lint/format/test configuration.
- Add environment validation and a minimal modular folder layout.
- Add Docker Compose for PostgreSQL and LocalStack, with queue provisioning.
- Create reusable workspace agent definitions under `.github/agents/` for domain implementation, test authoring, and read-only reliability review, following the agent workflow plan.
- Add an initial README setup section.

**Exit criteria**

- A clean checkout installs and starts using documented Bun/Compose commands.
- A minimal health endpoint responds.
- Unit test, lint, and type-check commands work in CI/local setup.
- The custom agents have valid frontmatter, explicit boundaries, and can be selected in the intended VS Code workflow.
- No business logic or secrets are embedded in configuration.

## Stage 1 — Domain model

**Goal:** Implement financial rules without infrastructure dependencies.

**Delivery status:** Recovered selectively from the local stash and checked against the synchronized Stage 0 foundation. After conformance fixes, 67 domain tests plus five foundation tests pass, along with lint, type-check, build, and formatting. Factories reject invalid openings and blank references; transitions prohibit failure codes on non-failure states. `Money` uses exact `bigint` minor units with decimal-string input/output. Ledger reconstruction includes `OPENING` exactly once. Stage 2 supplied a unique processed-reversal reference constraint; Stage 3 subsequently implemented its durable check/application protocol.

**Work**

- Implement `Money`, wallet, wager transaction, immutable ledger entry, domain errors/failure codes, and integration event types.
- Implement operation/reversal/reference rules and explicit state transitions.
- Add unit tests for invalid amounts, currency handling, transitions, ledger math, and all operation outcomes.
- Orchestrate the domain implementation and independent test work with bounded agent tasks; use the reviewer only for read-only checks of meaningful financial changes.

**Exit criteria**

- Domain package imports no NestJS, ORM, or AWS modules.
- Monetary values remain decimal strings or exact `bigint` minor units behind `Money`, without conversion to `number`.
- All cases in [00 — Domain and Financial Rules](../specs/00-domain-and-financial-rules.md) pass.

## Stage 2 — Database and wallet lifecycle

**Goal:** Persist wallets and ledger under schema-enforced invariants.

**Depends on:** Stage 1.

**Delivery status:** Delivered with both audit corrections verified: 31 real PostgreSQL integration tests plus the existing 72 tests pass (103 total, 309 assertions), as do lint, type-check, build, and formatting. The five-table schema uses exact string-mapped `NUMERIC(38,2)`, identity/reversal constraints, cross-wallet/currency foreign keys, and ledger mutation triggers. Wallet creation atomically records positive `OPENING`; zero opening has no transaction or entry. Wallet HTTP queries, wallet-scoped cursor pagination, and non-mutating reconciliation are wired. Empty-schema up/down/up and populated initial-schema rollback refusal pass. Migrations never run automatically at startup.

**Revalidation gate (2026-10-29):** Closed for the two reported gaps. `RejectNonFiniteMoney` adds finite-value constraints without editing the applied initial migration; tests cover SQL `NaN`/infinities, populated corrective down/up and explicit refusal of corrupt legacy data without rewriting it. The globally registered HTTP filter now handles malformed JSON with the stable sanitized envelope, tested via real HTTP requests. The correction was applied to the local database and repeated `up` was a no-op. Stage 3 subsequently completed as recorded below.

**Boundary:** Stage 2 provides the schema and wallet lifecycle. Stage 3 adds the HTTP transactional wagering use case. Inbox/Outbox processing belongs to Stage 4. A single-transaction five-table rollback test verifies infrastructure only. HTTP reconciliation discrepancies currently use structured logging and a process-local counter; metrics export remains Stage 5.

**Work**

- Configure MikroORM and PostgreSQL mapping without lossy decimal conversion.
- Create reversible migrations, constraints, indexes, foreign keys, and ledger immutability trigger.
- Implement wallet/ledger repositories, wallet creation with atomic `OPENING`, queries, pagination, and reconciliation.
- Add PostgreSQL integration tests for constraints, transactions, migrations, and ledger reconstruction.
- Delegate schema/migration and integration-test tasks only after their contracts are agreed and file ownership is non-overlapping.

**Exit criteria**

- Database rejects negative balances, duplicate wallets, invalid duplicate ledger entries, and ledger update/delete.
- Positive wallet opening creates one matching credit; zero opening creates none.
- Migration up/down/up and reconciliation tests pass.

## Stage 3 — Wager processing, API, and idempotency

**Goal:** Safely process HTTP wagers under concurrent requests.

**Depends on:** Stages 1 and 2.

**Delivery status:** Delivered and verified. The API now validates and normalizes submissions, hashes canonical business fields, uses ordered database advisory locks for identity/idempotency followed by a wallet row lock, and persists the wager, wallet/version, ledger, response snapshot, and Outbox events atomically. Durable replay, conflict, rejection, and pending-reference outcomes are implemented. The OpenAPI contract is checked in at `docs/api/openapi.yaml`.

**Verification (2026-10-29):** 119 tests / 404 assertions pass across six files; 47 are real PostgreSQL integration tests / 229 assertions. Coverage includes 50 simultaneous identical requests, the `80.00 BRL` race against `100.00 BRL`, concurrent direct reversals, replay snapshots, rollback after injected Outbox failure, and the durable currency-mismatch migration guard. Lint, type-check, build, and format check pass. `Stage3WagerIdentity` was applied to the configured development database; a second migration run was a no-op.

**Boundary:** The concurrency suite exercises one Nest process with concurrent HTTP requests and multiple PostgreSQL connections; three independent application processes have not been verified. Pending-reference rows and Outbox messages are durable, but no worker retries references or publishes events. Authentication and readiness are not implemented.

**Work**

- Implement canonical payload hashing and persistent identity/idempotency handling.
- Implement the shared `ProcessWager` application use case and database transaction/locking policy.
- Add wager submission and transaction query endpoints with stable response/error mapping.
- Document those contracts in OpenAPI. `providerId` remains an untrusted business field; authenticated provider identity is handoff work, not an implemented Stage 3 feature.
- Add tests for replay snapshots, payload conflicts, reversal uniqueness, and concurrent wallet updates.
- Keep financial transaction-boundary changes under one integration owner; use a read-only reliability review for future changes affecting persistence invariants.

**Exit criteria — met for the documented single-process scope**

- Fifty concurrent identical submissions cause one financial effect.
- Concurrent `80.00 BRL` bets satisfy the required scenario.
- Replay returns the original outcome snapshot; conflicting payloads return `409`.
- The use case persists financial and outbox records atomically (outbox publisher is completed in Stage 4).

## Stage 4 — SQS, Inbox/Outbox, and recovery workers

**Goal:** Make asynchronous delivery and event publication recoverable.

**Depends on:** Stage 3.

**Work**

- Implement SQS consumers using the shared use case and persistent Inbox.
- Implement transactional Outbox, leased multi-publisher processing, retries, and operational handling of exhausted events.
- Implement durable pending-reference scheduling and reprocessing.
- Configure visibility timeout, redrive/DLQ, FIFO grouping/deduplication, and graceful shutdown.
- Add real-container integration and crash/restart tests.
- Delegate consumer and publisher work only where interfaces and database transaction boundaries are stable; keep shared contract changes under one owner.

**Exit criteria**

- Commit-before-ack redelivery does not duplicate financial effects.
- Events are never published before commit and can be safely republished.
- Pending references recover or expire according to policy across restarts.
- Two publisher processes and at least three application processes pass the applicable tests.

## Stage 5 — Operations, hardening, and handoff

**Goal:** Verify end-to-end requirements and make the solution easy to evaluate.

**Depends on:** Stages 0–4.

**Work**

- Complete structured logs, metrics, liveness/readiness, and error sanitization.
- Run complete unit, integration, concurrency, migration, lint, and type-check suites.
- Review every requirement in the challenge against implementation and tests.
- Run a read-only reliability review of the integrated diff, triage its findings, and independently verify any fixes.
- Update root README and `ARCHITECTURE.md` to reflect actual commands, behavior, limitations, and any deviations from these specs.
- Optionally run and document a load test; it is not a prerequisite for completion.

**Exit criteria**

- All mandatory challenge completion criteria are demonstrably met.
- A clean environment can follow the README to run the application and tests.
- The development handoff records agent roles used, bounded tasks, reviewed outputs, and actual validation evidence without overstating agent guarantees.
- No unresolved high-risk behavior or undocumented deviations remain.

## Dependency overview

```text
Stage 0
  └── Stage 1
        └── Stage 2
              └── Stage 3
                    └── Stage 4
                          └── Stage 5
```

Stages are intentionally sequential because each builds on the prior stage's contracts. Within a stage, independent unit tests, documentation, and infrastructure setup may proceed in parallel when they do not introduce conflicting changes.
