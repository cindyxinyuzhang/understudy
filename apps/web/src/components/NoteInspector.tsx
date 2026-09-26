import type { AnnotationRead, Note } from "@understudy/api-types";

import { useDeleteAnnotation, useUpsertAnnotations } from "../lib/queries";
import { midiToName } from "./SheetPage";

const NOTE_SWATCHES = ["#f59e0b", "#e11d48", "#0ea5e9", "#16a34a", "#a855f7"];

/**
 * Per-note annotation: a colour and a note to self ("breathe", "watch the cut-off").
 *
 * Opened by double-clicking a notehead, because single click is already spoken for by
 * selection and the two gestures happen at very different rates — you select hundreds
 * of notes and annotate a handful.
 *
 * Annotations default to private. A cast member marking their own breath points is not
 * publishing a correction to the score.
 */
export default function NoteInspector({
  scoreId,
  note,
  annotations,
  onClose,
}: {
  scoreId: string;
  note: Note;
  annotations: AnnotationRead[];
  onClose: () => void;
}) {
  const upsert = useUpsertAnnotations(scoreId);
  const remove = useDeleteAnnotation(scoreId);

  const forNote = annotations.filter(
    (a) => a.targetType === "note" && a.targetId === note.id,
  );
  const colorAnnotation = forNote.find((a) => a.kind === "color");
  const textAnnotation = forNote.find((a) => a.kind === "text");
  const currentText = (textAnnotation?.payload as { text?: string } | undefined)?.text ?? "";

  return (
    <aside className="panel stack note-inspector">
      <header className="row">
        <strong>
          Bar {note.measure}
          {note.midi == null ? " · rest" : ` · ${midiToName(note.midi)}`}
        </strong>
        <div className="spacer" />
        <button className="ghost" onClick={onClose}>
          ×
        </button>
      </header>

      {note.lyric && <div className="muted">“{note.lyric}”</div>}

      <div className="row">
        <span className="muted" style={{ fontSize: 12 }}>
          Colour
        </span>
        {NOTE_SWATCHES.map((color) => (
          <button
            key={color}
            className="swatch"
            style={{ background: color }}
            onClick={() =>
              upsert.mutate([
                {
                  targetType: "note",
                  targetId: note.id,
                  kind: "color",
                  payload: { color },
                  isShared: false,
                },
              ])
            }
          />
        ))}
        {colorAnnotation && (
          <button className="ghost" onClick={() => remove.mutate(colorAnnotation.id)}>
            clear
          </button>
        )}
      </div>

      <form
        className="stack"
        style={{ gap: 6 }}
        onSubmit={(event) => {
          event.preventDefault();
          const value = new FormData(event.currentTarget).get("text");
          const text = typeof value === "string" ? value.trim() : "";
          if (!text) {
            if (textAnnotation) remove.mutate(textAnnotation.id);
            return;
          }
          upsert.mutate([
            {
              targetType: "note",
              targetId: note.id,
              kind: "text",
              payload: { text },
              isShared: false,
            },
          ]);
        }}
      >
        <input name="text" defaultValue={currentText} placeholder="Note to self…" key={note.id} />
        <button type="submit" disabled={upsert.isPending}>
          Save note
        </button>
      </form>

      <div className="mono muted" title="Deterministic ID, stable across re-recognition">
        {note.id}
      </div>
    </aside>
  );
}
