import * as Tone from 'tone'
import type { ScoreNote } from './score'

export type PlayMode = 'mine' | 'others' | 'all'

/** The stretch of music to play, in quarter notes from the start of the piece. */
export type Span = { start: number; end: number }

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
 *
 * The bar range works the same way: the Part always holds the whole piece, the
 * callback skips notes outside the span, and looping is the Transport's own loop.
 * So the span and the loop switch can both change while the music plays.
 */
export class Player {
  private part: Tone.Part<ScheduledNote> | null = null
  private synth: Tone.PolySynth | null = null
  private gain: Tone.Gain | null = null
  /** The "span is over" event, kept so it can move without touching the notes. */
  private endEvent: number | null = null
  private started = false

  private mode: PlayMode = 'all'
  private mine: ReadonlySet<string> = new Set()
  private span: Span = { start: 0, end: 0 }
  private loop = false

  constructor(private handlers: Handlers) {}

  /** Must run inside a real user gesture or the browser keeps the context suspended. */
  async unlock(): Promise<void> {
    if (this.started) return
    await Tone.start()
    this.started = true
  }

  setScore(notes: ScoreNote[]): void {
    this.dispose()

    this.gain = new Tone.Gain(0.25).toDestination()
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.15, sustain: 0.5, release: 0.4 },
    }).connect(this.gain)
    this.synth.maxPolyphony = 32

    this.part = new Tone.Part<ScheduledNote>((time, { note }) => {
      const { start, end } = this.span
      if (note.start < start || note.start >= end) return
      if (!sounds(note, this.mode, this.mine)) return
      const secondsPerQuarter = 60 / Tone.getTransport().bpm.value
      // Cut at the end of the span so a loop restarts clean, and shorten very
      // slightly so repeated pitches re-articulate instead of blurring.
      const quarters = Math.min(note.duration, end - note.start)
      this.synth?.triggerAttackRelease(note.freq, quarters * secondsPerQuarter * 0.92, time)
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

  /** Takes effect immediately if playing: the loop points and the end move with it. */
  setSpan(span: Span): void {
    this.span = span
    this.applySpan()
  }

  setLoop(loop: boolean): void {
    this.loop = loop
    this.applySpan()
  }

  async play(bpm: number): Promise<void> {
    await this.unlock()
    const transport = Tone.getTransport()
    transport.bpm.value = bpm
    transport.stop()
    transport.position = quartersToTransportTime(this.span.start)
    this.setLoopPoints()
    this.scheduleEnd()
    transport.start()
  }

  stop(): void {
    const transport = Tone.getTransport()
    transport.stop()
    transport.loop = false
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

  private setLoopPoints(): void {
    const transport = Tone.getTransport()
    transport.loopStart = quartersToTransportTime(this.span.start)
    transport.loopEnd = quartersToTransportTime(this.span.end)
    transport.loop = this.loop
  }

  /** Without a loop, the music stops itself half a beat after the span, so the last note's release is heard. */
  private scheduleEnd(): void {
    this.clearEnd()
    if (this.loop) return
    this.endEvent = Tone.getTransport().scheduleOnce(() => {
      Tone.getDraw().schedule(() => this.stop(), Tone.now())
    }, quartersToTransportTime(this.span.end + 0.5))
  }

  /** Re-aim a running playback at a changed span or loop setting. */
  private applySpan(): void {
    const transport = Tone.getTransport()
    const { start, end } = this.span
    if (end <= start || transport.state !== 'started') return
    this.setLoopPoints()

    // A span moved out from under the playhead: jump back in rather than run on.
    const now = (transport.ticks / transport.PPQ) as number
    if (now < start || now >= end) {
      if (!this.loop) {
        this.stop()
        return
      }
      transport.position = quartersToTransportTime(start)
    }
    this.scheduleEnd()
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
