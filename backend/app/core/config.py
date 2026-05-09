"""Application configuration using Pydantic settings."""
from pydantic_settings import BaseSettings
from pydantic import field_validator
from typing import Optional, Union


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # IB Gateway settings
    IB_HOST: str = "127.0.0.1"
    IB_PORT: int = 7497  # Paper trading port
    IB_CLIENT_ID: int = 1
    IB_CLIENT_POOL_SIZE: int = 2
    IB_READONLY: bool = True
    IB_ACCOUNT: str | None = None
    AUTO_TRADE_ENABLED: bool = False
    AUTO_TRADE_INTERVAL_SECONDS: int = 60
    AUTO_TRADE_RTH_ONLY: bool = True

    # Redis settings
    REDIS_URL: str = "redis://localhost:6379"

    # API settings
    API_V1_PREFIX: str = "/api/v1"
    PROJECT_NAME: str = "Trading Platform"

    # Polygon.io
    POLYGON_API_KEY: str = ""

    # CORS settings
    CORS_ORIGINS: Union[list[str], str] = "http://localhost:3000,http://localhost:5173"

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def parse_cors_origins(cls, v):
        """Parse CORS_ORIGINS from comma-separated string or list."""
        if isinstance(v, str):
            return [origin.strip() for origin in v.split(",")]
        return v

    class Config:
        env_file = ".env"
        case_sensitive = True


settings = Settings()
