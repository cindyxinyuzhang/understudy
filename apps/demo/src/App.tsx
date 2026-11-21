import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Player, type PlayMode } from './audio'
import { createOsmd, extractModel, type Palette, type ScoreModel } from './score'

const SCORE_URL = `${import.meta.env.BASE_URL}sample.musicxml`

// Kept in step with --ink and --paper in styles.css; OSMD needs literal colours.
const PALETTE: Palette = { ink: '#2b1a10', paper: '#fbf5ea' }

const MODES: { mode: PlayMode; label: string }[] = [
  { mode: 'mine', label: 'My part' },
  { mode: 'others', label: 'The others' },
  { mode: 'all', label: 'Everything' },
]

export function App() {
  const scoreRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const rectsRef = useRef(new Map<string, SVGRectElement>())

  const [model, setModel] = useState<ScoreModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [mine, setMine] = useState<ReadonlySet<string>>(new Set())
  const [part, setPart] = useState<number | null>(0)
  const [playing, setPlaying] = useState<PlayMode | null>(null)
  const [bpm, setBpm] = useState(100)

  // The highlight is set straight on the DOM from Tone's draw callback: a React
  // render per note would fall behind the music on a busy chord.
  const player = useMemo(
    () =>
      new Player({
        onNoteOn: (note) => {
          const rect = rectsRef.current.get(note.id)
          if (!rect) return
          rect.dataset.sounding = 'true'
          const ms = (note.duration * 60_000) / currentBpm.current
          window.setTimeout(() => delete rect.dataset.sounding, ms * 0.92)
        },
        onStop: () => {
          setPlaying(null)
          for (const rect of rectsRef.current.values()) delete rect.dataset.sounding
        },
      }),
    [],
  )
  const currentBpm = useRef(bpm)

  // Load once, then re-lay-out whenever the width changes enough to move line breaks.
  useEffect(() => {
    const container = scoreRef.current
    if (!container) return
    let cancelled = false
    const osmd = createOsmd(container, PALETTE)
    osmdRef.current = osmd

    const layout = () => {
      osmd.render()
      const next = extractModel(osmd, container)
      setModel(next)
      return next
    }

    osmd
      .load(SCORE_URL)
      .then(() => {
        if (cancelled) return
        const first = layout()
        setMine(notesOfPart(first, 0))
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))

    let lastWidth = container.clientWidth
    let timer = 0
    const observer = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastWidth) < 24 || !osmd.Sheet) return
      lastWidth = container.clientWidth
      window.clearTimeout(timer)
      timer = window.setTimeout(layout, 150)
    })
    observer.observe(container)

    return () => {
      cancelled = true
      observer.disconnect()
      window.clearTimeout(timer)
      osmd.clear()
    }
  }, [])

  // Note ids are structural, so a re-layout keeps the selection; only the schedule moves.
  useEffect(() => {
    if (!model) return
    player.stop()
    player.setScore(model.notes, model.parts.length, model.length)
  }, [model, player])

  useEffect(() => player.setMine(mine), [mine, player])

  useEffect(() => {
    currentBpm.current = bpm
    player.setTempo(bpm)
  }, [bpm, player])

  useEffect(() => () => player.dispose(), [player])

  const choosePart = useCallback(
    (index: number) => {
      if (!model) return
      setPart(index)
      setMine(notesOfPart(model, index))
    },
    [model],
  )

  const toggleNote = useCallback((id: string) => {
    setPart(null) // a hand-picked line no longer matches any one printed part
    setMine((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const play = async (mode: PlayMode) => {
    if (playing === mode) {
      player.stop()
      return
    }
    setPlaying(mode)
    await player.play(mode, bpm)
  }

  return (
    <div className="hall">
      <header className="masthead">
        <p className="eyebrow">Understudy</p>
        <h1>Learn your part</h1>
        <p className="lede">
          Pick your line out of a four-part score and hear it alone, against the others, or
          with them.
        </p>
      </header>

      <section className="controls" aria-label="Playback">
        <div className="control-group">
          <span className="label">Your line</span>
          <div className="segmented">
            {(model?.parts ?? ['Soprano', 'Alto', 'Tenor', 'Bass']).map((name, i) => (
              <button
                key={name}
                className={part === i ? 'on' : ''}
                disabled={!model}
                onClick={() => choosePart(i)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="control-group">
          <span className="label">Play</span>
          <div className="segmented">
            {MODES.map(({ mode, label }) => (
              <button
                key={mode}
                className={playing === mode ? 'on' : ''}
                disabled={!model || (mode !== 'all' && mine.size === 0)}
                onClick={() => void play(mode)}
              >
                {playing === mode ? 'Stop' : label}
              </button>
            ))}
          </div>
        </div>

        <label className="control-group tempo">
          <span className="label">
            Tempo <span className="value">{bpm}</span>
          </span>
          <input
            type="range"
            min={50}
            max={160}
            step={2}
            value={bpm}
            onChange={(event) => setBpm(Number(event.target.value))}
          />
        </label>
      </section>

      <p className="hint">
        Tap any note to add it to your line or take it out. Ode to Joy, arranged for four
        voices.
      </p>

      <main className="paper">
        {error && <p className="error">Couldn’t load the score: {error}</p>}
        {!model && !error && <p className="loading">Setting out the music…</p>}
        <div className="score-frame">
          <div ref={scoreRef} className="score" />
          {model && (
            <svg
              className="overlay"
              width={model.size.w}
              height={model.size.h}
              viewBox={`0 0 ${model.size.w} ${model.size.h}`}
            >
              {model.notes.map((note) => (
                <rect
                  key={note.id}
                  ref={(el) => {
                    if (el) rectsRef.current.set(note.id, el)
                    else rectsRef.current.delete(note.id)
                  }}
                  className={mine.has(note.id) ? 'note mine' : 'note'}
                  x={note.box.x - 3}
                  y={note.box.y - 3}
                  width={note.box.w + 6}
                  height={note.box.h + 6}
                  rx={4}
                  onClick={() => toggleNote(note.id)}
                />
              ))}
            </svg>
          )}
        </div>
      </main>

      <footer className="colophon">
        Engraved with OpenSheetMusicDisplay · played with Tone.js
      </footer>
    </div>
  )
}

function notesOfPart(model: ScoreModel, partIndex: number): Set<string> {
  return new Set(model.notes.filter((n) => n.partIndex === partIndex).map((n) => n.id))
}
