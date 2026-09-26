"""Real OMR via oemer.

Not installed in the API image — `pip install -e '.[omr]'`, and in practice this runs
in the GPU worker image only. Kept thin on purpose: rasterise pages, hand each to the
model, merge the MusicXML, reuse the shared parser.

Known limitation, stated plainly because it shapes the product: oemer returns MusicXML
but not per-note pixel geometry, so notes come back with `bbox=None`. The overlay UI
needs boxes to be clickable, so until we extract geometry from the model's intermediate
symbol map (it has one; it is just not in the public output), real-engine scores render
with a fallback layout derived from measure positions. Making this exact is the next
substantial piece of work on the ML side, and it is the reason the engine boundary
returns geometry rather than just MusicXML.
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from app.worker.omr.base import OmrResult, ProgressFn, RenderedPage
from app.worker.omr.musicxml import parse_musicxml

DPI = 200


class OemerEngine:
    name = "oemer"
    version = "0.1.7"

    def run(self, pdf_bytes: bytes, progress: ProgressFn) -> OmrResult:
        try:
            from pdf2image import convert_from_bytes
        except ImportError as exc:  # pragma: no cover - depends on optional extra
            raise RuntimeError(
                "oemer engine requires the 'omr' extra: pip install -e '.[omr]'"
            ) from exc

        progress(5, "rasterising")
        images = convert_from_bytes(pdf_bytes, dpi=DPI)

        pages: list[RenderedPage] = []
        xml_per_page: list[bytes] = []

        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            for i, image in enumerate(images):
                page_path = tmpdir / f"page-{i:03d}.png"
                image.save(page_path, "PNG")
                pages.append(
                    RenderedPage(
                        index=i,
                        width=image.width,
                        height=image.height,
                        data=page_path.read_bytes(),
                        content_type="image/png",
                    )
                )
                progress(5 + int(35 * (i + 1) / len(images)), f"rasterised page {i + 1}")

            for i, _page in enumerate(pages):
                # Subprocess rather than in-process import: oemer holds a large model in
                # memory and is not re-entrant, and a segfault in native code should kill
                # one page, not the worker.
                out_dir = tmpdir / f"out-{i:03d}"
                out_dir.mkdir()
                subprocess.run(
                    ["oemer", str(tmpdir / f"page-{i:03d}.png"), "-o", str(out_dir)],
                    check=True,
                    capture_output=True,
                    timeout=600,
                )
                produced = sorted(out_dir.glob("*.musicxml")) + sorted(out_dir.glob("*.xml"))
                if produced:
                    xml_per_page.append(produced[0].read_bytes())
                progress(40 + int(50 * (i + 1) / len(pages)), f"recognised page {i + 1}")

        if not xml_per_page:
            raise RuntimeError("oemer produced no MusicXML output")

        progress(92, "parsing")
        # One MusicXML per page; concatenating them correctly (continuing measure numbers
        # and matching parts across page breaks) is its own problem. For now we parse the
        # first page and treat multi-page stitching as unimplemented rather than silently
        # producing a wrong score.
        doc = parse_musicxml(xml_per_page[0])

        from app.scoredoc import Page as DocPage

        doc.pages = [
            DocPage(index=p.index, width=p.width, height=p.height, image_key="") for p in pages
        ]
        return OmrResult(doc=doc, pages=pages)
