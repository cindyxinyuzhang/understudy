from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.db import get_db

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz() -> dict[str, str]:
    """Liveness: is the process up. Deliberately touches nothing else, so a database
    blip does not cause the orchestrator to kill healthy pods."""
    return {"status": "ok"}


@router.get("/readyz")
def readyz(db: Session = Depends(get_db)) -> dict[str, str]:
    """Readiness: can we actually serve traffic."""
    db.execute(text("SELECT 1"))
    checks = {"database": "ok"}
    try:
        from app.jobs import get_redis

        get_redis().ping()
        checks["redis"] = "ok"
    except Exception as exc:  # noqa: BLE001
        checks["redis"] = f"error: {type(exc).__name__}"
    return {"status": "ok" if all(v == "ok" for v in checks.values()) else "degraded", **checks}
