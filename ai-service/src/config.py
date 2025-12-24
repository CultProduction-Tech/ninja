from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    # AI/LLM
    openrouter_api_key: str
    openrouter_model: str = "google/gemini-2.5-flash-lite"
    openai_api_key: Optional[str] = None

    # Supabase (добавь если используешь в коде)
    supabase_url: Optional[str] = None
    supabase_service_key: Optional[str] = None

    # API
    api_host: str = "0.0.0.0"
    api_port: int = 8000

    # Logging
    log_level: str = "INFO"

    # Pydantic v2 config
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"  # Игнорируем лишние поля из .env
    )


settings = Settings()
