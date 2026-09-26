"""initial schema

Revision ID: 0001
Revises:
Create Date: 2026-09-25

Hand-tidied from autogenerate. Two things the generator got wrong for Postgres and
which are worth knowing about:

* `scores.current_version_id` and `score_versions.score_id` are a cycle. The generator
  emitted both FKs inline, which fails on the first CREATE TABLE. The cycle is broken
  by creating `scores` without the constraint and adding it after `score_versions`
  exists — which is also why the model declares it with `use_alter=True`.
* The generator rendered `postgresql.JSONB(astext_type=Text())` with an unqualified
  `Text`, which is a NameError at migration time.
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None

JSONVariant = sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), "postgresql")
NOW = sa.text("CURRENT_TIMESTAMP")


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("display_name", sa.String(length=120), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_users_email", "users", ["email"], unique=True)

    op.create_table(
        "scores",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("title", sa.String(length=200), nullable=False),
        sa.Column("show", sa.String(length=200), nullable=True),
        sa.Column("current_version_id", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_scores_owner_id", "scores", ["owner_id"])

    op.create_table(
        "score_versions",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("score_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=16), server_default="pending", nullable=False),
        sa.Column("source_object_key", sa.String(length=512), nullable=False),
        sa.Column("engine", sa.String(length=64), nullable=True),
        sa.Column("engine_version", sa.String(length=64), nullable=True),
        sa.Column("doc", JSONVariant, nullable=True),
        sa.Column("page_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("note_count", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["score_id"], ["scores.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("score_id", "version", name="uq_score_version_number"),
    )
    op.create_index("ix_score_versions_score_id", "score_versions", ["score_id"])
    op.create_index("ix_score_versions_score_status", "score_versions", ["score_id", "status"])

    # The deferred half of the cycle. SQLite cannot ALTER TABLE ADD CONSTRAINT at all,
    # and rebuilding the table via batch mode just to add an FK it does not enforce by
    # default is not worth it — SQLite is only ever a local smoke-test target here.
    if op.get_bind().dialect.name != "sqlite":
        op.create_foreign_key(
            "fk_score_current_version",
            "scores",
            "score_versions",
            ["current_version_id"],
            ["id"],
            ondelete="SET NULL",
        )

    op.create_table(
        "score_shares",
        sa.Column("score_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=8), nullable=False, server_default="viewer"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["score_id"], ["scores.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("score_id", "user_id"),
        sa.UniqueConstraint("score_id", "user_id", name="uq_share_score_user"),
    )

    op.create_table(
        "jobs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("score_version_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=32), nullable=False, server_default="omr"),
        sa.Column("status", sa.String(length=16), server_default="queued", nullable=False),
        sa.Column("idempotency_key", sa.String(length=128), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("max_attempts", sa.Integer(), nullable=False, server_default="3"),
        sa.Column("progress", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("stage", sa.String(length=64), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("finished_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(["score_version_id"], ["score_versions.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("idempotency_key", name="uq_jobs_idempotency_key"),
    )
    op.create_index("ix_jobs_score_version_id", "jobs", ["score_version_id"])
    op.create_index("ix_jobs_status_created", "jobs", ["status", "created_at"])

    op.create_table(
        "profiles",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("score_id", sa.Uuid(), nullable=False),
        sa.Column("owner_id", sa.Uuid(), nullable=False),
        sa.Column("authored_version_id", sa.Uuid(), nullable=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("color", sa.String(length=9), nullable=False, server_default="#6366f1"),
        sa.Column("is_shared", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["authored_version_id"], ["score_versions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["owner_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["score_id"], ["scores.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("score_id", "owner_id", "name", name="uq_profile_name_per_owner"),
    )
    op.create_index("ix_profiles_owner_id", "profiles", ["owner_id"])
    op.create_index("ix_profiles_score_id", "profiles", ["score_id"])

    op.create_table(
        "profile_notes",
        sa.Column("profile_id", sa.Uuid(), nullable=False),
        sa.Column("note_id", sa.String(length=24), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.ForeignKeyConstraint(["profile_id"], ["profiles.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("profile_id", "note_id"),
    )
    # Reverse lookup: "which profiles contain this note", used to paint the overlay.
    op.create_index("ix_profile_notes_note", "profile_notes", ["note_id"])

    op.create_table(
        "annotations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("score_id", sa.Uuid(), nullable=False),
        sa.Column("author_id", sa.Uuid(), nullable=False),
        sa.Column("authored_version_id", sa.Uuid(), nullable=True),
        sa.Column("target_type", sa.String(length=8), nullable=False),
        sa.Column("target_id", sa.String(length=64), nullable=False),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column("payload", JSONVariant, nullable=False),
        sa.Column("is_shared", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint("target_type in ('note','part')", name="ck_annotation_target_type"),
        sa.ForeignKeyConstraint(["author_id"], ["users.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["authored_version_id"], ["score_versions.id"], ondelete="SET NULL"),
        sa.ForeignKeyConstraint(["score_id"], ["scores.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("ix_annotations_author_id", "annotations", ["author_id"])
    op.create_index("ix_annotations_score_id", "annotations", ["score_id"])
    op.create_index(
        "ix_annotations_score_target", "annotations", ["score_id", "target_type", "target_id"]
    )
    # One annotation of a given kind per target per author — this is what makes the
    # batch upsert in routers/annotations.py safe to retry.
    op.create_index(
        "uq_annotation_author_target_kind",
        "annotations",
        ["score_id", "author_id", "target_type", "target_id", "kind"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_table("annotations")
    op.drop_table("profile_notes")
    op.drop_table("profiles")
    op.drop_table("jobs")
    op.drop_table("score_shares")
    if op.get_bind().dialect.name != "sqlite":
        op.drop_constraint("fk_score_current_version", "scores", type_="foreignkey")
    op.drop_table("score_versions")
    op.drop_table("scores")
    op.drop_table("users")
