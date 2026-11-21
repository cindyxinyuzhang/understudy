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
 */
export function findParts(notes: readonly ScoreNote[]): FoundPart[] {
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

  const lines: string[][] = []
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
    lines.push(...split.filter((ids) => ids.length > 0))
  }

  const names = lines.length === SATB.length ? SATB : lines.map((_, i) => `Part ${i + 1}`)
  return lines.map((noteIds, i) => ({ name: names[i]!, noteIds }))
}

function meanFreq(notes: readonly ScoreNote[]): number {
  return notes.reduce((sum, n) => sum + n.freq, 0) / notes.length
}
