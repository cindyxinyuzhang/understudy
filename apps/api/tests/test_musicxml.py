"""MusicXML -> ScoreDoc. Exercised without any OMR engine installed."""

from __future__ import annotations

import textwrap

from app.worker.omr.musicxml import parse_musicxml

SAMPLE = textwrap.dedent("""\
<?xml version="1.0"?>
<score-partwise version="4.0">
  <part-list>
    <score-part id="P1"><part-name>Elphaba</part-name>
      <part-abbreviation>Elph.</part-abbreviation></score-part>
    <score-part id="P2"><part-name>Piano</part-name></score-part>
  </part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>2</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <direction><sound tempo="76"/></direction>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice>
        <lyric><text>Some</text></lyric></note>
      <note><pitch><step>E</step><alter>-1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice></note>
      <note><rest/><duration>4</duration><voice>1</voice></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice>
        <tie type="start"/></note>
      <note><chord/><pitch><step>B</step><octave>4</octave></pitch><duration>4</duration><voice>1</voice></note>
      <backup><duration>4</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>4</duration><voice>2</voice></note>
    </measure>
  </part>
  <part id="P2">
    <measure number="1">
      <attributes><divisions>4</divisions></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>16</duration><voice>1</voice><staff>2</staff></note>
    </measure>
  </part>
</score-partwise>
""").encode()


def test_parts_and_vocal_detection():
    doc = parse_musicxml(SAMPLE)
    assert [p.name for p in doc.parts] == ["Elphaba", "Piano"]
    assert [p.is_vocal for p in doc.parts] == [True, False]
    assert doc.parts[0].abbreviation == "Elph."


def test_divisions_are_normalised_across_parts():
    """P1 uses 2 ticks/quarter, P2 uses 4. Onsets from both must be comparable, which
    means one document-wide resolution."""
    doc = parse_musicxml(SAMPLE)
    assert doc.divisions == 4
    p1_first = next(n for n in doc.notes if n.part_id == "P1")
    assert p1_first.duration == 4  # a quarter note at the document resolution
    p2_first = next(n for n in doc.notes if n.part_id == "P2")
    assert p2_first.duration == 16  # a whole note


def test_pitch_alter_lyrics_and_rests():
    doc = parse_musicxml(SAMPLE)
    p1 = [n for n in doc.notes if n.part_id == "P1"]
    assert p1[0].midi == 60 and p1[0].lyric == "Some"
    assert p1[1].midi == 63  # E-flat 4
    assert p1[2].midi is None  # rest


def test_chord_notes_share_an_onset():
    doc = parse_musicxml(SAMPLE)
    m2 = [n for n in doc.notes if n.part_id == "P1" and n.measure == 2]
    g, b = m2[0], m2[1]
    assert g.onset == b.onset and g.onset_in_measure == b.onset_in_measure
    assert g.tie == "start"


def test_backup_rewinds_for_a_second_voice():
    doc = parse_musicxml(SAMPLE)
    voice2 = [n for n in doc.notes if n.part_id == "P1" and n.voice == 2]
    assert len(voice2) == 1
    assert voice2[0].onset_in_measure == 0


def test_absolute_onsets_advance_by_measure():
    doc = parse_musicxml(SAMPLE)
    m2 = next(n for n in doc.notes if n.part_id == "P1" and n.measure == 2)
    # Measure 1 is a full 4/4 bar: two quarters + a half = 16 ticks at divisions=4.
    assert m2.onset == 16
    assert doc.measure_count == 2
    assert doc.tempos[0].bpm == 76.0


def test_every_note_gets_an_id():
    doc = parse_musicxml(SAMPLE)
    ids = [n.id for n in doc.notes]
    assert all(ids) and len(set(ids)) == len(ids)
