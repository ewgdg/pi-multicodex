# pi-multicodex

![MultiCodex main panel](./assets/multicodex-main.png)

MultiCodex is a [pi](https://github.com/badlogic/pi-mono) extension that manages multiple ChatGPT Codex accounts and rotates between them automatically when you hit quota limits.

You add your Codex accounts once. After that, MultiCodex picks the best available account at session start and keeps that account sticky to preserve provider prompt-cache affinity. When one account runs dry mid-session, it switches to another and retries — no manual intervention needed.

## Provenance

This is a fork of [victor-software-house/pi-multicodex](https://github.com/victor-software-house/pi-multicodex), which in turn builds on [kim0/pi-multicodex](https://github.com/kim0/pi-multicodex) — the original extension that introduced Codex account rotation for pi.

The upstream (`victor-software-house/pi-multicodex`) is no longer maintained. This fork continues active development under `@ewgdg/pi-multicodex`.

## What's different in this fork

- **Renamed package.** Published as `@ewgdg/pi-multicodex`.
- **Self-contained.** Removed `pi-provider-utils` dependency — runtime utility seams live under `shared/` so the package works without pulling in extra dependencies.
- **Non-Codex model handling.** Skips MultiCodex startup entirely when the session model isn't a Codex model — no spurious errors or footer clutter.
- **Ongoing pi version compatibility.** Compatible with pi 0.80.8+ and its Models runtime/provider-auth interfaces.

### Rotation policy

- **Cache-aware rotation affinity.** Accounts with recent large-context sessions score higher, keeping prompt caches warm across turns.
- **Tier-weighted rotation scoring.** Plan tier (`free`, `plus`, `prolite`, `pro`) weighted into selection score so higher-capacity accounts carry more weight — reduces the chance of hitting the wall mid-session by preferring accounts with more quota headroom.
- **Weekly reset pressure prioritization.** Accounts nearing their weekly reset with remaining quota score higher — uses allowance before it expires rather than letting it roll over to waste.
- **Stale quota cooldown reconciliation.** Cleans up cooldowns that outlived their reset window automatically.

## Getting started

Install from npm:

```bash
pi install npm:@ewgdg/pi-multicodex
```

Restart pi. That is all you need — MultiCodex takes over the normal `openai-codex` provider path and auto-imports any Codex auth you have already set up in pi.

To manage your accounts inside a session, type `/multicodex`.

### Custom Codex transports

MultiCodex can route accounts through another extension's `openai-codex` transport, including `@howaboua/pi-codex-conversion`. No package order is required. MultiCodex registers managed-account auth without replacing the active transport, then wraps the effective Codex transport at session start.

## How it works

When you start a session, MultiCodex:

1. Imports your existing pi Codex auth automatically (if present) into the managed account pool.
2. Checks usage data across all managed accounts, including the imported pi login account.
3. Picks the best available account with a tier-weighted rotation score. The score uses plan hints from Codex usage metadata (`free` = 0.1x, `plus` = 1x, `prolite` = 5x, `pro` = 20x), weekly burn pressure, effective remaining quota, a soft 5-hour safety penalty, and cache affinity for recent large-context sessions.

For later requests in the same session, MultiCodex keeps using the active account instead of re-ranking every turn. It only selects another account when the active account becomes unavailable before output starts.

If you pin a specific account from `/multicodex accounts` or `/multicodex use`, that account is used until it hits quota, fails auth validation, or you clear the override.

When a request hits a quota or rate limit **before** any output is streamed, MultiCodex marks that account exhausted, picks the next available one, and retries. This happens up to 5 times transparently. If token validation or token refresh fails before the request starts, MultiCodex skips that account and retries another healthy one. If the manual override account fails, the override is cleared and rotation continues with the remaining accounts. Once output has started streaming, the error is surfaced as-is — no mid-stream account switching.

## Commands

Everything lives under one command: `/multicodex`.

| Command | What it does |
|---|---|
| `/multicodex` | Open the main interactive menu |
| `/multicodex accounts [identifier]` | Inspect account health, select an account, add one, or directly activate/login by identifier |
| `/multicodex use [identifier]` | Alias for `/multicodex accounts [identifier]` |
| `/multicodex show` | Alias for the account-management view; in non-interactive mode it prints per-account health lines |
| `/multicodex refresh [identifier\|all]` | Refresh token validity and usage data for one account or all accounts |
| `/multicodex reauth [identifier]` | Re-authenticate one account explicitly |
| `/multicodex footer` | Configure the usage footer display |
| `/multicodex rotation` | Show the current rotation policy |
| `/multicodex verify` | Check storage, settings, auth import, and reauth health |
| `/multicodex path` | Print storage and settings file locations |
| `/multicodex reset [manual\|quota\|all]` | Clear manual override, quota cooldowns, or both |
| `/multicodex help` | Print a compact usage line |

All subcommands support dynamic autocomplete. Account-focused subcommands autocomplete from the managed account list.

Commands that do not need a UI panel (`show`, `refresh`, `verify`, `path`, `reset`, `help`) work in non-interactive mode too.

## Account manager

The `/multicodex accounts` panel merges the old `show` and `use` flows into one place.

![MultiCodex use picker](./assets/multicodex-use-picker.png)

- **enter** activates the highlighted account.
- **u** refreshes token and usage health for the selected account.
- **r** re-authenticates the selected account.
- **n** starts login for a new managed account.
- **backspace** removes the selected account after confirmation.

Each row shows the account identifier, active/manual state, pi-auth origin, reauth state, quota state, and cached 5-hour and weekly usage windows.

When you remove an active account, MultiCodex switches to the next available one automatically.

![MultiCodex remove account confirmation](./assets/multicodex-remove-confirm.png)

## Usage footer

MultiCodex adds a live footer to your session showing the active account, 5-hour and 7-day usage percentages, and reset countdowns. The footer updates after every turn and on account switches.

You can customize which fields appear and their ordering with `/multicodex footer`.

![MultiCodex footer settings](./assets/multicodex-footer-settings.png)

## What it does under the hood

- **Provider override.** MultiCodex registers itself as the `openai-codex` provider. You do not need to select a different provider or change your model — it works with whatever Codex model you already use.
- **Auth import.** When pi has stored Codex OAuth credentials, MultiCodex imports them automatically into the same managed account pool used by manually added accounts and labels that account as `pi auth` in the UI.
- **Token refresh.** OAuth tokens are refreshed before expiry so requests do not fail due to stale credentials. You can also force a health refresh with `/multicodex refresh` or re-authenticate explicitly with `/multicodex reauth`.
- **Usage tracking.** Pi runtimes using the same agent directory share credential-free usage snapshots and normally coalesce per-account refresh work through advisory filesystem leases. Completed managed responses publish pending invalidation even in headless runtimes. Active observers reconcile at least every 30 seconds; there is no idle polling. When available, Codex plan metadata is used as a capacity hint for rotation scoring.
- **Quota cooldown.** When an account is exhausted, it stays on cooldown until the exhausted or most constrained known reset window clears (or 1 hour if reset time is unknown). Fresh 5-hour usage determines whether the cooldown is stale; when that window is unknown, weekly usage is used instead. Any remaining effective quota clears the cooldown immediately, including a fully reset window reporting 0% used.
- **Self-contained utility seams.** Stream primitives and `~/.pi/agent/*` path helpers live under `shared/` so the published package does not depend on a separate utility package for runtime wiring. MultiCodex still owns account storage, token policy, footer behavior, and command UX.

## Local development

This repo uses `mise` for tool versions and `pnpm` for dependency management.

```bash
mise install          # pin tool versions
pnpm install          # install dependencies
pnpm check            # lint + typecheck + test
npm pack --dry-run    # verify package contents
```

Run the extension directly during development:

```bash
pi -e ./src/index.ts
```

## Data storage

MultiCodex stores all data locally under `~/.pi/agent/`:

| File | Contents |
|---|---|
| `codex-accounts.json` | Managed account credentials and state |
| `settings.json` (key `pi-multicodex`) | Footer display preferences |
| `state/multicodex/usage-coordination/<sha256>/` | Credential-free shared usage state and short advisory leases |

Coordination paths use the full SHA-256 digest of the normalized account email; raw email addresses and credentials are never written to coordination artifacts. Coordination supports local filesystems only—NFS, SMB, and virtualization-mounted agent directories are outside its correctness contract. No data is sent anywhere except to the Codex API endpoints for auth refresh and usage queries.
