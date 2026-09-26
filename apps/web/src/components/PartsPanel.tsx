import type { Part } from "@understudy/api-types";

import { useUpsertAnnotations } from "../lib/queries";
import { useViewer } from "../state/viewer";

const PART_SWATCHES = ["#e11d48", "#0ea5e9", "#16a34a", "#f59e0b", "#a855f7", "#14b8a6", "#64748b"];

/**
 * Voice parts as OMR found them: colour them, mute them, solo them.
 *
 * Part colour is stored as a shared annotation rather than a client preference, because
 * "Elphaba is red in this score" is a decision a music director makes once for everyone,
 * not a per-browser setting each cast member redoes.
 *
 * Mute and solo are the opposite — they are per-tab UI state, because they change
 * several times a minute while practising and mean nothing to anyone else.
 */
export default function PartsPanel({
  scoreId,
  parts,
  partColors,
  noteCounts,
}: {
  scoreId: string;
  parts: Part[];
  partColors: Map<string, string>;
  noteCounts: Map<string, number>;
}) {
  const { mutedPartIds, soloPartIds, togglePartMuted, togglePartSolo, colorByPart, toggleColorByPart } =
    useViewer();
  const upsert = useUpsertAnnotations(scoreId);

  return (
    <section className="panel stack">
      <header className="row">
        <strong>Voices</strong>
        <div className="spacer" />
        <label className="row muted" style={{ fontSize: 12 }}>
          <input type="checkbox" checked={colorByPart} onChange={toggleColorByPart} />
          tint
        </label>
      </header>

      <ul className="voice-list">
        {parts.map((part) => {
          const color = partColors.get(part.id) ?? "#64748b";
          const soloed = soloPartIds.has(part.id);
          const muted = mutedPartIds.has(part.id);
          return (
            <li key={part.id} className="voice">
              <button
                className="swatch"
                style={{ background: color }}
                title="Change this voice's colour for everyone"
                onClick={() => {
                  const index = PART_SWATCHES.indexOf(color);
                  upsert.mutate([
                    {
                      targetType: "part",
                      targetId: part.id,
                      kind: "color",
                      payload: { color: PART_SWATCHES[(index + 1) % PART_SWATCHES.length] },
                      isShared: true,
                    },
                  ]);
                }}
              />
              <span className="voice-name">
                {part.name}
                <span className="muted"> · {noteCounts.get(part.id) ?? 0}</span>
              </span>
              <button
                className={soloed ? "chip on" : "chip"}
                title="Solo"
                onClick={() => togglePartSolo(part.id)}
              >
                S
              </button>
              <button
                className={muted ? "chip on" : "chip"}
                title="Mute"
                onClick={() => togglePartMuted(part.id)}
              >
                M
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
