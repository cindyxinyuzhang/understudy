/**
 * A voice-ish tone.
 *
 * Deliberately not a sampler. A rehearsal tool needs pitch and rhythm to be
 * unmistakable, not a convincing timbre — and a sampled voice would mean shipping tens
 * of megabytes of audio, decoding it on load, and still sounding wrong on the vowels.
 * A filtered triangle with a soft attack sings the line clearly and costs nothing.
 *
 * The important property is that every node is created per note and torn down when it
 * finishes. Long-lived oscillators that get retuned are the usual cause of clicks and
 * of notes that keep sounding after a stop.
 */

export interface VoiceHandle {
  stop: (at: number) => void;
}

export function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export interface VoiceOptions {
  startAt: number;
  endAt: number;
  midi: number;
  gain: number;
  /** Distinguishes parts by ear when several sound at once. */
  detune?: number;
}

export function playVoice(
  context: AudioContext,
  destination: AudioNode,
  { startAt, endAt, midi, gain, detune = 0 }: VoiceOptions,
): VoiceHandle {
  const oscillator = context.createOscillator();
  oscillator.type = "triangle";
  oscillator.frequency.value = midiToFrequency(midi);
  oscillator.detune.value = detune;

  // Rolls off the buzz of the triangle's upper partials so stacked parts stay legible.
  const filter = context.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = Math.min(6000, midiToFrequency(midi) * 6);
  filter.Q.value = 0.6;

  const envelope = context.createGain();
  const attack = 0.012;
  const release = 0.08;
  // Sustain slightly past the notated end so legato lines do not gap, but never past
  // the next note's attack by enough to muddy it.
  const stopAt = Math.max(endAt, startAt + 0.05);

  envelope.gain.setValueAtTime(0.0001, startAt);
  envelope.gain.exponentialRampToValueAtTime(gain, startAt + attack);
  envelope.gain.setValueAtTime(gain, Math.max(startAt + attack, stopAt - release));
  envelope.gain.exponentialRampToValueAtTime(0.0001, stopAt + release);

  oscillator.connect(filter).connect(envelope).connect(destination);
  oscillator.start(startAt);
  oscillator.stop(stopAt + release + 0.02);

  // Without this, a long practice session accumulates thousands of dead nodes.
  oscillator.onended = () => {
    oscillator.disconnect();
    filter.disconnect();
    envelope.disconnect();
  };

  return {
    stop(at: number) {
      const when = Math.max(at, context.currentTime);
      envelope.gain.cancelScheduledValues(when);
      envelope.gain.setValueAtTime(Math.max(envelope.gain.value, 0.0001), when);
      envelope.gain.exponentialRampToValueAtTime(0.0001, when + 0.03);
      try {
        oscillator.stop(when + 0.05);
      } catch {
        /* already stopped */
      }
    },
  };
}

/** A short click for the metronome. Separate from voices so it cannot be muted by solo. */
export function playClick(
  context: AudioContext,
  destination: AudioNode,
  at: number,
  accent: boolean,
): void {
  const oscillator = context.createOscillator();
  const envelope = context.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = accent ? 1600 : 1100;
  envelope.gain.setValueAtTime(0.0001, at);
  envelope.gain.exponentialRampToValueAtTime(accent ? 0.22 : 0.12, at + 0.002);
  envelope.gain.exponentialRampToValueAtTime(0.0001, at + 0.045);
  oscillator.connect(envelope).connect(destination);
  oscillator.start(at);
  oscillator.stop(at + 0.06);
  oscillator.onended = () => {
    oscillator.disconnect();
    envelope.disconnect();
  };
}
