# Portable filesystem coordination primitives

> This research record predates the production contract. Current behavior is defined by issue #9 and the usage-coordination ADR.

Research for [Evaluate portable filesystem coordination primitives](https://github.com/ewgdg/pi-multicodex/issues/2).

## Question

Which Node filesystem primitives can coordinate independent MultiCodex processes on Linux, macOS, and Windows while tolerating crashes, stale owners, missed notifications, and damaged intermediate files?

## Context and boundary

- The repository pins Node 24.17.0 in `mise.toml`.
- A coordination scope should be rooted under the same Pi agent directory returned by `getAgentDir()`, because that is also where MultiCodex resolves `codex-accounts.json` and Pi applies `PI_CODING_AGENT_DIR`.
- Shared usage coordination state must remain credential-free and separate from `codex-accounts.json`.
- The current `UsageCoordinator` already partitions refresh behavior by account, suppresses ordinary refreshes for 30 seconds, joins in-process work, queues forced follow-ups, and throttles failures. A cross-process layer must preserve those semantics rather than replace the process-local coordinator.
- The current usage request timeout is 10 seconds, which establishes a lower bound—not a complete value—for any ownership lease.

The recommendation below is limited to **local filesystems**. Node explicitly warns that exclusive creation may not work reliably on network filesystems, and `fs.watch()` may be unavailable or unreliable on NFS, SMB, and virtualized mounts. Network-mounted coordination roots should be documented as unsupported rather than treated as a correctness-preserving deployment.

## Primitive evaluation

### 1. Atomic state publication

Use a unique temporary file in the canonical file's directory, then publish it by rename:

1. Open the temporary path with `wx`.
2. Write the complete serialized document.
3. Validate that the intended complete document was produced.
4. Call `FileHandle.sync()`.
5. Close the handle.
6. Rename the temporary path over the canonical path.
7. Best-effort sync the parent directory where the platform permits it.

POSIX specifies atomic replacement when `rename()` replaces an existing destination. Node 24 delegates Unix rename operations to `rename()` and Windows rename operations to `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`. Node's API documentation does not itself make a universal cross-platform atomicity guarantee, so the protocol should treat failed replacement as a recoverable operation and preserve the previous canonical file until replacement succeeds.

Constraints:

- Temporary and canonical paths must be in the same directory and filesystem.
- Readers open, read, and close only the canonical path; they never consume temporary or quarantine files.
- Temporary names must be unique per publication attempt. Cleanup must require a conservative age/grace threshold and remain bounded and race-tolerant because a matching temporary path may still belong to an active writer.
- Writers must retry only bounded transient rename/access failures. They must not delete the previous canonical file to make a replacement succeed.
- A canonical document must be self-validating through a schema/version and complete metadata. Readers may treat missing or malformed documents as absent, but must distinguish an unknown newer protocol version; otherwise an older process could overwrite valid newer state. The compatibility policy remains for [Define shared usage state and identity rules](https://github.com/ewgdg/pi-multicodex/issues/4).
- A successful rename is a publication boundary for concurrent readers, but not a portable guarantee that the latest publication survives sudden power loss.

Primary sources:

- [Node.js 24.17.0 `fs.rename`](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html#fsrenameoldpath-newpath-callback)
- [POSIX `rename()`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html)
- [Node/libuv Unix rename implementation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/unix/fs.c#L1723)
- [Node/libuv Windows rename implementation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/fs.c#L2333-L2340)
- [Microsoft `MoveFileExW`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)

### 2. Exclusive refresh ownership

`open(path, "wx")` is the strongest portable Node-only acquisition primitive available for this design. Node maps exclusive creation to `O_CREAT | O_EXCL` on POSIX and `CREATE_NEW` on Windows. On supported local filesystems, only one contender creates a previously absent path.

The created file should be treated as a **lease record**, not as an OS-held lock. It should contain enough data to diagnose and reject stale work, including:

- a cryptographically or otherwise strongly unique owner/attempt token;
- account identity and account generation;
- acquisition and expiry timestamps;
- refresh mode or compatibility class;
- protocol/schema version.

Constraints:

- Never use `exists()` followed by ordinary creation; the check/create sequence races.
- A newly created but empty or unparseable lease may be a writer between creation and content publication. Give it a conservative initialization grace period before considering recovery.
- After acquiring ownership, reread canonical shared state before making the API request. Another process may have committed a usable result while this contender waited.
- Partition ownership per account. A refresh for one account must not contend with unrelated accounts.

Primary sources:

- [Node.js filesystem flags](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html#file-system-flags)
- [POSIX `open()` and `O_EXCL`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)
- [Microsoft `CREATE_NEW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Node/libuv Windows open mapping](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/fs.c#L499-L525)

### 3. Stale-owner recovery

Plain filesystem leases cannot provide strict at-most-once ownership through process crashes, suspension, host sleep, wall-clock changes, or a stale-reaper race. For example, a process can decide that owner A is stale, owner A can release, owner B can acquire the same path, and the reaper can then act on owner B's path. Re-reading and token checks narrow this race but do not make deletion or rename conditional on the observed token.

The same pathname ABA race affects ordinary release and renewal: an expired owner can resume and `unlink`, rename, rewrite, or update timestamps on a successor's lease. Every release, renewal, and reap path must therefore tolerate disturbing a successor. No available plain filesystem sequence makes the token comparison and pathname mutation one conditional atomic operation.

The protocol therefore must remain correct when two refreshes overlap.

Constraints:

- Lease duration must exceed the 10-second request timeout plus acquisition, publication, scheduling, and retry margin. Renewal may be needed if operations can exceed that bound.
- Do not use PID existence as proof of ownership or death. PIDs are reused and do not identify work across hosts or restarts.
- Prefer renaming a suspected stale lease to a unique same-directory quarantine path before cleanup, while recognizing that this still cannot establish strict conditional ownership. Apply conservative age/grace qualification before touching lease or quarantine debris.
- Every committed result should carry the attempt/owner token, account generation, and relevant timestamps for diagnosis and later rejection rules.
- Those fields do not by themselves order competing publications: rename-over is unconditional last-writer-wins, random tokens are unordered, and client wall-clock or response-completion timestamps do not prove response freshness.
- The contract, state model, and prototype tickets must choose and validate how a late expired owner is prevented from regressing accepted state—or explicitly constrain the design so such regression is harmless.
- Ownership is an API-request suppression optimization, not a correctness boundary.
- Missing leases, duplicate refreshes, and aged lease/quarantine debris are expected recovery states. Filename shape or mere presence is never sufficient to classify a path as orphaned.

This means the design can target **usually one request per account**, not guaranteed exactly-once or at-most-once execution.

### 4. Change notification

Watch a stable containing directory, not a replaceable state file. Node documents substantial `fs.watch()` caveats:

- behavior is not fully consistent across platforms;
- events may be unavailable or unreliable on NFS, SMB, and virtualized filesystems;
- `filename` may be absent;
- on Linux and macOS, a watch on a file remains attached to the old inode after delete/recreate;
- on Windows, moving or renaming the watched directory emits no events, while deleting it reports `EPERM`;

Therefore watcher events can only be wake-up hints.

Constraints:

- Coalesce/debounce events, then reread canonical state.
- Do not depend on event type, count, ordering, or filename.
- Rebind after watcher error or directory recreation. Because a Windows directory move can be silent, active wait periods also need an independent directory existence/identity check or a watch on a stable parent.
- Reconcile at startup; before freshness and ownership decisions; after waiting for ownership; after stale recovery; and when relevant process activity resumes after possible sleep.
- If bounded missed-event recovery requires polling, poll only while an observer or refresh waiter is active. Do not turn the system into permanent idle polling.
- `fs.watchFile()` is not a correctness substitute; Node documents it as stat polling and recommends `fs.watch()` when possible.

The existing `watchImportedOpenAICodexAuth()` implementation already follows the useful parts of this shape: it watches the directory, treats events as debounced hints, tolerates a missing target, and rebinds when directories appear.

Primary source:

- [Node.js 24.17.0 `fs.watch()` caveats](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html#fswatchfilename-options-listener)

### 5. Crash durability

`FileHandle.sync()` is the appropriate Node primitive for flushing file data, but Node notes that exact behavior is operating-system and device-specific.

- Linux requires a separate directory `fsync()` to ensure the directory entry itself reaches durable storage.
- On Apple platforms, Node 24's libuv attempts stronger synchronization mechanisms before falling back to `fsync()`.
- On Windows, libuv uses `FlushFileBuffers()` for file sync, while its rename path uses `MoveFileExW` without `MOVEFILE_WRITE_THROUGH`.
- Portable parent-directory syncing is not uniformly available through Node. In particular, Windows directory handles and `FlushFileBuffers()` access rules prevent relying on one cross-platform directory-sync sequence.

Consequences:

- Shared coordination state is a reconstructible cache and arbitration aid, never the sole source of business correctness.
- Startup and normal reconciliation must tolerate a missing canonical file, the previous canonical version, and aged temporary, lease, or quarantine debris. Cleanup must use grace periods and tolerate racing an active writer.
- The protocol must not promise that the newest rename survives sudden power loss on every supported platform/filesystem.

Primary sources:

- [Node.js 24.17.0 `FileHandle.sync()`](https://nodejs.org/download/release/v24.17.0/docs/api/fs.html#filehandlesync)
- [Linux `fsync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html)
- [Apple `fsync(2)` and `F_FULLFSYNC`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/fsync.2.html)
- [Node/libuv Apple sync implementation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/unix/fs.c#L170-L202)
- [Node/libuv Windows `FlushFileBuffers()` implementation](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/fs.c#L2343-L2353)
- [Microsoft `FlushFileBuffers()`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)

### 6. Open-handle and replacement behavior

On Unix, an already-open descriptor remains attached to the old file after replacement. Node/libuv opens Windows files with read, write, and delete sharing to approximate Unix behavior, so readers opened by Node normally do not prevent replacement. Other Windows software may open a path without delete sharing and temporarily block rename or deletion.

Constraints:

- Keep all state-file handles short-lived.
- Never cache an open descriptor as the shared-state view.
- Retry bounded sharing/access failures on Windows while retaining the prior valid canonical file.
- Reconciliation must reread by path after publication hints; an earlier open handle cannot observe replacement.

Primary sources:

- [Linux `rename(2)`](https://man7.org/linux/man-pages/man2/rename.2.html)
- [Node/libuv Windows sharing modes](https://github.com/nodejs/node/blob/v24.17.0/deps/uv/src/win/fs.c#L499-L513)
- [Microsoft `FILE_SHARE_DELETE`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

## Recommended protocol constraints

1. Support local filesystems only; document NFS, SMB, and virtualization-mounted roots as unsupported for coordination correctness.
2. Store credential-free shared usage state separately from `codex-accounts.json`, under the same agent-directory scope.
3. Partition canonical state and ownership by normalized account identity to avoid unrelated-account contention.
4. Publish canonical state with a same-directory unique temporary file, file sync, close, and rename-over sequence.
5. Acquire leases through exclusive creation, but design for overlapping stale and current owners rather than claiming at-most-once refresh.
6. Persist protocol version, owner token, account generation, refresh compatibility class, and relevant timestamps in state/lease records, while leaving the authoritative ordering/rejection rule to the state-model and prototype decisions.
7. Reconcile canonical state immediately after ownership acquisition and before fetching.
8. Make forced requests bypass freshness while still joining compatible live ownership and consuming its committed result.
9. Treat watcher events only as hints; correctness comes from rereading and validating canonical state.
10. Make publication and consumption idempotent where possible. Explicitly resolve and validate how unconditional late publication interacts with newer state and invalidated account generations.
11. Tolerate aged temporary, lease, and quarantine debris. Clean it only after conservative grace checks, with bounded work and race-tolerant failure handling.
12. Keep the coordination directory stable and handles short-lived.
13. Treat the latest state as reconstructible: never rely on its newest version surviving sudden power loss.

## Design implications for later tickets

- The coordination contract must explicitly accept occasional duplicate API requests during stale-owner recovery.
- Shared-state identity rules must define account generations and determine whether a filesystem-only publication protocol can reject late results before commit, or must instead preserve a newer accepted view despite an older canonical overwrite.
- The prototype should force owner termination, suspension beyond lease expiry, simultaneous stale recovery, missed watcher events, malformed canonical state, and Windows-style transient replacement failures.
- The integration design should reuse the existing process-local `UsageCoordinator`; the filesystem layer should feed snapshots, invalidation, and refresh arbitration into it rather than becoming a shared in-memory coordinator.
