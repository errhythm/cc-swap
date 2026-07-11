"""Tests for file-backed Codex account switching."""

from __future__ import annotations

import base64
import json

import pytest

from claude_swap import codex
from claude_swap.codex_usage import CodexUsageError
from claude_swap.exceptions import ConfigError, SwitchError


def _jwt(email: str, account_id: str) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps({"email": email, "chatgpt_account_id": account_id}).encode()
    ).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{payload}.signature"


def _auth(email: str, account_id: str) -> dict:
    return {
        "auth_mode": "chatgpt",
        "tokens": {
            "id_token": _jwt(email, account_id),
            "access_token": f"access-{account_id}",
            "refresh_token": f"refresh-{account_id}",
            "account_id": account_id,
        },
    }


@pytest.fixture
def switcher(tmp_path, monkeypatch):
    backup = tmp_path / "backup"
    home = tmp_path / "codex-home"
    home.mkdir()
    monkeypatch.setenv("CODEX_HOME", str(home))
    monkeypatch.setattr(codex, "get_backup_root", lambda: backup)
    instance = codex.CodexAccountSwitcher()
    return instance, home


def _write_live(home, auth: dict) -> None:
    (home / "auth.json").write_text(json.dumps(auth), encoding="utf-8")


def test_add_and_switch_preserves_other_codex_files(switcher):
    instance, home = switcher
    (home / "config.toml").write_text('model = "gpt-test"\n', encoding="utf-8")
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)

    _write_live(home, _auth("two@example.com", "account-two"))
    instance.add_account(assume_yes=True)

    result = instance.switch_to("1", json_output=True)

    assert result["switched"]
    assert json.loads((home / "auth.json").read_text()) == _auth(
        "one@example.com", "account-one"
    )
    assert (home / "config.toml").read_text(encoding="utf-8") == 'model = "gpt-test"\n'
    assert instance.current_account_number() == "1"


def test_add_refreshes_existing_account_in_place(switcher):
    instance, home = switcher
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)

    refreshed = _auth("one@example.com", "account-one")
    refreshed["tokens"]["refresh_token"] = "fresh-refresh-token"
    _write_live(home, refreshed)
    instance.add_account(assume_yes=True)

    listed = instance.list_accounts()
    assert [account["number"] for account in listed["accounts"]] == [1]
    assert json.loads((instance.credentials_dir / "account-1.json").read_text()) == refreshed


def test_switch_saves_the_currently_refreshed_auth_before_activating_target(switcher):
    instance, home = switcher
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)
    _write_live(home, _auth("two@example.com", "account-two"))
    instance.add_account(assume_yes=True)

    refreshed = _auth("two@example.com", "account-two")
    refreshed["tokens"]["refresh_token"] = "rotated-refresh-token"
    _write_live(home, refreshed)
    instance.switch_to("1", json_output=True)

    assert json.loads((instance.credentials_dir / "account-2.json").read_text()) == refreshed


def test_switch_refuses_to_overwrite_an_unmanaged_live_login(switcher):
    instance, home = switcher
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)
    _write_live(home, _auth("two@example.com", "account-two"))
    instance.add_account(assume_yes=True)
    unmanaged = _auth("outside@example.com", "outside-account")
    _write_live(home, unmanaged)

    with pytest.raises(SwitchError, match="unmanaged"):
        instance.switch_to("1", json_output=True)

    assert json.loads((home / "auth.json").read_text()) == unmanaged


def test_api_key_accounts_get_a_stable_non_secret_label(switcher):
    instance, home = switcher
    _write_live(
        home,
        {"auth_mode": "api_key", "OPENAI_API_KEY": "sk-test-not-a-real-key"},
    )

    instance.add_account(assume_yes=True)

    account = instance.list_accounts()["accounts"][0]
    assert account["email"].startswith("api-key-")
    assert account["email"].endswith("@codex.local")
    assert "sk-test" not in account["email"]


def test_keyring_only_configuration_is_rejected_without_writing(switcher):
    instance, home = switcher
    (home / "config.toml").write_text(
        'cli_auth_credentials_store = "keyring"\n', encoding="utf-8"
    )

    with pytest.raises(ConfigError, match="OS keyring"):
        instance.add_account(assume_yes=True)

    assert not instance.sequence_file.exists()


def test_snapshot_fetches_codex_usage_and_reuses_fresh_result(switcher, monkeypatch):
    instance, home = switcher
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)
    fetched: list[dict] = []

    def fetch(auth, *, base_url):
        fetched.append(auth)
        assert base_url == "https://chatgpt.com/backend-api"
        return {"five_hour": {"pct": 25}, "seven_day": {"pct": 50}}

    monkeypatch.setattr(codex, "fetch_codex_usage", fetch)

    snapshot = instance.accounts_snapshot()
    cached = instance.accounts_snapshot(fetch=set())

    assert snapshot.active_number == "1"
    assert snapshot.accounts[0].usage.last_good == {
        "five_hour": {"pct": 25},
        "seven_day": {"pct": 50},
    }
    assert cached.accounts[0].usage.last_good == snapshot.accounts[0].usage.last_good
    assert len(fetched) == 1


def test_snapshot_marks_api_key_usage_as_not_applicable(switcher):
    instance, home = switcher
    _write_live(home, {"auth_mode": "api_key", "OPENAI_API_KEY": "sk-test"})
    instance.add_account(assume_yes=True)

    snapshot = instance.accounts_snapshot()

    assert snapshot.accounts[0].kind == "api_key"
    assert snapshot.accounts[0].usage.sentinel == "api key"


def test_snapshot_refreshes_an_inactive_codex_login_after_usage_401(switcher, monkeypatch):
    instance, home = switcher
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)
    _write_live(home, _auth("two@example.com", "account-two"))
    instance.add_account(assume_yes=True)

    refreshed = _auth("one@example.com", "account-one")
    refreshed["tokens"]["access_token"] = "fresh-access"
    refreshed["tokens"]["refresh_token"] = "fresh-refresh"
    refresh_calls = []

    def fetch(auth, *, base_url):
        if auth["tokens"]["access_token"] != "fresh-access":
            raise CodexUsageError("expired", status_code=401)
        return {"five_hour": {"pct": 25}}

    def refresh(auth):
        refresh_calls.append(auth)
        return refreshed

    monkeypatch.setattr(codex, "fetch_codex_usage", fetch)
    monkeypatch.setattr(codex, "refresh_codex_auth", refresh)

    snapshot = instance.accounts_snapshot(fetch={"1"})

    assert snapshot.accounts[0].usage.last_good == {"five_hour": {"pct": 25}}
    assert refresh_calls == [_auth("one@example.com", "account-one")]
    assert json.loads((instance.credentials_dir / "account-1.json").read_text()) == refreshed


def test_snapshot_never_refreshes_the_active_codex_login(switcher, monkeypatch):
    instance, home = switcher
    _write_live(home, _auth("one@example.com", "account-one"))
    instance.add_account(assume_yes=True)

    monkeypatch.setattr(
        codex,
        "fetch_codex_usage",
        lambda auth, *, base_url: (_ for _ in ()).throw(
            CodexUsageError("expired", status_code=401)
        ),
    )
    monkeypatch.setattr(
        codex,
        "refresh_codex_auth",
        lambda auth: pytest.fail("the active Codex auth must not be refreshed"),
    )

    snapshot = instance.accounts_snapshot()

    assert snapshot.accounts[0].usage.last_good is None
    assert snapshot.accounts[0].usage.last_error == "expired"


def _jwt_with_plan(email: str, account_id: str, plan: str) -> str:
    payload = base64.urlsafe_b64encode(
        json.dumps(
            {
                "email": email,
                "chatgpt_account_id": account_id,
                "https://api.openai.com/auth": {"chatgpt_plan_type": plan},
            }
        ).encode()
    ).decode().rstrip("=")
    return f"eyJhbGciOiJub25lIn0.{payload}.signature"


def _auth_with_plan(email: str, account_id: str, plan: str) -> dict:
    auth = _auth(email, account_id)
    auth["tokens"]["id_token"] = _jwt_with_plan(email, account_id, plan)
    return auth


@pytest.mark.parametrize(
    "plan,expected",
    [
        ("team", "Codex Team"),
        ("pro", "Codex Pro"),
        ("plus", "Codex Plus"),
        ("business", "Codex Business"),
        ("enterprise", "Codex Enterprise"),
        ("", "Codex"),
        (None, "Codex"),
        ("go_pro", "Codex Go Pro"),
    ],
)
def test_codex_org_label_maps_plan_to_display(plan, expected):
    assert codex.codex_org_label(plan) == expected


def test_plan_type_read_from_token_and_falls_back_to_access_token():
    assert codex._plan_type_from_auth(_auth_with_plan("a@b.co", "acct", "team")) == "team"
    # id_token without a plan claim -> read the access_token namespace instead.
    auth = _auth("a@b.co", "acct")
    auth["tokens"]["access_token"] = _jwt_with_plan("a@b.co", "acct", "pro")
    assert codex._plan_type_from_auth(auth) == "pro"
    assert codex._plan_type_from_auth(_auth("a@b.co", "acct")) == ""


def test_add_records_plan_and_list_shows_team_label(switcher):
    instance, home = switcher
    _write_live(home, _auth_with_plan("team@example.com", "acct-team", "team"))
    instance.add_account(assume_yes=True)

    stored = json.loads(instance.sequence_file.read_text())
    assert stored["accounts"]["1"]["planType"] == "team"

    listed = instance.list_accounts()["accounts"][0]
    assert listed["planType"] == "team"
    assert listed["label"] == "Codex Team"


def test_list_derives_plan_for_accounts_saved_without_plan_type(switcher):
    """Accounts stored before planType existed still show their plan."""
    instance, home = switcher
    _write_live(home, _auth_with_plan("team@example.com", "acct-team", "team"))
    instance.add_account(assume_yes=True)

    # Simulate a legacy backup: drop the recorded planType from the sequence.
    data = json.loads(instance.sequence_file.read_text())
    del data["accounts"]["1"]["planType"]
    instance.sequence_file.write_text(json.dumps(data), encoding="utf-8")

    listed = instance.list_accounts()["accounts"][0]
    assert listed["planType"] == "team"
    assert listed["label"] == "Codex Team"


def test_snapshot_org_name_reflects_plan(switcher, monkeypatch):
    instance, home = switcher
    _write_live(home, _auth_with_plan("team@example.com", "acct-team", "team"))
    instance.add_account(assume_yes=True)
    monkeypatch.setattr(
        codex, "fetch_codex_usage", lambda auth, *, base_url: {"five_hour": {"pct": 1}}
    )

    snapshot = instance.accounts_snapshot()

    assert snapshot.accounts[0].org_name == "Codex Team"
    assert snapshot.accounts[0].display_tag == "Codex Team"


def test_usage_text_output_includes_reset_countdown(switcher, monkeypatch, capsys):
    instance, home = switcher
    _write_live(home, _auth_with_plan("team@example.com", "acct-team", "team"))
    instance.add_account(assume_yes=True)
    monkeypatch.setattr(
        codex,
        "fetch_codex_usage",
        lambda auth, *, base_url: {
            "five_hour": {"pct": 47, "resets_at": "2999-01-01T00:00:00Z"}
        },
    )

    instance.usage_status()

    out = capsys.readouterr().out
    assert "47% used" in out
    assert "resets in" in out
