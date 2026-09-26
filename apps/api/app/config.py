from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["dev", "test", "prod"] = "dev"
    database_url: str = "postgresql+psycopg://understudy:understudy@localhost:5432/understudy"
    redis_url: str = "redis://localhost:6379/0"

    # --- auth ---------------------------------------------------------------
    # Supabase issues HS256 JWTs signed with the project's JWT secret. We verify
    # locally rather than calling Supabase on every request: no network hop on the
    # hot path, and the API keeps working if Supabase's auth endpoint is degraded.
    supabase_jwt_secret: str = "dev-secret-not-for-prod"
    supabase_jwt_audience: str = "authenticated"
    # Dev escape hatch: trust an `X-Dev-User` header instead of a real JWT so the
    # stack runs with `docker compose up` and no Supabase project. Never in prod.
    auth_dev_mode: bool = True

    # --- object storage -----------------------------------------------------
    # "local" writes to a directory and serves it from the API; see app/storage.py for
    # why that exists and why it is not a production option.
    storage_backend: Literal["s3", "local"] = "s3"
    local_storage_dir: str = "./.storage"
    # S3-compatible; MinIO locally, Supabase Storage / S3 in prod.
    s3_endpoint_url: str | None = "http://localhost:9000"
    s3_region: str = "us-east-1"
    s3_bucket: str = "understudy"
    s3_access_key: str = "minioadmin"
    s3_secret_key: str = "minioadmin"
    s3_public_base_url: str | None = None

    # --- pipeline -----------------------------------------------------------
    omr_engine: Literal["fake", "oemer"] = "fake"
    # "queue" hands work to Redis/RQ, which is the real topology. "inline" runs the task
    # in the request thread instead — no broker, no worker process. That makes `pytest`,
    # Playwright and a bare `uvicorn` all work with nothing else running, at the cost of
    # a slow request. Never inline in prod: OMR takes minutes and would hold a worker.
    job_mode: Literal["queue", "inline"] = "queue"
    job_max_attempts: int = 3
    job_timeout_seconds: int = 900

    # --- observability ------------------------------------------------------
    sentry_dsn: str | None = None
    log_level: str = "INFO"

    cors_origins: list[str] = ["http://localhost:5173"]

    @property
    def auth_enforced(self) -> bool:
        return self.env == "prod" or not self.auth_dev_mode


@lru_cache
def get_settings() -> Settings:
    return Settings()
