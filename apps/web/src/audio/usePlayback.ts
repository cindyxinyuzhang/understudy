/**
 * React binding for the playback engine.
 *
 * The engine deliberately lives outside React: it owns a mutable AudioContext, it is
 * driven by a timer rather than by renders, and its position changes ~60 times a
 * second. Putting any of that in state would re-render the score on every frame. What
 * crosses into React is only what genuinely changes the UI — the transport status, and
 * the playhead, which reads the engine directly from an animation frame.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import type { ScoreIndex } from "../lib/scoreIndex";
import { PlaybackEngine, type PlaybackConfig, type PlaybackStatus } from "./scheduler";

export function usePlayback(index: ScoreIndex, config: Partial<PlaybackConfig>) {
  const engine = useMemo(() => new PlaybackEngine(index), [index]);
  const [status, setStatus] = useState<PlaybackStatus>("stopped");

  useEffect(() => {
    engine.onStatusChange = setStatus;
    return () => {
      engine.onStatusChange = null;
      engine.dispose();
    };
  }, [engine]);

  // Config is pushed into the engine as an effect rather than read by it, so the engine
  // has no dependency on React and can be unit tested with a mock AudioContext.
  const serialised = JSON.stringify({
    ...config,
    noteIds: config.noteIds ? [...config.noteIds].sort() : null,
    audiblePartIds: config.audiblePartIds ? [...config.audiblePartIds].sort() : [],
    backgroundPartIds: config.backgroundPartIds ? [...config.backgroundPartIds].sort() : [],
  });
  useEffect(() => {
    engine.setConfig(config);
    // `serialised` is the real dependency: the config object is rebuilt every render,
    // but its contents rarely change, and re-seating playback on every render would
    // make the audio stutter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, serialised]);

  return { engine, status };
}

/**
 * Highlight the notes currently sounding, and move the playhead.
 *
 * Writes to the DOM directly instead of through state. Re-rendering a few thousand SVG
 * nodes 60 times a second is the one thing guaranteed to make this app feel slow, and
 * the only elements that actually change are the handful under the playhead.
 */
export function usePlaybackHighlight(engine: PlaybackEngine, enabled: boolean): void {
  const active = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;

    const paint = () => {
      const next = new Set(engine.getSoundingNoteIds());

      for (const id of active.current) {
        if (!next.has(id)) {
          document.querySelector(`[data-note-id="${id}"]`)?.removeAttribute("data-playing");
        }
      }
      for (const id of next) {
        if (!active.current.has(id)) {
          document.querySelector(`[data-note-id="${id}"]`)?.setAttribute("data-playing", "true");
        }
      }
      active.current = next;
      frame = requestAnimationFrame(paint);
    };

    frame = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(frame);
      for (const id of active.current) {
        document.querySelector(`[data-note-id="${id}"]`)?.removeAttribute("data-playing");
      }
      active.current = new Set();
    };
  }, [engine, enabled]);
}
