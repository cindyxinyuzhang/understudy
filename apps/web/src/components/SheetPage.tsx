import type { Note } from "@understudy/api-types";
import { memo, useRef, useState } from "react";

import type { NoteStyle } from "../lib/noteStyles";

interface Marquee {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface SheetPageProps {
  pageIndex: number;
  width: number;
  height: number;
  imageUrl: string;
  notes: Note[];
  styles: Map<string, NoteStyle>;
  interactive: boolean;
  onPaint: (noteIds: string[], shouldBelong: boolean) => void;
  onInspect: (noteId: string) => void;
}

/**
 * One page: the engraved image, with an SVG hit layer on top.
 *
 * The image is the real page as the singer knows it; the overlay only adds colour and
 * hit targets. That is the whole reason note geometry is normalised 0..1 in the score
 * document — the same boxes line up at any zoom level and any page-image resolution,
 * and the SVG viewBox does the scaling for free.
 *
 * Two gestures:
 *
 * - Paint. Press on a note and drag across others. The first note decides the
 *   direction (pressing a selected note erases, pressing an unselected one adds) and
 *   the rest of the drag follows it, so a mis-drag over already-selected notes does
 *   not toggle them back off.
 * - Marquee. Press on empty space and drag a box to take everything inside it. This is
 *   how you grab a whole phrase without tracing it.
 */
function SheetPage({
  pageIndex,
  width,
  height,
  imageUrl,
  notes,
  styles,
  interactive,
  onPaint,
  onInspect,
}: SheetPageProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const paintMode = useRef<boolean | null>(null);
  const painted = useRef<Set<string>>(new Set());
  const marqueeStart = useRef<{ x: number; y: number } | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);

  /** Pointer position in page pixel coordinates, independent of CSS size and zoom. */
  function toPageCoords(event: React.PointerEvent): { x: number; y: number } | null {
    const svg = svgRef.current;
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * width,
      y: ((event.clientY - rect.top) / rect.height) * height,
    };
  }

  function beginPaint(note: Note, event: React.PointerEvent) {
    if (!interactive) return;
    event.preventDefault();
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
    paintMode.current = !(styles.get(note.id)?.selected ?? false);
    painted.current = new Set([note.id]);
    onPaint([note.id], paintMode.current);
  }

  function continuePaint(note: Note) {
    if (paintMode.current === null || painted.current.has(note.id)) return;
    painted.current.add(note.id);
    onPaint([note.id], paintMode.current);
  }

  function endGesture(event: React.PointerEvent) {
    if (marqueeStart.current && marquee) {
      const box = normalise(marquee);
      const inside = notes
        .filter((note) => note.bbox && intersects(note.bbox, box, width, height))
        .map((note) => note.id);
      // A marquee always adds. Subtracting with a box is a rarer intent and needs its
      // own modifier; guessing wrong would silently wipe a selection.
      if (inside.length > 0) onPaint(inside, true);
    }
    paintMode.current = null;
    painted.current = new Set();
    marqueeStart.current = null;
    setMarquee(null);
    (event.currentTarget as Element).releasePointerCapture?.(event.pointerId);
  }

  return (
    <div className="sheet-page" style={{ aspectRatio: `${width} / ${height}` }}>
      <img src={imageUrl} alt={`Page ${pageIndex + 1}`} draggable={false} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className={interactive ? "hit-layer interactive" : "hit-layer"}
        onPointerDown={(event) => {
          if (!interactive || event.button !== 0) return;
          const point = toPageCoords(event);
          if (!point) return;
          marqueeStart.current = point;
          (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!marqueeStart.current || paintMode.current !== null) return;
          const point = toPageCoords(event);
          if (!point) return;
          const start = marqueeStart.current;
          if (Math.hypot(point.x - start.x, point.y - start.y) < 4) return;
          setMarquee({ x0: start.x, y0: start.y, x1: point.x, y1: point.y });
        }}
        onPointerUp={endGesture}
        onPointerCancel={endGesture}
      >
        {notes.map((note) => {
          if (!note.bbox) return null;
          const [nx, ny, nw, nh] = note.bbox;
          const style = styles.get(note.id) ?? null;
          // Padded outward so a notehead is a comfortable click target without the
          // padding showing up as visible colour.
          const pad = 2;
          return (
            <g key={note.id} data-note-id={note.id}>
              <rect
                className="note-hit"
                x={nx * width - pad}
                y={ny * height - pad}
                width={nw * width + pad * 2}
                height={nh * height + pad * 2}
                rx={3}
                fill={style?.fill ?? "transparent"}
                stroke={style?.stroke ?? "transparent"}
                strokeWidth={style?.strokeWidth ?? 0}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  beginPaint(note, event);
                }}
                onPointerEnter={() => continuePaint(note)}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                  onInspect(note.id);
                }}
              >
                <title>
                  {note.lyric ? `“${note.lyric}” · ` : ""}bar {note.measure}
                  {note.midi == null ? " · rest" : ` · ${midiToName(note.midi)}`}
                </title>
              </rect>
              {style?.annotated && (
                <circle
                  className="note-marker"
                  cx={nx * width + nw * width + 3}
                  cy={ny * height - 2}
                  r={2.6}
                />
              )}
            </g>
          );
        })}

        {marquee && (
          <rect
            className="marquee"
            {...(() => {
              const box = normalise(marquee);
              return { x: box.x, y: box.y, width: box.w, height: box.h };
            })()}
          />
        )}
      </svg>
    </div>
  );
}

function normalise(m: Marquee) {
  return {
    x: Math.min(m.x0, m.x1),
    y: Math.min(m.y0, m.y1),
    w: Math.abs(m.x1 - m.x0),
    h: Math.abs(m.y1 - m.y0),
  };
}

function intersects(
  bbox: readonly number[],
  box: { x: number; y: number; w: number; h: number },
  width: number,
  height: number,
): boolean {
  const x = (bbox[0] ?? 0) * width;
  const y = (bbox[1] ?? 0) * height;
  const w = (bbox[2] ?? 0) * width;
  const h = (bbox[3] ?? 0) * height;
  return x < box.x + box.w && x + w > box.x && y < box.y + box.h && y + h > box.y;
}

const NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

export function midiToName(midi: number): string {
  return `${NAMES[midi % 12]}${Math.floor(midi / 12) - 1}`;
}

// Re-rendering every page on each selection change would mean thousands of SVG nodes
// reconciled per click; only the page whose style map changed needs to update.
export default memo(SheetPage);
