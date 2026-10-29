# Agent-Assisted Development Workflow

**Status:** Workspace agents available; Stage 0–2 execution recorded below
**Purpose:** Demonstrate practical creation and orchestration of project-specific coding agents while keeping financial correctness and delivery accountability explicit.

## 1. Scope

Custom agents are development tools, not application runtime components. They will be stored in `.github/agents/` so the project team can reuse them in VS Code:

- `domain-engineer.agent.md` — implements bounded domain tasks from the domain specification and adds or updates focused unit tests.
- `test-engineer.agent.md` — adds independent test coverage for an agreed contract without changing production behavior unless explicitly assigned.
- `reliability-reviewer.agent.md` — read-only review of financial invariants, idempotency, concurrency, persistence, and recovery behavior.

The human developer remains accountable for design decisions, integration, test execution, and accepting changes. The primary coding assistant acts as orchestrator: it decomposes work, assigns bounded tasks, avoids conflicting file ownership, integrates results, and verifies behavior.

## 2. Orchestration rules

1. Assign an agent only a concrete work package with an explicit scope, relevant specification, expected outputs, and stop condition.
2. Delegate independent work, not one continuous investigation split across agents. Do not start agents merely to obtain a second opinion on small or obvious changes.
3. Give each implementation task a clear file/surface owner. Do not allow parallel agents to edit the same production files.
4. Freeze or communicate contracts before parallel implementation. If one task depends on another agent's result, run it sequentially rather than asking agents to guess interfaces.
5. Use the reliability reviewer in read-only mode. It reports findings; the orchestrator decides and implements any fix, then reruns focused tests.
6. Agent output is not proof of correctness. The orchestrator inspects the resulting diff, runs the relevant tests/type-check/lint commands, and reports what was actually verified.
7. Preserve security and privacy: do not send credentials, secrets, or private project data to external tools. Agents work within the repository context.
8. Track decisions and outcomes in the pull request or development summary; do not treat agent conversations as the authoritative specification.

## 3. Planned use by roadmap stage

| Stage | Agent activity | Orchestrator responsibility |
|---|---|---|
| 0 — Foundation | Create and validate the three reusable workspace agent definitions; no code implementation is delegated yet. | Confirm each agent's scope, tool permissions, and frontmatter; keep these agents out of runtime and production dependencies. |
| 1 — Domain | Assign the domain engineer a bounded domain slice; after its contract is stable, assign independent unit-test coverage to the test engineer. | Resolve domain decisions, prevent overlapping edits, run unit tests, and check monetary handling for forbidden numeric conversions. |
| 2 — Persistence | Assign schema/migration work as a bounded task; assign integration tests only after the schema contract is agreed. | Verify database-level constraints, migration reversibility, ledger immutability, and real PostgreSQL test results. |
| 3 — API and idempotency | Use implementation and test tasks sequentially or on disjoint files after request/response contracts are fixed. | Verify race behavior, replay snapshots, payload conflicts, and API error mapping. |
| 4 — Messaging and recovery | Delegate consumer and outbox work only after their shared transaction and event contracts are stable; keep ownership of overlapping files separate. | Verify commit-before-ack, redelivery, duplicate publication, reference recovery, and multi-process behavior using integration tests. |
| 5 — Handoff | Request a read-only reliability review of the completed diff and requirements coverage. | Triage findings, make any required fixes, execute the final suite, and document verified results and limitations. |

Agent use is selective: if a stage has no independent bounded work, implement it directly rather than manufacturing parallel tasks.

## 4. Agent definition quality checks

Each `.agent.md` definition must:

- use valid YAML frontmatter with a clear name and discovery-oriented description;
- state its bounded responsibility and prohibited scope;
- identify the authoritative specifications it should follow;
- specify expected output and when to stop or request clarification;
- avoid claiming test results unless the agent actually ran the tests;
- avoid unnecessary tool permissions, broad autonomous workflows, or duplicated general instructions.

After creation, verify that the agent files are in `.github/agents/`, have valid frontmatter, and can be selected in the intended editor workflow. Update this plan if the implemented agent roles or orchestration policy changes.

## 5. Evidence of successful use

The project may describe agent-assisted work as completed only when the development record identifies:

- which agent role handled which bounded task;
- which files or deliverables resulted;
- what the orchestrator reviewed or changed;
- which tests or validations were run and their actual outcomes;
- any rejected agent suggestions or unresolved limitations that affected the result.

Do not claim that agents independently guaranteed financial correctness. Correctness is demonstrated by database constraints, implementation review, and passing tests.

### Stage 2 execution

One bounded implementation agent owned `src/database/` only: MikroORM mappings/configuration, the initial migration, and its CLI. The orchestrator owned the non-overlapping application ports, repositories, wallet HTTP wiring, documentation, and integration tests. A separate test-authoring agent was not needed for this slice.

Integration review added strict processed-reversal reference and permanent-failure checks, used PostgreSQL constraint metadata for wallet conflicts, and disabled migration snapshot generation to keep temporary test-database files out of the source tree. Bun required an explicit AJV 8 runtime peer for the migration toolchain.

Actual verification: 92 tests / 268 assertions, including 20 real PostgreSQL integration tests; lint, type-check, build, and formatting passed. The initial migration was applied to the development database and a repeated `up` made no changes. The compiled migration runner and compiled API liveness/missing-wallet query also passed. No persistent wagering pipeline, SQS delivery guarantees, or multi-process financial concurrency were claimed.
