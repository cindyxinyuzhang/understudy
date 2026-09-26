import { useEffect, useRef } from "react";

import type { PlaybackEngine, PlaybackStatus } from "../audio/scheduler";
import type { ScoreIndex } from "../lib/scoreIndex";

/**
 * Play controls and a scrubber.
 *
 * The position readout and the scrubber thumb are updated from an animation frame by
 * writing to refs, not by setting state. The alternative — a `positionTicks` in a store
 * — would re-render this component's whole subtree sixty times a second for the sake of
 * two numbers.
 */
export default function Transport({
  engine,
  status,
  index,
  tempoScale,
  onTempoScaleChange,
  metronome,
  onMetronomeChange,
  selectionSize,
  playSelectionOnly,
  onPlaySelectionOnlyChange,
}: {
  engine: PlaybackEngine;
  status: PlaybackStatus;
  index: ScoreIndex;
  tempoScale: number;
  onTempoScaleChange: (value: number) => void;
  metronome: boolean;
  onMetronomeChange: (value: boolean) => void;
  selectionSize: number;
  playSelectionOnly: boolean;
  onPlaySelectionOnlyChange: (value: boolean) => void;
}) {
  const scrubber = useRef<HTMLInputElement>(null);
  const readout = useRef<HTMLSpanElement>(null);
  const scrubbing = useRef(false);

  useEffect(() => {
    let frame = 0;
    const tick = () => {
      const ticks = engine.getPositionTicks();
      if (!scrubbing.current && scrubber.current) {
        scrubber.current.value = String(Math.round(ticks));
      }
      if (readout.current) readout.current.textContent = formatPosition(index, ticks);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [engine, index]);

  const playing = status === "playing";

  return (
    <div className="transport card stack" style={{ gap: 10 }}>
      <div className="row">
        <button
          className="primary"
          onClick={() => (playing ? engine.pause() : void engine.play())}
          title={playing ? "Pause" : "Play"}
        >
          {playing ? "❚❚ Pause" : "▶ Play"}
        </button>
        <button onClick={() => engine.stop()} disabled={status === "stopped"} title="Stop">
          ■
        </button>
        <span ref={readout} className="mono muted" style={{ minWidth: 92 }}>
          bar 1 · 0:00
        </span>
        <div className="spacer" />
        <label className="row muted" style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={metronome}
            onChange={(event) => onMetronomeChange(event.target.checked)}
          />
          click
        </label>
      </div>

      <input
        ref={scrubber}
        type="range"
        min={0}
        max={Math.max(1, index.totalTicks)}
        defaultValue={0}
        className="scrubber"
        onPointerDown={() => (scrubbing.current = true)}
        onPointerUp={(event) => {
          scrubbing.current = false;
          engine.seek(Number((event.target as HTMLInputElement).value));
        }}
        onChange={(event) => {
          if (readout.current) {
            readout.current.textContent = formatPosition(index, Number(event.target.value));
          }
        }}
      />

      <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
        <label className="row muted" style={{ fontSize: 12, gap: 6 }}>
          tempo
          <input
            type="range"
            min={0.4}
            max={1.4}
            step={0.05}
            value={tempoScale}
            onChange={(event) => onTempoScaleChange(Number(event.target.value))}
            style={{ width: 110 }}
          />
          <span className="mono" style={{ minWidth: 34 }}>
            {Math.round(tempoScale * 100)}%
          </span>
        </label>

        <label className="row muted" style={{ fontSize: 12 }}>
          <input
            type="checkbox"
            checked={playSelectionOnly}
            disabled={selectionSize === 0}
            onChange={(event) => onPlaySelectionOnlyChange(event.target.checked)}
          />
          my part only{selectionSize > 0 ? ` (${selectionSize})` : ""}
        </label>
      </div>
    </div>
  );
}

function formatPosition(index: ScoreIndex, ticks: number): string {
  const divisions = index.doc.divisions || 480;
  const beatsPerBar = index.doc.timeSignatures?.[0]?.numerator ?? 4;
  const bar = Math.floor(ticks / (divisions * beatsPerBar)) + 1;
  const seconds = index.ticksToSeconds(ticks);
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `bar ${bar} · ${minutes}:${String(rest).padStart(2, "0")}`;
}
