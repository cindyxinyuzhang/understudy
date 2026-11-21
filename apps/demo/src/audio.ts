import * as Tone from 'tone'
import type { Schedule, Scheduled, ScoreNote } from './score'

/** The stretch of music to play, in quarter notes of performance time (repeats unrolled). */
export type Span = { start: number; end: number }

/**
 * How loud each note plays, 0 (silent) to 1. Notes not in `byNote` play at `rest`,
 * which covers notes no part has claimed.
 */
export type Levels = { byNote: ReadonlyMap<string, number>; rest: number }

/** Tone.Part reads each event's `time`; the note rides along beside it. */
type ScheduledNote = { time: string } & Scheduled

/** Where the file's tempo changes, as a multiple of its opening tempo. */
type TempoMark = { at: number; factor: number }

type Handlers = {
  /** Called on the animation frame a note begins, for highlighting. */
  onNoteOn: (note: ScoreNote) => void
  onStop: () => void
}

/**
 * Playback is one Tone.Part over every note in the score. Each note's level is
 * read in the callback rather than baked into the schedule, so muting a part or
 * moving its volume mid-phrase keeps perfect time — and the highlight keeps
 * tracking the music even for parts you have silenced.
 *
 * The bar range works the same way: the Part always holds the whole piece, the
 * callback skips notes outside the span, and looping is the Transport's own loop.
 * So the span and the loop switch can both change while the music plays.
 *
 * Time is performance time: repeats are already unrolled in the schedule. Tempo
 * changes written in the file scale the user's tempo, so "half as fast" stays half
 * as fast whatever the slider says.
 */
export class Player {
  private part: Tone.Part<ScheduledNote> | null = null
  private tempoPart: Tone.Part<{ time: string; factor: number }> | null = null
  private tempoMarks: TempoMark[] = []
  private baseBpm = 100
  /** Where a pause left the music, in performance quarters; null when not paused. */
  private pausedAt: number | null = null
  private synth: Tone.PolySynth | null = null
  private gain: Tone.Gain | null = null
  /** The "span is over" event, kept so it can move without touching the notes. */
  private endEvent: number | null = null
  private started = false

  private levels: Levels = { byNote: new Map(), rest: 1 }
  private span: Span = { start: 0, end: 0 }
  private loop = false

  constructor(private handlers: Handlers) {}

  /** Must run inside a real user gesture or the browser keeps the context suspended. */
  async unlock(): Promise<void> {
    if (this.started) return
    await Tone.start()
    this.started = true
  }

  setScore(schedule: Schedule): void {
    this.dispose()

    this.gain = new Tone.Gain(0.25).toDestination()
    this.synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: 'triangle' },
      envelope: { attack: 0.02, decay: 0.15, sustain: 0.5, release: 0.4 },
    }).connect(this.gain)
    this.synth.maxPolyphony = 32

    this.part = new Tone.Part<ScheduledNote>((time, { note, at }) => {
      const { start, end } = this.span
      if (at < start || at >= end) return
      const level = this.levels.byNote.get(note.id) ?? this.levels.rest
      // From the tempo in force at this note, not the transport's current value,
      // which hasn't caught up yet when a tempo change lands on the same beat.
      const secondsPerQuarter = 60 / (this.baseBpm * this.factorAt(at))
      // Cut at the end of the span so a loop restarts clean, and shorten very
      // slightly so repeated pitches re-articulate instead of blurring.
      const quarters = Math.min(note.duration, end - at)
      if (level > 0) {
        this.synth?.triggerAttackRelease(note.freq, quarters * secondsPerQuarter * 0.92, time, level)
      }
      Tone.getDraw().schedule(() => this.handlers.onNoteOn(note), time)
    }, schedule.events.map((e) => ({ time: quartersToTransportTime(e.at), ...e })))
    this.part.start(0)

    // Only where the tempo actually changes; a file without tempo marks has none.
    const opening = schedule.visits.find((v) => v.tempo)?.tempo ?? null
    this.tempoMarks = []
    for (const visit of schedule.visits) {
      const factor = opening && visit.tempo ? visit.tempo / opening : 1
      const last = this.tempoMarks[this.tempoMarks.length - 1]
      if (factor !== (last?.factor ?? 1)) this.tempoMarks.push({ at: visit.at, factor })
    }
    this.tempoPart = new Tone.Part(
      (time, { factor }) => Tone.getTransport().bpm.setValueAtTime(this.baseBpm * factor, time),
      this.tempoMarks.map((m) => ({ time: quartersToTransportTime(m.at), factor: m.factor })),
    )
    this.tempoPart.start(0)
  }

  /** The file's tempo multiple in force at a point in the performance. */
  private factorAt(at: number): number {
    let factor = 1
    for (const mark of this.tempoMarks) if (mark.at <= at) factor = mark.factor
    return factor
  }

  /** Each pass of a loop starts at the tempo in force where the span begins. */
  private onLoop = (time: number) => {
    Tone.getTransport().bpm.setValueAtTime(this.baseBpm * this.factorAt(this.span.start), time)
  }

  private nowQuarters(): number {
    const transport = Tone.getTransport()
    return transport.ticks / transport.PPQ
  }

  setLevels(levels: Levels): void {
    this.levels = levels
  }

  /** The user's tempo; the file's own tempo changes are applied on top of it. */
  setTempo(bpm: number): void {
    this.baseBpm = bpm
    const transport = Tone.getTransport()
    const at = transport.state === 'started' ? this.nowQuarters() : this.span.start
    transport.bpm.value = bpm * this.factorAt(at)
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

  /** Resumes from a pause if it is still inside the span; otherwise starts at the span. */
  async play(bpm: number): Promise<void> {
    await this.unlock()
    const transport = Tone.getTransport()
    this.baseBpm = bpm
    const resumeAt = this.pausedAt
    this.pausedAt = null
    if (resumeAt !== null && resumeAt >= this.span.start && resumeAt < this.span.end) {
      transport.bpm.cancelScheduledValues(0)
      transport.bpm.value = bpm * this.factorAt(resumeAt)
      this.setLoopPoints()
      this.scheduleEnd()
      transport.start()
      return
    }
    transport.stop()
    transport.bpm.cancelScheduledValues(0)
    transport.bpm.value = bpm * this.factorAt(this.span.start)
    transport.position = quartersToTransportTime(this.span.start)
    transport.off('loop', this.onLoop).on('loop', this.onLoop)
    this.setLoopPoints()
    this.scheduleEnd()
    transport.start()
  }

  /** Holds the music where it is; play() carries on from here. */
  pause(): void {
    const transport = Tone.getTransport()
    if (transport.state !== 'started') return
    this.pausedAt = this.nowQuarters()
    transport.pause()
    this.synth?.releaseAll()
    this.handlers.onStop()
  }

  stop(): void {
    this.pausedAt = null
    const transport = Tone.getTransport()
    transport.stop()
    transport.loop = false
    transport.off('loop', this.onLoop)
    this.clearEnd()
    this.synth?.releaseAll()
    this.handlers.onStop()
  }

  dispose(): void {
    this.clearEnd()
    this.part?.dispose()
    this.part = null
    this.tempoPart?.dispose()
    this.tempoPart = null
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
    const now = this.nowQuarters()
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
