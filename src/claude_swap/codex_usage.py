"""Read Codex rate-limit windows through the same backend route Codex uses."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from datetime import datetime, timezone
from typing import Any

DEFAULT_CHATGPT_BASE_URL = "https://chatgpt.com/backend-api"
DEFAULT_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"
# Codex CLI's public OAuth client identifier. Keep this aligned with Codex's
# own refresh request so saved ChatGPT logins are refreshed by the same flow.
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"


class CodexUsageError(Exception):
    """Codex usage could not be fetched or decoded."""

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


def usage_url(base_url: str) -> str:
    """Build Codex's upstream rate-limit endpoint from a configured base URL."""
    base = base_url.rstrip("/")
    if (
        base.startswith("https://chatgpt.com")
        or base.startswith("https://chat.openai.com")
    ) and "/backend-api" not in base:
        base = f"{base}/backend-api"
    if "/backend-api" in base:
        return f"{base}/wham/usage"
    return f"{base}/api/codex/usage"


def _jwt_claims(auth: dict[str, Any]) -> dict[str, Any]:
    tokens = auth.get("tokens")
    if not isinstance(tokens, dict):
        return {}
    token = tokens.get("id_token")
    if not isinstance(token, str):
        return {}
    import base64

    pieces = token.split(".")
    if len(pieces) != 3:
        return {}
    try:
        payload = pieces[1] + "=" * (-len(pieces[1]) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("ascii"))
        claims = json.loads(decoded.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, json.JSONDecodeError):
        return {}
    return claims if isinstance(claims, dict) else {}


def _headers(auth: dict[str, Any]) -> dict[str, str]:
    tokens = auth.get("tokens")
    if not isinstance(tokens, dict):
        raise CodexUsageError("saved login has no ChatGPT access token")
    access_token = tokens.get("access_token")
    if not isinstance(access_token, str) or not access_token:
        raise CodexUsageError("saved login has no ChatGPT access token")
    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "ccswap",
        "Accept": "application/json",
    }
    account_id = tokens.get("account_id")
    claims = _jwt_claims(auth)
    auth_claims = claims.get("https://api.openai.com/auth")
    if not isinstance(account_id, str) or not account_id:
        if isinstance(auth_claims, dict):
            account_id = auth_claims.get("chatgpt_account_id")
    if isinstance(account_id, str) and account_id:
        headers["ChatGPT-Account-ID"] = account_id
    if isinstance(auth_claims, dict) and auth_claims.get(
        "chatgpt_account_is_fedramp"
    ):
        headers["X-OpenAI-Fedramp"] = "true"
    return headers


def _window(window: object) -> dict[str, Any] | None:
    if not isinstance(window, dict):
        return None
    pct = window.get("used_percent")
    if isinstance(pct, bool) or not isinstance(pct, (int, float)):
        return None
    result: dict[str, Any] = {"pct": float(pct)}
    reset_at = window.get("reset_at")
    if isinstance(reset_at, (int, float)) and not isinstance(reset_at, bool):
        result["resets_at"] = (
            datetime.fromtimestamp(reset_at, timezone.utc)
            .isoformat(timespec="seconds")
            .replace("+00:00", "Z")
        )
    return result


def _convert_payload(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CodexUsageError("Codex usage response is not a JSON object")
    rate_limit = payload.get("rate_limit")
    if not isinstance(rate_limit, dict):
        raise CodexUsageError("Codex usage response has no rate-limit data")
    usage: dict[str, Any] = {}
    primary = _window(rate_limit.get("primary_window"))
    secondary = _window(rate_limit.get("secondary_window"))
    if primary is not None:
        usage["five_hour"] = primary
    if secondary is not None:
        usage["seven_day"] = secondary
    if not usage:
        raise CodexUsageError("Codex did not return subscription usage windows for this account")
    return usage


def fetch_codex_usage(
    auth: dict[str, Any],
    *,
    base_url: str = DEFAULT_CHATGPT_BASE_URL,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Fetch normalized Codex primary/secondary rate-limit windows."""
    url = usage_url(base_url)
    request = urllib.request.Request(url, headers=_headers(auth))
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (401, 403):
            raise CodexUsageError(
                "Codex OAuth token is expired or unauthorized; run 'codex login', "
                "then refresh it with 'ccswap codex add'",
                status_code=exc.code,
            ) from exc
        raise CodexUsageError(
            f"Codex usage request failed ({exc.code})", status_code=exc.code
        ) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise CodexUsageError(f"Codex usage request failed: {exc.reason}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CodexUsageError(f"Could not decode Codex usage response: {exc}") from exc
    return _convert_payload(payload)


def refresh_codex_auth(
    auth: dict[str, Any],
    *,
    refresh_url: str = DEFAULT_REFRESH_TOKEN_URL,
    timeout: float = 10.0,
) -> dict[str, Any]:
    """Return ``auth`` with its ChatGPT OAuth tokens refreshed.

    Codex rotates refresh tokens. Callers must persist the returned document
    before using it and must not invoke this for the currently active login,
    which Codex itself may be refreshing concurrently.
    """
    tokens = auth.get("tokens")
    refresh_token = tokens.get("refresh_token") if isinstance(tokens, dict) else None
    if not isinstance(refresh_token, str) or not refresh_token:
        raise CodexUsageError("saved login has no ChatGPT refresh token")

    body = json.dumps(
        {
            "client_id": CODEX_OAUTH_CLIENT_ID,
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
        }
    ).encode("utf-8")
    request = urllib.request.Request(
        refresh_url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "ccswap",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code in (400, 401, 403):
            raise CodexUsageError(
                "Codex refresh token is expired, revoked, or already used; "
                "run 'codex login', then refresh it with 'ccswap codex add'",
                status_code=exc.code,
            ) from exc
        raise CodexUsageError(
            f"Codex token refresh failed ({exc.code})", status_code=exc.code
        ) from exc
    except (urllib.error.URLError, OSError) as exc:
        raise CodexUsageError(f"Codex token refresh failed: {exc.reason}") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise CodexUsageError(f"Could not decode Codex token refresh response: {exc}") from exc

    if not isinstance(payload, dict):
        raise CodexUsageError("Codex token refresh response is not a JSON object")
    access_token = payload.get("access_token")
    rotated_refresh_token = payload.get("refresh_token")
    if not isinstance(access_token, str) or not access_token:
        raise CodexUsageError("Codex token refresh response has no access token")

    # The auth document is JSON-only; copying it through JSON avoids mutating a
    # caller's stale snapshot before the caller has durably saved the rotation.
    refreshed = json.loads(json.dumps(auth))
    refreshed_tokens = refreshed["tokens"]
    refreshed_tokens["access_token"] = access_token
    if isinstance(rotated_refresh_token, str) and rotated_refresh_token:
        refreshed_tokens["refresh_token"] = rotated_refresh_token
    id_token = payload.get("id_token")
    if isinstance(id_token, str) and id_token:
        refreshed_tokens["id_token"] = id_token
    refreshed["last_refresh"] = (
        datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    )
    return refreshed
