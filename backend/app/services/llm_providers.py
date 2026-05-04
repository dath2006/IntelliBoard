"""
LLM Provider Service — bridges llm_connector.py with the pydantic-ai agent.

Manages per-user GitHub Copilot tokens stored in the DB (users table),
and resolves model strings for pydantic-ai consumption.
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

# Make llm_connector importable from project root
_ROOT = Path(__file__).parent.parent.parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Provider registry — static metadata only (no auth state here)
# ---------------------------------------------------------------------------

PROVIDERS: list[dict[str, str]] = [
    {
        "id": "openai",
        "label": "OpenAI",
        "auth_type": "api_key",
        "model_prefix": "openai:",
        "description": "OpenAI GPT models via API key configured in server settings.",
    },
    {
        "id": "github",
        "label": "GitHub Copilot",
        "auth_type": "device_code",
        "model_prefix": "github-copilot:",
        "description": "GitHub Copilot models using your GitHub account's Copilot subscription.",
    },
]

# Models available when GitHub Copilot is connected
GITHUB_COPILOT_MODELS = [
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4",
    "gpt-3.5-turbo",
    "claude-3.5-sonnet",
    "o3-mini",
]

# Default OpenAI models always available when OPENAI_API_KEY is set
OPENAI_MODELS = [
    "gpt-5.4-mini",
]


# ---------------------------------------------------------------------------
# Token helpers — stored as JSON in users.github_copilot_token column
# We use a lightweight approach: store the raw GitHub OAuth token in a
# dedicated column added via migration.
# ---------------------------------------------------------------------------

async def get_github_token(db: AsyncSession, user_id: str) -> str | None:
    """Return the stored GitHub OAuth token for a user, or None."""
    from app.models.user import User
    result = await db.execute(select(User.github_copilot_token).where(User.id == user_id))
    row = result.one_or_none()
    if row is None:
        return None
    return row[0]


async def save_github_token(db: AsyncSession, user_id: str, token: str) -> None:
    """Persist a GitHub OAuth token for a user."""
    from app.models.user import User
    await db.execute(
        update(User).where(User.id == user_id).values(github_copilot_token=token)
    )
    await db.commit()


async def delete_github_token(db: AsyncSession, user_id: str) -> None:
    """Remove the stored GitHub token for a user."""
    from app.models.user import User
    await db.execute(
        update(User).where(User.id == user_id).values(github_copilot_token=None)
    )
    await db.commit()


# ---------------------------------------------------------------------------
# Model listing
# ---------------------------------------------------------------------------

async def list_models_for_user(db: AsyncSession, user_id: str) -> list[dict[str, Any]]:
    """
    Return all available models for a user across all providers.

    Each entry: { id, label, provider, model_id }
    where model_id is the pydantic-ai model string (e.g. "openai:gpt-4o").
    """
    models: list[dict[str, Any]] = []

    # OpenAI models — available when API key is configured server-side
    if settings.OPENAI_API_KEY:
        for m in OPENAI_MODELS:
            models.append({
                "id": f"openai:{m}",
                "label": m,
                "provider": "openai",
                "provider_label": "OpenAI",
            })

    # GitHub Copilot models — available when user has connected their account
    gh_token = await get_github_token(db, user_id)
    if gh_token:
        copilot_models = await _fetch_copilot_models(gh_token)
        for m in copilot_models:
            models.append({
                "id": f"github-copilot:{m}",
                "label": m,
                "provider": "github",
                "provider_label": "GitHub Copilot",
            })

    return models


async def _fetch_copilot_models(github_token: str) -> list[str]:
    """Try to fetch live model list from Copilot API, fall back to static list."""
    try:
        import requests
        from llm_connector import GitHubCopilotProvider
        provider = GitHubCopilotProvider()
        return provider.list_models(github_token)
    except Exception as exc:
        log.warning("Could not fetch Copilot models: %s. Using fallback list.", exc)
        return GITHUB_COPILOT_MODELS


# ---------------------------------------------------------------------------
# Model string resolution for pydantic-ai
# ---------------------------------------------------------------------------

async def resolve_pydantic_ai_model(
    db: AsyncSession,
    user_id: str,
    model_id: str,
) -> tuple[str, dict[str, str]]:
    """
    Resolve a model_id (e.g. "github-copilot:gpt-4o") to a pydantic-ai
    model string and any extra environment overrides needed.

    Returns (pydantic_ai_model_string, env_overrides).
    """
    if model_id.startswith("github-copilot:"):
        model_name = model_id[len("github-copilot:"):]
        gh_token = await get_github_token(db, user_id)
        if not gh_token:
            raise ValueError(
                "GitHub Copilot is not connected. Please connect your GitHub account first."
            )
        # Exchange for Copilot session token
        copilot_token = await _get_copilot_session_token(gh_token)
        # pydantic-ai supports openai-compatible endpoints via OpenAI provider
        # with a custom base_url. We use the openai provider pointed at Copilot.
        return f"openai:{model_name}", {
            "OPENAI_API_KEY": copilot_token,
            "OPENAI_BASE_URL": "https://api.githubcopilot.com",
        }

    if model_id.startswith("openai:"):
        return model_id, {}

    # Unknown prefix — pass through as-is (pydantic-ai handles it)
    return model_id, {}


async def _get_copilot_session_token(github_token: str) -> str:
    """Exchange GitHub OAuth token for a short-lived Copilot session token."""
    try:
        import requests
        resp = requests.get(
            "https://api.github.com/copilot_internal/v2/token",
            headers={
                "Authorization": f"token {github_token}",
                "Accept": "application/json",
            },
            timeout=15,
        )
        if resp.ok:
            token = resp.json().get("token")
            if token:
                return token
    except Exception as exc:
        log.warning("Copilot token exchange failed: %s. Using GitHub token directly.", exc)
    return github_token


# ---------------------------------------------------------------------------
# GitHub OAuth device-code flow helpers (called from API routes)
# ---------------------------------------------------------------------------

async def start_github_device_flow() -> dict[str, Any]:
    """Initiate GitHub device-code flow. Returns device code info."""
    try:
        import requests
        resp = requests.post(
            "https://github.com/login/device/code",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "client_id": "Iv1.b507a08c87ecfe98",
                "scope": "read:user copilot",
            },
            timeout=15,
        )
        if not resp.ok:
            raise RuntimeError(f"GitHub device code request failed: HTTP {resp.status_code}")
        data = resp.json()
        if not data.get("device_code"):
            raise RuntimeError("GitHub device code response missing required fields.")
        return {
            "device_code": data["device_code"],
            "user_code": data["user_code"],
            "verification_uri": data["verification_uri"],
            "expires_in": data["expires_in"],
            "interval": data.get("interval", 5),
        }
    except Exception as exc:
        raise RuntimeError(f"Failed to start GitHub device flow: {exc}") from exc


async def poll_github_device_flow(device_code: str) -> dict[str, Any]:
    """
    Poll GitHub for the access token.
    Returns {"status": "pending"} or {"status": "authorized", "token": "..."}.
    """
    try:
        import requests
        resp = requests.post(
            "https://github.com/login/oauth/access_token",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "client_id": "Iv1.b507a08c87ecfe98",
                "device_code": device_code,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            },
            timeout=15,
        )
        if not resp.ok:
            return {"status": "error", "message": f"HTTP {resp.status_code}"}

        data = resp.json()
        if "access_token" in data:
            return {"status": "authorized", "token": data["access_token"]}

        error = data.get("error", "unknown")
        if error in ("authorization_pending", "slow_down"):
            return {"status": "pending"}
        if error == "expired_token":
            return {"status": "expired"}
        if error == "access_denied":
            return {"status": "denied"}
        return {"status": "error", "message": error}
    except Exception as exc:
        return {"status": "error", "message": str(exc)}
