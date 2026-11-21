import type { AnnotationRead, ProfileRead } from "@understudy/api-types";
import { useMemo } from "react";

import { buildNoteStyles } from "../lib/noteStyles";
import type { ScoreIndex } from "../lib/scoreIndex";
import { useViewer } from "../state/viewer";
import SheetPage from "./SheetPage";

/**
 * The score itself: every page stacked vertically, each with its own hit layer.
 *
 * Style resolution happens once here for the whole document and is sliced per page, so
 * a selection change does one pass over the notes rather than one per page component.
 */
export default function ScoreSheet({
  index,
  pageUrls,
  profiles,
  annotations,
  activeProfile,
  onPaint,
}: {
  index: ScoreIndex;
  pageUrls: string[];
  profiles: ProfileRead[];
  annotations: AnnotationRead[];
  activeProfile: ProfileRead | null;
  onPaint: (noteIds: string[], shouldBelong: boolean) => void;
}) {
  const { colorByPart, showOtherProfiles, zoom, inspectNote } = useViewer();

  const styles = useMemo(
    () =>
      buildNoteStyles(
        index.notesById.keys(),
        (noteId) => index.notesById.get(noteId)?.partId,
        {
          activeProfile,
          otherProfiles: profiles.filter((p) => p.id !== activeProfile?.id),
          annotations,
          parts: index.doc.parts ?? [],
          colorByPart,
          showOtherProfiles,
        },
      ),
    [index, activeProfile, profiles, annotations, colorByPart, showOtherProfiles],
  );

  return (
    <div className="sheet" style={{ width: `${zoom * 100}%` }}>
      {/* Recolours the page images' ink to dark brown, leaving the paper white. Pages
          are rendered images, so their glyph colour can't be set any other way here.
          Gamma > 1 keeps the near-black ink dark rather than washing it out. */}
      <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true">
        <filter id="sheet-ink" colorInterpolationFilters="sRGB">
          <feComponentTransfer>
            <feFuncR type="gamma" amplitude={0.85} exponent={1.5} offset={0.15} />
            <feFuncG type="gamma" amplitude={0.91} exponent={1.5} offset={0.09} />
            <feFuncB type="gamma" amplitude={0.95} exponent={1.5} offset={0.05} />
          </feComponentTransfer>
        </filter>
      </svg>
      {(index.doc.pages ?? []).map((page, i) => (
        <SheetPage
          key={page.index}
          pageIndex={page.index}
          width={page.width}
          height={page.height}
          imageUrl={pageUrls[i] ?? ""}
          notes={index.notesByPage[page.index] ?? []}
          styles={styles}
          interactive={activeProfile !== null}
          onPaint={onPaint}
          onInspect={inspectNote}
        />
      ))}
    </div>
  );
}
