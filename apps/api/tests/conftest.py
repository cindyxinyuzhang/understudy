"""Test harness.

Two deliberate substitutions and nothing else:

* SQLite file per test instead of Postgres, so `pytest` is one command with no
  containers. Everything that would be Postgres-specific (JSONB operators, RLS) is
  absent from the codebase by design, so this stays honest. CI additionally runs the
  Alembic migrations against a real Postgres to catch anything SQLite would forgive.
* An in-memory object store and an inline job runner, so the full upload -> recognise
  -> render path is exercised end to end in-process. The queue itself is not faked out
  of the tests that care about it — `test_jobs.py` drives the real task function.
"""

from __future__ import annotations

import os

# Set before anything imports `app`: Settings is cached on first access, so a fixture
# would be too late.
os.environ.update(
    ENV="test",
    DATABASE_URL="sqlite+pysqlite:///:memory:",
    AUTH_DEV_MODE="true",
    OMR_ENGINE="fake",
    LOG_LEVEL="WARNING",
)

import uuid
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool


@pytest.fixture
def db_engine():
    # StaticPool + a single in-memory connection so the app and the test see the same
    # database; without it every connection gets its own empty SQLite.
    engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    from app import models  # noqa: F401
    from app.db import Base

    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def session_factory(db_engine):
    return sessionmaker(bind=db_engine, autoflush=False, expire_on_commit=False, future=True)


class FakeStorage:
    """In-memory S3 stand-in. Same three calls the real one exposes."""

    def __init__(self) -> None:
        self.objects: dict[str, tuple[bytes, str]] = {}

    def put_object(self, key: str, body, content_type: str) -> str:
        self.objects[key] = (body if isinstance(body, bytes) else body.read(), content_type)
        return key

    def get_object(self, key: str) -> bytes:
        return self.objects[key][0]

    def presigned_get(self, key: str, expires_in: int = 3600) -> str:
        return f"memory://{key}"

    def ensure_bucket(self) -> None:
        pass


@pytest.fixture
def storage(monkeypatch) -> FakeStorage:
    fake = FakeStorage()
    from app import storage as real

    for name in ("put_object", "get_object", "presigned_get", "ensure_bucket"):
        monkeypatch.setattr(real, name, getattr(fake, name))
    return fake


@pytest.fixture
def enqueued(monkeypatch) -> list:
    """Capture enqueues instead of touching Redis. Tests that want the work done call
    `run_job` explicitly, which keeps 'was it queued' and 'does it work' separate."""
    calls: list = []
    import app.jobs as jobs_mod
    import app.routers.scores as scores_mod

    def _capture(job):
        calls.append(job.id)

    monkeypatch.setattr(jobs_mod, "enqueue", _capture)
    monkeypatch.setattr(scores_mod, "enqueue", _capture)
    return calls


@pytest.fixture
def client(session_factory, storage, enqueued, monkeypatch) -> Iterator[TestClient]:
    import app.db as db_mod
    import app.worker.tasks as tasks_mod
    from app.db import get_db
    from app.main import app

    monkeypatch.setattr(db_mod, "SessionLocal", session_factory)
    monkeypatch.setattr(tasks_mod, "SessionLocal", session_factory)

    def override_get_db():
        db = session_factory()
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


def as_user(client: TestClient, email: str) -> TestClient:
    client.headers["X-Dev-User"] = email
    return client


@pytest.fixture
def alice(client) -> TestClient:
    return as_user(client, "alice@example.com")


def make_pdf(marker: bytes = b"score-1") -> bytes:
    """Minimal bytes that pass the `%PDF` sniff. The fake OMR engine only hashes the
    content, so the bytes need not be a valid PDF — they need to be distinguishable."""
    return b"%PDF-1.7\n" + marker + b"\n%%EOF\n"


def run_job(session_factory, job_id: uuid.UUID) -> None:
    from app.worker.tasks import run_omr_job

    run_omr_job(str(job_id))


def upload_score(client: TestClient, title: str = "Defying Gravity", marker: bytes = b"s1") -> dict:
    resp = client.post(
        "/scores",
        files={"file": ("score.pdf", make_pdf(marker), "application/pdf")},
        data={"title": title, "show": "Wicked"},
    )
    assert resp.status_code == 202, resp.text
    return resp.json()
