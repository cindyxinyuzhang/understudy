"""Relational model.

Shape of the thing, in one paragraph: a ``Score`` is the stable identity a user
shares ("Defying Gravity"). Every OMR run produces an immutable ``ScoreVersion``
holding the canonical score document as JSONB. User work — profiles (a singer's
selected notes) and annotations — hangs off the *score*, not the version, and
addresses notes by deterministic ID so it survives a re-OMR. See
docs/DECISIONS.md #3 and #4.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base

# JSONB on Postgres, plain JSON on SQLite so the unit suite runs without a database
# container. Nothing in the app relies on JSONB operators; queries against note data
# go through the loaded document, not SQL.
JSONVariant = JSON().with_variant(JSONB, "postgresql")


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


def enum_column(enum_cls: type[enum.Enum], length: int):
    """Store an enum as VARCHAR while keeping it an enum in Python.

    A plain `String` column looked fine — `JobStatus.queued` is a `str` subclass, so it
    writes correctly — but it reads back as a bare string, which silently breaks every
    `is` comparison and every dict lookup keyed on the enum. `native_enum=False` keeps
    the column a VARCHAR (so adding a status is a code change, not a migration with an
    `ALTER TYPE`) while restoring round-tripping.

    `create_constraint=False` because the CHECK a database-level enum implies is the
    part that makes adding a value painful, and the value set is already enforced by
    Pydantic at the edge.
    """
    return Enum(
        enum_cls,
        native_enum=False,
        create_constraint=False,
        length=length,
        values_callable=lambda members: [m.value for m in members],
    )


class JobStatus(enum.StrEnum):
    queued = "queued"
    running = "running"
    succeeded = "succeeded"
    failed = "failed"
    cancelled = "cancelled"


class VersionStatus(enum.StrEnum):
    pending = "pending"  # row exists, PDF uploaded, OMR not finished
    ready = "ready"  # doc populated, safe to open
    failed = "failed"  # OMR gave up after max attempts


class ShareRole(enum.StrEnum):
    viewer = "viewer"  # read score + own profiles
    editor = "editor"  # + correct the score, re-run OMR, edit shared annotations
    owner = "owner"  # + delete, manage shares


class TargetType(enum.StrEnum):
    note = "note"
    part = "part"


class User(Base):
    """Local mirror of a Supabase auth user.

    We keep a row per user so shares and ownership can be foreign keys and so we can
    resolve "share with this email" without a round trip to the auth service. The
    row is upserted from JWT claims on each request (see app/auth.py).
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True)  # == Supabase `sub`
    email: Mapped[str] = mapped_column(String(320), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(120))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Score(Base):
    __tablename__ = "scores"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    title: Mapped[str] = mapped_column(String(200))
    show: Mapped[str | None] = mapped_column(String(200))
    # Points at the version clients get by default. Nullable while the first OMR runs.
    current_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey(
            "score_versions.id",
            ondelete="SET NULL",
            use_alter=True,
            name="fk_score_current_version",
        )
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    versions: Mapped[list[ScoreVersion]] = relationship(
        back_populates="score",
        foreign_keys="ScoreVersion.score_id",
        cascade="all, delete-orphan",
        order_by="ScoreVersion.version",
    )
    shares: Mapped[list[ScoreShare]] = relationship(
        back_populates="score", cascade="all, delete-orphan"
    )


class ScoreVersion(Base):
    """An immutable snapshot of one OMR run (or one manual correction pass).

    Immutability is what makes annotation migration tractable: a profile records the
    version it was authored against, so when a new version lands we can diff note ID
    sets and tell the user exactly what did and did not carry over.
    """

    __tablename__ = "score_versions"
    __table_args__ = (
        UniqueConstraint("score_id", "version", name="uq_score_version_number"),
        Index("ix_score_versions_score_status", "score_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    score_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scores.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[int] = mapped_column(Integer)
    status: Mapped[VersionStatus] = mapped_column(
        enum_column(VersionStatus, 16),
        default=VersionStatus.pending,
        server_default=VersionStatus.pending.value,
    )

    source_object_key: Mapped[str] = mapped_column(
        String(512)
    )  # the uploaded PDF in object storage
    engine: Mapped[str | None] = mapped_column(String(64))
    engine_version: Mapped[str | None] = mapped_column(String(64))

    # The canonical score document. See packages/api-types ScoreDoc / app/schemas.py.
    doc: Mapped[dict | None] = mapped_column(JSONVariant)
    page_count: Mapped[int] = mapped_column(Integer, default=0)
    note_count: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    score: Mapped[Score] = relationship(back_populates="versions", foreign_keys=[score_id])
    jobs: Mapped[list[Job]] = relationship(
        back_populates="score_version", cascade="all, delete-orphan"
    )


class Job(Base):
    """A unit of async work (today: OMR of one uploaded PDF).

    We keep job state in Postgres rather than reading it out of Redis. Redis is the
    transport; Postgres is the record. That means job history survives a Redis flush,
    and the status endpoint is a plain indexed read instead of an RQ registry scan.
    """

    __tablename__ = "jobs"
    __table_args__ = (
        # Idempotency: the same upload retried by a flaky client reuses the job row
        # instead of burning a second GPU minute.
        UniqueConstraint("idempotency_key", name="uq_jobs_idempotency_key"),
        Index("ix_jobs_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    score_version_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("score_versions.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(32), default="omr")
    status: Mapped[JobStatus] = mapped_column(
        enum_column(JobStatus, 16), default=JobStatus.queued, server_default=JobStatus.queued.value
    )
    idempotency_key: Mapped[str] = mapped_column(String(128))
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3)
    progress: Mapped[int] = mapped_column(Integer, default=0)  # 0..100, advisory only
    stage: Mapped[str | None] = mapped_column(String(64))
    error: Mapped[str | None] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    score_version: Mapped[ScoreVersion] = relationship(back_populates="jobs")


class Profile(Base):
    """One singer's part: a named set of notes inside a score.

    Attached to the score, not the version — "Elphaba" outlives any particular OMR run.
    `authored_version_id` records which version the note IDs came from so we can report
    on drift after a re-OMR.
    """

    __tablename__ = "profiles"
    __table_args__ = (
        UniqueConstraint("score_id", "owner_id", "name", name="uq_profile_name_per_owner"),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    score_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scores.id", ondelete="CASCADE"), index=True
    )
    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    authored_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("score_versions.id", ondelete="SET NULL")
    )
    name: Mapped[str] = mapped_column(String(120))
    color: Mapped[str] = mapped_column(String(9), default="#6366f1")  # #rrggbb or #rrggbbaa
    # Profiles are private by default; flipping this makes them visible to anyone the
    # score is shared with (how a music director publishes "Ensemble Sopranos").
    is_shared: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    notes: Mapped[list[ProfileNote]] = relationship(
        back_populates="profile", cascade="all, delete-orphan", passive_deletes=True
    )


class ProfileNote(Base):
    """Membership row: this note belongs to this profile.

    Join table rather than a `text[]` column on `profiles`. An array is one fewer table
    and a single-row read, but it makes "which profiles contain note X" a sequential
    scan, makes concurrent edits a lost-update race (last writer clobbers the whole
    array), and pushes diffing into application code. Rows give us set operations in
    SQL and per-note provenance for free. See docs/DECISIONS.md #4.
    """

    __tablename__ = "profile_notes"
    __table_args__ = (Index("ix_profile_notes_note", "note_id"),)

    profile_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    note_id: Mapped[str] = mapped_column(String(24), primary_key=True)
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    profile: Mapped[Profile] = relationship(back_populates="notes")


class Annotation(Base):
    """Color / text / marker attached to a single note or a whole part.

    One table for both targets, discriminated by `target_type`, because the read path
    is always "give me every annotation on this score" and splitting it into two tables
    would just mean two queries and a merge.
    """

    __tablename__ = "annotations"
    __table_args__ = (
        CheckConstraint("target_type in ('note','part')", name="ck_annotation_target_type"),
        Index("ix_annotations_score_target", "score_id", "target_type", "target_id"),
        # One annotation of a given kind per target per author. This is what makes the
        # batch upsert in routers/annotations.py idempotent: re-colouring a note
        # replaces its colour instead of stacking a second row.
        Index(
            "uq_annotation_author_target_kind",
            "score_id",
            "author_id",
            "target_type",
            "target_id",
            "kind",
            unique=True,
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=_uuid)
    score_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scores.id", ondelete="CASCADE"), index=True
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    authored_version_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("score_versions.id", ondelete="SET NULL")
    )
    target_type: Mapped[TargetType] = mapped_column(enum_column(TargetType, 8))
    target_id: Mapped[str] = mapped_column(String(64))  # note ID, or part ID
    kind: Mapped[str] = mapped_column(String(16))  # "color" | "text" | "marker"
    payload: Mapped[dict] = mapped_column(JSONVariant, default=dict)
    is_shared: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class ScoreShare(Base):
    # No separate unique constraint: (score_id, user_id) is the primary key, which already
    # allows one share per user per score. Postgres folds an identical unique constraint
    # into the primary key, so declaring one here only makes autogenerate report drift.
    __tablename__ = "score_shares"

    score_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scores.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[ShareRole] = mapped_column(
        enum_column(ShareRole, 8), default=ShareRole.viewer, server_default=ShareRole.viewer.value
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    score: Mapped[Score] = relationship(back_populates="shares")
