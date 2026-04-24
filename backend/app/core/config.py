from pydantic import ConfigDict
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
    COOKIE_SECURE: bool = False
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080  # 7 days
    
    # AI Agent Settings
    OPENAI_API_KEY: str = ""  # User-provided or backend proxy key
    OPENAI_BASE_URL: str | None = None  # For AI Gateway / Proxy endpoints
    AGENT_MODEL: str = "openai:gpt-5.4-mini"  # Pydantic AI model string
    KNOWLEDGE_DB_PATH: str = "./knowledge_db"  # Path for RAG knowledge base
    CHROMA_PERSISTENCE_DIR: str = "./.chroma"  # Chroma vector DB persistence

    model_config = ConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")


settings = Settings()
