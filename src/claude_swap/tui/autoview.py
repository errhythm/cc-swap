"""Live auto-switch screen: the active provider's engine, visualized.

Runs :class:`AutoSwitchEngine` in a thread worker and renders its typed
events. Opens in **dry-run** — opening a view must never start switching
accounts on its own; going live is an explicit, confirmed action. The
engine's own state file semantics make it safe to run alongside an external
``ccswap auto`` process.

The active account's full card sits on top (same widget as the dashboard's
panel, with the threshold tick); this screen adds the engine badge, the
ranked switch candidates, and the decision log. While it is up, the app's
snapshot poller runs store-only: the engine is the only fetcher.
"""

from __future__ import annotations

from dataclasses import replace
from typing import TYPE_CHECKING

from rich.text import Text
from textual.app import ComposeResult
from textual.binding import Binding
from textual.containers import Horizontal, Vertical
from textual.screen import Screen
from textual.widgets import Footer, RichLog, Static

from claude_swap.autoswitch import (
    AutoSwitchEngine,
    AutoSwitchEvent,
    binding_pct,
    pct_label,
)
from claude_swap.codex_autoswitch import CodexAutoSwitchEngine
from claude_swap.models import AccountsSnapshot
from claude_swap.settings import (
    SETTING_SPECS,
    effective_model_names,
    gate_thresholds,
    load_settings,
    parse_model_names,
    parse_model_thresholds,
    parse_window_selection,
)
from claude_swap.tui import data
from claude_swap.tui.modals import ConfirmModal
from claude_swap.tui.theme import Palette
from claude_swap.tui.widgets import AccountsPanel

if TYPE_CHECKING:
    from claude_swap.tui.app import CswapApp

_EVENT_ROLES = {
    "switch": "accent",
    "error": "sev_warn",
    "account-quarantined": "sev_warn",
    "all-exhausted": "sev_crit",
}
_QUIET_KINDS = {"poll", "no-switch", "sleep", "account-unquarantined"}


def event_text(
    event: AutoSwitchEvent, *, palette: Palette = Palette.DARK, mask: bool = False
) -> Text:
    """Log line for one engine event, styled like the CLI's human renderer.

    ``mask`` redacts mailboxes in the human line only. The engine's own
    ``human()`` stays intact for the CLI.
    """
    role = _EVENT_ROLES.get(event.kind)
    if role is not None:
        style = getattr(palette, role)
    else:
        style = palette.muted if event.kind in _QUIET_KINDS else palette.foreground
    body = data.mask_emails_in_text(event.human()) if mask else event.human()
    text = Text()
    text.append(f"{data.clock_stamp()}  ", style=palette.muted)
    text.append(body, style=style)
    return text


class AutoScreen(Screen):
    BINDINGS = [
        Binding("l", "toggle_live", "Go live / dry-run"),
        Binding("t", "adjust_threshold", "Threshold"),
        Binding("left", "threshold_step(-1)", "-1%"),
        Binding("right", "threshold_step(1)", "+1%"),
        Binding("enter", "adjust_done", "Done"),
        Binding("escape,q", "back", "Back"),
    ]

    app: "CswapApp"

    def __init__(self, provider: str) -> None:
        super().__init__()
        self.provider = provider
        self._engine: AutoSwitchEngine | CodexAutoSwitchEngine | None = None
        self._settings = None
        # Session-only threshold adjustment (t, then arrows). Never written
        # to settings.json — same memory-only precedent as the dry-run
        # toggle. ``_configured_threshold`` is the mount-time file value the
        # screen reverts to on exit; ``_entry_threshold`` is the value when
        # adjust mode was entered (wake/log only on a net change).
        self._adjusting = False
        self._configured_threshold: float | None = None
        self._entry_threshold: float | None = None
        # Notes and events, so toggling the mask can redraw the log. The
        # engine does not keep a transcript of its own.
        self._log_items: list[tuple[str, str | AutoSwitchEvent]] = []

    def compose(self) -> ComposeResult:
        yield AccountsPanel(
            show_minis=False,
            provider=self.provider,
            id="auto-active-panel",
        )
        with Vertical(id="auto-top"):
            with Horizontal(id="auto-title-row"):
                yield Static(" DRY-RUN ", id="mode-badge", classes="dry")
                yield Static("", id="auto-summary")
            yield Static("", id="candidates")
        yield RichLog(id="event-log", highlight=False, markup=False, wrap=True)
        yield Footer()

    # -- lifecycle ----------------------------------------------------------

    def on_mount(self) -> None:
        self.app.set_store_only(self.provider, True)
        switcher = self.app.switcher_for(self.provider)
        self._settings = load_settings(switcher.backup_dir)
        # The bar tick everywhere reads app.threshold_pct, loaded once at app
        # startup — sync it to the fresh file value so bars and engine agree,
        # and remember that value: unmount restores it (only the session
        # adjustment reverts, not this correction).
        self._configured_threshold = self._settings.threshold
        self.app.threshold_pct = self._settings.threshold
        self._update_summary()
        self.watch(self.app, "snapshots", self._on_snapshots)
        self.watch(self.app, "theme", self._on_theme_change)
        self.watch(self.app, "mask_accounts", self._on_mask_change)
        self._start_engine(dry_run=True)

    def on_unmount(self) -> None:
        if self._engine is not None:
            self._engine.stop()
        # A session threshold must not outlive the engine it steered: unpin
        # the poll planner and put the bar tick back on the file value.
        self.app.switcher_for(self.provider).clear_poll_policy_inputs()
        if self._configured_threshold is not None:
            self.app.threshold_pct = self._configured_threshold
        self.app.set_store_only(self.provider, False)

    def _on_theme_change(self, _theme: str) -> None:
        self._update_summary()
        self._update_badge()
        snap = self.app.snapshots[self.provider]
        if snap is not None:
            self._on_snapshot(snap)

    def action_back(self) -> None:
        if self._adjusting:
            self._end_adjust()
            return
        self.app.pop_screen()

    # -- threshold adjust mode ------------------------------------------------

    def check_action(self, action: str, parameters: tuple) -> bool | None:
        if action in ("threshold_step", "adjust_done") and not self._adjusting:
            return False  # hidden and inert until adjust mode is armed
        return True

    def action_adjust_threshold(self) -> None:
        if self._adjusting:
            self._end_adjust()
            return
        self._adjusting = True
        self._entry_threshold = self._settings.threshold
        self._update_summary()
        self.refresh_bindings()

    def action_adjust_done(self) -> None:
        if self._adjusting:
            self._end_adjust()

    def action_threshold_step(self, delta: float) -> None:
        if not self._adjusting:
            return
        spec = SETTING_SPECS["autoswitch.threshold"]
        value = min(spec.hi, max(spec.lo, self._settings.threshold + delta))
        self._set_threshold(value)

    def _end_adjust(self) -> None:
        self._adjusting = False
        self._update_summary()
        self.refresh_bindings()
        if self._settings.threshold == self._entry_threshold:
            return  # no net change: nothing to announce, no tick to force
        if self._engine is not None:
            self._engine.wake()  # show a decision at the new value now
        self._log_note(
            f"— threshold set to {pct_label(self._settings.threshold)}% "
            "for this session —"
        )

    def _set_threshold(self, value: float) -> None:
        if value == self._settings.threshold:
            return
        self._settings = replace(self._settings, threshold=value)
        if self._engine is not None:
            self._engine.apply_threshold(value)
        self.app.threshold_pct = value
        self.query_one("#auto-active-panel", AccountsPanel).refresh()
        self._update_summary()

    def _update_summary(self) -> None:
        palette = Palette.from_theme(self.app.current_theme)
        text = Text()
        text.append("auto-switch · ")
        text.append(
            f"threshold {pct_label(self._settings.threshold)}%",
            style=palette.accent if self._adjusting else "",
        )
        gates = []
        if self._settings.threshold_5h is not None:
            gates.append(f"5h {pct_label(self._settings.threshold_5h)}%")
        if self._settings.threshold_7d is not None:
            gates.append(f"7d {pct_label(self._settings.threshold_7d)}%")
        for name, pct in parse_model_thresholds(self._settings.model_thresholds):
            gates.append(f"{name} {pct_label(pct)}%")
        if gates:
            text.append(" · " + " ".join(gates))
        if self._settings.threshold != self._configured_threshold:
            text.append(" (session)", style=palette.muted)
        text.append(f" · poll every {self._settings.interval_seconds:.0f}s")
        if self.app.mask_accounts:
            text.append(" · masked", style=palette.muted)
        if self._adjusting:
            text.append("   ← → adjust · enter done", style=palette.muted)
        self.query_one("#auto-summary", Static).update(text)

    # -- engine -------------------------------------------------------------

    def _start_engine(self, *, dry_run: bool) -> None:
        engine_type = AutoSwitchEngine if self.provider == "claude" else CodexAutoSwitchEngine
        engine = engine_type(
            self.app.switcher_for(self.provider),
            self._settings,
            self._emit_from_thread,
            dry_run=dry_run,
        )
        self._engine = engine
        self.run_worker(
            engine.run_loop,
            thread=True,
            group="engine",
            exit_on_error=False,
            name=f"auto-engine-{'dry' if dry_run else 'live'}",
        )
        self._update_badge()
        mode = "DRY-RUN (watching only)" if dry_run else "LIVE (will switch accounts)"
        self._log_note(f"— engine started: {mode} —")

    def _emit_from_thread(self, event: AutoSwitchEvent) -> None:
        """Engine ``on_event`` callback — runs on the worker thread."""
        try:
            self.app.call_from_thread(self._on_engine_event, event)
        except Exception:
            # App/screen tearing down mid-tick; the event has nowhere to go.
            pass

    def _on_engine_event(self, event: AutoSwitchEvent) -> None:
        if not self.is_attached:
            return
        self._log_items.append(("event", event))
        self._write_log_item(("event", event))
        if event.kind == "switch":
            self.app.request_refresh(self.provider)

    def _log_note(self, note: str) -> None:
        item: tuple[str, str | AutoSwitchEvent] = ("note", note)
        self._log_items.append(item)
        self._write_log_item(item)

    def _write_log_item(self, item: tuple[str, str | AutoSwitchEvent]) -> None:
        if not self.is_mounted:
            return
        palette = Palette.from_theme(self.app.current_theme)
        kind, payload = item
        log = self.query_one("#event-log", RichLog)
        if kind == "note":
            log.write(Text(str(payload), style=palette.muted))
            return
        assert isinstance(payload, AutoSwitchEvent)
        log.write(
            event_text(payload, palette=palette, mask=self.app.mask_accounts)
        )

    def _repaint_log(self) -> None:
        if not self.is_mounted:
            return
        log = self.query_one("#event-log", RichLog)
        log.clear()
        for item in self._log_items:
            self._write_log_item(item)

    def _on_mask_change(self, _on: bool) -> None:
        self._update_summary()
        self._on_snapshot(self.app.snapshots[self.provider])
        self._repaint_log()

    def action_toggle_live(self) -> None:
        if self._engine is None:
            return
        if self._engine.dry_run:
            self.app.push_screen(
                ConfirmModal(
                    "Go live? ccswap will switch your active account "
                    "automatically when the threshold is reached.\n\n"
                    "(Same behavior as the provider's `ccswap auto` command.)",
                    title="Go live",
                    yes_label="Go live",
                ),
                self._on_live_confirm,
            )
        else:
            self._restart_engine(dry_run=True)

    def _on_live_confirm(self, confirmed: bool | None) -> None:
        if confirmed:
            self._restart_engine(dry_run=False)

    def _restart_engine(self, *, dry_run: bool) -> None:
        if self._engine is not None:
            self._engine.stop()
        self._start_engine(dry_run=dry_run)

    def _update_badge(self) -> None:
        badge = self.query_one("#mode-badge", Static)
        if self._engine is not None and not self._engine.dry_run:
            badge.update(" LIVE ")
            badge.set_classes("live")
        else:
            badge.update(" DRY-RUN ")
            badge.set_classes("dry")

    # -- candidates -----------------------------------------------------------

    def _on_snapshot(self, snap: AccountsSnapshot | None) -> None:
        if snap is None:
            return
        self.query_one("#candidates", Static).update(
            self._candidates_text(snap, active_number=snap.active_number)
        )

    def _on_snapshots(
        self, snapshots: dict[str, AccountsSnapshot | None]
    ) -> None:
        self._on_snapshot(snapshots[self.provider])

    def _candidates_text(
        self, snap: AccountsSnapshot, active_number: str | None
    ) -> Text:
        """Switch targets ranked by remaining headroom (best first)."""
        # Same window set as the engine (autoswitch.model and
        # autoswitch.windows included), so the displayed ranking can never
        # disagree with the account it picks.
        palette = Palette.from_theme(self.app.current_theme)
        claude = self.provider == "claude" and self._settings is not None
        if claude:
            models = effective_model_names(self._settings)
            overrides = gate_thresholds(self._settings).overrides
        else:
            models = parse_model_names(self._settings.model) if self._settings else ()
            overrides = {}
        windows = (
            parse_window_selection(self._settings.windows)
            if self._settings
            else ("5h", "7d")
        )
        ranked: list[tuple[float, str]] = []  # (sort key: pct used, number)
        lines: dict[str, Text] = {}
        for acc in snap.accounts:
            if acc.number == active_number or not acc.switchable:
                continue
            pct = binding_pct(
                acc.usage.last_good,
                models,
                windows,
                gate_thresholds=overrides or None,
                default_threshold=self._settings.threshold if claude and overrides else None,
            )
            entry = Text()
            entry.append(f"\n  {acc.number:>2}  ", style=palette.foreground)
            entry.append(
                data.present_email(acc.email, mask=self.app.mask_accounts),
                style=palette.foreground,
            )
            if acc.usage.sentinel is not None:
                entry.append(
                    f"  {data.sentinel_label(acc.usage.sentinel)}", style=palette.muted
                )
                ranked.append((998.0, acc.number))
            elif pct is None:
                entry.append("  usage unknown", style=palette.muted)
                ranked.append((999.0, acc.number))
            else:
                entry.append(f"  {pct:3.0f}% used", style=palette.severity(pct))
                ranked.append((pct, acc.number))
            lines[acc.number] = entry

        text = Text()
        text.append("Next best", style=palette.muted)
        if not ranked:
            text.append("\n  no other switchable accounts", style=palette.muted)
            return text
        for _pct, number in sorted(ranked):
            text.append(lines[number])
        return text
