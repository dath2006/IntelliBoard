"""
LLM Provider API routes.

Endpoints:
  GET  /api/llm/providers          — list providers + connection status for current user
  GET  /api/llm/models             — list available models for current user
  POST /api/llm/github/connect     — start GitHub device-code flow
  POST /api/llm/github/poll        — poll for token after user authorizes
  DELETE /api/llm/github/disconnect — remove stored GitHub token
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.dependencies import require_auth
from app.database.session import get_db
from app.models.user import User
from app.services.llm_providers import (
    PROVIDERS,
    delete_github_token,
    get_github_token,
    list_models_for_user,
    poll_github_device_flow,
    save_github_token,
    start_github_device_flow,
)

router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------

class ProviderStatus(BaseModel):
    id: str
    label: str
    auth_type: str
    description: str
    connected: bool


class ModelInfo(BaseModel):
    id: str
    label: str
    provider: str
    provider_label: str


class GitHubConnectResponse(BaseModel):
    device_code: str
    user_code: str
    verification_uri: str
    expires_in: int
    interval: int


class GitHubPollRequest(BaseModel):
    device_code: str


class GitHubPollResponse(BaseModel):
    status: str  # "pending" | "authorized" | "expired" | "denied" | "error"
    message: str | None = None


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/providers", response_model=list[ProviderStatus])
async def list_providers(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    """List all LLM providers and their connection status for the current user."""
    from app.core.config import settings

    gh_token = await get_github_token(db, user.id)
    result = []
    for p in PROVIDERS:
        if p["id"] == "openai":
            connected = bool(settings.OPENAI_API_KEY)
        elif p["id"] == "github":
            connected = bool(gh_token)
        else:
            connected = False
        result.append(ProviderStatus(
            id=p["id"],
            label=p["label"],
            auth_type=p["auth_type"],
            description=p["description"],
            connected=connected,
        ))
    return result


@router.get("/models", response_model=list[ModelInfo])
async def list_models(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    """List all available LLM models for the current user."""
    models = await list_models_for_user(db, user.id)
    return [ModelInfo(**m) for m in models]


@router.post("/github/connect", response_model=GitHubConnectResponse)
async def github_connect(
    user: User = Depends(require_auth),
):
    """Start GitHub device-code OAuth flow. Returns the code to show the user."""
    try:
        data = await start_github_device_flow()
        return GitHubConnectResponse(**data)
    except RuntimeError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@router.post("/github/poll", response_model=GitHubPollResponse)
async def github_poll(
    body: GitHubPollRequest,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    """
    Poll GitHub for the access token after the user has authorized.

    Frontend should call this every ~5 seconds until status is 'authorized'.
    """
    result = await poll_github_device_flow(body.device_code)
    if result["status"] == "authorized":
        token = result.get("token", "")
        if token:
            await save_github_token(db, user.id, token)
    return GitHubPollResponse(
        status=result["status"],
        message=result.get("message"),
    )


@router.delete("/github/disconnect")
async def github_disconnect(
    db: AsyncSession = Depends(get_db),
    user: User = Depends(require_auth),
):
    """Remove the stored GitHub Copilot token for the current user."""
    await delete_github_token(db, user.id)
    return {"ok": True}
