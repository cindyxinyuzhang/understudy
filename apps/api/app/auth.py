"""Identity: turn a request into a `User` row.

Supabase owns the credential flow (email magic links, OAuth). We never see a password.
What reaches us is a JWT; we verify its signature locally and mirror the claims into
our `users` table so ownership and shares can be real foreign keys.
"""

from __future__ import annotations

import uuid

from fastapi import Depends, Header, HTTPException, status
from jose import JWTError, jwt
from sqlalchemy.orm import Session

from app.config import Settings, get_settings
from app.db import get_db
from app.models import User

_CREDENTIALS_ERROR = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Not authenticated",
    headers={"WWW-Authenticate": "Bearer"},
)


def _upsert_user(db: Session, *, user_id: uuid.UUID, email: str, display_name: str | None) -> User:
    user = db.get(User, user_id)
    if user is None:
        user = User(id=user_id, email=email, display_name=display_name)
        db.add(user)
        db.flush()
    elif user.email != email:
        # Supabase is the source of truth for the address; keep the mirror honest.
        user.email = email
        db.flush()
    return user


def current_user(
    authorization: str | None = Header(default=None),
    x_dev_user: str | None = Header(default=None, alias="X-Dev-User"),
    db: Session = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> User:
    if authorization and authorization.lower().startswith("bearer "):
        token = authorization.split(" ", 1)[1]
        try:
            claims = jwt.decode(
                token,
                settings.supabase_jwt_secret,
                algorithms=["HS256"],
                audience=settings.supabase_jwt_audience,
            )
        except JWTError as exc:
            raise _CREDENTIALS_ERROR from exc
        sub = claims.get("sub")
        email = claims.get("email")
        if not sub or not email:
            raise _CREDENTIALS_ERROR
        return _upsert_user(
            db,
            user_id=uuid.UUID(sub),
            email=email,
            display_name=(claims.get("user_metadata") or {}).get("full_name"),
        )

    # Dev bypass: `X-Dev-User: alice@example.com` becomes a stable synthetic identity.
    # Gated on env so a misconfigured prod deploy fails closed rather than open.
    if x_dev_user and not settings.auth_enforced:
        synthetic_id = uuid.uuid5(uuid.NAMESPACE_URL, f"understudy-dev:{x_dev_user}")
        return _upsert_user(db, user_id=synthetic_id, email=x_dev_user, display_name=x_dev_user)

    raise _CREDENTIALS_ERROR
