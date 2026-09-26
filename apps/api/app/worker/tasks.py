"""The OMR worker task.

Contract with the rest of the system:

* Idempotent. Re-running a job that already succeeded is a no-op, so an at-least-once
  queue (which RQ is, on worker crash) cannot corrupt a score.
* Crash-safe. Every state transition is committed before the next step starts, so a
  worker killed mid-run leaves a job in `running` with an accurate `stage`, and the
  reaper can requeue it.
* Failure is partial, not total. Page images are uploaded before the document is
  written; a failure after upload wastes storage, never leaves a `ready` version
  pointing at images that do not exist.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

import structlog

from app import storage
from app.config import get_settings
from app.db import SessionLocal
from app.jobs import mark_failed, mark_running, mark_succeeded
from app.models import Job, JobStatus, Score, ScoreVersion, VersionStatus
from app.worker.omr.base import get_engine

log = structlog.get_logger(__name__)


def run_omr_job(job_id: str) -> None:
    settings = get_settings()
    db = SessionLocal()
    try:
        job = db.get(Job, uuid.UUID(job_id))
        if job is None:
            log.warning("omr.job_missing", job_id=job_id)
            return
        # At-least-once delivery means we can be handed a job someone already finished.
        if job.status in (JobStatus.succeeded, JobStatus.cancelled):
            log.info("omr.job_already_settled", job_id=job_id, status=job.status)
            return

        version = db.get(ScoreVersion, job.score_version_id)
        if version is None:
            mark_failed(db, job, "score version disappeared")
            db.commit()
            return

        bound = log.bind(job_id=job_id, score_version_id=str(version.id), attempt=job.attempts + 1)
        mark_running(db, job, "starting")
        db.commit()

        def progress(pct: int, stage: str) -> None:
            job.progress = max(job.progress, min(99, pct))
            job.stage = stage
            db.commit()
            bound.info("omr.progress", pct=pct, stage=stage)

        try:
            engine = get_engine(settings.omr_engine)
            bound.info("omr.start", engine=engine.name, engine_version=engine.version)

            pdf_bytes = storage.get_object(version.source_object_key)
            result = engine.run(pdf_bytes, progress)

            # Upload page images first, then point the document at them. The reverse order
            # can publish a version whose images 404.
            progress(96, "uploading-pages")
            for page in result.pages:
                key = (
                    f"scores/{version.score_id}/versions/{version.id}"
                    f"/pages/{page.index:03d}.{page.extension}"
                )
                storage.put_object(key, page.data, page.content_type)
                result.doc.pages[page.index].image_key = key

            version.doc = result.doc.model_dump(by_alias=True, mode="json")
            version.page_count = len(result.doc.pages)
            version.note_count = len(result.doc.notes)
            version.engine = engine.name
            version.engine_version = engine.version
            version.status = VersionStatus.ready

            # First successful version of a score becomes the one clients open. Later
            # versions are activated explicitly so a re-OMR cannot silently move a
            # singer's score out from under them mid-rehearsal.
            score = db.get(Score, version.score_id)
            if score is not None and score.current_version_id is None:
                score.current_version_id = version.id

            mark_succeeded(db, job)
            db.commit()
            bound.info("omr.done", notes=version.note_count, pages=version.page_count)

        except Exception as exc:  # noqa: BLE001 - the worker boundary swallows everything
            db.rollback()
            job = db.get(Job, uuid.UUID(job_id))
            version = db.get(ScoreVersion, job.score_version_id)
            bound.exception("omr.failed", error=str(exc))
            should_retry = mark_failed(db, job, f"{type(exc).__name__}: {exc}")
            if not should_retry and version is not None:
                version.status = VersionStatus.failed
            db.commit()
            if should_retry:
                from app.jobs import enqueue

                enqueue(job)
            else:
                raise
    finally:
        db.close()


def reap_stalled_jobs(stall_seconds: int = 1800) -> int:
    """Requeue jobs whose worker died without settling them.

    RQ's own job registry would lose this on a Redis flush, and a `running` row with a
    stale `started_at` is the only durable evidence that a GPU worker was OOM-killed.
    Run from a cron/beat every few minutes.
    """
    from datetime import timedelta

    from app.jobs import enqueue

    cutoff = datetime.now(UTC) - timedelta(seconds=stall_seconds)
    db = SessionLocal()
    requeued = 0
    try:
        stalled = (
            db.query(Job)
            .filter(
                Job.status == JobStatus.running, Job.started_at.isnot(None), Job.started_at < cutoff
            )
            .all()
        )
        for job in stalled:
            if job.attempts >= job.max_attempts:
                job.status = JobStatus.failed
                job.error = "worker stalled; out of attempts"
                job.finished_at = datetime.now(UTC)
                continue
            job.status = JobStatus.queued
            job.stage = "requeued-after-stall"
            requeued += 1
        db.commit()
        for job in stalled:
            if job.status == JobStatus.queued:
                enqueue(job)
    finally:
        db.close()
    return requeued
