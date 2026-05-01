import pytest

from app.core.config import Settings


def test_agent_settings_defaults():
    settings = Settings(_env_file=None)

    assert settings.AGENT_MODEL == "openai:gpt-5.2"
    assert settings.AGENT_FALLBACK_MODEL == ""
    assert settings.AGENT_ENABLED is False
    assert settings.AGENT_MAX_TOOL_CALLS == 40
    assert settings.AGENT_MAX_PROMPT_CHARS == 12000
    assert settings.AGENT_SNAPSHOT_MAX_BYTES == 1_000_000
    assert settings.AGENT_MAX_RUN_SECONDS == 180
    assert settings.AGENT_ENABLE_LOGFIRE is False


def test_agent_settings_env_overrides(monkeypatch):
    monkeypatch.setenv("AGENT_MODEL", "openai:gpt-5.4")
    monkeypatch.setenv("AGENT_ENABLED", "true")
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("AGENT_MAX_TOOL_CALLS", "12")

    settings = Settings(_env_file=None)

    assert settings.AGENT_MODEL == "openai:gpt-5.4"
    assert settings.AGENT_ENABLED is True
    assert settings.OPENAI_API_KEY == "test-key"
    assert settings.AGENT_MAX_TOOL_CALLS == 12
    settings.require_agent_ready()


def test_agent_preflight_ignores_missing_key_when_disabled(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("AGENT_ENABLED", "false")

    Settings(_env_file=None).require_agent_ready()


def test_agent_preflight_requires_openai_key_when_enabled(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("AGENT_ENABLED", "true")

    settings = Settings(_env_file=None)

    with pytest.raises(RuntimeError, match="OPENAI_API_KEY"):
        settings.require_agent_ready()


def test_agent_preflight_rejects_model_without_provider(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("AGENT_ENABLED", "true")
    monkeypatch.setenv("AGENT_MODEL", "gpt-5.2")

    settings = Settings(_env_file=None)

    with pytest.raises(RuntimeError, match="provider:model"):
        settings.require_agent_ready()
