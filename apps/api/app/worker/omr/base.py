"""The OMR seam.

Optical music recognition is the part of this system most likely to be replaced: the
open-source engines are all mediocre on dense musical-theatre vocal scores, and the
realistic path is swapping engines (or bolting a correction UI on top) once we see
real failure cases. So it lives behind a three-method interface with no imports from
the web or database layers, and the engine is selected by config string.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Protocol

from app.scoredoc import ScoreDoc

ProgressFn = Callable[[int, str], None]


@dataclass
class RenderedPage:
    """One page of the source, rasterised (or vectorised) for the overlay renderer.

    The client draws this image and puts an SVG hit layer on top, so whatever the engine
    emits here is literally what the singer sees and clicks.
    """

    index: int
    width: int
    height: int
    data: bytes
    content_type: str = "image/png"

    @property
    def extension(self) -> str:
        return {"image/png": "png", "image/svg+xml": "svg", "image/jpeg": "jpg"}[self.content_type]


@dataclass
class OmrResult:
    # `doc.pages[*].image_key` is left empty by engines; the task fills it in after
    # uploading, so engines never need storage credentials.
    doc: ScoreDoc
    pages: list[RenderedPage] = field(default_factory=list)


class OmrEngine(Protocol):
    name: str
    version: str

    def run(self, pdf_bytes: bytes, progress: ProgressFn) -> OmrResult: ...


def get_engine(name: str) -> OmrEngine:
    if name == "fake":
        from app.worker.omr.fake import FakeEngine

        return FakeEngine()
    if name == "oemer":
        from app.worker.omr.oemer_engine import OemerEngine

        return OemerEngine()
    raise ValueError(f"Unknown OMR engine: {name!r}")
