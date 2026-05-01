from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    SECRET_KEY: str = "change-me-in-production-use-a-long-random-string"
    DATABASE_URL: str = "sqlite+aiosqlite:///./velxio.db"
    DATA_DIR: str = "."
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    GOOGLE_REDIRECT_URI: str = "http://localhost:8001/api/auth/google/callback"
    FRONTEND_URL: str = "http://localhost:5173"
    # Set to true in production (HTTPS). Controls the Secure flag on the JWT cookie.
    OPENAI_API_KEY: str = ""
    ARDUINO_ESP32_PATH: str = ""
    IDF_PATH: str = ""
    COOKIE_SECURE: bool = False
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080  # 7 days
    AGENT_MODEL: str = "openai:gpt-5.4-mini"
    AGENT_FALLBACK_MODEL: str = ""
    AGENT_ENABLED: bool = True
    AGENT_MAX_TOOL_CALLS: int = 40
    AGENT_MAX_PROMPT_CHARS: int = 12000
    AGENT_SNAPSHOT_MAX_BYTES: int = 1_000_000
    AGENT_MAX_RUN_SECONDS: int = 180
    AGENT_ENABLE_LOGFIRE: bool = False

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    def require_agent_ready(self) -> None:
        """Validate runtime-only agent requirements without affecting other APIs."""
        if not self.AGENT_ENABLED:
            return
        if not self.OPENAI_API_KEY:
            raise RuntimeError("OPENAI_API_KEY is required when AGENT_ENABLED is true.")
        if ":" not in self.AGENT_MODEL:
            raise RuntimeError("AGENT_MODEL must use the provider:model format.")


settings = Settings()
