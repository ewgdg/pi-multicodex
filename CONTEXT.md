# MultiCodex

MultiCodex manages Codex accounts and presents their quota availability during agent activity.

## Language

**Usage consumption event**:
A signal that a Codex model response completed and may have consumed account quota.
_Avoid_: Turn-end event, subagent usage event

**Pending usage invalidation**:
Knowledge retained by connected runtimes and the Usage Broker that quota may have been consumed after the refresh work represented by the newest snapshot began. Signals coalesce, and the pending invalidation becomes refresh-eligible when that snapshot loses freshness.
_Avoid_: Dirty cache, immediate expiration

**Usage snapshot**:
Codex-reported quota state for an account at a specific time, including usage windows and reset times.
_Avoid_: Turn cost, local usage estimate

**Snapshot freshness**:
Whether the newest accepted usage snapshot is recent enough to satisfy an automatic refresh request. Failed refresh attempts do not renew freshness.
_Avoid_: Last-attempt freshness, cache validity

**Usage Coordinator**:
The authority that shares usage snapshots and coordinates refresh eligibility across sessions in one Pi runtime.
_Avoid_: Footer controller, account-local usage cache

**Usage coordination scope**:
The Pi runtimes that use the same MultiCodex account store and therefore coordinate usage snapshots and refresh work.
_Avoid_: Process tree, launcher group

**Managed account identity**:
The trimmed, lowercase account email used across credential changes, removal, and later re-addition. OpenAI account ID does not alter this identity; a different email is a different managed account.
_Avoid_: OpenAI account ID, display email

**Usage Broker**:
An auto-spawned, ephemeral local process that coordinates credential-free usage snapshots, invalidation, retry suppression, and refresh assignments for one usage coordination scope. It exits when no runtimes remain connected.
_Avoid_: Persistent daemon, shared Usage Coordinator

**Broker usage state**:
Credential-free usage snapshots and refresh coordination metadata held in memory by the Usage Broker and reconstructed from connected runtimes after broker restart.
_Avoid_: Durable usage state, shared account storage

**Locally available snapshot**:
A validated usage snapshot retained by one process while the Usage Broker is unavailable or restarting. It may seed reconstructed broker state after reconnection.
_Avoid_: Broker-accepted snapshot, durable snapshot

**Active usage monitoring**:
Refreshing usage snapshots while Codex responses are actively consuming quota, without polling during idle periods.
_Avoid_: Footer polling, continuous polling

**Awaited usage refresh**:
A refresh request whose caller waits for a usable snapshot or refresh failure, including startup checks and explicit refresh commands.
_Avoid_: Blocking refresh, foreground refresh

**Forced usage refresh**:
An awaited refresh that bypasses snapshot freshness and retry suppression but joins compatible refresh work already in flight.
_Avoid_: Unconditionally duplicated refresh, forced follow-up

**Background usage refresh**:
A refresh request triggered by active usage monitoring that never delays model work or snapshot rendering.
_Avoid_: Fire-and-forget fetch, passive refresh

**Refresh demand**:
A process-local reason to perform or await refresh work, such as an active usage observer, startup selection, or an explicit command. Shared invalidation alone does not require the process that records it to fetch.
_Avoid_: Shared observer, global subscriber

**Compatible refresh work**:
Refresh work for the same managed account identity whose result can satisfy another request, regardless of which runtime started it.
_Avoid_: Shared promise, owner process work

**Superseded refresh attempt**:
Refresh work whose ownership was validly succeeded during stale-owner recovery. Its result can never become accepted, even if it completes after its successor.
_Avoid_: Late winner, newest completion

**Retry suppression**:
A short shared period after failed refresh work during which automatic requests retain stale status without starting another API call. It does not make a snapshot fresh, and forced requests bypass it.
_Avoid_: Failure freshness, error cache

**Interactive session**:
The user-facing agent session that owns and displays the MultiCodex footer.
_Avoid_: Main process, parent UI

**Headless session**:
An agent session without its own visible footer, such as a subagent or workflow agent.
_Avoid_: Child process, background-only session
