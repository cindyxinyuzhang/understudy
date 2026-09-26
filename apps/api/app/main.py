from __future__ import annotations

import time
import uuid
from contextlib import asynccontextmanager

import structlog
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.routing import APIRoute

from app.config import get_settings
from app.logging_setup import configure_logging
from app.routers import annotations, health, jobs, me, profiles, scores, shares

settings = get_settings()
configure_logging(settings)
log = structlog.get_logger(__name__)


def custom_operation_id(route: APIRoute) -> str:
    """Stable, readable operation IDs.

    FastAPI's default bakes the path and method into the name, so `openapi-typescript`
    and any generated client end up with churny identifiers that change whenever a route
    moves. Using the handler's function name keeps the generated TypeScript stable, and
    makes a renamed endpoint a visible diff in the generated file instead of a silent one.
    """
    return route.name


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.sentry_dsn:
        import sentry_sdk

        sentry_sdk.init(dsn=settings.sentry_dsn, environment=settings.env, traces_sample_rate=0.1)
    if settings.env != "test":
        try:
            from app.storage import ensure_bucket

            ensure_bucket()
        except Exception as exc:  # noqa: BLE001 - storage may lag behind the API on boot
            log.warning("storage.bucket_check_failed", error=str(exc))
    if settings.auth_dev_mode and settings.env == "prod":
        raise RuntimeError("AUTH_DEV_MODE must be off in prod")
    log.info("api.start", env=settings.env, omr_engine=settings.omr_engine)
    yield


app = FastAPI(
    title="Understudy API",
    version="0.1.0",
    description="Part-learning tool for musical theatre vocal scores.",
    lifespan=lifespan,
    generate_unique_id_function=custom_operation_id,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["Retry-After"],
)


@app.middleware("http")
async def request_context(request: Request, call_next):
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    structlog.contextvars.bind_contextvars(request_id=request_id, path=request.url.path)
    started = time.perf_counter()
    try:
        response = await call_next(request)
    finally:
        structlog.contextvars.unbind_contextvars("request_id", "path")
    response.headers["X-Request-ID"] = request_id
    log.info(
        "http.request",
        method=request.method,
        status=response.status_code,
        duration_ms=round((time.perf_counter() - started) * 1000, 1),
    )
    return response


for module in (health, me, scores, jobs, profiles, annotations, shares):
    app.include_router(module.router)
