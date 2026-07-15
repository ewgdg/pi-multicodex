# Usage coordination invariants

This maps the hard cross-process usage invariants to observable tests. Filesystem watchers and advisory leases improve convergence and duplicate suppression; they are not strict correctness boundaries.

| Invariant | Observable coverage |
|---|---|
| Managed identity is trimmed lowercase email; account ID never merges identities | `usage-coordination.test.ts` identity digest; `usage-coordinator.test.ts` normalized identity isolation; `account-manager.test.ts` matching-account-ID isolation |
| Paths use full SHA-256 and artifacts contain no raw email or credentials | `usage-coordination-filesystem.test.ts` identity/artifact inspection and credential-free diagnostics |
| Known state is validated as one document; malformed/oversized state is unavailable | `usage-coordination.test.ts` validation/size tests; filesystem malformed/oversized canonical test |
| Valid mutations preserve additive unknown fields | pure validation test and filesystem read-merge-publish test |
| Readers consume only bounded canonical state | filesystem canonical read, malformed/oversized, and debris tests |
| Publication uses same-directory temporary replacement and preserves canonical bytes on failure | filesystem injected replacement-failure/local-fallback test |
| Leases use exclusive creation, bounded records, expiry quarantine, and token-aware release | filesystem stale lease recovery and contention tests |
| Network work never runs under the state-write lease | filesystem refresh path contract: refresh lease encloses fetch; state-write lease is acquired only inside mutation publication |
| Automatic refresh accepts shared freshness only from snapshot `fetchedAt` | in-memory fresh reuse and `UsageCoordinator` fetched-at freshness tests |
| Forced refresh bypasses freshness/backoff but joins compatible work | in-memory, filesystem-adapter, process-local coordinator, and real-process contention tests |
| Network/API failure preserves snapshots and publishes retry suppression | in-memory and filesystem failure tests |
| Authentication failure and cancellation do not publish retry suppression | in-memory and filesystem classification tests |
| Success clears only the invalidation captured before fetch | in-memory and filesystem invalidation-during-refresh tests |
| Completed headless responses publish invalidation without starting network work | `usage-coordinator.test.ts` and `account-manager.test.ts` headless consumption tests |
| Individual waiter cancellation detaches while owned work continues | `usage-coordinator.test.ts` aborted-waiter publication test |
| Account removal forgets local state but preserves shared continuity | `usage-coordinator.test.ts` and `account-manager.test.ts` remove/re-add tests |
| Newer in-memory snapshots are not downgraded by late shared publication | `UsageCoordinator.acceptSnapshot` is exercised by shared subscription/import tests; older `fetchedAt` values are rejected |
| Watcher events are hints; validated rereads drive subscribers | filesystem debounced watcher test; coordinator safety reconciliation test coverage |
| Missing roots bind through an existing parent; watcher/read failures degrade visibly and recover | filesystem parent-rebind, injected read-permission, and watcher failure/recovery tests |
| No persistent watcher or safety timer remains without observer demand | usage coordinator observer lifecycle and status observer lifecycle tests |
| Cleanup examines at most 20 recognized aged entries and preserves unrelated files | filesystem bounded debris test |
| Normal cross-process contention usually performs one fetch | `usage-coordination-process.test.ts` simultaneous-process barrier test |
| A successor recovers after owner termination and lease expiry | `usage-coordination-process.test.ts` killed-owner barrier test |
| Different accounts and agent-directory scopes refresh independently | real-process separate-account and separate-root tests |
| Invalidation arriving during cross-process refresh remains pending | real-process invalidation-during-refresh test |
| Suspended-owner overlap and late publication are diagnosable and repairable | real-process `SIGSTOP` recovery test and filesystem duplicate/late-publication diagnostics test |
| A crashed state writer recovers without exposing partial canonical state | real-process state-writer termination test |
| Missed watcher hints and likely-sleep gaps reconcile from canonical state | real-process missed-hint test and deterministic `UsageCoordinator` likely-sleep test |
| Explicit refresh reports success only for fresh confirmation | `commands.test.ts` single/all typed outcome tests |
| Quota cooldown clears only after fresh healthy confirmation | `account-manager.test.ts` quota reconciliation tests |
| Single/all refresh APIs return typed availability and normalized-email keys | shared contract tests and `account-manager.test.ts` typed all-account result test |

Production tests are release-blocking on Linux. The implementation is cross-platform by design; macOS and Windows evidence comes from the completed throwaway filesystem prototype rather than production validation.
