# ccswap mod for Claude Code

A Claude Code mod that shows your [ccswap](https://github.com/errhythm/ccswap) accounts inside the session. It reads everything from the `ccswap` CLI on your PATH (`ccswap list --json`), so install ccswap first (`uv tool install ccswap`).

- `/ccswap` lists accounts with 5h and 7d usage. `/ccswap best`, `/ccswap next`, or `/ccswap <slot|email>` switches accounts. `/ccswap pane` opens the accounts pane, and `/ccswap refresh` re-reads usage. Each command answers right away, without starting a Claude turn.
- A toast appears when the active account changes. The mod polls every 60s, so it also catches switches made by `ccswap auto` or the menu bar.
- The pane opens with keyboard focus and has four tabs: `c` Claude (5h and 7d bars, the slot's digit switches to it), `x` Codex (the slot's digit switches; restart Codex afterwards), `h` History (recent switches from ccswap's log) and `s` Settings (`t` threshold, `g` strategy, `w` binding windows, `l` statusline). `r` refreshes the open tab, Esc closes the pane.
- A band above the prompt appears once the active account's binding window reaches `autoswitch.threshold` (default 90%). It names the account with the most headroom, and its button switches there. Typing that digit into an empty prompt presses it.

## Install

```
claude plugin marketplace add errhythm/ccswap
claude plugin install ccswap@ccswap
```

Or, inside a session: `/plugin install ccswap --marketplace errhythm/ccswap`.

After a switch, Claude Code can take about 30s to pick up the new login (macOS Keychain cache). If it doesn't, restart Claude Code.

## Develop

```
claude plugin validate mod
claude plugin test mod
claude --plugin-dir mod
```
