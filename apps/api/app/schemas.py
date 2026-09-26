"""Wire types. These are the OpenAPI schema, and therefore the TypeScript types."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import Field

from app.camel import CamelModel
from app.models import JobStatus, ShareRole, TargetType, VersionStatus
from app.scoredoc import ScoreDoc


# --- scores -----------------------------------------------------------------
class ScoreSummary(CamelModel):
    id: uuid.UUID
    title: str
    show: str | None = None
    owner_id: uuid.UUID
    my_role: ShareRole
    current_version_id: uuid.UUID | None = None
    status: VersionStatus | None = None
    page_count: int = 0
    note_count: int = 0
    updated_at: datetime


class ScoreVersionSummary(CamelModel):
    id: uuid.UUID
    version: int
    status: VersionStatus
    engine: str | None = None
    engine_version: str | None = None
    page_count: int
    note_count: int
    created_at: datetime
    is_current: bool = False


class ScoreDetail(ScoreSummary):
    versions: list[ScoreVersionSummary] = Field(default_factory=list)


class ScoreDocResponse(CamelModel):
    """The renderable payload: the document plus signed URLs for its page images.

    URLs are minted per request and expire, so the response is deliberately
    uncacheable while the document itself (the expensive part) is content-addressed
    by version ID and cached hard on the client.
    """

    score_id: uuid.UUID
    version_id: uuid.UUID
    version: int
    doc: ScoreDoc
    page_urls: list[str] = Field(default_factory=list)


class ScoreCreateResponse(CamelModel):
    score: ScoreSummary
    job: JobRead


# --- jobs -------------------------------------------------------------------
class JobRead(CamelModel):
    id: uuid.UUID
    score_version_id: uuid.UUID
    kind: str
    status: JobStatus
    progress: int
    stage: str | None = None
    attempts: int
    max_attempts: int
    error: str | None = None
    created_at: datetime
    started_at: datetime | None = None
    finished_at: datetime | None = None


# --- profiles ---------------------------------------------------------------
class ProfileCreate(CamelModel):
    name: str = Field(min_length=1, max_length=120)
    color: str = Field(default="#6366f1", pattern=r"^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
    is_shared: bool = False
    note_ids: list[str] = Field(default_factory=list)


class ProfileUpdate(CamelModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    color: str | None = Field(default=None, pattern=r"^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
    is_shared: bool | None = None


class ProfileNotesPatch(CamelModel):
    """Incremental edit. Clicking a note sends one add or one remove, not the whole set —
    which keeps a 900-note part's edits at a few hundred bytes and makes concurrent
    edits by two people commute instead of clobbering."""

    add: list[str] = Field(default_factory=list)
    remove: list[str] = Field(default_factory=list)


class ProfileRead(CamelModel):
    id: uuid.UUID
    score_id: uuid.UUID
    owner_id: uuid.UUID
    name: str
    color: str
    is_shared: bool
    authored_version_id: uuid.UUID | None = None
    note_ids: list[str] = Field(default_factory=list)
    created_at: datetime
    updated_at: datetime


# --- annotations ------------------------------------------------------------
class AnnotationUpsert(CamelModel):
    target_type: TargetType
    target_id: str
    kind: str = Field(pattern=r"^(color|text|marker)$")
    payload: dict = Field(default_factory=dict)
    is_shared: bool = False


class AnnotationRead(CamelModel):
    id: uuid.UUID
    score_id: uuid.UUID
    author_id: uuid.UUID
    target_type: TargetType
    target_id: str
    kind: str
    payload: dict
    is_shared: bool
    updated_at: datetime


# --- sharing ----------------------------------------------------------------
class ShareCreate(CamelModel):
    email: str
    role: ShareRole = ShareRole.viewer


class ShareRead(CamelModel):
    user_id: uuid.UUID
    email: str
    role: ShareRole
    created_at: datetime


# --- version migration ------------------------------------------------------
class ProfileMigration(CamelModel):
    profile_id: uuid.UUID
    profile_name: str
    kept: int
    lost: int
    lost_note_ids: list[str] = Field(default_factory=list)


class MigrationReport(CamelModel):
    """What activating a new score version did to existing user work.

    Surfaced to the user rather than silently applied: "14 of your 312 notes no longer
    exist in the corrected score" is information a singer needs before a rehearsal.
    """

    from_version_id: uuid.UUID | None = None
    to_version_id: uuid.UUID
    notes_added: int
    notes_removed: int
    profiles: list[ProfileMigration] = Field(default_factory=list)
    annotations_orphaned: int = 0


ScoreCreateResponse.model_rebuild()
