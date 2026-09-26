from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.authz import ScoreAccess, require_score
from app.db import get_db
from app.models import Score, ScoreShare, ShareRole, User
from app.schemas import ShareCreate, ShareRead

router = APIRouter(prefix="/scores/{score_id}/shares", tags=["sharing"])


@router.get("", response_model=list[ShareRead])
def list_shares(
    access: ScoreAccess = Depends(require_score()), db: Session = Depends(get_db)
) -> list[ShareRead]:
    rows = db.execute(
        select(ScoreShare, User)
        .join(User, User.id == ScoreShare.user_id)
        .where(ScoreShare.score_id == access.score.id)
    ).all()
    return [
        ShareRead(user_id=s.user_id, email=u.email, role=s.role, created_at=s.created_at)
        for s, u in rows
    ]


@router.post("", response_model=ShareRead, status_code=status.HTTP_201_CREATED)
def add_share(
    body: ShareCreate,
    access: ScoreAccess = Depends(require_score(ShareRole.owner)),
    db: Session = Depends(get_db),
) -> ShareRead:
    """Share by email address.

    The invitee must already exist in our `users` mirror, i.e. they have signed in at
    least once. Inviting a stranger needs an email side channel and a pending-invite
    table; for a cast of ten who all sign in on day one, that is not yet worth building.
    """
    target = db.execute(select(User).where(User.email == body.email.lower())).scalar_one_or_none()
    if target is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "No such user — ask them to sign in once, then share"
        )
    if target.id == access.score.owner_id:
        raise HTTPException(status.HTTP_409_CONFLICT, "That user already owns this score")
    if body.role is ShareRole.owner:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Ownership transfer is not supported")

    share = db.execute(
        select(ScoreShare).where(
            ScoreShare.score_id == access.score.id, ScoreShare.user_id == target.id
        )
    ).scalar_one_or_none()
    if share is None:
        share = ScoreShare(score_id=access.score.id, user_id=target.id, role=body.role)
        db.add(share)
    else:
        share.role = body.role
    db.commit()
    db.refresh(share)
    return ShareRead(
        user_id=target.id, email=target.email, role=share.role, created_at=share.created_at
    )


@router.delete("/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_share(
    user_id: uuid.UUID,
    access: ScoreAccess = Depends(require_score(ShareRole.owner)),
    db: Session = Depends(get_db),
) -> None:
    share = db.execute(
        select(ScoreShare).where(
            ScoreShare.score_id == access.score.id, ScoreShare.user_id == user_id
        )
    ).scalar_one_or_none()
    if share is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Share not found")
    db.delete(share)
    db.commit()


__all__ = ["router", "Score"]
