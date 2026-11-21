import * as Tone from 'tone'
import type { ScoreNote } from './score'

export type PlayMode = 'mine' | 'others' | 'all'

/** Which notes sound in each mode, given the set the user has claimed. */
function sounds(note: ScoreNote, mode: PlayMode, mine: ReadonlySet<string>): boolean {
  if (mode === 'all') return true
  const isMine = mine.has(note.id)
  return mode === 'mine' ? isMine : !isMine
}

/** Tone.Part reads each event's `time`; the note rides along beside it. */
type ScheduledNote = { time: string; note: ScoreNote }

type Handlers = {
  /** Called on the animation frame a note begins, for highlighting. */
  onNoteOn: (note: ScoreNote) => void
  onStop: () => void
}

/**
 * Playback is one Tone.Part over every note in the score. Muting is decided in
 * the callback rather than by rebuilding the schedule, so switching between
 * "my part" and "everything" mid-phrase keeps perfect time — and so the
 * highlight keeps tracking the music even for voices you have silenced.
 */
export class Player {
  private part: Tone.Part<ScheduledNote> | null = null
  private synth: Tone.PolySynth | null = null
  private gain: Tone.Gain | null = null
  /** The "piece is over" event, kept so a restart can clear it without touching the notes. */
  private endEvent: number | null = null
  private started = false

  private mode: PlayMode = 'all'
  private mine: ReadonlySet<string> = new Set()
  private lengthQuarters = 0

  constructor(private handlers: Handlers) {}

  /** Must run inside a real user gesture or the browser keeps the context suspended. */
  async unlock(): Promise<void> {
    if (this.started) return
    await Tone.start()
    this.started = true
  }

  setScore(notes: ScoreNote[], lengthQuarters: number): void {
    this.dispose()
    this.lengthQuarters = lengthQuarters

    this.gain = new Tone.Gain(0.25).toDestination()
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.15, sustain: 0.5, release: 0.4 },
    }).connect(this.gain)
    this.synth.maxPolyphony = 32

    this.part = new Tone.Part<ScheduledNote>((time, { note }) => {
      if (!sounds(note, this.mode, this.mine)) return
      const secondsPerQuarter = 60 / Tone.getTransport().bpm.value
      // Shorten very slightly so repeated pitches re-articulate instead of blurring.
      const held = note.duration * secondsPerQuarter * 0.92
      this.synth?.triggerAttackRelease(note.freq, held, time)
      Tone.getDraw().schedule(() => this.handlers.onNoteOn(note), time)
    }, notes.map((note) => ({ time: quartersToTransportTime(note.start), note })))

    this.part.start(0)
  }

  setMode(mode: PlayMode): void {
    this.mode = mode
  }

  setMine(mine: ReadonlySet<string>): void {
    this.mine = mine
  }

  setTempo(bpm: number): void {
    Tone.getTransport().bpm.value = bpm
  }

  async play(bpm: number): Promise<void> {
    await this.unlock()
    const transport = Tone.getTransport()
    transport.bpm.value = bpm
    transport.stop()
    transport.position = 0
    // Clear only our own end marker. transport.cancel() would also wipe the notes
    // the Part scheduled, and a started Part does not reschedule them on start().
    this.clearEnd()
    // One bar of tail so the final chord can ring before everything is torn down.
    this.endEvent = transport.scheduleOnce(() => {
      Tone.getDraw().schedule(() => this.stop(), Tone.now())
    }, quartersToTransportTime(this.lengthQuarters + 4))
    transport.start()
  }

  stop(): void {
    const transport = Tone.getTransport()
    transport.stop()
    transport.position = 0
    this.clearEnd()
    this.synth?.releaseAll()
    this.handlers.onStop()
  }

  dispose(): void {
    this.clearEnd()
    this.part?.dispose()
    this.part = null
    this.synth?.dispose()
    this.gain?.dispose()
    this.synth = null
    this.gain = null
  }

  private clearEnd(): void {
    if (this.endEvent !== null) Tone.getTransport().clear(this.endEvent)
    this.endEvent = null
  }
}

/** Quarter notes -> Tone's bars:beats:sixteenths, so tempo changes rescale for free. */
export function quartersToTransportTime(quarters: number): string {
  const bars = Math.floor(quarters / 4)
  const beats = Math.floor(quarters % 4)
  const sixteenths = (quarters % 1) * 4
  return `${bars}:${beats}:${sixteenths}`
}
