"""Authorization.

Enforced here, in the API layer, not in Postgres row-level security. The reason is
that the browser never talks to Postgres: every read and write goes through FastAPI,
which holds a single service-role connection. RLS in that topology protects nothing
extra — the policy would be evaluated against a role that is allowed to do everything
— while costing us a second place where rules live and a much harder debugging story.

What would change the decision: exposing Supabase's auto-generated REST/Realtime API
to the client for any table. The moment a browser can issue its own query, the database
has to be the one saying no, and these checks become a duplicate of the policy rather
than the policy itself. docs/DECISIONS.md #6.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable

from fastapi import Depends, HTTPException, Path, status
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import current_user
from app.db import get_db
from app.models import Score, ScoreShare, ShareRole, User

_RANK = {ShareRole.viewer: 0, ShareRole.editor: 1, ShareRole.owner: 2}


class ScoreAccess:
    """The result of an access check: the score, plus what this user may do with it."""

    def __init__(self, score: Score, user: User, role: ShareRole):
        self.score = score
        self.user = user
        self.role = role

    @property
    def can_edit(self) -> bool:
        return _RANK[self.role] >= _RANK[ShareRole.editor]

    @property
    def is_owner(self) -> bool:
        return self.role is ShareRole.owner


def _resolve_role(db: Session, score: Score, user: User) -> ShareRole | None:
    if score.owner_id == user.id:
        return ShareRole.owner
    share = db.execute(
        select(ScoreShare).where(ScoreShare.score_id == score.id, ScoreShare.user_id == user.id)
    ).scalar_one_or_none()
    return share.role if share else None


def require_score(min_role: ShareRole = ShareRole.viewer) -> Callable[..., ScoreAccess]:
    """Dependency factory: `access: ScoreAccess = Depends(require_score(ShareRole.editor))`."""

    def dependency(
        score_id: uuid.UUID = Path(...),
        db: Session = Depends(get_db),
        user: User = Depends(current_user),
    ) -> ScoreAccess:
        score = db.get(Score, score_id)
        # 404 rather than 403 for a score the user cannot see at all: a 403 would
        # confirm the ID exists, which is a (small) information leak on shared links.
        if score is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Score not found")
        role = _resolve_role(db, score, user)
        if role is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Score not found")
        if _RANK[role] < _RANK[min_role]:
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"Requires {min_role.value} access")
        return ScoreAccess(score, user, role)

    return dependency
