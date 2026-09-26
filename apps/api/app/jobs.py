"""Job orchestration: Postgres is the record, Redis is the transport.

Enqueue path is deliberately two-phase — write the `jobs` row inside the request's
transaction, hand the ID to RQ after commit. Doing it the other way round lets a worker
pick up a job whose row is not visible yet (or never commits), which is the classic
dual-write bug in this shape of system.
"""

from __future__ import annotations

import functools
import uuid
from datetime import UTC, datetime

from redis import Redis
from rq import Queue
from sqlalchemy.orm import Session

from app.config import get_settings
from app.models import Job, JobStatus

QUEUE_NAME = "omr"


@functools.lru_cache
def get_redis() -> Redis:
    return Redis.from_url(get_settings().redis_url)


def get_queue() -> Queue:
    s = get_settings()
    return Queue(QUEUE_NAME, connection=get_redis(), default_timeout=s.job_timeout_seconds)


def create_or_get_job(
    db: Session, *, score_version_id: uuid.UUID, idempotency_key: str, kind: str = "omr"
) -> tuple[Job, bool]:
    """Returns (job, created). Re-POSTing the same upload returns the original job."""
    existing = db.query(Job).filter(Job.idempotency_key == idempotency_key).one_or_none()
    if existing is not None:
        return existing, False
    job = Job(
        score_version_id=score_version_id,
        kind=kind,
        idempotency_key=idempotency_key,
        max_attempts=get_settings().job_max_attempts,
    )
    db.add(job)
    db.flush()
    return job, True


def enqueue(job: Job) -> None:
    """Hand a committed job row to the worker.

    Safe to call twice: the task re-reads status from Postgres and no-ops on a job that
    has already settled.
    """
    if get_settings().job_mode == "inline":
        from app.worker.tasks import run_omr_job

        run_omr_job(str(job.id))
        return

    get_queue().enqueue(
        "app.worker.tasks.run_omr_job",
        str(job.id),
        job_id=f"omr:{job.id}",
        retry=None,  # retries are our own, driven by `attempts`, so they survive Redis loss
    )


def mark_running(db: Session, job: Job, stage: str) -> None:
    job.status = JobStatus.running
    job.stage = stage
    job.attempts += 1
    job.started_at = job.started_at or datetime.now(UTC)
    db.flush()


def mark_succeeded(db: Session, job: Job) -> None:
    job.status = JobStatus.succeeded
    job.progress = 100
    job.stage = "done"
    job.error = None
    job.finished_at = datetime.now(UTC)
    db.flush()


def mark_failed(db: Session, job: Job, error: str) -> bool:
    """Record a failure. Returns True if the job should be retried."""
    job.error = error[:4000]
    if job.attempts < job.max_attempts:
        job.status = JobStatus.queued
        job.stage = "retry-pending"
        db.flush()
        return True
    job.status = JobStatus.failed
    job.finished_at = datetime.now(UTC)
    db.flush()
    return False
