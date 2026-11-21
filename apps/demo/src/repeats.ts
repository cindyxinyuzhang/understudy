import { RepetitionInstructionEnum, type RepetitionInstruction } from 'opensheetmusicdisplay'

/** What a bar carries about repeats, as OSMD reads it from the file. */
export type RepeatMarks = {
  FirstRepetitionInstructions: RepetitionInstruction[]
  LastRepetitionInstructions: RepetitionInstruction[]
}

/**
 * The order bars are performed in, as indices into the written bars: repeat signs
 * send the music back once, and an ending bracket plays only on the passes it is
 * numbered for ("1." on the first, "2." on the second).
 *
 * Jumps written in words (D.C., D.S., Coda, Fine) are not followed: those bars
 * play once, in written order.
 */
export function performanceOrder(bars: readonly RepeatMarks[]): number[] {
  const has = (list: RepetitionInstruction[], type: RepetitionInstructionEnum) =>
    list.find((r) => r.type === type)

  const order: number[] = []
  /** Back-jumps already taken, by the bar that carries them. */
  const taken = new Map<number, number>()
  let repeatFrom = 0
  /** Which pass through the current repeat this is, counting from 1. */
  let pass = 1
  /** The numbers of the ending bracket we are inside, if any. */
  let ending: number[] | null = null

  // A malformed file could loop forever; no real piece repeats more than this.
  const limit = bars.length * 8
  let i = 0
  while (i < bars.length && order.length < limit) {
    const bar = bars[i]!
    const opens = has(bar.FirstRepetitionInstructions, RepetitionInstructionEnum.Ending)
    if (opens) ending = opens.endingIndices?.length ? opens.endingIndices : [1]
    const closes = has(bar.LastRepetitionInstructions, RepetitionInstructionEnum.Ending)

    // An ending that isn't for this pass is skipped over, bracket and all.
    if (ending && !ending.includes(pass)) {
      if (closes) ending = null
      i++
      continue
    }

    // Arriving at a start-repeat from before it (not by jumping back) begins a new repeat.
    const previous = order[order.length - 1]
    if (
      has(bar.FirstRepetitionInstructions, RepetitionInstructionEnum.StartLine) &&
      (previous === undefined || previous < i)
    ) {
      repeatFrom = i
      pass = 1
    }

    order.push(i)
    if (closes) ending = null

    if (has(bar.LastRepetitionInstructions, RepetitionInstructionEnum.BackJumpLine)) {
      const done = taken.get(i) ?? 0
      if (done < 1) {
        taken.set(i, done + 1)
        pass++
        i = repeatFrom
        continue
      }
      // Past a repeat: whatever comes next is played once.
      pass = 1
    }
    // Leaving the last ending of a repeat (no further bracket follows) also ends it.
    const next = bars[i + 1]
    if (closes && !(next && has(next.FirstRepetitionInstructions, RepetitionInstructionEnum.Ending))) {
      pass = 1
    }
    i++
  }
  return order
}
