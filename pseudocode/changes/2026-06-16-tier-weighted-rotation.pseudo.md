---
affects:
  - usage.ts
  - usage-client.ts
  - selection.ts
  - account-manager.ts
  - hooks.ts
  - extension.ts
  - commands.ts
  - index.ts
---

# Tier-weighted rotation policy

## Intent

Use Codex plan tier and reset windows to pick accounts that burn expiring weekly quota while avoiding accounts likely to run out during the short reset window.

## Behavior

```pseudo
when parsing Codex usage response:
  read primary_window and secondary_window usage percent and reset time
  read plan_type when present
  read window length metadata when present
  keep unknown fields optional so older or changed API responses still parse

normalize plan type:
  lower-case plan text
  remove separators and known ChatGPT/OpenAI wrapper words where practical
  map free-like plans to free
  map plus-like plans to plus
  map pro-lite/prolite-like plans to prolite
  map pro-like plans to pro
  otherwise use unknown

capacity multiplier defaults:
  free -> 0.1
  plus -> 1
  go -> 0.5
  prolite -> 5
  pro -> 20
  unknown/team/business/enterprise/edu -> 1

when selecting best account:
  exclude unavailable, reauth-needed, cooldown, and retry-excluded accounts
  refresh usage outside this module before ranking, as today

  for each candidate with known usage:
    primaryRemainingPercent = 100 - primary_window.used_percent when known
    weeklyRemainingPercent = 100 - secondary_window.used_percent when known
    capacityMultiplier = multiplier for plan_type, or 1 if unknown

    primaryRemainingUnits = primaryRemainingPercent / 100 * capacityMultiplier
    weeklyRemainingUnits = weeklyRemainingPercent / 100 * capacityMultiplier
    if secondary reset is in the future:
      hoursUntilWeeklyReset = time until secondary reset, minimum small positive value
      weeklyBurnPressure = weeklyRemainingUnits / (hoursUntilWeeklyReset ^ 1.5)
      this makes reset timing dominate enough that near-reset leftover quota beats far-reset large quota
    otherwise:
      weeklyBurnPressure = 0 because stale expired reset data must not look urgent

    primaryGatePenalty:
      if primaryRemainingUnits is near zero, strongly penalize account
      else if primaryRemainingUnits is thin, lightly penalize account
      do not hard-block unless every alternative is unusable; quota retry remains final guard

    score = weighted sum of:
      weekly burn pressure, normalized against candidate set
      primary remaining units, normalized against candidate set
      effective remaining units, min(primary, weekly), normalized against candidate set, with lower weight than weekly pressure so low weekly quota near reset is not over-penalized
      primary gate penalty
      usage confidence bonus
      cache affinity bonus for the active account when caller supplies cache context

    cache affinity bonus:
      applies only to current active account
      cacheFreshness = exp(-age since last Codex assistant response / 1 hour)
      contextPressure = 1 - exp(-context tokens / 64000)
      bonus = max affinity weight * cacheFreshness * contextPressure
      this strongly protects fresh large-context sessions while allowing small or stale sessions to rerank

  prefer higher score
  break ties by earlier weekly reset
  fall back to random available account only when no usable usage data exists

quota exhaustion cooldown:
  when quota error happens before streaming, refresh usage
  choose cooldown reset based on exhausted or most constrained window rather than blindly earliest reset
  use fallback cooldown only when reset data is unavailable

when showing rotation policy:
  describe tier-weighted scoring, weekly burn pressure, soft 5-hour safety penalty, cache affinity, active stickiness, pre-stream retry, and cooldown behavior
  do not describe the removed lowest-percent selection policy

on session start for existing conversations:
  inspect current branch for last Codex assistant response
  skip malformed assistant timestamps and continue scanning older entries
  use context usage tokens when available, otherwise fallback to last Codex assistant token usage
  pass cache affinity context into startup ranking for reasons other than new conversation
  do not give cache affinity bonus for a new conversation

while startup account selection is in progress:
  account manager exposes initializing state
  footer renders a neutral selecting-account message instead of stale active account
  footer does not refresh usage for the previous active account until initialization finishes
```
