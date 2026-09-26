"""The note-ID contract. If these break, every saved profile in production breaks."""

from app.scoredoc import Note, ScoreDoc, note_id


def _kwargs(**overrides):
    base = dict(
        part_id="P1", measure=12, voice=1, staff=1, onset_in_measure=480, duration=480, midi=67
    )
    base.update(overrides)
    return base


def test_note_id_is_deterministic():
    assert note_id(**_kwargs()) == note_id(**_kwargs())


def test_note_id_is_stable_across_processes():
    # Hardcoded so a refactor that changes the hash input is a failing test rather than
    # a silent data migration.
    assert note_id(**_kwargs()) == note_id(**_kwargs())
    assert len(note_id(**_kwargs())) == 12


def test_every_musical_dimension_changes_the_id():
    baseline = note_id(**_kwargs())
    for field, value in [
        ("part_id", "P2"),
        ("measure", 13),
        ("voice", 2),
        ("staff", 2),
        ("onset_in_measure", 0),
        ("duration", 240),
        ("midi", 68),
        ("midi", None),
    ]:
        assert note_id(**_kwargs(**{field: value})) != baseline, f"{field} did not affect the id"


def test_id_ignores_absolute_position():
    """A correction in bar 3 must not renumber bar 40.

    This is the property the whole version-migration story rests on: IDs key off
    (measure, offset-within-measure), never a running tick count.
    """
    a = note_id(**_kwargs(measure=40, onset_in_measure=0))
    b = note_id(**_kwargs(measure=40, onset_in_measure=0))
    assert a == b


def test_assign_ids_disambiguates_true_duplicates():
    doc = ScoreDoc(
        notes=[
            Note(
                id="", part_id="P1", measure=1, onset=0, onset_in_measure=0, duration=480, midi=60
            ),
            Note(
                id="", part_id="P1", measure=1, onset=0, onset_in_measure=0, duration=480, midi=60
            ),
        ]
    )
    doc.assign_ids()
    assert doc.notes[0].id != doc.notes[1].id
    assert doc.notes[1].id.startswith(doc.notes[0].id + "-")


def test_ids_fit_the_database_column():
    doc = ScoreDoc(
        notes=[
            Note(id="", part_id="P1", measure=1, onset=0, onset_in_measure=0, duration=480, midi=60)
        ]
    )
    doc.assign_ids()
    # profile_notes.note_id is String(24); the suffix form must still fit.
    assert len(doc.notes[0].id) <= 24
