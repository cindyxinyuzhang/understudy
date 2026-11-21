import {
  OpenSheetMusicDisplay,
  VexFlowGraphicalNote,
  type GraphicalNote,
} from 'opensheetmusicdisplay'

/** OSMD lays out in abstract units; one unit is 10px at zoom 1. */
const UNIT_PX = 10

export type ScoreNote = {
  /** Stable across re-layout: position in the musical structure, not the drawing. */
  id: string
  /** Staff from the top of a system, 0-based. Several singers' lines can share one. */
  staff: number
  /** Voice number as written in the file; tells apart lines that share a staff. */
  voice: number
  /** 1-based, as printed. */
  measure: number
  /** Hz — handed straight to the synth. */
  freq: number
  /** Quarter notes from the start of the piece. */
  start: number
  /** Quarter notes. Tied groups are folded into their first note. */
  duration: number
  /** Pixel box of the notehead in the rendered SVG, for the selection overlay. */
  box: { x: number; y: number; w: number; h: number }
}

export type Bar = {
  /** As printed. */
  number: number
  /** Quarter notes from the start of the piece. */
  start: number
  end: number
  /** Pixel box spanning every staff of this bar, for shading a chosen range. */
  box: { x: number; y: number; w: number; h: number } | null
}

/** A drawn notehead: SVG at runtime, though OSMD types it as an HTML element. */
export type HeadElement = HTMLElement | SVGElement

export type ScoreModel = {
  notes: ScoreNote[]
  bars: Bar[]
  /** Quarter notes in the whole excerpt. */
  length: number
  /** Pixel size of the rendered engraving. */
  size: { w: number; h: number }
  /**
   * The noteheads OSMD drew for each note id, tie continuations included, so a note
   * can be coloured on the engraving itself. Replaced on every render.
   */
  heads: Map<string, HeadElement[]>
  /** Every drawn note group, for colouring its stem, flag, dots and accidentals. */
  glyphs: Glyph[]
}

/**
 * One note as VexFlow drew it: a stem shared by one or more heads, plus its dots
 * and accidentals. Ids are the model notes behind each head, null for a rest.
 */
export type Glyph = {
  group: HeadElement
  noteIds: (string | null)[]
  /** Each dot or accidental, with the note of the head it sits beside. */
  marks: { el: HeadElement; noteId: string | null }[]
}

export type Palette = {
  /** Notes, clefs, lyrics. */
  ink: string
  /** The page the score sits on. */
  ground: string
  staffLine: string
}

export function createOsmd(container: HTMLElement, palette: Palette): OpenSheetMusicDisplay {
  const osmd = new OpenSheetMusicDisplay(container, {
    backend: 'svg',
    autoResize: false, // we re-render deliberately, so geometry and audio stay in step
    drawTitle: false, // the page furnishes its own heading
    drawSubtitle: false,
    drawComposer: false,
    drawLyricist: false,
    drawCredits: false,
    // Part names describe the file's layout, not who sings what; the user decides that.
    drawPartNames: false,
    drawPartAbbreviations: false,
    drawMeasureNumbers: true,
    drawLyrics: true,
    // No white anywhere: the engraving sits straight on the page's ground colour.
    defaultColorMusic: palette.ink,
    defaultColorNotehead: palette.ink,
    defaultColorStem: palette.ink,
    defaultColorRest: palette.ink,
    defaultColorLabel: palette.ink,
    defaultColorTitle: palette.ink,
    pageBackgroundColor: palette.ground,
  })
  osmd.EngravingRules.StaffLineColor = palette.staffLine
  osmd.EngravingRules.LedgerLineColorDefault = palette.ink
  // A little under full size fits a four-bar phrase on each line at desktop widths,
  // which is how singers read a hymn tune; the overlay scales with it.
  osmd.zoom = 0.8
  return osmd
}

/**
 * Walk OSMD's graphical tree once after a render and pull out everything the rest
 * of the app needs: what sounds when, and where it sits on the page.
 *
 * Two things are worth knowing about the walk:
 *   - MeasureList is indexed [measure][staff], across every instrument. A staff
 *     can hold several voices (SA on one, TB on another), so a note is located by
 *     staff and voice, never assumed to belong to anyone.
 *   - A tied group is one sound. We keep the first note of the tie, give it the
 *     whole tied duration, and drop the continuations so they are neither played
 *     nor selectable as separate events.
 */
export function extractModel(osmd: OpenSheetMusicDisplay, container: HTMLElement): ScoreModel {
  const graphic = osmd.GraphicSheet
  const scale = UNIT_PX * osmd.zoom
  const notes: ScoreNote[] = []
  const heads = new Map<string, HeadElement[]>()
  /** Tie start notes by their source note, so continuations can find their id. */
  const tieIds = new Map<unknown, string>()

  let length = 0

  const origin = container.querySelector('svg')?.getBoundingClientRect() ?? null

  for (const staves of graphic.MeasureList) {
    if (!staves) continue
    staves.forEach((measure, staff) => {
      if (!measure) return
      const measureNumber = measure.MeasureNumber
      const seq = new Map<number, number>()

      for (const staffEntry of measure.staffEntries ?? []) {
        for (const voiceEntry of staffEntry.graphicalVoiceEntries ?? []) {
          // A chord in one voice is one VexFlow note with several heads; rank each
          // pitch from the top so it can be matched to its own head, not the chord's.
          const byPitch = (voiceEntry.notes ?? [])
            .filter((g) => g.sourceNote?.Pitch && !g.sourceNote.isRest())
            .sort((a, b) => b.sourceNote.Pitch.Frequency - a.sourceNote.Pitch.Frequency)
          for (const gNote of voiceEntry.notes ?? []) {
            const source = gNote.sourceNote
            if (!source || source.isRest()) continue

            const head = noteheadOf(gNote, byPitch.indexOf(gNote))

            // Continuations of a tie are already covered by the tie's first note;
            // only their heads are kept, so the tied note colours as one.
            const tie = source.NoteTie
            if (tie && tie.StartNote !== source) {
              const startId = tieIds.get(tie.StartNote)
              if (startId && head) heads.get(startId)?.push(head)
              continue
            }

            const pitch = source.Pitch
            if (!pitch) continue

            const start = source.getAbsoluteTimestamp().RealValue * 4
            const duration = (tie ? tie.Duration.RealValue : source.Length.RealValue) * 4
            if (duration <= 0) continue

            // With no head to measure, the whole drawn note is the next best box.
            const drawn = head ?? (gNote instanceof VexFlowGraphicalNote ? gNote.getSVGGElement?.() : null)
            const box = (drawn && boxOf(drawn, origin)) ?? fallbackBox(gNote, scale)

            const voice = source.ParentVoiceEntry?.ParentVoice?.VoiceId ?? 1
            const n = seq.get(voice) ?? 0
            seq.set(voice, n + 1)

            const id = `${staff}:${voice}:${measureNumber}:${n}`
            heads.set(id, head ? [head] : [])
            if (tie) tieIds.set(source, id)

            notes.push({
              id,
              staff,
              voice,
              measure: measureNumber,
              freq: pitch.Frequency,
              start,
              duration,
              box,
            })
            length = Math.max(length, start + duration)
          }
        }
      }
    })
  }

  notes.sort((a, b) => a.start - b.start || a.staff - b.staff || a.voice - b.voice)

  const svg = container.querySelector('svg')
  const size = {
    w: svg ? Number(svg.getAttribute('width')) || svg.clientWidth : 0,
    h: svg ? Number(svg.getAttribute('height')) || svg.clientHeight : 0,
  }

  const bars: Bar[] = osmd.Sheet.SourceMeasures.map((source, i) => {
    const start = source.AbsoluteTimestamp.RealValue * 4
    return {
      number: source.MeasureNumber,
      start,
      end: start + source.Duration.RealValue * 4,
      box: barBox(graphic.MeasureList[i] ?? [], scale),
    }
  })

  evenRows(bars)

  return { notes, bars, length, size, heads, glyphs: findGlyphs(container, heads) }
}

type Box = ScoreNote['box']

/**
 * The notehead VexFlow drew for this note. Chords share a stem but each head is a
 * separate element; heads are ranked from the top to match the note's pitch rank.
 */
function noteheadOf(gNote: GraphicalNote, rank: number): HeadElement | null {
  if (!(gNote instanceof VexFlowGraphicalNote)) return null
  const heads = (gNote.getNoteheadSVGs?.() ?? [])
    .map((el) => ({ el, top: el.getBoundingClientRect().top }))
    .sort((a, b) => a.top - b.top)
  return heads[rank]?.el ?? heads[0]?.el ?? null
}

/**
 * OSMD leaves a note's own bounding box empty after a VexFlow render, so measure
 * the notehead VexFlow actually drew.
 */
function boxOf(head: Element, origin: DOMRect | null): Box | null {
  if (!origin) return null
  const r = head.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
}

function findGlyphs(container: HTMLElement, heads: Map<string, HeadElement[]>): Glyph[] {
  const noteOf = new Map<Element, string>()
  for (const [id, els] of heads) for (const el of els) noteOf.set(el, id)
  const middle = (el: Element) => {
    const r = el.getBoundingClientRect()
    return r.top + r.height / 2
  }

  return [...container.querySelectorAll<SVGGElement>('.vf-stavenote')].map((group) => {
    const own = [...group.querySelectorAll('.vf-notehead')].map((el) => ({
      id: noteOf.get(el) ?? null,
      y: middle(el),
    }))
    // A dot or accidental belongs to the head at its height.
    const marks = [...group.querySelectorAll<SVGPathElement>('.vf-modifiers path')].map((el) => {
      const y = middle(el)
      let best: (typeof own)[number] | undefined
      for (const head of own) if (!best || Math.abs(head.y - y) < Math.abs(best.y - y)) best = head
      return { el, noteId: best?.id ?? null }
    })
    return { group, noteIds: own.map((h) => h.id), marks }
  })
}

/** About a notehead's size, centred on OSMD's anchor for the note. */
function fallbackBox(gNote: GraphicalNote, scale: number): Box {
  const at = gNote.PositionAndShape.AbsolutePosition
  return { x: at.x * scale - 6, y: at.y * scale - 5, w: 12, h: 10 }
}

/** Union of one bar's staff boxes; a bar never breaks across systems, so it is one rectangle. */
function barBox(staves: ({ PositionAndShape: BoundingBoxLike } | undefined)[], scale: number): Box | null {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const staff of staves) {
    if (!staff) continue
    const bb = staff.PositionAndShape
    const at = bb.AbsolutePosition
    x0 = Math.min(x0, at.x + bb.BorderLeft)
    x1 = Math.max(x1, at.x + bb.BorderRight)
    y0 = Math.min(y0, at.y + bb.BorderTop)
    y1 = Math.max(y1, at.y + bb.BorderBottom)
  }
  if (!Number.isFinite(x0) || x1 <= x0 || y1 <= y0) return null
  return { x: x0 * scale, y: y0 * scale, w: (x1 - x0) * scale, h: (y1 - y0) * scale }
}

type BoundingBoxLike = {
  AbsolutePosition: { x: number; y: number }
  BorderLeft: number
  BorderRight: number
  BorderTop: number
  BorderBottom: number
}

/**
 * Each bar's box stops at its own lowest stem, which leaves a ragged edge when a
 * range is shaded. Bars whose boxes overlap vertically sit on the same row, so
 * give them all that row's full height.
 */
function evenRows(bars: Bar[]): void {
  const rows: Box[][] = []
  for (const bar of bars) {
    const box = bar.box
    if (!box) continue
    const row = rows.find((r) => r.some((b) => box.y < b.y + b.h && b.y < box.y + box.h))
    if (row) row.push(box)
    else rows.push([box])
  }
  for (const row of rows) {
    const top = Math.min(...row.map((b) => b.y))
    const bottom = Math.max(...row.map((b) => b.y + b.h))
    for (const b of row) {
      b.y = top
      b.h = bottom - top
    }
  }
}
