# MultiCodex

MultiCodex manages Codex accounts and presents their quota availability during agent activity.

## Language

**Usage consumption event**:
A signal that a Codex model response completed and may have consumed account quota.
_Avoid_: Turn-end event, subagent usage event

**Pending usage invalidation**:
Durable knowledge that quota may have been consumed after the refresh work represented by the newest snapshot began. Signals coalesce, and the pending invalidation becomes refresh-eligible when that snapshot loses freshness.
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

**Shared usage state**:
Durable, credential-free usage snapshots and refresh coordination metadata shared within one usage coordination scope. Each managed account identity has one mutable state document.
_Avoid_: Shared coordinator, shared account storage

**Refresh outcome**:
Credential-free completion status for one refresh attempt, recorded separately from snapshot data so stale usage cannot masquerade as fresh confirmation.
_Avoid_: Cached error, snapshot status

**Locally available snapshot**:
A validated usage snapshot usable by one process when cross-process publication fails. It does not renew shared freshness and may be superseded during later reconciliation.
_Avoid_: Accepted shared snapshot, successful publication

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

**Refresh lease**:
An expiring per-account filesystem claim that suppresses duplicate refresh work during normal operation. It is not strict ownership: stale recovery may overlap a resumed owner, and the last published state may temporarily win.
_Avoid_: File lock, correctness boundary

**State-write lease**:
A short expiring per-account filesystem claim that serializes ordinary read-merge-publish mutations of shared usage state. Crash recovery may overlap a suspended writer, so it reduces lost updates without claiming strict mutual exclusion.
_Avoid_: Permanent lock, transaction lock

**Retry suppression**:
A short shared period after failed refresh work during which automatic requests retain stale status without starting another API call. It does not make a snapshot fresh, and forced requests bypass it.
_Avoid_: Failure freshness, error cache

**Interactive session**:
The user-facing agent session that owns and displays the MultiCodex footer.
_Avoid_: Main process, parent UI

**Headless session**:
An agent session without its own visible footer, such as a subagent or workflow agent.
_Avoid_: Child process, background-only session
