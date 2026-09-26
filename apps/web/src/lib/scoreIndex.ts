/**
 * Derived, read-only views over a ScoreDoc.
 *
 * Built once per document and memoised. The document arrives as flat arrays because
 * that is what serialises well and what the OMR worker naturally produces; rendering
 * and playback both want it indexed several different ways, and recomputing those
 * lookups inside a render pass over a few thousand notes is exactly the kind of thing
 * that makes a score viewer feel sluggish.
 */
import type { Note, Part, ScoreDoc } from "@understudy/api-types";

export interface ScoreIndex {
  doc: ScoreDoc;
  notesById: Map<string, Note>;
  notesByPage: Note[][];
  notesByPart: Map<string, Note[]>;
  partsById: Map<string, Part>;
  /** Pitched notes only, ascending by onset. Rests are never scheduled. */
  playable: Note[];
  totalTicks: number;
  ticksToSeconds: (ticks: number) => number;
  secondsToTicks: (seconds: number) => number;
}

interface TempoSegment {
  startTicks: number;
  startSeconds: number;
  secondsPerTick: number;
}

/**
 * A score can change tempo partway through, so ticks map to seconds piecewise rather
 * than by a single multiplier. Segments are precomputed and looked up by binary search
 * — the audio scheduler calls this on every lookahead tick.
 */
function buildTempoMap(doc: ScoreDoc): TempoSegment[] {
  const divisions = doc.divisions || 480;
  const tempos = [...(doc.tempos ?? [])].sort((a, b) => a.onset - b.onset);
  if (tempos.length === 0 || (tempos[0]?.onset ?? 0) > 0) {
    tempos.unshift({ onset: 0, bpm: 90 });
  }

  const segments: TempoSegment[] = [];
  let seconds = 0;
  for (let i = 0; i < tempos.length; i += 1) {
    const tempo = tempos[i]!;
    const secondsPerTick = 60 / (tempo.bpm * divisions);
    segments.push({ startTicks: tempo.onset, startSeconds: seconds, secondsPerTick });
    const next = tempos[i + 1];
    if (next) seconds += (next.onset - tempo.onset) * secondsPerTick;
  }
  return segments;
}

function segmentForTicks(segments: TempoSegment[], ticks: number): TempoSegment {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (segments[mid]!.startTicks <= ticks) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo]!;
}

function segmentForSeconds(segments: TempoSegment[], seconds: number): TempoSegment {
  let lo = 0;
  let hi = segments.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (segments[mid]!.startSeconds <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return segments[lo]!;
}

export function buildScoreIndex(doc: ScoreDoc): ScoreIndex {
  const notesById = new Map<string, Note>();
  const notesByPage: Note[][] = (doc.pages ?? []).map(() => []);
  const notesByPart = new Map<string, Note[]>();
  const partsById = new Map<string, Part>();

  for (const part of doc.parts ?? []) {
    partsById.set(part.id, part);
    notesByPart.set(part.id, []);
  }

  for (const note of doc.notes ?? []) {
    notesById.set(note.id, note);
    const page = notesByPage[note.page];
    if (page) page.push(note);
    else (notesByPage[note.page] ??= []).push(note);
    const partBucket = notesByPart.get(note.partId);
    if (partBucket) partBucket.push(note);
    else notesByPart.set(note.partId, [note]);
  }

  const playable = (doc.notes ?? [])
    .filter((note): note is Note & { midi: number } => note.midi != null)
    .sort((a, b) => a.onset - b.onset || a.partId.localeCompare(b.partId));

  const totalTicks = (doc.notes ?? []).reduce(
    (max, note) => Math.max(max, note.onset + note.duration),
    0,
  );

  const segments = buildTempoMap(doc);

  return {
    doc,
    notesById,
    notesByPage,
    notesByPart,
    partsById,
    playable,
    totalTicks,
    ticksToSeconds(ticks) {
      const segment = segmentForTicks(segments, ticks);
      return segment.startSeconds + (ticks - segment.startTicks) * segment.secondsPerTick;
    },
    secondsToTicks(seconds) {
      const segment = segmentForSeconds(segments, seconds);
      return segment.startTicks + (seconds - segment.startSeconds) / segment.secondsPerTick;
    },
  };
}
