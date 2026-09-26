from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.authz import _resolve_role
from app.db import get_db
from app.models import Job, JobStatus, Score, ScoreVersion, User
from app.schemas import JobRead

router = APIRouter(prefix="/jobs", tags=["jobs"])

# Advisory poll interval, sent as a header so the client does not hardcode one. Long
# while the job is queued behind others, short once it is actually running.
_POLL_HINT = {JobStatus.queued: 3, JobStatus.running: 1}


@router.get("/{job_id}", response_model=JobRead)
def get_job(
    job_id: uuid.UUID,
    response: Response,
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> JobRead:
    """Poll a job.

    Polling rather than websockets: an OMR run is minutes long and a handful of clients
    watch it, so a 1-3s poll costs a trivial amount and removes a whole class of
    connection-lifecycle bugs. Supabase Realtime is the upgrade path if a score ever
    needs many simultaneous watchers.
    """
    row = db.execute(
        select(Job, Score)
        .join(ScoreVersion, Job.score_version_id == ScoreVersion.id)
        .join(Score, Score.id == ScoreVersion.score_id)
        .where(Job.id == job_id)
    ).one_or_none()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")
    job, score = row
    if _resolve_role(db, score, user) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Job not found")

    if job.status in _POLL_HINT:
        response.headers["Retry-After"] = str(_POLL_HINT[job.status])
    else:
        response.headers["Cache-Control"] = "private, max-age=60"
    return JobRead.model_validate(job)
