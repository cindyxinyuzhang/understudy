import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'

import { Player, type Levels } from './audio'
import logoUrl from './assets/brand/logo-on-dark.svg'
import sampleUrl from './assets/sample.musicxml?url'
import { findParts } from './parts'
import {
  buildSchedule,
  createOsmd,
  extractModel,
  type HeadElement,
  type Palette,
  type ScoreModel,
  type ScoreNote,
} from './score'

// Imported rather than served from public/ so the built file name carries a content
// hash: a regenerated sample can never be shadowed by a cached copy of the old one.
const SAMPLE_URL = sampleUrl

/**
 * OSMD needs literal colours, so read them from tokens.css; the fallbacks match it.
 * Barlines have no OSMD option and are coloured in styles.css instead.
 */
function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  const token = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback
  return {
    ink: token('--us-ink', '#24222B'),
    ground: token('--us-ground', '#E3E1D8'),
    staffLine: token('--us-staff-line', '#A39F96'),
  }
}

// Used only through the --part custom property, so the tokens can stay as var()s.
const PART_COLOURS = [
  'var(--us-part-soprano)',
  'var(--us-part-alto)',
  'var(--us-part-tenor)',
  'var(--us-part-bass)',
  'var(--us-part-5)',
  'var(--us-part-6)',
  'var(--us-part-7)',
  'var(--us-part-8)',
]

const SATB = ['Soprano', 'Alto', 'Tenor', 'Bass']

const TEMPO = { min: 50, max: 160, step: 4 }
const DEFAULT_BPM = 100
const clampTempo = (bpm: number) => Math.min(TEMPO.max, Math.max(TEMPO.min, bpm))

/** Whether something is heard, and how loud: volume is the slider's 0-100. */
type Mix = { on: boolean; volume: number }

const FULL: Mix = { on: true, volume: 100 }

/** Slider position to synth velocity; squared, so the slider's middle sounds like the middle. */
const levelOf = (mix: Mix) => (mix.on ? (mix.volume / 100) ** 2 : 0)

/** A singer's part as the user has marked it out. The score file knows nothing about these. */
type Part = { id: string; name: string; colour: string } & Mix

let nextPartId = 1
const newPart = (name: string, index: number): Part => ({
  id: `part-${nextPartId++}`,
  name,
  colour: PART_COLOURS[index % PART_COLOURS.length]!,
  ...FULL,
})

export function App() {
  const scoreRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const layoutRef = useRef<() => ScoreModel | null>(() => null)
  const rectsRef = useRef(new Map<string, SVGRectElement>())

  const [model, setModel] = useState<ScoreModel | null>(null)
  const [title, setTitle] = useState('')
  const [staffCount, setStaffCount] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [parts, setParts] = useState<Part[]>([])
  const [owner, setOwner] = useState<ReadonlyMap<string, string>>(new Map())
  const [activePartId, setActivePartId] = useState<string | null>(null)
  const [myPartId, setMyPartId] = useState<string | null>(null)

  /** Notes no part has claimed. */
  const [others, setOthers] = useState<Mix>(FULL)
  const [playing, setPlaying] = useState(false)
  const [bpm, setBpm] = useState(DEFAULT_BPM)
  /** Indices into model.bars, inclusive. */
  const [range, setRange] = useState({ from: 0, to: 0 })
  const [loop, setLoop] = useState(false)
  /** A bar drag in progress: where it began, and whether it has left that bar yet. */
  const barDrag = useRef<{ anchor: number; moved: boolean; wasOnlyThisBar: boolean } | null>(null)
  const currentBpm = useRef(bpm)

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
          setPlaying(false)
          for (const rect of rectsRef.current.values()) delete rect.dataset.sounding
        },
      }),
    [],
  )

  // One OSMD for the page's lifetime; scores are loaded into it. Re-lay-out when the
  // width changes enough to move line breaks — note ids are structural, so the
  // user's parts survive it.
  useEffect(() => {
    const container = scoreRef.current
    if (!container) return
    const osmd = createOsmd(container, readPalette())
    osmdRef.current = osmd
    layoutRef.current = () => {
      if (!osmd.Sheet) return null
      osmd.render()
      const next = extractModel(osmd, container)
      setModel(next)
      return next
    }

    let lastWidth = container.clientWidth
    let timer = 0
    const observer = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - lastWidth) < 24) return
      lastWidth = container.clientWidth
      window.clearTimeout(timer)
      timer = window.setTimeout(() => layoutRef.current(), 150)
    })
    observer.observe(container)

    return () => {
      observer.disconnect()
      window.clearTimeout(timer)
      osmd.clear()
      // clear() leaves OSMD's page divs behind; a remount (StrictMode, hot reload)
      // would otherwise stack an empty page above the new one.
      container.replaceChildren()
      osmdRef.current = null
    }
  }, [])

  /** `content` is a URL, MusicXML text, or an .mxl file as a binary string. */
  const loadScore = useCallback(
    async (content: string, fallbackTitle: string) => {
      const osmd = osmdRef.current
      if (!osmd) return
      player.stop()
      setLoading(true)
      setError(null)
      try {
        await osmd.load(content)
        setTitle(osmd.Sheet.TitleString?.trim() || fallbackTitle)
        setStaffCount(osmd.Sheet.Staves.length)
        setParts([])
        setOwner(new Map())
        setActivePartId(null)
        setMyPartId(null)
        setOthers(FULL)
        const laidOut = layoutRef.current()
        setRange({ from: 0, to: Math.max(0, (laidOut?.bars.length ?? 1) - 1) })
        // Start from the file's own tempo when it gives one.
        const opening = laidOut?.bars.find((b) => b.tempo)?.tempo
        setBpm(opening ? clampTempo(Math.round(opening)) : DEFAULT_BPM)
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        setLoading(false)
      }
    },
    [player],
  )

  useEffect(() => {
    void loadScore(SAMPLE_URL, 'Sample score')
  }, [loadScore])

  const schedule = useMemo(() => (model ? buildSchedule(model) : null), [model])

  useEffect(() => {
    if (!schedule) return
    player.stop()
    player.setScore(schedule)
  }, [schedule, player])

  const bars = model?.bars ?? []
  const wholePiece = range.from === 0 && range.to === bars.length - 1
  // The chosen bars, in performance time: from the first time the first bar is
  // played to the next time the last bar finishes, repeats and all.
  const span = useMemo(() => {
    if (!schedule) return null
    if (wholePiece) return { start: 0, end: schedule.length }
    const first = schedule.visits.find((v) => v.bar === range.from)
    if (!first) return null
    const last =
      schedule.visits.find((v) => v.bar === range.to && v.at >= first.at) ??
      schedule.visits.find((v) => v.bar === range.to)
    return { start: first.at, end: last && last.end > first.at ? last.end : first.end }
  }, [schedule, range, wholePiece])
  useEffect(() => {
    if (span) player.setSpan(span)
  }, [span, player])
  useEffect(() => player.setLoop(loop), [loop, player])
  useEffect(() => {
    currentBpm.current = bpm
    player.setTempo(bpm)
  }, [bpm, player])
  useEffect(() => () => player.dispose(), [player])

  const partById = useMemo(() => new Map(parts.map((l) => [l.id, l])), [parts])

  const levels = useMemo<Levels>(() => {
    const byNote = new Map<string, number>()
    for (const [noteId, partId] of owner) {
      const part = partById.get(partId)
      if (part) byNote.set(noteId, levelOf(part))
    }
    return { byNote, rest: levelOf(others) }
  }, [owner, partById, others])
  useEffect(() => player.setLevels(levels), [levels, player])

  const unclaimed = model ? model.notes.filter((n) => !partById.has(owner.get(n.id) ?? '')).length : 0
  // Notes take their part's colour on the engraving itself. OSMD's SVG is not React's,
  // so this writes straight to it; a re-layout makes a new model and repaints.
  useEffect(() => {
    if (!model) return
    const colourOf = (noteId: string | null) =>
      noteId ? partById.get(owner.get(noteId) ?? '')?.colour : undefined
    // VexFlow sets fills and strokes as attributes; styles.css overrides them from
    // --part on whatever carries the class.
    const paint = (el: HeadElement, className: string, colour: string | undefined) => {
      el.classList.toggle(className, Boolean(colour))
      if (colour) el.style.setProperty('--part', colour)
      else el.style.removeProperty('--part')
    }
    for (const [noteId, heads] of model.heads) {
      for (const head of heads) paint(head, 'owned', colourOf(noteId))
    }
    for (const glyph of model.glyphs) {
      // A stem shared by notes of different parts stays ink.
      const colours = glyph.noteIds.map(colourOf)
      const one = colours.every((c) => c && c === colours[0]) ? colours[0] : undefined
      paint(glyph.group, 'stem-owned', one)
      for (const mark of glyph.marks) paint(mark.el, 'owned', colourOf(mark.noteId))
    }
  }, [model, owner, partById])

  const addParts = (names: string[]) => {
    const added = names.map((name, i) => newPart(name, parts.length + i))
    setParts((prev) => [...prev, ...added])
    setActivePartId(added[0]!.id)
    if (!myPartId) setMyPartId(added[0]!.id)
  }

  /** Replace whatever parts exist with one per melodic line found in the score. */
  const detectParts = () => {
    if (!model) return
    const found = findParts(model.notes, model.staffInstruments)
    if (found.length === 0) return
    const made = found.map((f, i) => newPart(f.name, i))
    const next = new Map<string, string>()
    found.forEach((f, i) => f.noteIds.forEach((id) => next.set(id, made[i]!.id)))
    setParts(made)
    setOwner(next)
    setActivePartId(made[0]!.id)
    setMyPartId(made[0]!.id)
  }

  const changeTempo = (direction: 1 | -1) =>
    setBpm((b) => clampTempo(b + direction * TEMPO.step))

  const removePart = (id: string) => {
    setParts((prev) => prev.filter((l) => l.id !== id))
    setOwner((prev) => new Map([...prev].filter(([, partId]) => partId !== id)))
    if (activePartId === id) setActivePartId(null)
    if (myPartId === id) setMyPartId(null)
  }

  const updatePart = (id: string, patch: Partial<Part>) =>
    setParts((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))

  const renamePart = (id: string, name: string) => updatePart(id, { name })

  /**
   * Click hands one note to the part being marked; clicking it again takes it back.
   * Shift-click does the same for every note in that note's voice on that staff,
   * which is usually exactly one singer's part in a closed score.
   */
  const assign = (note: ScoreNote, wholeVoice: boolean) => {
    if (!activePartId || !model) return
    const targets = wholeVoice
      ? model.notes.filter((n) => n.staff === note.staff && n.voice === note.voice)
      : [note]
    setOwner((prev) => {
      const next = new Map(prev)
      const release = targets.every((n) => prev.get(n.id) === activePartId)
      for (const n of targets) {
        if (release) next.delete(n.id)
        else next.set(n.id, activePartId)
      }
      return next
    })
  }

  const togglePlay = async () => {
    if (playing) {
      player.pause()
      return
    }
    if (!model || loading) return
    setPlaying(true)
    await player.play(bpm)
  }

  // Space plays and pauses from anywhere, except while typing or on a control
  // that uses Space itself (a slider moves with it).
  const toggleRef = useRef(togglePlay)
  toggleRef.current = togglePlay
  useEffect(() => {
    const ownsSpace = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLInputElement && target.type !== 'button' && target.type !== 'checkbox'))
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || event.ctrlKey || event.metaKey || event.altKey) return
      if (ownsSpace(event.target)) return
      // Also stops the page scrolling, and a focused button from being pressed too.
      event.preventDefault()
      void toggleRef.current()
    }
    // A focused button presses itself on Space's keyup; we've already acted on keydown.
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && event.target instanceof HTMLButtonElement) event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const openFile = async (file: File) => {
    const isZip = /\.mxl$/i.test(file.name)
    const content = isZip ? await readAsBinaryString(file) : await file.text()
    await loadScore(content, file.name.replace(/\.[^.]+$/, ''))
  }


  /** The bar under a pointer, from the overlay's own coordinates (it is drawn 1:1 in px). */
  const barAt = (event: React.PointerEvent<SVGSVGElement>): number | null => {
    const origin = event.currentTarget.getBoundingClientRect()
    const x = event.clientX - origin.left
    const y = event.clientY - origin.top
    const i = bars.findIndex(
      (bar) => bar.box && x >= bar.box.x && x <= bar.box.x + bar.box.w && y >= bar.box.y && y <= bar.box.y + bar.box.h,
    )
    return i === -1 ? null : i
  }

  // Dragging over the music picks a span of bars; a click picks one bar, and a
  // second click on that same lone bar goes back to the whole piece. Notes sit
  // above the bar layer and keep their own clicks, so this never fights marking.
  const onBarDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || (event.target as Element).classList.contains('note')) return
    const i = barAt(event)
    if (i === null) return
    event.currentTarget.setPointerCapture(event.pointerId)
    barDrag.current = { anchor: i, moved: false, wasOnlyThisBar: range.from === i && range.to === i }
    setRange({ from: i, to: i })
  }

  const onBarMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const drag = barDrag.current
    if (!drag) return
    const i = barAt(event)
    if (i === null) return
    if (i !== drag.anchor) drag.moved = true
    setRange({ from: Math.min(drag.anchor, i), to: Math.max(drag.anchor, i) })
  }

  const onBarUp = () => {
    const drag = barDrag.current
    barDrag.current = null
    if (drag && !drag.moved && drag.wasOnlyThisBar) setRange({ from: 0, to: bars.length - 1 })
  }

  const meta = model
    ? [plural(staffCount, 'stave', 'staves'), plural(bars.length, 'bar', 'bars')].join(' · ')
    : ''

  return (
    <div className="app">
      <div className="masthead">
        <header className="topbar">
          <img className="logo" src={logoUrl} width={140} alt="Understudy" />

          <p className="score-heading">
            <span className="score-title">{title || (loading ? 'Loading…' : 'No score')}</span>
            {meta && <span className="score-meta"> · {meta}</span>}
          </p>

          <div className="topbar-actions">
            <Help />
            <label className="open-file">
              <UploadIcon />
              <span className="open-label">Open another score</span>
              <input
                type="file"
                accept=".musicxml,.xml,.mxl"
                aria-label="Open another score"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void openFile(file)
                }}
              />
            </label>
          </div>
        </header>

        <section className="parts-strip" aria-label="Who sings what?">
          {parts.length === 0 ? (
            <div className="presets">
              <h2>Who sings what?</h2>
              <button className="preset-satb" disabled={!model || loading} onClick={detectParts}>
                <span className="dots" aria-hidden="true">
                  {SATB.map((name, i) => (
                    <span key={name} className="dot" style={{ '--part': PART_COLOURS[i] } as CSSProperties} />
                  ))}
                </span>
                Split parts for me
              </button>
              <button
                className="preset-mine"
                disabled={!model || loading}
                onClick={() => addParts(['Part 1'])}
              >
                <span className="dot" aria-hidden="true" style={{ '--part': 'var(--us-accent)' } as CSSProperties} />
                Define parts myself
              </button>
              <p className="hint">You can change any note afterwards by clicking it.</p>
            </div>
          ) : (
            <ul className="parts">
              {parts.map((part) => (
                <li
                  key={part.id}
                  className={part.id === activePartId ? 'part active' : 'part'}
                  style={{ '--part': part.colour } as CSSProperties}
                  onClick={() => setActivePartId(part.id)}
                >
                  <span className="dot" />
                  <input
                    className="part-name"
                    value={part.name}
                    size={Math.max(4, part.name.length)}
                    aria-label="Part name"
                    onChange={(event) => renamePart(part.id, event.target.value)}
                  />
                  <button
                    className={part.id === myPartId ? 'mine-toggle on' : 'mine-toggle'}
                    title="This is the part I'm learning"
                    aria-pressed={part.id === myPartId}
                    onClick={(event) => {
                      event.stopPropagation()
                      setMyPartId(part.id)
                    }}
                  >
                    {part.id === myPartId ? 'Mine' : 'Me?'}
                  </button>
                  <MixControls
                    name={part.name || 'this part'}
                    mix={part}
                    onChange={(patch) => updatePart(part.id, patch)}
                  />
                  <button
                    className="remove"
                    aria-label={`Remove ${part.name}`}
                    onClick={(event) => {
                      event.stopPropagation()
                      removePart(part.id)
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
              {unclaimed > 0 && (
                <li className="part others" style={{ '--part': 'var(--us-muted)' } as CSSProperties}>
                  <span className="dot" />
                  <span className="part-name">Other notes</span>
                  <MixControls
                    name="other notes"
                    mix={others}
                    onChange={(patch) => setOthers((m) => ({ ...m, ...patch }))}
                  />
                </li>
              )}
              <li className="links">
                <button className="link" onClick={() => addParts([`Part ${parts.length + 1}`])}>
                  + Add a part
                </button>
                <button className="link" onClick={detectParts}>
                  Find the parts again
                </button>
              </li>
            </ul>
          )}
        </section>
      </div>

      <div className="main">
        <main className="score-column">
          {error && <p className="error">Couldn’t read that score: {error}</p>}
          {loading && !error && <p className="loading">Setting out the music…</p>}
          <div className="score-scroll">
            <div className="score-frame">
              <div ref={scoreRef} className="score" />
              {model && !loading && (
                <svg
                  className={activePartId ? 'overlay marking' : 'overlay'}
                  onPointerDown={onBarDown}
                  onPointerMove={onBarMove}
                  onPointerUp={onBarUp}
                  onPointerCancel={onBarUp}
                  width={model.size.w}
                  height={model.size.h}
                  viewBox={`0 0 ${model.size.w} ${model.size.h}`}
                >
                  {bars.map(
                    (bar, i) =>
                      bar.box && (
                        <rect
                          key={`hit-${i}`}
                          className="bar-hit"
                          x={bar.box.x}
                          y={bar.box.y}
                          width={bar.box.w}
                          height={bar.box.h}
                        />
                      ),
                  )}
                  {!wholePiece &&
                    bars.slice(range.from, range.to + 1).map(
                      (bar) =>
                        bar.box && (
                          <rect
                            key={`bar-${bar.number}-${bar.start}`}
                            className="bar-shade"
                            x={bar.box.x}
                            y={bar.box.y}
                            width={bar.box.w}
                            height={bar.box.h}
                          />
                        ),
                    )}
                  {model.notes.map((note) => {
                    const part = partById.get(owner.get(note.id) ?? '')
                    const cls = ['note', part && 'owned']
                    return (
                      <rect
                        key={note.id}
                        ref={(el) => {
                          if (el) rectsRef.current.set(note.id, el)
                          else rectsRef.current.delete(note.id)
                        }}
                        className={cls.filter(Boolean).join(' ')}
                        data-bar={note.measure}
                        style={part ? ({ '--part': part.colour } as CSSProperties) : undefined}
                        x={note.box.x - 3}
                        y={note.box.y - 3}
                        width={note.box.w + 6}
                        height={note.box.h + 6}
                        rx={4}
                        onClick={(event) => assign(note, event.shiftKey)}
                      >
                        <title>{part ? part.name : 'Unassigned'}</title>
                      </rect>
                    )
                  })}
                </svg>
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Floats over the score, centred at the bottom of the window. */}
      <div className="transport floating" role="group" aria-label="Playback">
        <button
          className="play"
          aria-label={playing ? 'Pause' : 'Play'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
          disabled={!model || loading}
          onClick={() => void togglePlay()}
        >
          {playing ? <PauseIcon /> : <PlayIcon />}
        </button>
        <button
          className="round loop"
          aria-label="Loop"
          aria-pressed={loop}
          title={loop ? 'Loop: on' : 'Loop: off'}
          onClick={() => setLoop((l) => !l)}
        >
          <LoopIcon />
        </button>
        <div className="tempo" role="group" aria-label="Tempo">
          <RepeatButton
            className="round"
            label="Slower"
            disabled={bpm <= TEMPO.min}
            onStep={() => changeTempo(-1)}
          >
            −
          </RepeatButton>
          <output className="bpm" aria-live="polite" title="Beats per minute">
            {bpm}
            <span className="bpm-unit">bpm</span>
          </output>
          <RepeatButton
            className="round"
            label="Faster"
            disabled={bpm >= TEMPO.max}
            onStep={() => changeTempo(1)}
          >
            +
          </RepeatButton>
        </div>
      </div>
    </div>
  )
}

/** A "?" that opens a short guide; Escape or a click elsewhere closes it. */
function Help() {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false)
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [open])

  return (
    <div className="help" ref={root}>
      <button
        className="help-button"
        aria-label="How to use Understudy"
        aria-expanded={open}
        aria-controls="help-panel"
        onClick={() => setOpen((o) => !o)}
      >
        ?
      </button>
      {open && (
        <section id="help-panel" className="help-panel" aria-label="How to use Understudy">
          <h2>How it works</h2>
          <ol>
            <li>
              <strong>Say who sings what.</strong> “Split parts for me” finds each line in the
              score and gives it its own part. “Define parts myself” starts you with one
              empty part; add more with “+ Add a part”.
            </li>
            <li>
              <strong>Fix any note.</strong> Pick a part in the list, then click a note to give
              it to that part, or click it again to take it back. Shift-click takes every note
              in that voice on its staff.
            </li>
            <li>
              <strong>Choose bars.</strong> Drag across bars on the score, or click one bar.
              Click that bar again to go back to the whole piece.
            </li>
            <li>
              <strong>Listen.</strong> Press play, or the Space bar, to play and pause. Turn
              each part on or off with its speaker and set its volume with the slider. Loop
              repeats the chosen bars.
            </li>
          </ol>
          <p>Open your own score as MusicXML (.musicxml, .xml or .mxl).</p>
        </section>
      )}
    </div>
  )
}

/** A part's on/off and volume, on its own line under the part's name. */
function MixControls({
  name,
  mix,
  onChange,
}: {
  name: string
  mix: Mix
  onChange: (patch: Partial<Mix>) => void
}) {
  return (
    // Its own clicks shouldn't also pick the part for marking.
    <div className="mix" onClick={(event) => event.stopPropagation()}>
      <button
        className="speaker"
        aria-label={`Play ${name}`}
        aria-pressed={mix.on}
        title={mix.on ? `Playing ${name}` : `${name}: off`}
        onClick={() => onChange({ on: !mix.on })}
      >
        <SpeakerIcon on={mix.on} />
      </button>
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={mix.volume}
        disabled={!mix.on}
        aria-label={`Volume of ${name}`}
        onChange={(event) => onChange({ volume: Number(event.target.value) })}
      />
    </div>
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Steps once on press, then keeps stepping while held. Keyboard presses step once. */
function RepeatButton({
  className,
  label,
  disabled,
  onStep,
  children,
}: {
  className: string
  label: string
  disabled: boolean
  onStep: () => void
  children: ReactNode
}) {
  const timer = useRef(0)
  const stepRef = useRef(onStep)
  stepRef.current = onStep
  const stop = () => window.clearTimeout(timer.current)
  useEffect(() => stop, [])
  useEffect(() => {
    if (disabled) stop()
  }, [disabled])

  const start = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return
    stepRef.current()
    const tick = (delay: number) => {
      timer.current = window.setTimeout(() => {
        stepRef.current()
        tick(90)
      }, delay)
    }
    tick(450)
  }

  return (
    <button
      className={className}
      aria-label={label}
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      // Pointer presses are handled above; this catches Enter and Space.
      onClick={(event) => {
        if (event.detail === 0) stepRef.current()
      }}
    >
      {children}
    </button>
  )
}

function SpeakerIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 5 6 9H3v6h3l5 4V5z" fill="currentColor" />
      {on ? (
        <>
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M18.5 5.5a9 9 0 0 1 0 13" />
        </>
      ) : (
        <path d="m16 9 6 6M22 9l-6 6" />
      )}
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
      <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" fill="currentColor" />
    </svg>
  )
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect x="6" y="5" width="4.5" height="14" rx="1.5" fill="currentColor" />
      <rect x="13.5" y="5" width="4.5" height="14" rx="1.5" fill="currentColor" />
    </svg>
  )
}

function LoopIcon() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 2l4 4-4 4" />
      <path d="M3 11V9a3 3 0 0 1 3-3h15" />
      <path d="M7 22l-4-4 4-4" />
      <path d="M21 13v2a3 3 0 0 1-3 3H3" />
    </svg>
  )
}

function UploadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 15V3" />
      <path d="M7 8l5-5 5 5" />
      <path d="M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  )
}

function readAsBinaryString(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsBinaryString(file)
  })
}
