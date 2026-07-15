# Coordinate Codex usage across Pi runtimes

MultiCodex keeps one process-local Usage Coordinator per Pi runtime. It remains authoritative for memory cache, promises, timers, observers, cancellation, credentials, token refresh, and owned network work.

Behind that coordinator, runtimes resolving the same Pi agent directory share credential-free usage snapshots, pending invalidation, refresh outcomes, retry suppression, and short advisory leases. Managed identity is the trimmed lowercase email; filesystem paths use its full SHA-256 digest and never contain raw identity or credentials.

Automatic refreshes accept a shared snapshot as fresh only from its `fetchedAt` time. Forced refreshes bypass freshness and retry suppression but join compatible active work. Network/API failures preserve stale data and publish short retry suppression; authentication failures and cancellation do not. Callers receive typed `fresh`, `stale`, `locally-available`, or `unavailable` results with refresh outcome and warnings separate from snapshot data.

Filesystem watchers are hints, and leases reduce duplicate work rather than guarantee strict ownership. Stale-owner recovery can rarely overlap a resumed owner, with later reconciliation repairing last-writer-wins state. The contract covers Linux, macOS, and Windows local filesystems by design; network filesystems are unsupported.

Persistent watcher and safety-reconciliation work exists only while a local observer or waiter creates demand. Completed managed responses always record pending invalidation without delaying response completion.
