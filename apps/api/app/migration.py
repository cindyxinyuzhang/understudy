"""Moving user work from one score version to the next.

Because note IDs are derived from musical identity (app/scoredoc.py), migration is a
set operation rather than a heuristic alignment: notes present in both versions keep
their IDs and therefore keep their profile membership and annotations for free. The
only real work is reporting what did *not* survive, so a singer finds out before the
rehearsal rather than during it.

Orphaned rows are kept, not deleted. If a later correction restores the note — a
plausible outcome when the first correction was wrong — the selection reappears. The
cost is a slow accumulation of dead rows, which a periodic vacuum job can sweep.
"""

from __future__ import annotations

import uuid

from sqlalchemy.orm import Session

from app.models import Annotation, Profile, ScoreVersion, TargetType
from app.schemas import MigrationReport, ProfileMigration

MAX_REPORTED_LOST = 50


def note_ids_of(version: ScoreVersion | None) -> set[str]:
    if version is None or not version.doc:
        return set()
    return {n["id"] for n in version.doc.get("notes", [])}


def build_report(
    db: Session,
    *,
    score_id: uuid.UUID,
    from_version: ScoreVersion | None,
    to_version: ScoreVersion,
) -> MigrationReport:
    before = note_ids_of(from_version)
    after = note_ids_of(to_version)

    profiles = db.query(Profile).filter(Profile.score_id == score_id).all()
    profile_reports: list[ProfileMigration] = []
    for profile in profiles:
        owned = {pn.note_id for pn in profile.notes}
        lost = sorted(owned - after)
        profile_reports.append(
            ProfileMigration(
                profile_id=profile.id,
                profile_name=profile.name,
                kept=len(owned) - len(lost),
                lost=len(lost),
                lost_note_ids=lost[:MAX_REPORTED_LOST],
            )
        )

    orphaned = (
        db.query(Annotation)
        .filter(Annotation.score_id == score_id, Annotation.target_type == TargetType.note)
        .all()
    )
    orphan_count = sum(1 for a in orphaned if a.target_id not in after)

    return MigrationReport(
        from_version_id=from_version.id if from_version else None,
        to_version_id=to_version.id,
        notes_added=len(after - before),
        notes_removed=len(before - after),
        profiles=profile_reports,
        annotations_orphaned=orphan_count,
    )
