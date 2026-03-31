from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional


class Settings(BaseSettings):
    openrouter_api_key: str
    openrouter_model: str = "google/gemini-2.5-pro-preview-05-06"
    openai_api_key: Optional[str] = None

    supabase_url: Optional[str] = None
    supabase_service_key: Optional[str] = None

    api_host: str = "0.0.0.0"
    api_port: int = 8000

    log_level: str = "INFO"

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore"
    )


settings = Settings()
