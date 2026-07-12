# MultiCodex

MultiCodex manages Codex accounts and presents their quota availability during agent activity.

## Language

**Usage consumption event**:
A signal that a Codex model response completed and may have consumed account quota.
_Avoid_: Turn-end event, subagent usage event

**Usage snapshot**:
Codex-reported quota state for an account at a specific time, including usage windows and reset times.
_Avoid_: Turn cost, local usage estimate

**Usage Coordinator**:
The authority that shares usage snapshots and coordinates refresh eligibility across sessions in one Pi runtime.
_Avoid_: Footer controller, account-local usage cache

**Active usage monitoring**:
Refreshing usage snapshots while Codex responses are actively consuming quota, without polling during idle periods.
_Avoid_: Footer polling, continuous polling

**Interactive session**:
The user-facing agent session that owns and displays the MultiCodex footer.
_Avoid_: Main process, parent UI

**Headless session**:
An agent session without its own visible footer, such as a subagent or workflow agent.
_Avoid_: Child process, background-only session
