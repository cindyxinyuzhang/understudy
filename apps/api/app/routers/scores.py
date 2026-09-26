from __future__ import annotations

import hashlib
import uuid

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile, status
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app import storage
from app.auth import current_user
from app.authz import ScoreAccess, require_score
from app.db import get_db
from app.jobs import create_or_get_job, enqueue
from app.migration import build_report
from app.models import Job, Score, ScoreShare, ScoreVersion, ShareRole, User, VersionStatus
from app.schemas import (
    JobRead,
    MigrationReport,
    ScoreCreateResponse,
    ScoreDetail,
    ScoreDocResponse,
    ScoreSummary,
    ScoreVersionSummary,
)
from app.scoredoc import ScoreDoc

router = APIRouter(prefix="/scores", tags=["scores"])

MAX_PDF_BYTES = 50 * 1024 * 1024


def _summary(score: Score, role: ShareRole, current: ScoreVersion | None) -> ScoreSummary:
    return ScoreSummary(
        id=score.id,
        title=score.title,
        show=score.show,
        owner_id=score.owner_id,
        my_role=role,
        current_version_id=score.current_version_id,
        status=current.status if current else None,
        page_count=current.page_count if current else 0,
        note_count=current.note_count if current else 0,
        updated_at=score.updated_at,
    )


@router.get("", response_model=list[ScoreSummary])
def list_scores(
    db: Session = Depends(get_db), user: User = Depends(current_user)
) -> list[ScoreSummary]:
    """Everything this user owns or has been shared. One query, not N+1: the share role
    comes back in the same row via an outer join."""
    rows = db.execute(
        select(Score, ScoreShare.role)
        .outerjoin(ScoreShare, (ScoreShare.score_id == Score.id) & (ScoreShare.user_id == user.id))
        .where(or_(Score.owner_id == user.id, ScoreShare.user_id == user.id))
        .order_by(Score.updated_at.desc())
    ).all()

    version_ids = [s.current_version_id for s, _ in rows if s.current_version_id]
    versions = (
        {
            v.id: v
            for v in db.execute(
                select(ScoreVersion).where(ScoreVersion.id.in_(version_ids))
            ).scalars()
        }
        if version_ids
        else {}
    )

    return [
        _summary(
            score,
            ShareRole.owner if score.owner_id == user.id else (role or ShareRole.viewer),
            versions.get(score.current_version_id) if score.current_version_id else None,
        )
        for score, role in rows
    ]


@router.post("", response_model=ScoreCreateResponse, status_code=status.HTTP_202_ACCEPTED)
def create_score(
    file: UploadFile = File(...),
    title: str = Form(...),
    show: str | None = Form(default=None),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    db: Session = Depends(get_db),
    user: User = Depends(current_user),
) -> ScoreCreateResponse:
    """Upload a PDF and kick off recognition.

    202, not 201: the score exists but is not usable yet. The client gets a job handle
    and polls `/jobs/{id}`. Returning 201 with an empty score would be a lie the
    frontend then has to special-case.
    """
    payload = file.file.read()
    if not payload:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Empty file")
    if len(payload) > MAX_PDF_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "PDF exceeds 50MB")
    if not payload.startswith(b"%PDF"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Not a PDF")

    digest = hashlib.sha256(payload).hexdigest()
    score = Score(owner_id=user.id, title=title, show=show)
    db.add(score)
    db.flush()

    version = ScoreVersion(
        score_id=score.id,
        version=1,
        status=VersionStatus.pending,
        source_object_key=f"scores/{score.id}/source/v1-{digest[:12]}.pdf",
    )
    db.add(version)
    db.flush()

    storage.put_object(version.source_object_key, payload, "application/pdf")

    # Content hash in the idempotency key means a double-submit of the same PDF is free,
    # while a genuinely different PDF under a retried request still gets its own job.
    key = idempotency_key or f"omr:{version.id}:{digest}"
    job, _created = create_or_get_job(db, score_version_id=version.id, idempotency_key=key)
    db.commit()
    enqueue(job)

    return ScoreCreateResponse(
        score=_summary(score, ShareRole.owner, version), job=JobRead.model_validate(job)
    )


@router.get("/{score_id}", response_model=ScoreDetail)
def get_score(
    access: ScoreAccess = Depends(require_score()), db: Session = Depends(get_db)
) -> ScoreDetail:
    score = access.score
    versions = (
        db.execute(
            select(ScoreVersion)
            .where(ScoreVersion.score_id == score.id)
            .order_by(ScoreVersion.version)
        )
        .scalars()
        .all()
    )
    current = next((v for v in versions if v.id == score.current_version_id), None)
    detail = ScoreDetail(
        **_summary(score, access.role, current).model_dump(),
        versions=[
            ScoreVersionSummary(
                id=v.id,
                version=v.version,
                status=v.status,
                engine=v.engine,
                engine_version=v.engine_version,
                page_count=v.page_count,
                note_count=v.note_count,
                created_at=v.created_at,
                is_current=v.id == score.current_version_id,
            )
            for v in versions
        ],
    )
    return detail


@router.get("/{score_id}/doc", response_model=ScoreDocResponse)
def get_score_doc(
    version_id: uuid.UUID | None = Query(default=None, alias="versionId"),
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> ScoreDocResponse:
    """The renderable document. `?versionId=` lets an editor preview a version before
    activating it; without it you get whatever is current."""
    target_id = version_id or access.score.current_version_id
    if target_id is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Score has no ready version yet")
    version = db.get(ScoreVersion, target_id)
    if version is None or version.score_id != access.score.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    if version.status is not VersionStatus.ready or not version.doc:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Version is {version.status}")

    doc = ScoreDoc.model_validate(version.doc)
    return ScoreDocResponse(
        score_id=access.score.id,
        version_id=version.id,
        version=version.version,
        doc=doc,
        page_urls=[storage.presigned_get(p.image_key) for p in doc.pages],
    )


@router.post("/{score_id}/versions", response_model=JobRead, status_code=status.HTTP_202_ACCEPTED)
def create_version(
    file: UploadFile = File(...),
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    access: ScoreAccess = Depends(require_score(ShareRole.editor)),
    db: Session = Depends(get_db),
) -> JobRead:
    """Re-run recognition on a corrected PDF. Produces a new version; does not activate it."""
    payload = file.file.read()
    if not payload.startswith(b"%PDF"):
        raise HTTPException(status.HTTP_415_UNSUPPORTED_MEDIA_TYPE, "Not a PDF")

    next_version = (
        db.execute(
            select(func.coalesce(func.max(ScoreVersion.version), 0)).where(
                ScoreVersion.score_id == access.score.id
            )
        ).scalar_one()
        + 1
    )
    digest = hashlib.sha256(payload).hexdigest()
    version = ScoreVersion(
        score_id=access.score.id,
        version=next_version,
        source_object_key=f"scores/{access.score.id}/source/v{next_version}-{digest[:12]}.pdf",
    )
    db.add(version)
    db.flush()
    storage.put_object(version.source_object_key, payload, "application/pdf")

    job, _ = create_or_get_job(
        db,
        score_version_id=version.id,
        idempotency_key=idempotency_key or f"omr:{version.id}:{digest}",
    )
    db.commit()
    enqueue(job)
    return JobRead.model_validate(job)


@router.get("/{score_id}/versions/{version_id}/migration", response_model=MigrationReport)
def preview_migration(
    version_id: uuid.UUID,
    access: ScoreAccess = Depends(require_score(ShareRole.editor)),
    db: Session = Depends(get_db),
) -> MigrationReport:
    """Dry run: what would activating this version do to everyone's saved work."""
    target = db.get(ScoreVersion, version_id)
    if target is None or target.score_id != access.score.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    current = (
        db.get(ScoreVersion, access.score.current_version_id)
        if access.score.current_version_id
        else None
    )
    return build_report(db, score_id=access.score.id, from_version=current, to_version=target)


@router.post("/{score_id}/versions/{version_id}/activate", response_model=MigrationReport)
def activate_version(
    version_id: uuid.UUID,
    access: ScoreAccess = Depends(require_score(ShareRole.editor)),
    db: Session = Depends(get_db),
) -> MigrationReport:
    target = db.get(ScoreVersion, version_id)
    if target is None or target.score_id != access.score.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Version not found")
    if target.status is not VersionStatus.ready:
        raise HTTPException(status.HTTP_409_CONFLICT, f"Version is {target.status}")

    current = (
        db.get(ScoreVersion, access.score.current_version_id)
        if access.score.current_version_id
        else None
    )
    report = build_report(db, score_id=access.score.id, from_version=current, to_version=target)
    access.score.current_version_id = target.id
    db.commit()
    return report


@router.delete("/{score_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_score(
    access: ScoreAccess = Depends(require_score(ShareRole.owner)), db: Session = Depends(get_db)
) -> None:
    db.delete(access.score)
    db.commit()


@router.get("/{score_id}/jobs", response_model=list[JobRead])
def list_score_jobs(
    access: ScoreAccess = Depends(require_score()), db: Session = Depends(get_db)
) -> list[JobRead]:
    jobs = (
        db.execute(
            select(Job)
            .join(ScoreVersion, Job.score_version_id == ScoreVersion.id)
            .where(ScoreVersion.score_id == access.score.id)
            .order_by(Job.created_at.desc())
        )
        .scalars()
        .all()
    )
    return [JobRead.model_validate(j) for j in jobs]
