from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from app.authz import ScoreAccess, require_score
from app.db import get_db
from app.migration import note_ids_of
from app.models import Profile, ProfileNote, ScoreVersion
from app.schemas import ProfileCreate, ProfileNotesPatch, ProfileRead, ProfileUpdate

router = APIRouter(prefix="/scores/{score_id}/profiles", tags=["profiles"])

# A vocal part in a long musical-theatre number runs to a few thousand notes. Cap the
# write so a malformed client cannot ask us to insert a million rows in one request.
MAX_NOTES_PER_REQUEST = 20_000


def _read(profile: Profile) -> ProfileRead:
    return ProfileRead(
        id=profile.id,
        score_id=profile.score_id,
        owner_id=profile.owner_id,
        name=profile.name,
        color=profile.color,
        is_shared=profile.is_shared,
        authored_version_id=profile.authored_version_id,
        note_ids=[n.note_id for n in profile.notes],
        created_at=profile.created_at,
        updated_at=profile.updated_at,
    )


def _load_owned(db: Session, access: ScoreAccess, profile_id: uuid.UUID) -> Profile:
    """Profiles are personal. Being an editor on a score does not grant the right to
    rewrite someone else's part — that is their rehearsal work, not score data."""
    profile = db.get(Profile, profile_id)
    if profile is None or profile.score_id != access.score.id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
    if profile.owner_id != access.user.id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Not your profile")
    return profile


@router.get("", response_model=list[ProfileRead])
def list_profiles(
    access: ScoreAccess = Depends(require_score()), db: Session = Depends(get_db)
) -> list[ProfileRead]:
    """Your own profiles, plus any the score's collaborators have published."""
    profiles = (
        db.execute(
            select(Profile)
            .where(
                Profile.score_id == access.score.id,
                or_(Profile.owner_id == access.user.id, Profile.is_shared.is_(True)),
            )
            .order_by(Profile.created_at)
        )
        .scalars()
        .unique()
        .all()
    )
    return [_read(p) for p in profiles]


@router.post("", response_model=ProfileRead, status_code=status.HTTP_201_CREATED)
def create_profile(
    body: ProfileCreate,
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> ProfileRead:
    if len(body.note_ids) > MAX_NOTES_PER_REQUEST:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Too many notes")

    existing = db.execute(
        select(Profile).where(
            Profile.score_id == access.score.id,
            Profile.owner_id == access.user.id,
            Profile.name == body.name,
        )
    ).scalar_one_or_none()
    if existing is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, "You already have a profile with that name")

    profile = Profile(
        score_id=access.score.id,
        owner_id=access.user.id,
        authored_version_id=access.score.current_version_id,
        name=body.name,
        color=body.color,
        is_shared=body.is_shared,
    )
    db.add(profile)
    db.flush()
    _apply_notes(
        db,
        profile,
        add=body.note_ids,
        remove=[],
        current_version_id=access.score.current_version_id,
    )
    db.commit()
    db.refresh(profile)
    return _read(profile)


@router.patch("/{profile_id}", response_model=ProfileRead)
def update_profile(
    profile_id: uuid.UUID,
    body: ProfileUpdate,
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> ProfileRead:
    profile = _load_owned(db, access, profile_id)
    for field, value in body.model_dump(exclude_unset=True).items():
        setattr(profile, field, value)
    db.commit()
    db.refresh(profile)
    return _read(profile)


@router.delete("/{profile_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_profile(
    profile_id: uuid.UUID,
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> None:
    db.delete(_load_owned(db, access, profile_id))
    db.commit()


@router.patch("/{profile_id}/notes", response_model=ProfileRead)
def patch_profile_notes(
    profile_id: uuid.UUID,
    body: ProfileNotesPatch,
    access: ScoreAccess = Depends(require_score()),
    db: Session = Depends(get_db),
) -> ProfileRead:
    """Add/remove notes incrementally.

    Chosen over PUT-the-whole-set because selection is a click-by-click gesture: a
    diff keeps the request tiny, and two people (or two tabs) editing different parts
    of the same profile merge instead of overwriting each other. Adds are idempotent —
    re-sending an add the client already made is a no-op, so retries are safe.
    """
    profile = _load_owned(db, access, profile_id)
    if len(body.add) + len(body.remove) > MAX_NOTES_PER_REQUEST:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Too many notes in one patch")

    _apply_notes(
        db,
        profile,
        add=body.add,
        remove=body.remove,
        current_version_id=access.score.current_version_id,
    )
    db.commit()
    db.refresh(profile)
    return _read(profile)


def _apply_notes(
    db: Session,
    profile: Profile,
    *,
    add: list[str],
    remove: list[str],
    current_version_id: uuid.UUID | None = None,
) -> None:
    if add and current_version_id is not None:
        # Reject IDs that are not in the score at all. Without this, a buggy client can
        # quietly fill the table with membership rows that will never render.
        known = note_ids_of(db.get(ScoreVersion, current_version_id))
        if known:
            unknown = [n for n in add if n not in known]
            if unknown:
                raise HTTPException(
                    422,
                    f"{len(unknown)} note id(s) are not in the current score version",
                )

    if remove:
        db.execute(
            delete(ProfileNote).where(
                ProfileNote.profile_id == profile.id, ProfileNote.note_id.in_(set(remove))
            )
        )
    if add:
        existing = {
            row
            for row in db.execute(
                select(ProfileNote.note_id).where(
                    ProfileNote.profile_id == profile.id, ProfileNote.note_id.in_(set(add))
                )
            ).scalars()
        }
        db.add_all(
            ProfileNote(profile_id=profile.id, note_id=nid)
            for nid in dict.fromkeys(add)
            if nid not in existing
        )
    db.flush()
