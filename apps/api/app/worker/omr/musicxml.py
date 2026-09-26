"""MusicXML (partwise) -> ScoreDoc.

Real OMR engines emit MusicXML, so this parser is the adapter between "what engines
produce" and "what this app stores". Kept engine-agnostic and dependency-free
(stdlib ElementTree) so it is unit-testable without any OMR installed, and so a future
engine swap reuses it unchanged.

Deliberately partial: we read pitch, rhythm, voice, staff, lyrics, ties, tempo and
time signatures — everything playback and selection need. Slurs, dynamics, articulations
and beams are dropped, because nothing downstream consumes them yet.
"""

from __future__ import annotations

import xml.etree.ElementTree as ET
from collections.abc import Iterable

from app.scoredoc import Note, Part, ScoreDoc, Tempo, TimeSignature

_STEP_TO_SEMITONE = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}

# Part names that are almost certainly accompaniment rather than a singer.
_NON_VOCAL_HINTS = ("piano", "keyboard", "accomp", "reduction", "orch", "guitar", "bass", "drum")


def _text(el: ET.Element | None, default: str = "") -> str:
    return (el.text or default).strip() if el is not None and el.text else default


def _int(el: ET.Element | None, default: int = 0) -> int:
    try:
        return int(float(_text(el, str(default))))
    except ValueError:
        return default


def _pitch_to_midi(pitch: ET.Element) -> int:
    step = _text(pitch.find("step"), "C").upper()
    octave = _int(pitch.find("octave"), 4)
    alter = _int(pitch.find("alter"), 0)
    return (octave + 1) * 12 + _STEP_TO_SEMITONE.get(step, 0) + alter


def _is_vocal(name: str) -> bool:
    lowered = name.lower()
    return not any(hint in lowered for hint in _NON_VOCAL_HINTS)


def _iter_parts(root: ET.Element) -> Iterable[tuple[str, str, str | None]]:
    for sp in root.findall("./part-list/score-part"):
        pid = sp.get("id") or ""
        yield (
            pid,
            _text(sp.find("part-name"), pid) or pid,
            _text(sp.find("part-abbreviation")) or None,
        )


def parse_musicxml(xml_bytes: bytes) -> ScoreDoc:
    root = ET.fromstring(xml_bytes)
    if root.tag == "score-timewise":
        raise ValueError("score-timewise MusicXML is not supported; convert to partwise first")

    part_meta = dict((pid, (name, abbr)) for pid, name, abbr in _iter_parts(root))
    doc = ScoreDoc(divisions=480)

    # MusicXML lets each part declare its own `divisions`. We normalise everything onto
    # one document-wide resolution so onsets from different parts are directly comparable
    # (playback merges parts into a single timeline).
    declared = [_int(d, 0) for d in root.iter("divisions")]
    declared = [d for d in declared if d > 0]
    doc.divisions = _lcm_all(declared) if declared else 480

    seen_time_sigs: set[tuple[int, int, int]] = set()
    seen_tempos: set[int] = set()
    max_measure = 0

    for part_index, part_el in enumerate(root.findall("part")):
        pid = part_el.get("id") or f"P{part_index + 1}"
        name, abbr = part_meta.get(pid, (pid, None))
        doc.parts.append(
            Part(id=pid, name=name, abbreviation=abbr, index=part_index, is_vocal=_is_vocal(name))
        )

        part_divisions = 0
        absolute = 0  # ticks at the start of the current measure, in doc.divisions

        for measure_el in part_el.findall("measure"):
            measure_no = _int_attr(measure_el.get("number"), default=max_measure + 1)
            max_measure = max(max_measure, measure_no)

            div_el = measure_el.find("./attributes/divisions")
            if div_el is not None:
                part_divisions = _int(div_el, part_divisions)
            scale = (doc.divisions // part_divisions) if part_divisions else 1

            time_el = measure_el.find("./attributes/time")
            if time_el is not None:
                sig = (
                    measure_no,
                    _int(time_el.find("beats"), 4),
                    _int(time_el.find("beat-type"), 4),
                )
                if sig not in seen_time_sigs:
                    seen_time_sigs.add(sig)
                    doc.time_signatures.append(
                        TimeSignature(measure=sig[0], numerator=sig[1], denominator=sig[2])
                    )

            cursor = 0  # ticks into the measure
            last_onset = 0  # for <chord/>, which shares the previous note's onset
            measure_len = 0

            for child in measure_el:
                if child.tag == "backup":
                    cursor = max(0, cursor - _int(child.find("duration")) * scale)
                    continue
                if child.tag == "forward":
                    cursor += _int(child.find("duration")) * scale
                    measure_len = max(measure_len, cursor)
                    continue
                if child.tag == "direction":
                    sound = child.find("sound")
                    if sound is not None and sound.get("tempo"):
                        onset = absolute + cursor
                        if onset not in seen_tempos:
                            seen_tempos.add(onset)
                            doc.tempos.append(Tempo(onset=onset, bpm=float(sound.get("tempo"))))
                    continue
                if child.tag != "note":
                    continue

                duration = _int(child.find("duration")) * scale
                is_chord = child.find("chord") is not None
                onset_in_measure = last_onset if is_chord else cursor

                pitch_el = child.find("pitch")
                midi = _pitch_to_midi(pitch_el) if pitch_el is not None else None

                tie = None
                tie_els = [t.get("type") for t in child.findall("tie")]
                if "start" in tie_els and "stop" in tie_els:
                    tie = "continue"
                elif "start" in tie_els:
                    tie = "start"
                elif "stop" in tie_els:
                    tie = "stop"

                lyric_el = child.find("./lyric/text")

                doc.notes.append(
                    Note(
                        id="",
                        part_id=pid,
                        measure=measure_no,
                        voice=_int(child.find("voice"), 1),
                        staff=_int(child.find("staff"), 1),
                        onset=absolute + onset_in_measure,
                        onset_in_measure=onset_in_measure,
                        duration=duration,
                        midi=midi,
                        tie=tie,
                        lyric=_text(lyric_el) or None,
                        page=0,  # engines that know page layout overwrite this
                        bbox=None,  # ditto for geometry
                    )
                )

                if not is_chord:
                    cursor += duration
                    last_onset = onset_in_measure
                measure_len = max(measure_len, cursor)

            absolute += measure_len

    doc.measure_count = max_measure
    if not doc.tempos:
        doc.tempos.append(Tempo(onset=0, bpm=90.0))
    doc.assign_ids()
    return doc


def _int_attr(value: str | None, default: int) -> int:
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


def _lcm_all(values: list[int]) -> int:
    from math import gcd

    out = values[0]
    for v in values[1:]:
        out = out * v // gcd(out, v)
    # Guard against a pathological score blowing the tick resolution up.
    return min(out, 30720)
