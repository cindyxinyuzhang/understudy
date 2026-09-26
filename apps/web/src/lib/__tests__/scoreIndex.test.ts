import type { Note, ScoreDoc } from "@understudy/api-types";
import { describe, expect, it } from "vitest";

import { buildScoreIndex } from "../scoreIndex";

function note(partial: Partial<Note> & Pick<Note, "id" | "onset">): Note {
  return {
    partId: "P1",
    measure: 1,
    voice: 1,
    staff: 1,
    onsetInMeasure: 0,
    duration: 480,
    midi: 60,
    page: 0,
    ...partial,
  } as Note;
}

function doc(partial: Partial<ScoreDoc> = {}): ScoreDoc {
  return {
    schemaVersion: 1,
    divisions: 480,
    measureCount: 4,
    pages: [
      { index: 0, width: 1200, height: 1600, imageKey: "a" },
      { index: 1, width: 1200, height: 1600, imageKey: "b" },
    ],
    parts: [
      { id: "P1", name: "Elphaba", index: 0, isVocal: true },
      { id: "P2", name: "Glinda", index: 1, isVocal: true },
    ],
    notes: [],
    tempos: [{ onset: 0, bpm: 120 }],
    timeSignatures: [{ measure: 1, numerator: 4, denominator: 4 }],
    ...partial,
  } as ScoreDoc;
}

describe("buildScoreIndex", () => {
  it("indexes notes by id, page and part", () => {
    const index = buildScoreIndex(
      doc({
        notes: [
          note({ id: "a", onset: 0, partId: "P1", page: 0 }),
          note({ id: "b", onset: 480, partId: "P2", page: 0 }),
          note({ id: "c", onset: 960, partId: "P1", page: 1 }),
        ],
      }),
    );

    expect(index.notesById.get("b")?.partId).toBe("P2");
    expect(index.notesByPage[0]?.map((n) => n.id)).toEqual(["a", "b"]);
    expect(index.notesByPage[1]?.map((n) => n.id)).toEqual(["c"]);
    expect(index.notesByPart.get("P1")?.map((n) => n.id)).toEqual(["a", "c"]);
  });

  it("excludes rests from the playable list and orders it by onset", () => {
    const index = buildScoreIndex(
      doc({
        notes: [
          note({ id: "late", onset: 960 }),
          note({ id: "rest", onset: 480, midi: null }),
          note({ id: "early", onset: 0 }),
        ],
      }),
    );
    expect(index.playable.map((n) => n.id)).toEqual(["early", "late"]);
  });

  it("measures total length from the end of the last note, not its start", () => {
    const index = buildScoreIndex(
      doc({ notes: [note({ id: "a", onset: 1920, duration: 1920 })] }),
    );
    expect(index.totalTicks).toBe(3840);
  });

  describe("tempo map", () => {
    it("converts ticks to seconds at a constant tempo", () => {
      const index = buildScoreIndex(doc({ tempos: [{ onset: 0, bpm: 120 }] }));
      // 120bpm = 0.5s per quarter; divisions is 480 ticks per quarter.
      expect(index.ticksToSeconds(480)).toBeCloseTo(0.5);
      expect(index.ticksToSeconds(1920)).toBeCloseTo(2);
    });

    it("applies a mid-score tempo change only from where it happens", () => {
      const index = buildScoreIndex(
        doc({
          tempos: [
            { onset: 0, bpm: 60 },
            { onset: 1920, bpm: 120 },
          ],
        }),
      );
      // Four quarters at 60bpm.
      expect(index.ticksToSeconds(1920)).toBeCloseTo(4);
      // Then four at 120bpm: 4s + 2s. A single-multiplier conversion would give 4s.
      expect(index.ticksToSeconds(3840)).toBeCloseTo(6);
    });

    it("round-trips ticks through seconds across a tempo change", () => {
      const index = buildScoreIndex(
        doc({
          tempos: [
            { onset: 0, bpm: 72 },
            { onset: 960, bpm: 144 },
            { onset: 2880, bpm: 96 },
          ],
        }),
      );
      for (const ticks of [0, 480, 960, 1400, 2880, 5000]) {
        expect(index.secondsToTicks(index.ticksToSeconds(ticks))).toBeCloseTo(ticks, 3);
      }
    });

    it("assumes a default tempo when the score declares none", () => {
      const index = buildScoreIndex(doc({ tempos: [] }));
      expect(index.ticksToSeconds(480)).toBeGreaterThan(0);
    });

    it("covers the span before the first declared tempo", () => {
      // A score whose first tempo marking is not at bar 1 still has to play bar 1.
      const index = buildScoreIndex(doc({ tempos: [{ onset: 1920, bpm: 120 }] }));
      expect(index.ticksToSeconds(0)).toBe(0);
      expect(index.ticksToSeconds(960)).toBeGreaterThan(0);
    });
  });
});
