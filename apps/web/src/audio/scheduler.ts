/**
 * Playback: a lookahead scheduler over the Web Audio clock.
 *
 * The problem this solves is that `setTimeout` is not a musical clock. It drifts, it is
 * throttled in background tabs, and it is at the mercy of whatever the main thread is
 * doing — which, in this app, includes re-rendering a few thousand SVG noteheads. Notes
 * scheduled with it arrive audibly late and unevenly.
 *
 * The standard answer, and what this is: a coarse timer that never makes sound itself,
 * and a sample-accurate clock that does. Every 25ms the timer wakes up, looks 120ms
 * into the future, and hands every note starting in that window to the Web Audio
 * scheduler with an exact `AudioContext.currentTime` offset. The audio thread then
 * plays them precisely, on time, no matter how busy the main thread gets. Jitter in the
 * timer only has to stay below the lookahead window to be inaudible.
 *
 * The same reasoning is why playback position is read from `AudioContext.currentTime`
 * rather than accumulated per frame: it is the only clock in the browser that actually
 * matches what the user is hearing.
 */
import type { ScoreIndex } from "../lib/scoreIndex";
import { playClick, playVoice, type VoiceHandle } from "./synth";

const SCHEDULE_INTERVAL_MS = 25;
const LOOKAHEAD_SECONDS = 0.12;

export type PlaybackStatus = "stopped" | "playing" | "paused";

export interface PlaybackConfig {
  /** Restrict playback to these notes (a saved part). Null plays everything. */
  noteIds: Set<string> | null;
  /** Parts that should sound, after mute/solo. */
  audiblePartIds: Set<string>;
  /** Parts played at reduced volume — "my part loud, the rest as a guide". */
  backgroundPartIds: Set<string>;
  tempoScale: number;
  metronome: boolean;
  loop: { startTicks: number; endTicks: number } | null;
}

interface ScheduledNote {
  id: string;
  startedAt: number;
  endsAt: number;
  handle: VoiceHandle;
}

const DEFAULT_CONFIG: PlaybackConfig = {
  noteIds: null,
  audiblePartIds: new Set(),
  backgroundPartIds: new Set(),
  tempoScale: 1,
  metronome: false,
  loop: null,
};

export class PlaybackEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  private index: ScoreIndex;
  private config: PlaybackConfig = DEFAULT_CONFIG;

  /** Notes to play, filtered and ordered; rebuilt whenever the selection changes. */
  private queue: { id: string; partId: string; midi: number; onset: number; end: number }[] = [];
  private cursor = 0;
  private nextClickTick = 0;

  /** Score-time origin of the current run, and the context time it started at. */
  private originTicks = 0;
  private originContextTime = 0;
  private pausedAtTicks = 0;

  private sounding: ScheduledNote[] = [];
  private status: PlaybackStatus = "stopped";

  onStatusChange: ((status: PlaybackStatus) => void) | null = null;

  constructor(index: ScoreIndex) {
    this.index = index;
  }

  getStatus(): PlaybackStatus {
    return this.status;
  }

  /**
   * Current position in ticks, derived from the audio clock.
   *
   * Called from requestAnimationFrame by the playhead, so it must stay allocation-free
   * and cheap — it runs 60 times a second for the whole length of a song.
   */
  getPositionTicks(): number {
    if (this.status !== "playing" || !this.context) return this.pausedAtTicks;
    const elapsed = (this.context.currentTime - this.originContextTime) * this.config.tempoScale;
    const originSeconds = this.index.ticksToSeconds(this.originTicks);
    return this.index.secondsToTicks(originSeconds + elapsed);
  }

  /** Notes sounding right now, for highlighting. Read once per animation frame. */
  getSoundingNoteIds(): string[] {
    if (!this.context) return [];
    const now = this.context.currentTime;
    const ids: string[] = [];
    for (const note of this.sounding) {
      if (note.startedAt <= now && note.endsAt > now) ids.push(note.id);
    }
    return ids;
  }

  setConfig(config: Partial<PlaybackConfig>): void {
    const wasPlaying = this.status === "playing";
    const at = this.getPositionTicks();
    this.config = { ...this.config, ...config };
    this.rebuildQueue();
    if (wasPlaying) {
      // Re-seat the run at the current position so a mid-playback change to tempo or
      // part selection takes effect immediately without a jump.
      this.restartFrom(at);
    } else {
      this.pausedAtTicks = at;
      this.seekCursor(at);
    }
  }

  async play(fromTicks?: number): Promise<void> {
    const context = this.ensureContext();
    // Browsers start the context suspended until a user gesture; play() is always
    // called from a click, which is the one moment resuming is allowed.
    if (context.state === "suspended") await context.resume();

    const start = fromTicks ?? this.pausedAtTicks;
    this.rebuildQueue();
    this.restartFrom(start);
    this.setStatus("playing");
  }

  pause(): void {
    if (this.status !== "playing") return;
    this.pausedAtTicks = this.getPositionTicks();
    this.haltSound();
    this.setStatus("paused");
  }

  stop(): void {
    this.pausedAtTicks = 0;
    this.cursor = 0;
    this.haltSound();
    this.setStatus("stopped");
  }

  seek(ticks: number): void {
    const clamped = Math.max(0, Math.min(this.index.totalTicks, ticks));
    if (this.status === "playing") {
      this.restartFrom(clamped);
    } else {
      this.pausedAtTicks = clamped;
      this.seekCursor(clamped);
    }
  }

  dispose(): void {
    this.haltSound();
    void this.context?.close();
    this.context = null;
    this.master = null;
  }

  // -- internals ------------------------------------------------------------

  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.context.destination);
    }
    return this.context;
  }

  private setStatus(status: PlaybackStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.onStatusChange?.(status);
  }

  private rebuildQueue(): void {
    const { noteIds, audiblePartIds, backgroundPartIds } = this.config;
    const audible = new Set([...audiblePartIds, ...backgroundPartIds]);
    this.queue = this.index.playable
      .filter((note) => {
        if (!audible.has(note.partId)) return false;
        // A note selected into the part being practised always sounds, even if its
        // voice part is otherwise muted — the selection is the point.
        if (noteIds && !noteIds.has(note.id) && !audiblePartIds.has(note.partId)) return false;
        return true;
      })
      .map((note) => ({
        id: note.id,
        partId: note.partId,
        midi: note.midi as number,
        onset: note.onset,
        end: note.onset + note.duration,
      }));
  }

  private seekCursor(ticks: number): void {
    // Linear from the start is fine: the queue is a few thousand entries and seeking is
    // a user-initiated action, not a hot path.
    this.cursor = this.queue.findIndex((note) => note.onset >= ticks);
    if (this.cursor < 0) this.cursor = this.queue.length;
    const beat = this.index.doc.divisions || 480;
    this.nextClickTick = Math.ceil(ticks / beat) * beat;
  }

  private restartFrom(ticks: number): void {
    const context = this.ensureContext();
    this.haltSound();
    this.originTicks = Math.max(0, ticks);
    this.originContextTime = context.currentTime + 0.05; // a beat of headroom to fill the first window
    this.seekCursor(this.originTicks);
    this.timer = setInterval(() => this.tick(), SCHEDULE_INTERVAL_MS);
    this.tick();
  }

  private haltSound(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const now = this.context?.currentTime ?? 0;
    for (const note of this.sounding) note.handle.stop(now);
    this.sounding = [];
  }

  private contextTimeFor(ticks: number): number {
    const seconds = this.index.ticksToSeconds(ticks) - this.index.ticksToSeconds(this.originTicks);
    return this.originContextTime + seconds / this.config.tempoScale;
  }

  /** One pass of the scheduler: drain everything starting inside the lookahead window. */
  private tick(): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;

    const horizon = context.currentTime + LOOKAHEAD_SECONDS;
    const loopEnd = this.config.loop?.endTicks ?? null;

    while (this.cursor < this.queue.length) {
      const note = this.queue[this.cursor]!;
      if (loopEnd !== null && note.onset >= loopEnd) break;

      const startAt = this.contextTimeFor(note.onset);
      if (startAt > horizon) break;

      const isFocus = this.config.noteIds ? this.config.noteIds.has(note.id) : true;
      const isBackground = this.config.backgroundPartIds.has(note.partId) && !isFocus;
      const handle = playVoice(context, master, {
        startAt: Math.max(startAt, context.currentTime),
        endAt: this.contextTimeFor(note.end),
        midi: note.midi,
        gain: isBackground ? 0.06 : 0.2,
        detune: isBackground ? -4 : 0,
      });
      this.sounding.push({
        id: note.id,
        startedAt: startAt,
        endsAt: this.contextTimeFor(note.end),
        handle,
      });
      this.cursor += 1;
    }

    if (this.config.metronome) this.scheduleClicks(context, master, horizon);

    // Drop finished notes so the highlight scan and memory stay bounded.
    this.sounding = this.sounding.filter((note) => note.endsAt > context.currentTime - 0.2);

    const position = this.getPositionTicks();
    if (loopEnd !== null && position >= loopEnd) {
      this.restartFrom(this.config.loop!.startTicks);
      return;
    }
    if (this.cursor >= this.queue.length && position > this.index.totalTicks) {
      this.stop();
    }
  }

  private scheduleClicks(context: AudioContext, master: GainNode, horizon: number): void {
    const beat = this.index.doc.divisions || 480;
    const signature = this.index.doc.timeSignatures?.[0];
    const beatsPerBar = signature?.numerator ?? 4;
    while (this.contextTimeFor(this.nextClickTick) <= horizon) {
      const at = this.contextTimeFor(this.nextClickTick);
      if (at >= context.currentTime) {
        playClick(context, master, at, (this.nextClickTick / beat) % beatsPerBar === 0);
      }
      this.nextClickTick += beat;
    }
  }
}
