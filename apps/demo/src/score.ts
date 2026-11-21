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

export type ScoreModel = {
  notes: ScoreNote[]
  bars: Bar[]
  /** Quarter notes in the whole excerpt. */
  length: number
  /** Pixel size of the rendered engraving. */
  size: { w: number; h: number }
}

export type Palette = {
  ink: string
  paper: string
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
    // No white anywhere: the engraving is drawn in dark brown on warm paper.
    defaultColorMusic: palette.ink,
    defaultColorNotehead: palette.ink,
    defaultColorStem: palette.ink,
    defaultColorRest: palette.ink,
    defaultColorLabel: palette.ink,
    defaultColorTitle: palette.ink,
    pageBackgroundColor: palette.paper,
  })
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
          for (const gNote of voiceEntry.notes ?? []) {
            const source = gNote.sourceNote
            if (!source || source.isRest()) continue

            // Continuations of a tie are already covered by the tie's first note.
            const tie = source.NoteTie
            if (tie && tie.StartNote !== source) continue

            const pitch = source.Pitch
            if (!pitch) continue

            const start = source.getAbsoluteTimestamp().RealValue * 4
            const duration = (tie ? tie.Duration.RealValue : source.Length.RealValue) * 4
            if (duration <= 0) continue

            const box = noteheadBox(gNote, origin) ?? fallbackBox(gNote, scale)

            const voice = source.ParentVoiceEntry?.ParentVoice?.VoiceId ?? 1
            const n = seq.get(voice) ?? 0
            seq.set(voice, n + 1)

            notes.push({
              id: `${staff}:${voice}:${measureNumber}:${n}`,
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

  return { notes, bars, length, size }
}

type Box = ScoreNote['box']

/**
 * OSMD leaves a note's own bounding box empty after a VexFlow render, so measure
 * the notehead VexFlow actually drew. Chords share a stem but each notehead is
 * separate, which is what lets one note of a chord be claimed on its own.
 */
function noteheadBox(gNote: GraphicalNote, origin: DOMRect | null): Box | null {
  if (!origin || !(gNote instanceof VexFlowGraphicalNote)) return null
  const heads = gNote.getNoteheadSVGs?.() ?? []
  const el = heads[0] ?? gNote.getSVGGElement?.()
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
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
