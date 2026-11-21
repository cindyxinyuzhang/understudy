import type { OpenSheetMusicDisplay } from 'opensheetmusicdisplay'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'

import { Player, type PlayMode } from './audio'
import sampleUrl from './assets/sample.musicxml?url'
import { findParts } from './parts'
import { createOsmd, extractModel, type Palette, type ScoreModel, type ScoreNote } from './score'

// Imported rather than served from public/ so the built file name carries a content
// hash: a regenerated sample can never be shadowed by a cached copy of the old one.
const SAMPLE_URL = sampleUrl

// Kept in step with --ink and --paper in styles.css; OSMD needs literal colours.
const PALETTE: Palette = { ink: '#2b1a10', paper: '#fbf5ea' }

const PART_COLOURS = ['#8c2f39', '#3d6b73', '#4f6b3a', '#b8862b', '#6b3f69', '#b5562f']

const MODES: { mode: PlayMode; label: string }[] = [
  { mode: 'mine', label: 'Just my part' },
  { mode: 'others', label: 'Everyone else' },
  { mode: 'all', label: 'Everyone' },
]

/** A singer's part as the user has marked it out. The score file knows nothing about these. */
type Part = { id: string; name: string; colour: string }

let nextPartId = 1
const newPart = (name: string, index: number): Part => ({
  id: `part-${nextPartId++}`,
  name,
  colour: PART_COLOURS[index % PART_COLOURS.length]!,
})

export function App() {
  const scoreRef = useRef<HTMLDivElement>(null)
  const osmdRef = useRef<OpenSheetMusicDisplay | null>(null)
  const layoutRef = useRef<() => ScoreModel | null>(() => null)
  const rectsRef = useRef(new Map<string, SVGRectElement>())

  const [model, setModel] = useState<ScoreModel | null>(null)
  const [title, setTitle] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [parts, setParts] = useState<Part[]>([])
  const [owner, setOwner] = useState<ReadonlyMap<string, string>>(new Map())
  const [activePartId, setActivePartId] = useState<string | null>(null)
  const [myPartId, setMyPartId] = useState<string | null>(null)

  const [mode, setMode] = useState<PlayMode>('all')
  const [playing, setPlaying] = useState(false)
  const [bpm, setBpm] = useState(100)
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
    const osmd = createOsmd(container, PALETTE)
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
        setParts([])
        setOwner(new Map())
        setActivePartId(null)
        setMyPartId(null)
        setMode('all')
        const laidOut = layoutRef.current()
        setRange({ from: 0, to: Math.max(0, (laidOut?.bars.length ?? 1) - 1) })
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

  useEffect(() => {
    if (!model) return
    player.stop()
    player.setScore(model.notes)
  }, [model, player])

  const mine = useMemo(() => {
    const ids = new Set<string>()
    if (myPartId) for (const [noteId, partId] of owner) if (partId === myPartId) ids.add(noteId)
    return ids
  }, [owner, myPartId])

  // Hearing "just me" with nothing marked as mine would be silence; fall back.
  const effectiveMode: PlayMode = mine.size === 0 ? 'all' : mode

  useEffect(() => player.setMine(mine), [mine, player])
  useEffect(() => player.setMode(effectiveMode), [effectiveMode, player])

  const bars = model?.bars ?? []
  const fromBar = bars[range.from]
  const toBar = bars[range.to]
  const wholePiece = range.from === 0 && range.to === bars.length - 1
  useEffect(() => {
    if (fromBar && toBar) player.setSpan({ start: fromBar.start, end: toBar.end })
  }, [fromBar, toBar, player])
  useEffect(() => player.setLoop(loop), [loop, player])
  useEffect(() => {
    currentBpm.current = bpm
    player.setTempo(bpm)
  }, [bpm, player])
  useEffect(() => () => player.dispose(), [player])

  const partById = useMemo(() => new Map(parts.map((l) => [l.id, l])), [parts])
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const partId of owner.values()) c.set(partId, (c.get(partId) ?? 0) + 1)
    return c
  }, [owner])

  const addParts = (names: string[]) => {
    const added = names.map((name, i) => newPart(name, parts.length + i))
    setParts((prev) => [...prev, ...added])
    setActivePartId(added[0]!.id)
    if (!myPartId) setMyPartId(added[0]!.id)
  }

  /** Replace whatever parts exist with one per melodic line found in the score. */
  const detectParts = () => {
    if (!model) return
    const found = findParts(model.notes)
    if (found.length === 0) return
    const made = found.map((f, i) => newPart(f.name, i))
    const next = new Map<string, string>()
    found.forEach((f, i) => f.noteIds.forEach((id) => next.set(id, made[i]!.id)))
    setParts(made)
    setOwner(next)
    setActivePartId(made[0]!.id)
    setMyPartId(made[0]!.id)
  }

  const removePart = (id: string) => {
    setParts((prev) => prev.filter((l) => l.id !== id))
    setOwner((prev) => new Map([...prev].filter(([, partId]) => partId !== id)))
    if (activePartId === id) setActivePartId(null)
    if (myPartId === id) setMyPartId(null)
  }

  const renamePart = (id: string, name: string) =>
    setParts((prev) => prev.map((l) => (l.id === id ? { ...l, name } : l)))

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
      player.stop()
      return
    }
    setPlaying(true)
    await player.play(bpm)
  }

  const openFile = async (file: File) => {
    const isZip = /\.mxl$/i.test(file.name)
    const content = isZip ? await readAsBinaryString(file) : await file.text()
    await loadScore(content, file.name.replace(/\.[^.]+$/, ''))
  }

  const activePart = activePartId ? partById.get(activePartId) : undefined

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

  return (
    <div className="hall">
      <header className="masthead">
        <p className="eyebrow">Understudy</p>
        <h1>Learn your part</h1>
        <p className="lede">
          Bring a score, mark out who sings what, then hear your part alone, against the
          others, or with them.
        </p>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="panel">
            <h2>Score</h2>
            <p className="score-title">{title || '—'}</p>
            <label className="file-button">
              Open MusicXML…
              <input
                type="file"
                accept=".musicxml,.xml,.mxl"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  event.target.value = ''
                  if (file) void openFile(file)
                }}
              />
            </label>
            <button className="link" onClick={() => void loadScore(SAMPLE_URL, 'Sample score')}>
              Back to the sample
            </button>
          </section>

          <section className="panel">
            <h2>Parts</h2>
            {parts.length === 0 ? (
              <div className="empty">
                <p>
                  Let Understudy find the separate melodic lines, or name the parts yourself
                  and mark out which notes belong to each.
                </p>
                <button className="primary" disabled={!model || loading} onClick={detectParts}>
                  Find the parts for me
                </button>
                <div className="row">
                  <button onClick={() => addParts(['Soprano', 'Alto', 'Tenor', 'Bass'])}>
                    Soprano, Alto, Tenor, Bass
                  </button>
                  <button onClick={() => addParts(['Part 1'])}>One part</button>
                </div>
              </div>
            ) : (
              <>
                <ul className="parts">
                  {parts.map((part) => (
                    <li
                      key={part.id}
                      className={part.id === activePartId ? 'part active' : 'part'}
                      style={{ '--part': part.colour } as CSSProperties}
                      onClick={() => setActivePartId(part.id)}
                    >
                      <span className="swatch" />
                      <input
                        className="part-name"
                        value={part.name}
                        aria-label="Part name"
                        onChange={(event) => renamePart(part.id, event.target.value)}
                      />
                      <span className="count">{counts.get(part.id) ?? 0}</span>
                      <button
                        className={part.id === myPartId ? 'mine-toggle on' : 'mine-toggle'}
                        title="This is the part I'm learning"
                        onClick={(event) => {
                          event.stopPropagation()
                          setMyPartId(part.id)
                        }}
                      >
                        {part.id === myPartId ? 'Mine' : 'Me?'}
                      </button>
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
                </ul>
                <div className="row">
                  <button className="link" onClick={() => addParts([`Part ${parts.length + 1}`])}>
                    + Add a part
                  </button>
                  <button className="link" onClick={detectParts}>
                    Find the parts again
                  </button>
                </div>
                <p className="hint">
                  {activePart ? (
                    <>
                      Marking <strong>{activePart.name || 'this part'}</strong>. Click a note to
                      add or remove it; shift-click to take its whole voice on that staff.
                    </>
                  ) : (
                    'Pick a part above to start marking notes.'
                  )}
                </p>
              </>
            )}
          </section>

          <section className="panel transport">
            <button
              className="play"
              disabled={!model || loading}
              onClick={() => void togglePlay()}
            >
              {playing ? '■ Stop' : '▶ Play'}
            </button>
            <div className="control-group">
              <span className="label">Hear</span>
              <div className="segmented">
                {MODES.map(({ mode: m, label }) => (
                  <button
                    key={m}
                    className={effectiveMode === m ? 'on' : ''}
                    disabled={m !== 'all' && mine.size === 0}
                    onClick={() => setMode(m)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {mine.size === 0 && (
                <span className="small">Mark a part as yours to hear it alone.</span>
              )}
            </div>
            <div className="control-group">
              <span className="label">Bars</span>
              <div className="bar-range">
                <select
                  aria-label="From bar"
                  value={range.from}
                  disabled={bars.length === 0}
                  onChange={(event) => {
                    const from = Number(event.target.value)
                    setRange((r) => ({ from, to: Math.max(from, r.to) }))
                  }}
                >
                  {bars.map((bar, i) => (
                    <option key={i} value={i}>
                      {bar.number}
                    </option>
                  ))}
                </select>
                <span>to</span>
                <select
                  aria-label="To bar"
                  value={range.to}
                  disabled={bars.length === 0}
                  onChange={(event) => {
                    const to = Number(event.target.value)
                    setRange((r) => ({ from: Math.min(r.from, to), to }))
                  }}
                >
                  {bars.map((bar, i) => (
                    <option key={i} value={i}>
                      {bar.number}
                    </option>
                  ))}
                </select>
                {!wholePiece && (
                  <button
                    className="link"
                    onClick={() => setRange({ from: 0, to: bars.length - 1 })}
                  >
                    Whole piece
                  </button>
                )}
              </div>
              <span className="small">Or drag across bars on the score.</span>
            </div>
            <div className="control-group">
              <span className="label">At the end</span>
              <div className="segmented">
                <button className={loop ? '' : 'on'} onClick={() => setLoop(false)}>
                  Stop
                </button>
                <button className={loop ? 'on' : ''} onClick={() => setLoop(true)}>
                  Loop
                </button>
              </div>
            </div>
            <label className="control-group">
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
        </aside>

        <main className="paper">
          {error && <p className="error">Couldn’t read that score: {error}</p>}
          {loading && !error && <p className="loading">Setting out the music…</p>}
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
                  const cls = ['note', part && 'owned', part && part.id === myPartId && 'mine']
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
        </main>
      </div>

      <footer className="colophon">
        Engraved with OpenSheetMusicDisplay · played with Tone.js
      </footer>
    </div>
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
