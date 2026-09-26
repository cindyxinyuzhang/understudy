"""The canonical score document and its deterministic note IDs.

This module is the contract between the OMR worker (which produces documents) and
everything else (which addresses notes inside them). It has no database or FastAPI
imports on purpose: the GPU worker image can import it without pulling in the web
stack, and it is trivially unit-testable.
"""

from __future__ import annotations

from hashlib import blake2s
from typing import Literal

from pydantic import Field

from app.camel import CamelModel

SCHEMA_VERSION = 1


def note_id(
    *,
    part_id: str,
    measure: int,
    voice: int,
    staff: int,
    onset_in_measure: int,
    duration: int,
    midi: int | None,
) -> str:
    """Stable 12-hex-char ID for a note, derived from its musical identity.

    Why derive instead of assigning a UUID at ingest: a user's saved part must survive
    re-running OMR on a corrected PDF. If IDs were random, every re-run would orphan
    every selection. Hashing musical identity means a note that did not change keeps
    its ID, and only genuinely changed notes drop out — which is also exactly the set
    we want to show the user in a migration report.

    The position component is ``(measure, onset_in_measure)`` rather than an absolute
    tick offset. Absolute offsets make every note after an inserted or re-timed measure
    a "new" note; measure-relative offsets keep the blast radius of a local correction
    local.

    ``midi is None`` means a rest. Rests get IDs too — a singer counting bars wants to
    annotate them.
    """
    material = "|".join(
        [
            str(SCHEMA_VERSION),
            part_id,
            str(measure),
            str(voice),
            str(staff),
            str(onset_in_measure),
            str(duration),
            "rest" if midi is None else str(midi),
        ]
    )
    return blake2s(material.encode("utf-8"), digest_size=6).hexdigest()


class Page(CamelModel):
    index: int
    width: int  # pixels of the rendered page image
    height: int
    image_key: str  # object-storage key; client fetches via a signed URL


class Part(CamelModel):
    """A voice part / staff line as OMR understood it: "Elphaba", "Soprano", "Piano R.H."."""

    id: str
    name: str
    abbreviation: str | None = None
    index: int
    is_vocal: bool = True
    default_color: str | None = None


class Tempo(CamelModel):
    onset: int  # absolute ticks
    bpm: float


class TimeSignature(CamelModel):
    measure: int
    numerator: int
    denominator: int


class Note(CamelModel):
    """One notated event. Rests carry ``midi=None``.

    ``onset``/``onset_in_measure``/``duration`` are in ticks; ``ScoreDoc.divisions``
    says how many ticks are in a quarter note. Integer ticks rather than seconds so the
    document is tempo-independent — changing playback tempo must not rewrite the score.
    """

    id: str
    part_id: str
    measure: int
    voice: int = 1
    staff: int = 1
    onset: int  # absolute, from start of score
    onset_in_measure: int
    duration: int
    midi: int | None = None
    tie: Literal["start", "stop", "continue"] | None = None
    lyric: str | None = None
    page: int = 0
    # Normalised [x, y, w, h] in 0..1 page coordinates. Normalised, not pixels, so the
    # overlay stays correct at any zoom or page-image resolution.
    bbox: tuple[float, float, float, float] | None = None
    confidence: float = 1.0


class ScoreDoc(CamelModel):
    """Everything the client needs to render and play a score version."""

    schema_version: int = SCHEMA_VERSION
    divisions: int = 480  # ticks per quarter note
    pages: list[Page] = Field(default_factory=list)
    parts: list[Part] = Field(default_factory=list)
    notes: list[Note] = Field(default_factory=list)
    tempos: list[Tempo] = Field(default_factory=list)
    time_signatures: list[TimeSignature] = Field(default_factory=list)
    measure_count: int = 0

    def assign_ids(self) -> ScoreDoc:
        """Fill in deterministic IDs, de-duplicating the rare exact collision.

        Two notes can legitimately hash the same only if they are musically identical
        (same part, voice, staff, measure position, duration, pitch) — which is either
        an OMR double-detection or a genuine unison written twice. We suffix a counter
        so IDs stay unique, accepting that such a note's ID is order-dependent.
        """
        seen: dict[str, int] = {}
        for note in self.notes:
            base = note_id(
                part_id=note.part_id,
                measure=note.measure,
                voice=note.voice,
                staff=note.staff,
                onset_in_measure=note.onset_in_measure,
                duration=note.duration,
                midi=note.midi,
            )
            n = seen.get(base, 0)
            seen[base] = n + 1
            note.id = base if n == 0 else f"{base}-{n}"
        return self
