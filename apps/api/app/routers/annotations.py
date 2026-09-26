from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from app.authz import ScoreAccess, require_score
from app.db import get_db
from app.models import Annotation
from app.schemas import AnnotationRead, AnnotationUpsert

router = APIRouter(prefix="/scores/{score_id}/annotations", tags=["annotations"])

MAX_BATCH = 2000


@router.get("", response_model=list[AnnotationRead])
def list_annotations(
    access: ScoreAccess = Depends(require_score()), db: Session = Depends(get_db)
) -> list[AnnotationRead]:
    rows = (
        db.execute(
            select(Annotation).where(
                Annotation.score_id == access.score.id,
                or_(Annotation.author_id == access.user.id, Annotation.is_shared.is_(True)),
            )
        )
        .scalars()
        .all()
    )
    return [AnnotationRead.model_validate(r) for r in rows]


@router.put("", response_model=list[AnnotationRead])
def upsert_annotations(
    body: list[AnnotationUpsert],
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> list[AnnotationRead]:
    """Idempotent upsert keyed on (author, target, kind).

    One annotation of a given kind per target per author: re-colouring a note replaces
    its colour rather than stacking a second one. Batched because colouring a whole
    voice part is one gesture that touches hundreds of notes, and 300 POSTs would be
    300 round trips.
    """
    if len(body) > MAX_BATCH:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Batch too large")

    keys = {(a.target_type, a.target_id, a.kind) for a in body}
    existing = {
        (a.target_type, a.target_id, a.kind): a
        for a in db.execute(
            select(Annotation).where(
                Annotation.score_id == access.score.id, Annotation.author_id == access.user.id
            )
        ).scalars()
        if (a.target_type, a.target_id, a.kind) in keys
    }

    out: list[Annotation] = []
    for item in body:
        key = (item.target_type, item.target_id, item.kind)
        row = existing.get(key)
        if row is None:
            row = Annotation(
                score_id=access.score.id,
                author_id=access.user.id,
                authored_version_id=access.score.current_version_id,
                target_type=item.target_type,
                target_id=item.target_id,
                kind=item.kind,
            )
            db.add(row)
            existing[key] = row
        row.payload = item.payload
        row.is_shared = item.is_shared
        out.append(row)

    db.commit()
    for row in out:
        db.refresh(row)
    return [AnnotationRead.model_validate(r) for r in out]


@router.delete("/{annotation_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_annotation(
    annotation_id: uuid.UUID,
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> None:
    row = db.get(Annotation, annotation_id)
    if row is None or row.score_id != access.score.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Annotation not found")
    if row.author_id != access.user.id and not access.is_owner:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your annotation")
    db.delete(row)
    db.commit()
