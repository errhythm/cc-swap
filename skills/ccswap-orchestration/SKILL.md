---
name: ccswap-orchestration
description: Helps a coding agent make quota-aware decisions with ccswap before fanning out subagents or switching accounts. Use for "check my quota", "am I going to run out", "can I fan out", "should we switch accounts", or "which account has headroom", for Claude Code or Codex CLI accounts. Covers reading ccswap list/status/codex JSON, computing headroom, and picking a switch strategy. Not for authoring cc-swap's own source, and not a general model-routing skill outside quota pressure.
license: MIT
compatibility: Requires the ccswap CLI and jq.
metadata:
  version: "1.0.0"
---

# ccswap orchestration

ccswap tracks quota across Claude Code and Codex CLI accounts and switches between them. Check quota before expensive work, decide when a switch is warranted.

## When to use this skill

- Session start: confirm quota before planning any work.
- Before fanning out 3 or more subagents, or any quota-heavy task.
- User asks "check my quota", "which account", "should I switch", "before we spawn agents", "do I have quota".
- Deciding whether to switch accounts, or which strategy to use.
- Not for: writing or fixing ccswap's own code, or model-choice questions unrelated to quota.

Full command surface, JSON schema, error envelope, and gotchas (staleness, disable vs live credential, the TUI trap, restart behavior per provider) live in `references/ccswap-cli.md`. Open it before scripting against ccswap, before interpreting an unfamiliar `usageStatus`, or before using a `switch`/`auto`/`codex` flag not covered below.

## Step 1: read quota, never guess

| Situation | Command |
|---|---|
| Session start, or before any 3+ agent fan-out (Claude) | `ccswap list --json --provider claude` |
| Same, for Codex accounts | `ccswap codex list --json` or `ccswap codex usage --json` |
| Both providers at once | `ccswap list --provider all --json` (nested `{"claude": {...}, "codex": {...}}`) |
| Quick check, active Claude account | `ccswap status --json` |
| Quick check, active Codex account | `ccswap codex status --json` |
| Preview autoswitch, no mutation | `ccswap auto --once --dry-run` or `ccswap codex auto --once --dry-run` |

Compute headroom yourself, do not trust one `pct` field alone. Headroom is `100 - max(pct)` across the windows that apply: `fiveHour.pct` and `sevenDay.pct` for Claude, `weekly.pct` for Codex, plus any per-model `scoped` window's `pct` if that model matters. Claude auto-switch can trip on any one of 5h, 7d, or a named model (Fable) using its own threshold (`autoswitch.threshold5h`, `autoswitch.threshold7d`, `autoswitch.modelThresholds`); an unset gate inherits `autoswitch.threshold`.

```bash
ccswap list --json --provider claude | jq '.accounts[] | {email, fiveHour: .usage.fiveHour.pct, sevenDay: .usage.sevenDay.pct, headroom: (100 - ([.usage.fiveHour.pct, .usage.sevenDay.pct] | max))}'
```

`headroom <= 0` means at or over limit. Treat missing or null `pct` (a non-`ok` `usageStatus`) as unknown, never silently skip that account, surface it instead.

## Step 2: decide whether to switch

| Condition | Action |
|---|---|
| Active near its limit AND another account clears headroom `> 0` everywhere | `ccswap switch --strategy best` (Claude) or `ccswap codex switch NUM` |
| Active near its limit, any viable account is fine | `ccswap switch --strategy next-available` (skips accounts at their limit) |
| Active near its limit, no candidate clears every window | Do not switch, report the exhaustion |
| Need one specific account | `ccswap switch NUM` or `EMAIL` (never with `--strategy`; `--model NAMES` only pairs with `--strategy`) |
| Target's live login is stale or broken | `ccswap switch NUM --force`, recovery only, skips backing up the current login |

Claude Code usually applies a switch without a restart (Linux/Windows re-read live; macOS just needs its ~30s Keychain cache to clear). Codex differs, see below.

## Step 3: gate the fan-out

| Fan-out size | Required check |
|---|---|
| 1-2 agents | None, proceed |
| 3+ agents, or dual plans | Run step 1. If active headroom `<= 0`, run step 2 before spawning |
| Every account exhausted | Stop, do not spawn. Save state, report done vs pending, quote `resetsAt`/`countdown`, ask the user |

This scales to any number of configured accounts. Never assume a single fallback, iterate every row `list --json` returns.

## Step 4: route models under quota pressure

Quota-driven guidance only, not a general model-picking rule.

| Situation | Guidance |
|---|---|
| Active account near its limit, work queued | Prefer your cheaper or faster tier over your most expensive one |
| A per-model `scoped` window exists for the model you'd route to | Check its `pct` first, a model can be exhausted while other windows still have room |
| No account clears headroom for the tier you need | Switch (step 2) or defer, do not escalate to a pricier tier to force it through |

## Codex specifics

- Codex reads `auth.json` once at startup and never re-reads it. Codex ALWAYS needs a manual restart (quit and relaunch, or reload the IDE extension) after `ccswap codex switch` or `ccswap codex auto`, unlike Claude Code which usually applies a switch live.
- Read-only: `ccswap codex list`, `ccswap codex status`, `ccswap codex usage` (all accept `--json`).
- Mutating: `ccswap codex switch [NUM|EMAIL]` and `ccswap codex auto [--once] [--dry-run]`. Bare `ccswap codex auto` runs a foreground loop, use `--once` in scripts.
- `ccswap list --provider all --json` nests Codex under `.codex` with `weekly` usage, not `fiveHour`, since Codex has no 5-hour window.

## Every account exhausted

If every account checked, across every provider, shows headroom `<= 0` in a needed window, stop polling, one `list --json` call already answered it. Summarize done vs queued work, quote the soonest `resetsAt`, ask the user how to proceed.
