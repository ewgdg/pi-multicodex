# Issue #9: Cross-process Codex usage coordination

## Goal

Make Pi runtimes sharing one agent directory converge on credential-free Codex usage state and normally coalesce per-account usage refresh work through portable local-filesystem coordination.

## Intention

Keep the process-local `UsageCoordinator` authoritative for memory, promises, timers, observers, cancellation, authentication boundaries, and fetch ownership. Add one injected shared-coordination interface behind it, with in-memory and filesystem implementations exercising the same public contract.

## Scope & Constraints

- Managed identity is trimmed lowercase email; paths use full SHA-256 only.
- Shared artifacts contain no credentials or raw email.
- Shared state has no schema version and preserves unknown additive fields during valid mutations.
- Canonical state is capped at 64 KiB; leases at 8 KiB.
- Atomic same-directory replacement must preserve the prior canonical file on failure.
- Leases are advisory and recover through expiry/quarantine; no daemon or network-filesystem guarantee.
- Cached reads stay synchronous and memory-only.
- Completion-path invalidation is non-blocking.
- Forced refresh bypasses freshness/backoff but joins compatible active work.
- Only fresh confirmation clears quota cooldowns or reports explicit refresh success.

## Pre-agreed Test Seams

The issue explicitly establishes these seams:

1. Public shared coordination contract: read, invalidate, refresh, subscribe — tested against memory and filesystem adapters.
2. `UsageCoordinator` with injected shared adapter — tests process-local caching, typed availability, observer lifecycle, cancellation, and consumption coalescing.
3. `AccountManager` facade — tests normalized identity, typed outcomes, fresh-only cooldown reconciliation, continuity after remove/re-add, and local credential ownership.
4. Real child processes coordinated through messages/filesystem barriers for cross-process contention and recovery.

## Work Plan

1. Define shared state, typed availability/outcome contracts, identity helpers, validation/reduction logic, and centralized production policy.
2. Implement deterministic in-memory shared coordination for protocol/integration tests.
3. Implement filesystem state publication, advisory leases, stale recovery, bounded cleanup, warnings/diagnostics, and subscription/reconciliation.
4. Refactor `UsageCoordinator` around the injected adapter; remove account-ID identity, completion-time freshness, observer-gated invalidation, and forced follow-up behavior.
5. Update `AccountManager`, commands, status, startup/rotation, removal semantics, and quota reconciliation for typed results.
6. Add pure, adapter-contract, real-filesystem, integration, and child-process tests; update test discovery.
7. Update architecture/domain/release documentation and package contents.
8. Run focused tests/typechecking during slices, full checks at the end, then two-axis code review and fixes.
9. Commit with a semantic message closing issue #9.

## Validation

- Focused Vitest files after each vertical slice.
- `pnpm typecheck` regularly.
- `pnpm lint` before final review.
- `pnpm test` once at completion.
- `pnpm pack:dry` to confirm new coordination modules ship.
- Two-axis `/code-review` against the starting commit `f691287` and issue #9.

## Progress

- [x] Read issue, domain context, current coordinator/account/status/command integration, prototype, and testing instructions.
- [x] Confirmed the issue itself pre-agrees the public test seams.
- [x] Contracts and pure logic.
- [x] In-memory adapter.
- [x] Filesystem adapter.
- [x] Process-local coordinator integration.
- [x] Account/status/command/startup integration.
- [x] Test matrix and child-process coverage.
- [x] Documentation/package updates.
- [x] Full validation and review.
- [x] Commit.

## Decisions

- Use a dedicated `usage-coordination/` module tree and include it in package files.
- Production global coordination is rooted below the active Pi agent directory; tests inject temporary roots or memory adapters.
- Individual waiter cancellation is implemented outside owned work so compatible local/cross-process work can finish and publish.
- Authentication failures are explicitly classified at the account-manager fetch boundary so they release leases without shared retry suppression.
- Filesystem coordination is split into orchestration, storage/lease, watcher, and public-type modules so the shared adapter remains navigable without exposing mechanics to callers.

## Outcomes & Retrospective

- Added credential-free cross-process state, advisory refresh/state-write leases, retry suppression, local fallback, watcher reconciliation, and structured diagnostics under the active Pi agent directory.
- Process-local coordination retains credentials, fetch ownership, cancellation, observers, timers, and synchronous memory cache.
- Typed refresh outcomes now drive commands and fresh-only quota cooldown reconciliation.
- Deterministic memory, filesystem, integration, and real child-process coverage includes contention, independent accounts/scopes, invalidation races, process termination/suspension, writer crash, missed hints, sleep reconciliation, permission degradation, and watcher recovery.
- Two-axis review passed after tightening fail-fast filesystem classification, extracting shared result/wait helpers, bounding refresh acquisition, classifying usage endpoint authentication failures, and completing watcher/diagnostic seams.
- Committed to the current branch as `feat: coordinate usage across Pi runtimes`.
