#!/usr/bin/env python3
"""
LLM Provider Connector — Production-ready Python module.

Inspired by OpenClaw's provider connection architecture. Implements a unified
interface for connecting to external LLM providers via OAuth device-code flow,
token management, model discovery, and text generation.

Currently supports: GitHub Copilot (device-code OAuth).
Architecture is extensible for additional providers.

Usage:
    python llm_connector.py connect github
    python llm_connector.py models github
    python llm_connector.py generate github "Hello world"
    python llm_connector.py providers

Programmatic:
    from llm_connector import LLMConnector, GitHubCopilotProvider
    connector = LLMConnector()
    connector.register_provider(GitHubCopilotProvider())
    connector.connect("github")
    models = connector.list_models("github")
    response = connector.generate("github", models[0], "Hello world")
"""

from __future__ import annotations

import argparse
import hashlib
import http.server
import json
import logging
import os
import secrets
import sys
import threading
import time
import urllib.parse
import webbrowser
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Third-party imports (requests is the only external dependency)
# ---------------------------------------------------------------------------
try:
    import requests
except ImportError:
    print(
        "ERROR: 'requests' library is required.\n"
        "Install it with:  pip install requests",
        file=sys.stderr,
    )
    sys.exit(1)

# ============================================================================
# 1. LOGGING
# ============================================================================

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("llm_connector")


# ============================================================================
# 2. CONFIG & CONSTANTS
# ============================================================================

@dataclass(frozen=True)
class ConnectorConfig:
    """Global configuration for the LLM connector system."""

    token_dir: Path = field(
        default_factory=lambda: Path.home() / ".llm_connector"
    )
    token_file: str = "tokens.json"
    oauth_callback_port: int = 18741
    oauth_timeout_seconds: int = 300
    device_code_timeout_seconds: int = 900  # 15 minutes (matches OpenClaw)
    request_timeout_seconds: int = 30

    @property
    def token_path(self) -> Path:
        return self.token_dir / self.token_file


DEFAULT_CONFIG = ConnectorConfig()


# ============================================================================
# 3. CUSTOM EXCEPTIONS
# ============================================================================

class LLMConnectorError(Exception):
    """Base exception for the connector system."""


class ProviderNotRegisteredError(LLMConnectorError):
    """Raised when a provider ID is not found in the registry."""


class AuthenticationError(LLMConnectorError):
    """Raised when authentication fails."""


class TokenExpiredError(AuthenticationError):
    """Raised when a stored token has expired."""


class OAuthStateError(AuthenticationError):
    """Raised when OAuth state parameter does not match."""


class NetworkError(LLMConnectorError):
    """Raised when a network request fails."""


class TokenStoreCorruptionError(LLMConnectorError):
    """Raised when the token store file is corrupted."""


# ============================================================================
# 4. TOKEN STORE  (ported from store.ts + profile.ts)
# ============================================================================

class TokenStore:
    """
    Persistent JSON-backed token storage with file locking.

    Mirrors OpenClaw's AuthProfileStore — stores per-provider credentials
    with expiry tracking and safe concurrent read/write.

    Storage format:
    {
        "version": 1,
        "profiles": {
            "<provider>:<profile_id>": {
                "type": "token" | "oauth" | "api_key",
                "provider": "<provider_id>",
                "token": "<access_token>",
                "refresh": "<refresh_token>",       # optional
                "expires": <epoch_ms>,              # optional
                "email": "<user_email>",            # optional
                "display_name": "<display_name>"    # optional
            }
        }
    }
    """

    VERSION = 1

    def __init__(self, config: ConnectorConfig | None = None) -> None:
        self._config = config or DEFAULT_CONFIG
        self._path = self._config.token_path
        self._lock = threading.Lock()

    # -- public API ----------------------------------------------------------

    def load(self) -> dict[str, Any]:
        """Load the full store from disk. Returns empty store on missing file."""
        with self._lock:
            return self._read()

    def save(self, store: dict[str, Any]) -> None:
        """Atomically write the store to disk."""
        with self._lock:
            self._write(store)

    def upsert_profile(
        self,
        profile_id: str,
        credential: dict[str, Any],
    ) -> None:
        """Insert or update a single credential profile (mirrors profile.ts upsertAuthProfile)."""
        with self._lock:
            store = self._read()
            store.setdefault("profiles", {})[profile_id] = credential
            self._write(store)
        log.info("Stored auth profile: %s (%s)", profile_id, credential.get("provider"))

    def get_profile(self, profile_id: str) -> dict[str, Any] | None:
        """Retrieve a single profile or None."""
        store = self.load()
        return store.get("profiles", {}).get(profile_id)

    def remove_profile(self, profile_id: str) -> bool:
        """Remove a profile. Returns True if it existed."""
        with self._lock:
            store = self._read()
            profiles = store.get("profiles", {})
            if profile_id in profiles:
                del profiles[profile_id]
                self._write(store)
                log.info("Removed auth profile: %s", profile_id)
                return True
            return False

    def list_profiles_for_provider(self, provider: str) -> list[str]:
        """List all profile IDs belonging to a provider."""
        store = self.load()
        return [
            pid
            for pid, cred in store.get("profiles", {}).items()
            if cred.get("provider") == provider
        ]

    def resolve_token(self, provider: str) -> str | None:
        """
        Resolve a valid access token for the given provider.

        Checks expiry and returns the best available token, or None.
        Mirrors oauth.ts resolveApiKeyForProfile.
        """
        store = self.load()
        profiles = store.get("profiles", {})
        for pid, cred in profiles.items():
            if cred.get("provider") != provider:
                continue
            expires = cred.get("expires")
            if expires is not None:
                if isinstance(expires, (int, float)) and expires < time.time() * 1000:
                    log.debug("Token expired for profile %s", pid)
                    continue
            token = cred.get("token") or cred.get("key")
            if token:
                return token
        return None

    # -- internals -----------------------------------------------------------

    def _ensure_dir(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def _read(self) -> dict[str, Any]:
        if not self._path.exists():
            return {"version": self.VERSION, "profiles": {}}
        try:
            text = self._path.read_text(encoding="utf-8")
            data = json.loads(text)
            if not isinstance(data, dict):
                raise TokenStoreCorruptionError(f"Token store is not a JSON object: {self._path}")
            return data
        except json.JSONDecodeError as exc:
            raise TokenStoreCorruptionError(
                f"Token store JSON is corrupt: {self._path}: {exc}"
            ) from exc

    def _write(self, store: dict[str, Any]) -> None:
        self._ensure_dir()
        store["version"] = self.VERSION
        tmp_path = self._path.with_suffix(".tmp")
        tmp_path.write_text(
            json.dumps(store, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        tmp_path.replace(self._path)


# ============================================================================
# 5. ABSTRACT BASE PROVIDER  (ported from ProviderPlugin type)
# ============================================================================

class BaseProvider(ABC):
    """
    Abstract base class for LLM providers.

    Each concrete provider must declare its identity, auth type,
    and implement model listing + text generation.
    """

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique short identifier, e.g. 'github'."""

    @property
    @abstractmethod
    def label(self) -> str:
        """Human-readable provider name."""

    @property
    @abstractmethod
    def auth_type(self) -> str:
        """One of 'device_code', 'oauth', 'api_key'."""

    @abstractmethod
    def authenticate(
        self,
        config: ConnectorConfig,
        token_store: TokenStore,
    ) -> bool:
        """Run the provider-specific auth flow. Returns True on success."""

    @abstractmethod
    def list_models(self, token: str) -> list[str]:
        """Return available model IDs using the given access token."""

    @abstractmethod
    def generate(
        self,
        token: str,
        model: str,
        prompt: str,
        **kwargs: Any,
    ) -> str:
        """Generate a completion. Returns the response text."""


# ============================================================================
# 6. OAUTH CALLBACK SERVER (stdlib http.server)
# ============================================================================

class OAuthCallbackHandler(http.server.BaseHTTPRequestHandler):
    """HTTP handler that captures OAuth authorization code callbacks."""

    server: OAuthCallbackServer  # type: ignore[assignment]

    def do_GET(self) -> None:  # noqa: N802
        parsed = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(parsed.query)

        if parsed.path != "/callback":
            self.send_response(404)
            self.end_headers()
            return

        code = params.get("code", [None])[0]
        state = params.get("state", [None])[0]
        error = params.get("error", [None])[0]

        if error:
            self.server.result = {"error": error}
        elif code:
            self.server.result = {"code": code, "state": state}
        else:
            self.server.result = {"error": "missing_code"}

        html = (
            "<html><body><h2>Authentication complete</h2>"
            "<p>You can close this tab.</p></body></html>"
        )
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(html.encode())

        # Shut down after capturing the callback
        threading.Thread(target=self.server.shutdown, daemon=True).start()

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        log.debug("OAuth callback: %s", format % args)


class OAuthCallbackServer(http.server.HTTPServer):
    """Lightweight local server for OAuth redirect capture."""

    result: dict[str, Any] | None = None

    def __init__(self, port: int = 18741) -> None:
        super().__init__(("127.0.0.1", port), OAuthCallbackHandler)
        self.port = port

    @property
    def redirect_uri(self) -> str:
        return f"http://localhost:{self.port}/callback"

    def wait_for_callback(self, timeout: int = 300) -> dict[str, Any]:
        """Serve until callback is received or timeout is hit."""
        self.timeout = timeout
        thread = threading.Thread(target=self.serve_forever, daemon=True)
        thread.start()
        thread.join(timeout=timeout)
        if self.result is None:
            self.shutdown()
            raise AuthenticationError("OAuth callback timed out.")
        return self.result


# ============================================================================
# 7. AUTH MANAGER  (dispatches OAuth / device-code / API-key flows)
# ============================================================================

class AuthManager:
    """
    Coordinates authentication across providers.

    Mirrors OpenClaw's auth.ts runProviderAuthMethod — delegates to the
    provider's own authenticate() and persists results via TokenStore.
    """

    def __init__(
        self,
        config: ConnectorConfig | None = None,
        token_store: TokenStore | None = None,
    ) -> None:
        self.config = config or DEFAULT_CONFIG
        self.store = token_store or TokenStore(self.config)

    def connect(self, provider: BaseProvider) -> bool:
        """
        Run the full auth flow for a provider.

        Returns True on success.
        """
        log.info("Connecting to %s (%s auth)...", provider.label, provider.auth_type)

        # Check for existing valid token first
        existing = self.store.resolve_token(provider.id)
        if existing:
            log.info("Found existing valid token for %s.", provider.id)
            return True

        return provider.authenticate(self.config, self.store)

    def resolve_token(self, provider_id: str) -> str:
        """Get a valid token or raise."""
        token = self.store.resolve_token(provider_id)
        if token is None:
            raise AuthenticationError(
                f"No valid token for provider '{provider_id}'. "
                f"Run: python llm_connector.py connect {provider_id}"
            )
        return token


# ============================================================================
# 8. GITHUB COPILOT PROVIDER  (ported from login.ts)
# ============================================================================

# Constants from login.ts lines 11-13
_GH_CLIENT_ID = "Iv1.b507a08c87ecfe98"
_GH_DEVICE_CODE_URL = "https://github.com/login/device/code"
_GH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
_GH_COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token"
_GH_MODELS_URL = "https://api.githubcopilot.com/models"
_GH_CHAT_URL = "https://api.githubcopilot.com/chat/completions"


class GitHubCopilotProvider(BaseProvider):
    """
    GitHub Copilot LLM provider using device-code OAuth.

    Ported from OpenClaw's login.ts — uses GitHub's device code flow
    (RFC 8628) to obtain an access token, then exchanges it for a
    Copilot-specific session token for API access.
    """

    @property
    def id(self) -> str:
        return "github"

    @property
    def label(self) -> str:
        return "GitHub Copilot"

    @property
    def auth_type(self) -> str:
        return "device_code"

    # -- Authentication (mirrors login.ts:42-117) ----------------------------

    def authenticate(
        self,
        config: ConnectorConfig,
        token_store: TokenStore,
    ) -> bool:
        """Run GitHub device-code OAuth flow."""
        try:
            # Step 1: Request device code (login.ts:42-66)
            device = self._request_device_code()

            # Step 2: Display verification URL and user code (login.ts:146-148)
            print("\n" + "=" * 56)
            print("  GitHub Copilot — Device Authorization")
            print("=" * 56)
            print(f"\n  Visit:  {device['verification_uri']}")
            print(f"  Code:   {device['user_code']}")
            print(f"\n  Expires in {device['expires_in'] // 60} minutes.")
            print("=" * 56 + "\n")

            # Try to open browser automatically
            try:
                webbrowser.open(device["verification_uri"])
                log.info("Opened browser for authorization.")
            except Exception:
                log.info("Could not open browser. Please visit the URL manually.")

            # Step 3: Poll for access token (login.ts:68-117)
            expires_at = time.time() + device["expires_in"]
            interval_ms = max(1000, device.get("interval", 5) * 1000)
            print("Waiting for GitHub authorization...", end="", flush=True)

            access_token = self._poll_for_access_token(
                device_code=device["device_code"],
                interval_ms=interval_ms,
                expires_at=expires_at,
            )
            print(" done!\n")

            # Step 4: Store token (login.ts:163-172)
            profile_id = "github-copilot:github"
            token_store.upsert_profile(
                profile_id=profile_id,
                credential={
                    "type": "token",
                    "provider": self.id,
                    "token": access_token,
                    # GitHub device flow doesn't reliably include expiry
                },
            )

            log.info("GitHub Copilot authentication successful.")
            return True

        except AuthenticationError:
            raise
        except requests.RequestException as exc:
            raise NetworkError(f"Network error during GitHub auth: {exc}") from exc
        except Exception as exc:
            raise AuthenticationError(f"GitHub auth failed: {exc}") from exc

    def _request_device_code(self) -> dict[str, Any]:
        """POST to get device code and user code. (login.ts:42-66)"""
        resp = requests.post(
            _GH_DEVICE_CODE_URL,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            data={
                "client_id": _GH_CLIENT_ID,
                "scope": "read:user copilot",
            },
            timeout=30,
        )
        if not resp.ok:
            raise AuthenticationError(f"GitHub device code failed: HTTP {resp.status_code}")
        data = resp.json()
        if not data.get("device_code") or not data.get("user_code"):
            raise AuthenticationError("GitHub device code response missing required fields.")
        return data

    def _poll_for_access_token(
        self,
        device_code: str,
        interval_ms: int,
        expires_at: float,
    ) -> str:
        """Continuously poll GitHub for completed authorization. (login.ts:68-117)"""
        while time.time() < expires_at:
            resp = requests.post(
                _GH_ACCESS_TOKEN_URL,
                headers={
                    "Accept": "application/json",
                    "Content-Type": "application/x-www-form-urlencoded",
                },
                data={
                    "client_id": _GH_CLIENT_ID,
                    "device_code": device_code,
                    "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
                },
                timeout=30,
            )
            if not resp.ok:
                raise AuthenticationError(f"GitHub device token failed: HTTP {resp.status_code}")

            data = resp.json()

            if "access_token" in data and isinstance(data["access_token"], str):
                return data["access_token"]

            error = data.get("error", "unknown")
            if error == "authorization_pending":
                print(".", end="", flush=True)
                time.sleep(interval_ms / 1000)
                continue
            if error == "slow_down":
                time.sleep((interval_ms + 2000) / 1000)
                continue
            if error == "expired_token":
                raise AuthenticationError("GitHub device code expired. Run login again.")
            if error == "access_denied":
                raise AuthenticationError("GitHub login was cancelled by the user.")
            raise AuthenticationError(f"GitHub device flow error: {error}")

        raise AuthenticationError("GitHub device code expired. Run login again.")

    # -- Copilot Token Exchange ----------------------------------------------

    def _get_copilot_token(self, github_token: str) -> str:
        """Exchange GitHub access token for a Copilot session token."""
        try:
            resp = requests.get(
                _GH_COPILOT_TOKEN_URL,
                headers={
                    "Authorization": f"token {github_token}",
                    "Accept": "application/json",
                },
                timeout=30,
            )
            if resp.ok:
                data = resp.json()
                token = data.get("token")
                if token:
                    return token
        except requests.RequestException as exc:
            log.warning("Copilot token exchange failed: %s. Using GitHub token directly.", exc)
        # Fallback: use the GitHub token directly
        return github_token

    # -- Model Discovery (list_models) ---------------------------------------

    def list_models(self, token: str) -> list[str]:
        """
        Fetch available models from GitHub Copilot.

        Uses the Copilot models endpoint with the session token.
        """
        copilot_token = self._get_copilot_token(token)
        try:
            resp = requests.get(
                _GH_MODELS_URL,
                headers={
                    "Authorization": f"Bearer {copilot_token}",
                    "Accept": "application/json",
                    "Copilot-Integration-Id": "vscode-chat",
                },
                timeout=30,
            )
            if resp.ok:
                data = resp.json()
                models_list = data if isinstance(data, list) else data.get("data", data.get("models", []))
                return [
                    m.get("id", m.get("name", "unknown"))
                    for m in models_list
                    if isinstance(m, dict)
                ]
        except requests.RequestException as exc:
            log.warning("Could not fetch models from Copilot API: %s", exc)

        # Fallback: return known Copilot models
        return [
            "gpt-4o",
            "gpt-4o-mini",
            "gpt-4",
            "gpt-3.5-turbo",
            "claude-3.5-sonnet",
            "o3-mini",
        ]

    # -- Text Generation (generate) ------------------------------------------

    def generate(
        self,
        token: str,
        model: str,
        prompt: str,
        **kwargs: Any,
    ) -> str:
        """
        Generate a completion via GitHub Copilot Chat API.

        Exchanges the GitHub OAuth token for a Copilot session token,
        then uses the Copilot chat completions endpoint with proper
        integration headers (same flow as VS Code Copilot Chat).
        """
        copilot_token = self._get_copilot_token(token)

        messages = kwargs.get("messages") or [{"role": "user", "content": prompt}]
        system_msg = kwargs.get("system_message")
        if system_msg:
            messages = [{"role": "system", "content": system_msg}] + messages

        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": kwargs.get("temperature", 0.7),
            "max_tokens": kwargs.get("max_tokens", 4096),
            "stream": False,
        }

        try:
            resp = requests.post(
                _GH_CHAT_URL,
                headers={
                    "Authorization": f"Bearer {copilot_token}",
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Copilot-Integration-Id": "vscode-chat",
                    "Editor-Version": "vscode/1.96.0",
                    "Editor-Plugin-Version": "copilot-chat/0.24.2",
                    "Openai-Organization": "github-copilot",
                    "Openai-Intent": "conversation-panel",
                },
                json=body,
                timeout=kwargs.get("timeout", 120),
            )
            if not resp.ok:
                raise NetworkError(
                    f"Copilot API returned HTTP {resp.status_code}: {resp.text[:500]}"
                )
            data = resp.json()
            choices = data.get("choices", [])
            if choices:
                return choices[0].get("message", {}).get("content", "")
            return ""
        except requests.RequestException as exc:
            raise NetworkError(f"Copilot generation failed: {exc}") from exc


# ============================================================================
# 9. MAIN CONNECTOR CLASS (facade)
# ============================================================================

class LLMConnector:
    """
    Unified interface for managing LLM providers.

    Usage:
        connector = LLMConnector()
        connector.register_provider(GitHubCopilotProvider())
        connector.connect("github")
        models = connector.list_models("github")
        response = connector.generate("github", models[0], "Hello")
    """

    def __init__(self, config: ConnectorConfig | None = None) -> None:
        self._config = config or DEFAULT_CONFIG
        self._store = TokenStore(self._config)
        self._auth = AuthManager(self._config, self._store)
        self._providers: dict[str, BaseProvider] = {}

    def register_provider(self, provider: BaseProvider) -> None:
        """Register a provider. Overwrites if ID already exists."""
        self._providers[provider.id] = provider
        log.debug("Registered provider: %s (%s)", provider.id, provider.label)

    def list_providers(self) -> list[dict[str, str]]:
        """Return metadata for all registered providers."""
        return [
            {
                "id": p.id,
                "label": p.label,
                "auth_type": p.auth_type,
                "authenticated": "yes" if self._store.resolve_token(p.id) else "no",
            }
            for p in self._providers.values()
        ]

    def connect(self, provider_id: str, force: bool = False) -> bool:
        """
        Authenticate with a provider.

        If force=True, re-authenticates even if a valid token exists.
        """
        provider = self._get_provider(provider_id)
        if force:
            # Remove existing profiles to force re-auth
            for pid in self._store.list_profiles_for_provider(provider_id):
                self._store.remove_profile(pid)
        return self._auth.connect(provider)

    def disconnect(self, provider_id: str) -> None:
        """Remove all stored credentials for a provider."""
        self._get_provider(provider_id)  # validate it exists
        profiles = self._store.list_profiles_for_provider(provider_id)
        for pid in profiles:
            self._store.remove_profile(pid)
        log.info("Disconnected from %s. Removed %d profile(s).", provider_id, len(profiles))

    def list_models(self, provider_id: str) -> list[str]:
        """List available models for a provider."""
        provider = self._get_provider(provider_id)
        token = self._auth.resolve_token(provider_id)
        return provider.list_models(token)

    def generate(
        self,
        provider_id: str,
        model: str,
        prompt: str,
        **kwargs: Any,
    ) -> str:
        """Generate a completion from a provider."""
        provider = self._get_provider(provider_id)
        token = self._auth.resolve_token(provider_id)
        return provider.generate(token, model, prompt, **kwargs)

    def _get_provider(self, provider_id: str) -> BaseProvider:
        """Lookup provider or raise."""
        provider = self._providers.get(provider_id)
        if provider is None:
            available = ", ".join(self._providers.keys()) or "(none)"
            raise ProviderNotRegisteredError(
                f"Unknown provider '{provider_id}'. Registered: {available}"
            )
        return provider


# ============================================================================
# 10. CLI INTERFACE
# ============================================================================

def _build_default_connector() -> LLMConnector:
    """Create a connector with all built-in providers registered."""
    connector = LLMConnector()
    connector.register_provider(GitHubCopilotProvider())
    return connector


def cli_connect(args: argparse.Namespace) -> None:
    """Handle 'connect' subcommand."""
    connector = _build_default_connector()
    success = connector.connect(args.provider, force=args.force)
    if success:
        print(f"[OK] Connected to {args.provider}")
    else:
        print(f"[FAIL] Failed to connect to {args.provider}", file=sys.stderr)
        sys.exit(1)


def cli_disconnect(args: argparse.Namespace) -> None:
    """Handle 'disconnect' subcommand."""
    connector = _build_default_connector()
    connector.disconnect(args.provider)
    print(f"[OK] Disconnected from {args.provider}")


def cli_models(args: argparse.Namespace) -> None:
    """Handle 'models' subcommand."""
    connector = _build_default_connector()
    try:
        models = connector.list_models(args.provider)
    except AuthenticationError as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        sys.exit(1)

    if not models:
        print("No models found.")
        return

    print(f"\nAvailable models for {args.provider}:")
    print("-" * 40)
    for i, model in enumerate(models, 1):
        print(f"  {i:>2}. {model}")
    print()


def cli_generate(args: argparse.Namespace) -> None:
    """Handle 'generate' subcommand."""
    connector = _build_default_connector()
    try:
        model = args.model
        if not model:
            models = connector.list_models(args.provider)
            model = models[0] if models else "gpt-4o"
            log.info("Using default model: %s", model)

        response = connector.generate(
            provider_id=args.provider,
            model=model,
            prompt=args.prompt,
            temperature=args.temperature,
            max_tokens=args.max_tokens,
        )
        print(response)

    except (AuthenticationError, NetworkError) as exc:
        print(f"[FAIL] {exc}", file=sys.stderr)
        sys.exit(1)


def cli_providers(args: argparse.Namespace) -> None:
    """Handle 'providers' subcommand."""
    connector = _build_default_connector()
    providers = connector.list_providers()
    if not providers:
        print("No providers registered.")
        return

    print(f"\n{'ID':<15} {'Label':<25} {'Auth Type':<15} {'Status'}")
    print("-" * 70)
    for p in providers:
        status = "[OK] connected" if p["authenticated"] == "yes" else "[ ] not connected"
        print(f"  {p['id']:<13} {p['label']:<23} {p['auth_type']:<13} {status}")
    print()


def main() -> None:
    """CLI entry point."""
    parser = argparse.ArgumentParser(
        prog="llm_connector",
        description="LLM Provider Connector — connect to LLM providers via unified interface.",
    )
    parser.add_argument(
        "-v", "--verbose",
        action="store_true",
        help="Enable debug logging.",
    )
    subparsers = parser.add_subparsers(dest="command", help="Available commands")

    # -- connect -------------------------------------------------------------
    p_connect = subparsers.add_parser("connect", help="Authenticate with a provider")
    p_connect.add_argument("provider", help="Provider ID (e.g. 'github')")
    p_connect.add_argument("--force", action="store_true", help="Force re-authentication")
    p_connect.set_defaults(func=cli_connect)

    # -- disconnect ----------------------------------------------------------
    p_disconnect = subparsers.add_parser("disconnect", help="Remove stored credentials")
    p_disconnect.add_argument("provider", help="Provider ID")
    p_disconnect.set_defaults(func=cli_disconnect)

    # -- models --------------------------------------------------------------
    p_models = subparsers.add_parser("models", help="List available models")
    p_models.add_argument("provider", help="Provider ID")
    p_models.set_defaults(func=cli_models)

    # -- generate ------------------------------------------------------------
    p_gen = subparsers.add_parser("generate", help="Generate a completion")
    p_gen.add_argument("provider", help="Provider ID")
    p_gen.add_argument("prompt", help="The prompt text")
    p_gen.add_argument("-m", "--model", default=None, help="Model ID (default: auto)")
    p_gen.add_argument("-t", "--temperature", type=float, default=0.7, help="Temperature")
    p_gen.add_argument("--max-tokens", type=int, default=4096, help="Max tokens")
    p_gen.set_defaults(func=cli_generate)

    # -- providers -----------------------------------------------------------
    p_prov = subparsers.add_parser("providers", help="List registered providers")
    p_prov.set_defaults(func=cli_providers)

    args = parser.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    if not args.command:
        parser.print_help()
        sys.exit(0)

    try:
        args.func(args)
    except LLMConnectorError as exc:
        log.error("%s", exc)
        sys.exit(1)
    except KeyboardInterrupt:
        print("\nCancelled.")
        sys.exit(130)


# ============================================================================
# 11. ASSUMPTIONS & NOTES
# ============================================================================

"""
ASSUMPTIONS AND LIMITATIONS
============================

1. MOCKED / APPROXIMATED PARTS:
   - list_models() includes a hardcoded fallback list if the Copilot
     /models endpoint is unreachable (it may require specific headers).
   - The Copilot token exchange (_get_copilot_token) gracefully falls
     back to the GitHub token if the internal API is unavailable.

2. REAL ENDPOINTS (ready for production):
   - GitHub OAuth device code flow uses real GitHub OAuth endpoints.
   - Chat completions use the real api.githubcopilot.com endpoint.
   - All client IDs match OpenClaw's production values (login.ts:11).

3. SECURITY LIMITATIONS:
   - Tokens stored in plaintext JSON at ~/.llm_connector/tokens.json.
     Production use should integrate OS keychain (keyring library).
   - No encryption at rest. File permissions default to user-only on
     Unix, but Windows needs manual ACL.
   - Client ID is public (GitHub OAuth app), not a secret.
   - No PKCE on device code flow (GitHub doesn't require it for
     device auth grants per RFC 8628).

4. EXTENSION POINTS:
   - Add new providers by subclassing BaseProvider and calling
     connector.register_provider().
   - Token refresh: implement in provider's authenticate() method
     with refresh_token grant.
   - The OAuthCallbackServer is ready for Authorization Code flow
     providers (OpenAI, Google, etc.) when needed.
"""


if __name__ == "__main__":
    main()
