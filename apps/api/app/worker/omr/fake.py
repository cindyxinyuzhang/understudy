"""A deterministic stand-in for real OMR.

It ignores the PDF's actual musical content and synthesises a plausible three-part
vocal score, seeded by a hash of the file so the same upload always yields the same
result. It draws the score as SVG and emits note bounding boxes that line up exactly
with the glyphs it drew.

That last property is the point. Selection, colouring, profile playback, version
migration and the whole frontend can be built and end-to-end tested against a stack
that starts with `docker compose up` and needs no GPU, no model weights, and no
copyrighted sheet music in the repo. Swapping `OMR_ENGINE=oemer` changes one config
line; nothing downstream knows the difference.
"""

from __future__ import annotations

import random
from hashlib import blake2s

from app.scoredoc import Note, Page, Part, ScoreDoc, Tempo, TimeSignature
from app.worker.omr.base import OmrResult, ProgressFn, RenderedPage

PAGE_W, PAGE_H = 1200, 1600
MARGIN_X, MARGIN_TOP = 90, 110
STAFF_SPACING = 9  # px between staff lines
STAFF_H = STAFF_SPACING * 4
STAFF_GAP = 34  # between staves within a system
SYSTEM_GAP = 62
MEASURES_PER_SYSTEM = 4
SYSTEMS_PER_PAGE = 4
DIVISIONS = 480  # ticks per quarter

PARTS = [
    ("P1", "Elphaba", "Elph.", "#e11d48"),
    ("P2", "Glinda", "Glin.", "#0ea5e9"),
    ("P3", "Ensemble", "Ens.", "#16a34a"),
]

# Diatonic scale degrees each part sings, as MIDI. Kept in a comfortable written range
# per voice so the fake output is musically sane when you press play.
RANGES = {"P1": (55, 72), "P2": (60, 79), "P3": (53, 69)}

LYRICS = [
    "some",
    "things",
    "I",
    "can-",
    "not",
    "change",
    "but",
    "till",
    "I",
    "try",
    "I'll",
    "nev-",
    "er",
    "know",
    "too",
    "long",
    "I've",
    "been",
    "a-",
    "fraid",
    "of",
]


def _staff_top(system_in_page: int, staff_index: int) -> float:
    system_h = len(PARTS) * STAFF_H + (len(PARTS) - 1) * STAFF_GAP
    return (
        MARGIN_TOP + system_in_page * (system_h + SYSTEM_GAP) + staff_index * (STAFF_H + STAFF_GAP)
    )


def _midi_to_y(midi: int, staff_top: float) -> float:
    """Treble-clef-ish vertical placement: B4 (MIDI 71) sits on the middle line."""
    diatonic = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6]
    steps = (midi // 12) * 7 + diatonic[midi % 12]
    ref = (71 // 12) * 7 + diatonic[71 % 12]
    middle_line_y = staff_top + STAFF_H / 2
    return middle_line_y - (steps - ref) * (STAFF_SPACING / 2)


class FakeEngine:
    name = "fake"
    version = "1.0.0"

    def run(self, pdf_bytes: bytes, progress: ProgressFn) -> OmrResult:
        seed = int.from_bytes(blake2s(pdf_bytes, digest_size=8).digest(), "big")
        rng = random.Random(seed)
        progress(10, "layout")

        total_systems = SYSTEMS_PER_PAGE * 2  # two pages
        total_measures = total_systems * MEASURES_PER_SYSTEM
        measure_ticks = DIVISIONS * 4  # 4/4

        doc = ScoreDoc(
            divisions=DIVISIONS,
            measure_count=total_measures,
            tempos=[Tempo(onset=0, bpm=float(rng.choice([72, 84, 96, 108])))],
            time_signatures=[TimeSignature(measure=1, numerator=4, denominator=4)],
            parts=[
                Part(
                    id=pid,
                    name=name,
                    abbreviation=abbr,
                    index=i,
                    is_vocal=True,
                    default_color=color,
                )
                for i, (pid, name, abbr, color) in enumerate(PARTS)
            ],
            pages=[
                Page(index=0, width=PAGE_W, height=PAGE_H, image_key=""),
                Page(index=1, width=PAGE_W, height=PAGE_H, image_key=""),
            ],
        )

        notes: list[Note] = []
        for part_index, (pid, _name, _abbr, _color) in enumerate(PARTS):
            lo, hi = RANGES[pid]
            pitch = (lo + hi) // 2
            for measure in range(1, total_measures + 1):
                # Ensemble sits out some bars — gives the UI real "this part is silent
                # here" cases to render, and gives playback real rests.
                if pid == "P3" and (measure % 4 == 3):
                    notes.append(
                        Note(
                            id="",
                            part_id=pid,
                            measure=measure,
                            voice=1,
                            staff=1,
                            onset=(measure - 1) * measure_ticks,
                            onset_in_measure=0,
                            duration=measure_ticks,
                            midi=None,
                            page=(measure - 1) // (MEASURES_PER_SYSTEM * SYSTEMS_PER_PAGE),
                        )
                    )
                    continue

                onset_in_measure = 0
                while onset_in_measure < measure_ticks:
                    remaining = measure_ticks - onset_in_measure
                    duration = rng.choice(
                        [d for d in (DIVISIONS // 2, DIVISIONS, DIVISIONS * 2) if d <= remaining]
                    )
                    pitch = max(lo, min(hi, pitch + rng.choice([-2, -1, 0, 1, 2, 3])))
                    notes.append(
                        Note(
                            id="",
                            part_id=pid,
                            measure=measure,
                            voice=1,
                            staff=1,
                            onset=(measure - 1) * measure_ticks + onset_in_measure,
                            onset_in_measure=onset_in_measure,
                            duration=duration,
                            midi=pitch,
                            lyric=LYRICS[
                                (measure * 3 + onset_in_measure // 120 + part_index) % len(LYRICS)
                            ],
                            page=(measure - 1) // (MEASURES_PER_SYSTEM * SYSTEMS_PER_PAGE),
                            confidence=round(rng.uniform(0.82, 0.99), 2),
                        )
                    )
                    onset_in_measure += duration

        progress(45, "positioning")
        self._assign_geometry(notes, measure_ticks)
        doc.notes = notes
        doc.assign_ids()

        progress(70, "rendering-pages")
        pages = [
            RenderedPage(
                index=p.index,
                width=PAGE_W,
                height=PAGE_H,
                data=self._render_page(p.index, doc).encode("utf-8"),
                content_type="image/svg+xml",
            )
            for p in doc.pages
        ]
        progress(95, "finalising")
        return OmrResult(doc=doc, pages=pages)

    # -- geometry -------------------------------------------------------------
    def _assign_geometry(self, notes: list[Note], measure_ticks: int) -> None:
        """Give every note a normalised bbox matching where we will draw it."""
        usable_w = PAGE_W - 2 * MARGIN_X
        measure_w = usable_w / MEASURES_PER_SYSTEM
        head_w, head_h = 13.0, 9.5

        for note in notes:
            idx = note.measure - 1
            system_global = idx // MEASURES_PER_SYSTEM
            system_in_page = system_global % SYSTEMS_PER_PAGE
            measure_in_system = idx % MEASURES_PER_SYSTEM
            staff_index = next(i for i, p in enumerate(PARTS) if p[0] == note.part_id)
            staff_top = _staff_top(system_in_page, staff_index)

            x = (
                MARGIN_X
                + measure_in_system * measure_w
                + 26
                + (note.onset_in_measure / measure_ticks) * (measure_w - 40)
            )
            if note.midi is None:
                y = staff_top + STAFF_H / 2 - 6
                w, h = 16.0, 12.0
            else:
                y = _midi_to_y(note.midi, staff_top) - head_h / 2
                w, h = head_w, head_h
            note.bbox = (
                round(x / PAGE_W, 6),
                round(y / PAGE_H, 6),
                round(w / PAGE_W, 6),
                round(h / PAGE_H, 6),
            )

    # -- drawing --------------------------------------------------------------
    def _render_page(self, page_index: int, doc: ScoreDoc) -> str:
        out = [
            f'<svg xmlns="http://www.w3.org/2000/svg" width="{PAGE_W}" height="{PAGE_H}" '
            f'viewBox="0 0 {PAGE_W} {PAGE_H}">',
            f'<rect width="{PAGE_W}" height="{PAGE_H}" fill="#fffdf8"/>',
            '<g font-family="Georgia, serif">',
        ]
        if page_index == 0:
            out.append(
                f'<text x="{PAGE_W / 2}" y="62" text-anchor="middle" '
                f'font-size="30">Sample Score</text>'
            )
        out.append(
            f'<text x="{PAGE_W - MARGIN_X}" y="{PAGE_H - 40}" text-anchor="end" '
            f'font-size="15" fill="#666">{page_index + 1}</text>'
        )

        first_measure = page_index * SYSTEMS_PER_PAGE * MEASURES_PER_SYSTEM + 1
        usable_w = PAGE_W - 2 * MARGIN_X
        measure_w = usable_w / MEASURES_PER_SYSTEM

        for system_in_page in range(SYSTEMS_PER_PAGE):
            for staff_index, (_pid, _name, abbr, _color) in enumerate(PARTS):
                top = _staff_top(system_in_page, staff_index)
                for line in range(5):
                    y = top + line * STAFF_SPACING
                    out.append(
                        f'<line x1="{MARGIN_X}" y1="{y}" x2="{PAGE_W - MARGIN_X}" y2="{y}" '
                        f'stroke="#222" stroke-width="1"/>'
                    )
                out.append(
                    f'<text x="{MARGIN_X - 10}" y="{top + STAFF_H / 2 + 5}" text-anchor="end" '
                    f'font-size="13" fill="#444">{abbr}</text>'
                )
                out.append(
                    f'<text x="{MARGIN_X + 6}" y="{top + STAFF_H - 2}" '
                    f'font-size="34" fill="#222">&#119070;</text>'
                )
                for m in range(MEASURES_PER_SYSTEM + 1):
                    x = MARGIN_X + m * measure_w
                    out.append(
                        f'<line x1="{x}" y1="{top}" x2="{x}" y2="{top + STAFF_H}" '
                        f'stroke="#222" stroke-width="1"/>'
                    )
                measure_no = first_measure + system_in_page * MEASURES_PER_SYSTEM
                if staff_index == 0:
                    out.append(
                        f'<text x="{MARGIN_X + 2}" y="{top - 8}" font-size="12" '
                        f'fill="#888">{measure_no}</text>'
                    )

        for note in doc.notes:
            if note.page != page_index or note.bbox is None:
                continue
            x, y, w, h = (
                note.bbox[0] * PAGE_W,
                note.bbox[1] * PAGE_H,
                note.bbox[2] * PAGE_W,
                note.bbox[3] * PAGE_H,
            )
            if note.midi is None:
                out.append(
                    f'<rect x="{x:.1f}" y="{y:.1f}" width="{w:.1f}" '
                    f'height="{h / 2:.1f}" fill="#222"/>'
                )
                continue
            cx, cy = x + w / 2, y + h / 2
            filled = "#222" if note.duration < DIVISIONS * 2 else "none"
            out.append(
                f'<ellipse cx="{cx:.1f}" cy="{cy:.1f}" rx="{w / 2:.1f}" ry="{h / 2:.1f}" '
                f'transform="rotate(-18 {cx:.1f} {cy:.1f})" fill="{filled}" '
                f'stroke="#222" stroke-width="1.6"/>'
            )
            stem_up = note.midi < 71
            sx = cx + (w / 2 - 1) * (1 if stem_up else -1)
            sy2 = cy - 30 if stem_up else cy + 30
            out.append(
                f'<line x1="{sx:.1f}" y1="{cy:.1f}" x2="{sx:.1f}" y2="{sy2:.1f}" '
                f'stroke="#222" stroke-width="1.6"/>'
            )
            if note.duration < DIVISIONS:
                out.append(
                    f'<path d="M{sx:.1f},{sy2:.1f} q10,6 8,18" fill="none" '
                    f'stroke="#222" stroke-width="1.6"/>'
                )
            if note.lyric:
                staff_index = next(i for i, p in enumerate(PARTS) if p[0] == note.part_id)
                system_in_page = ((note.measure - 1) // MEASURES_PER_SYSTEM) % SYSTEMS_PER_PAGE
                ly = _staff_top(system_in_page, staff_index) + STAFF_H + 18
                out.append(
                    f'<text x="{cx:.1f}" y="{ly:.1f}" text-anchor="middle" font-size="11" '
                    f'fill="#333">{note.lyric}</text>'
                )

        out.append("</g></svg>")
        return "".join(out)
