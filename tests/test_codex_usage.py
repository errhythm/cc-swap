"""Tests for the read-only Codex rate-limit client."""

from __future__ import annotations

import base64
import json

from claude_swap import codex_usage


def _jwt(claims: dict) -> str:
    payload = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    return f"header.{payload}.signature"


def _auth() -> dict:
    return {
        "tokens": {
            "access_token": "access-token",
            "id_token": _jwt(
                {
                    "https://api.openai.com/auth": {
                        "chatgpt_account_id": "account-from-claim",
                        "chatgpt_account_is_fedramp": True,
                    }
                }
            ),
        }
    }


def test_usage_url_matches_codex_backend_paths():
    assert codex_usage.usage_url("https://chatgpt.com") == (
        "https://chatgpt.com/backend-api/wham/usage"
    )
    assert codex_usage.usage_url("https://example.test/api") == (
        "https://example.test/api/api/codex/usage"
    )


def test_fetch_usage_sends_codex_auth_headers_and_normalizes_windows(monkeypatch):
    requested = {}

    class Response:
        def read(self):
            return json.dumps(
                {
                    "rate_limit": {
                        "primary_window": {"used_percent": 12.5, "reset_at": 1_800_000_000},
                        "secondary_window": {"used_percent": 65},
                    }
                }
            ).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def urlopen(request, *, timeout):
        requested["url"] = request.full_url
        requested["headers"] = {name.lower(): value for name, value in request.header_items()}
        requested["timeout"] = timeout
        return Response()

    monkeypatch.setattr(codex_usage.urllib.request, "urlopen", urlopen)

    usage = codex_usage.fetch_codex_usage(_auth(), base_url="https://chatgpt.com")

    assert requested["url"] == "https://chatgpt.com/backend-api/wham/usage"
    assert requested["headers"] == {
        "authorization": "Bearer access-token",
        "user-agent": "ccswap",
        "accept": "application/json",
        "chatgpt-account-id": "account-from-claim",
        "x-openai-fedramp": "true",
    }
    assert usage == {
        "five_hour": {"pct": 12.5, "resets_at": "2027-01-15T08:00:00Z"},
        "seven_day": {"pct": 65.0},
    }


def test_fetch_usage_explains_expired_or_unauthorized_credentials(monkeypatch):
    def urlopen(request, *, timeout):
        raise codex_usage.urllib.error.HTTPError(
            request.full_url, 401, "Unauthorized", {}, None
        )

    monkeypatch.setattr(codex_usage.urllib.request, "urlopen", urlopen)

    try:
        codex_usage.fetch_codex_usage(_auth())
    except codex_usage.CodexUsageError as exc:
        assert "codex login" in str(exc)
    else:
        raise AssertionError("expected a Codex usage error")


def test_refresh_auth_uses_codex_refresh_contract_and_rotates_tokens(monkeypatch):
    requested = {}

    class Response:
        def read(self):
            return json.dumps(
                {
                    "access_token": "new-access",
                    "refresh_token": "new-refresh",
                    "id_token": "new-id",
                }
            ).encode()

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def urlopen(request, *, timeout):
        requested["url"] = request.full_url
        requested["method"] = request.get_method()
        requested["headers"] = {
            name.lower(): value for name, value in request.header_items()
        }
        requested["body"] = json.loads(request.data.decode())
        requested["timeout"] = timeout
        return Response()

    monkeypatch.setattr(codex_usage.urllib.request, "urlopen", urlopen)

    auth = _auth()
    auth["tokens"]["refresh_token"] = "old-refresh"
    refreshed = codex_usage.refresh_codex_auth(auth)

    assert requested == {
        "url": "https://auth.openai.com/oauth/token",
        "method": "POST",
        "headers": {
            "content-type": "application/json",
            "accept": "application/json",
            "user-agent": "ccswap",
        },
        "body": {
            "client_id": codex_usage.CODEX_OAUTH_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": "old-refresh",
        },
        "timeout": 10.0,
    }
    assert refreshed["last_refresh"].endswith("Z")
    assert refreshed["tokens"] == {
        **auth["tokens"],
        "access_token": "new-access",
        "refresh_token": "new-refresh",
        "id_token": "new-id",
    }
    assert auth["tokens"]["refresh_token"] == "old-refresh"
