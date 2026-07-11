"""Quota-based switching for file-backed Codex accounts.

Codex has a separate credential store and does not share Claude Code's
credential-lock/token-refresh protocol, so it deliberately uses a compact
engine rather than ``AutoSwitchEngine``. It changes ``$CODEX_HOME/auth.json``
for the *next* Codex launch; an already running Codex session must be restarted
to pick up the selected account.
"""

from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable
from pathlib import Path

from claude_swap.autoswitch import (
    AllExhaustedEvent,
    AutoSwitchEvent,
    ErrorEvent,
    NoSwitchEvent,
    PollEvent,
    SwitchEvent,
    TickOutcome,
    binding_pct,
)
from claude_swap.codex import CodexAccountSwitcher, _codex_restart_hint
from claude_swap.locking import FileLock
from claude_swap.settings import AutoSwitchSettings, atomic_write_json

STATE_FILENAME = "codex_autoswitch_state.json"
STATE_SCHEMA_VERSION = 1


def _ref(number: str, email: str) -> dict:
    return {"number": int(number), "email": email}


class CodexAutoSwitchEngine:
    """Switch saved Codex accounts once their binding quota reaches a limit."""

    def __init__(
        self,
        switcher: CodexAccountSwitcher,
        settings: AutoSwitchSettings,
        on_event: Callable[[AutoSwitchEvent], None],
        *,
        dry_run: bool = False,
        state_path: Path | None = None,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.switcher = switcher
        self.settings = settings
        self.on_event = on_event
        self.dry_run = dry_run
        self.state_path = state_path or (switcher.backup_dir / STATE_FILENAME)
        self.clock = clock
        self._stop = threading.Event()

    def _state_lock(self) -> FileLock:
        return FileLock(self.state_path.parent / ".codex_autoswitch_state.lock")

    def _read_state(self) -> dict:
        try:
            raw = json.loads(self.state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, UnicodeDecodeError):
            return {}
        return raw if isinstance(raw, dict) else {}

    def _in_cooldown(self, state: dict) -> bool:
        last = state.get("lastSwitchAt")
        return isinstance(last, (int, float)) and (
            self.clock() - last < self.settings.cooldown_seconds
        )

    def _emit(self, event: AutoSwitchEvent) -> None:
        self.on_event(event)

    def tick(self) -> TickOutcome:
        """Fetch usage, choose the best eligible account, and switch if needed."""
        try:
            return self._tick()
        except Exception as exc:
            self._emit(ErrorEvent(message=f"{type(exc).__name__}: {exc}"))
            return TickOutcome.ERROR

    def _tick(self) -> TickOutcome:
        snapshot = self.switcher.accounts_snapshot(fetch=None)
        accounts = {account.number: account for account in snapshot.accounts}
        current = snapshot.active_number
        if current is None or current not in accounts:
            self._emit(PollEvent(active=None, headroom={}, threshold=self.settings.threshold))
            self._emit(
                NoSwitchEvent(
                    reason="no-active-account",
                    detail="log in and run 'ccswap codex add' first",
                )
            )
            return TickOutcome.NO_ACTION

        usage = {
            number: account.usage.last_good
            if account.usage.sentinel is None
            else None
            for number, account in accounts.items()
        }
        headroom = {
            number: (100.0 - pct) if (pct := binding_pct(value)) is not None else None
            for number, value in usage.items()
        }
        active = accounts[current]
        self._emit(
            PollEvent(
                active=_ref(current, active.email),
                headroom=headroom,
                threshold=self.settings.threshold,
                fetch_errors={
                    number: account.usage.last_error
                    for number, account in accounts.items()
                    if usage[number] is None and account.usage.last_error
                },
            )
        )

        if active.kind == "api_key":
            self._emit(
                NoSwitchEvent(
                    reason="active-api-key",
                    detail="API-key accounts have no subscription quota to watch",
                )
            )
            return TickOutcome.NO_ACTION

        active_headroom = headroom[current]
        if active_headroom is None:
            self._emit(
                NoSwitchEvent(
                    reason="active-usage-unknown",
                    detail="will not switch without a reliable active quota reading",
                )
            )
            return TickOutcome.NO_ACTION
        active_pct = 100.0 - active_headroom
        if active_pct < self.settings.threshold:
            self._emit(
                NoSwitchEvent(
                    reason="below-threshold",
                    detail=f"{active_pct:.0f}% < {self.settings.threshold:.0f}%",
                )
            )
            return TickOutcome.NO_ACTION
        trigger = "at-limit" if active_headroom <= 0 else "proactive"

        state = self._read_state()
        if trigger == "proactive" and self._in_cooldown(state):
            self._emit(NoSwitchEvent(reason="cooldown"))
            return TickOutcome.NO_ACTION

        candidates = [
            account
            for number, account in accounts.items()
            if number != current and account.switchable and account.kind == "oauth"
        ]
        if not candidates:
            self._emit(NoSwitchEvent(reason="no-candidates"))
            return TickOutcome.BLOCKED

        qualifying: list[tuple[float, str]] = []
        hysteresis_bar = self.settings.threshold - self.settings.hysteresis_pct
        for account in candidates:
            candidate_headroom = headroom[account.number]
            if candidate_headroom is None or candidate_headroom <= 0:
                continue
            candidate_pct = 100.0 - candidate_headroom
            if trigger == "proactive" and (
                candidate_pct > hysteresis_bar
                or candidate_headroom <= active_headroom
            ):
                continue
            qualifying.append((candidate_headroom, account.number))
        qualifying.sort(reverse=True)

        if not qualifying:
            if all(
                candidate_headroom is not None and candidate_headroom <= 0
                for candidate_headroom in (headroom[account.number] for account in candidates)
            ):
                self._emit(AllExhaustedEvent(earliest_reset_at=None))
            else:
                self._emit(NoSwitchEvent(reason="no-qualifying-candidate"))
            return TickOutcome.BLOCKED

        target = accounts[qualifying[0][1]]
        return self._perform(current, active.email, target.number, target.email, trigger)

    def _perform(
        self,
        current: str,
        current_email: str,
        target: str,
        target_email: str,
        trigger: str,
    ) -> TickOutcome:
        if self.dry_run:
            self._emit(
                SwitchEvent(
                    trigger=trigger,
                    from_ref=_ref(current, current_email),
                    to_ref=_ref(target, target_email),
                    warnings=[_codex_restart_hint()],
                    dry_run=True,
                )
            )
            return TickOutcome.SWITCHED

        with self._state_lock():
            state = self._read_state()
            if trigger == "proactive" and self._in_cooldown(state):
                self._emit(NoSwitchEvent(reason="cooldown"))
                return TickOutcome.NO_ACTION
            result = self.switcher.switch_to(target, json_output=True)
            if not result.get("switched"):
                self._emit(NoSwitchEvent(reason="already-active"))
                return TickOutcome.NO_ACTION
            state["schemaVersion"] = STATE_SCHEMA_VERSION
            state["lastSwitchAt"] = self.clock()
            state["lastSwitchTo"] = target
            atomic_write_json(self.state_path, state)

        self._emit(
            SwitchEvent(
                trigger=trigger,
                from_ref=result.get("from"),
                to_ref=result.get("to"),
                warnings=[_codex_restart_hint()],
            )
        )
        return TickOutcome.SWITCHED

    def stop(self) -> None:
        self._stop.set()

    def run_loop(self) -> int:
        self._stop.clear()
        while not self._stop.is_set():
            self.tick()
            self._stop.wait(self.settings.interval_seconds)
        return 0
