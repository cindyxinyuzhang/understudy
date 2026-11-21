import type { ScoreNote } from './score'

/** One melodic line found in the score, top to bottom order. */
export type FoundPart = { name: string; noteIds: string[] }

const SATB = ['Soprano', 'Alto', 'Tenor', 'Bass']

/**
 * Work out how many separate melodic lines a score holds, and which notes are in each.
 *
 * A line is first a voice on a staff: closed-score SATB writes soprano and alto as two
 * voices on the treble staff. But hymnals often write two singers as chords in a single
 * voice instead, so within a voice the widest chord says how many lines it carries, and
 * each chord is dealt out by height: top note to the top line, bottom note to the bottom.
 * A chord thinner than the widest (a unison, say) spreads its notes evenly across them.
 *
 * Lines come back ordered staff by staff, and within a staff from highest to lowest
 * average pitch, so the names read top to bottom the way the page does.
 *
 * Names: four lines in all are Soprano, Alto, Tenor, Bass. Otherwise lines are
 * named by the instrument they belong to (`staffInstruments`, by staff index): an
 * instrument holding exactly four lines is SATB, one with a single line takes the
 * instrument's own name, and any other count is numbered ("Piano 1", "Piano 2").
 */
export function findParts(
  notes: readonly ScoreNote[],
  staffInstruments: readonly string[] = [],
): FoundPart[] {
  const voices = new Map<string, ScoreNote[]>()
  for (const note of notes) {
    const key = `${note.staff}:${note.voice}`
    const list = voices.get(key)
    if (list) list.push(note)
    else voices.set(key, [note])
  }

  const ordered = [...voices.values()].sort(
    (a, b) => a[0]!.staff - b[0]!.staff || meanFreq(b) - meanFreq(a),
  )

  const lines: { staff: number; ids: string[] }[] = []
  for (const voiceNotes of ordered) {
    const chords = new Map<number, ScoreNote[]>()
    for (const note of voiceNotes) {
      const chord = chords.get(note.start)
      if (chord) chord.push(note)
      else chords.set(note.start, [note])
    }
    const width = Math.max(...[...chords.values()].map((c) => c.length))
    const split: string[][] = Array.from({ length: width }, () => [])
    for (const chord of chords.values()) {
      chord.sort((a, b) => b.freq - a.freq)
      chord.forEach((note, j) => {
        const line = chord.length === 1 ? 0 : Math.round((j * (width - 1)) / (chord.length - 1))
        split[line]!.push(note.id)
      })
    }
    const staff = voiceNotes[0]!.staff
    lines.push(...split.filter((ids) => ids.length > 0).map((ids) => ({ staff, ids })))
  }

  if (lines.length === SATB.length) return lines.map((l, i) => ({ name: SATB[i]!, noteIds: l.ids }))

  const instrumentOf = (staff: number) => staffInstruments[staff] ?? 'Part'
  const lineCount = new Map<string, number>()
  for (const l of lines) lineCount.set(instrumentOf(l.staff), (lineCount.get(instrumentOf(l.staff)) ?? 0) + 1)
  const seen = new Map<string, number>()
  return lines.map((l) => {
    const instrument = instrumentOf(l.staff)
    const k = seen.get(instrument) ?? 0
    seen.set(instrument, k + 1)
    const count = lineCount.get(instrument)!
    const name = count === SATB.length ? SATB[k]! : count === 1 ? instrument : `${instrument} ${k + 1}`
    return { name, noteIds: l.ids }
  })
}

/** True when the parts found include a full Soprano, Alto, Tenor, Bass set. */
export const hasSatb = (found: readonly FoundPart[]) =>
  SATB.every((name) => found.some((f) => f.name === name))

function meanFreq(notes: readonly ScoreNote[]): number {
  return notes.reduce((sum, n) => sum + n.freq, 0) / notes.length
}
