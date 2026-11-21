// Generates src/assets/sample.musicxml — a 16-bar SATB setting of the "Ode to Joy"
// theme (Beethoven, Symphony No. 9 finale; public domain) in D major.
//
// The arrangement is kept deliberately homophonic: the lower voices mostly move
// with the melody, which is what makes it legible as a part-learning demo. Two
// details are there on purpose, to exercise the playback path rather than for
// musical reasons:
//
//   - the bass ties across the m3/m4 barline  -> tied notes must sound as one
//   - tenor and bass rest on the downbeat of m9 -> rests must not shift timing
//
// Printed in closed score, SA on the treble staff and TB on the bass staff, so
// the demo has to let people pick their own line out rather than being handed it.
//
// Run: npm run score

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../src/assets/sample.musicxml')

// quarter = 4 divisions, so an eighth is 2 and a dotted quarter is 6.
const DIVISIONS = 4
const q = { d: 4, type: 'quarter' }
const e = { d: 2, type: 'eighth' }
const h = { d: 8, type: 'half' }
const qd = { d: 6, type: 'quarter', dots: 1 }

/** `F#4` -> { step: 'F', alter: 1, octave: 4 } */
function parsePitch(token) {
  const m = /^([A-G])(#|b)?(\d)$/.exec(token)
  if (!m) throw new Error(`bad pitch: ${token}`)
  return {
    step: m[1],
    alter: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0,
    octave: Number(m[3]),
  }
}

/**
 * Compact note spelling: "F#4:q" or "r:q" for a rest. A trailing "~" starts a
 * tie, a leading "~" ends one.
 */
function note(spec, lyric) {
  let s = spec
  let tieStop = false
  let tieStart = false
  if (s.startsWith('~')) {
    tieStop = true
    s = s.slice(1)
  }
  if (s.endsWith('~')) {
    tieStart = true
    s = s.slice(0, -1)
  }
  const [pitch, rhythm] = s.split(':')
  const r = { q, e, h, qd }[rhythm]
  if (!r) throw new Error(`bad rhythm: ${rhythm}`)
  return { pitch, ...r, tieStart, tieStop, lyric }
}

// ---------------------------------------------------------------------------
// The music. Each voice is 16 measures; each measure is a list of notes.
// Phrase structure is A A B A, so measures repeat.
// ---------------------------------------------------------------------------

const S = {
  A1: ['F#4:q', 'F#4:q', 'G4:q', 'A4:q'],
  A2: ['A4:q', 'G4:q', 'F#4:q', 'E4:q'],
  A3: ['D4:q', 'D4:q', 'E4:q', 'F#4:q'],
  half: ['F#4:qd', 'E4:e', 'E4:h'], // half cadence (m4)
  full: ['E4:qd', 'D4:e', 'D4:h'], // authentic cadence (m8, m16)
  B1: ['E4:q', 'E4:q', 'F#4:q', 'D4:q'],
  B2: ['E4:q', 'F#4:e', 'G4:e', 'F#4:q', 'D4:q'],
  B3: ['E4:q', 'F#4:e', 'G4:e', 'F#4:q', 'E4:q'],
  B4: ['D4:q', 'E4:q', 'A3:h'],
}

const A = {
  A1: ['D4:q', 'D4:q', 'D4:q', 'F#4:q'],
  A2: ['F#4:q', 'D4:q', 'D4:q', 'C#4:q'],
  A3: ['A3:q', 'B3:q', 'C#4:q', 'D4:q'],
  half: ['D4:qd', 'C#4:e', 'C#4:h'],
  full: ['C#4:qd', 'A3:e', 'A3:h'],
  B1: ['C#4:q', 'C#4:q', 'D4:q', 'A3:q'],
  B2: ['C#4:q', 'D4:q', 'D4:q', 'B3:q'],
  B3: ['C#4:q', 'D4:q', 'D4:q', 'C#4:q'],
  B4: ['A3:q', 'C#4:q', 'A3:h'],
}

const T = {
  A1: ['A3:q', 'A3:q', 'B3:q', 'A3:q'],
  A2: ['A3:q', 'B3:q', 'A3:q', 'A3:q'],
  A3: ['F#3:q', 'F#3:q', 'A3:q', 'A3:q'],
  half: ['A3:qd', 'A3:e', 'A3:h'],
  full: ['A3:qd', 'F#3:e', 'F#3:h'],
  B1: ['r:q', 'A3:q', 'A3:q', 'F#3:q'], // rests in on the phrase change
  B2: ['A3:q', 'A3:q', 'A3:q', 'F#3:q'],
  B3: ['A3:q', 'A3:q', 'A3:q', 'A3:q'],
  B4: ['F#3:q', 'A3:q', 'E3:h'],
}

const B = {
  A1: ['D3:q', 'D3:q', 'G2:q', 'D3:q'],
  A2: ['D3:q', 'G2:q', 'D3:q', 'A2:q'],
  A3: ['D3:q', 'B2:q', 'A2:q', 'D3:q'],
  A3tied: ['D3:q', 'B2:q', 'A2:q', 'D3:q~'], // ties into the next measure
  halfTied: ['~D3:qd', 'A2:e', 'A2:h'],
  full: ['A2:qd', 'D3:e', 'D3:h'],
  B1: ['r:q', 'A2:q', 'D3:q', 'D3:q'],
  B2: ['A2:q', 'D3:q', 'D3:q', 'B2:q'],
  B3: ['A2:q', 'D3:q', 'D3:q', 'A2:q'],
  B4: ['D3:q', 'A2:q', 'A2:h'],
}

const soprano = [
  S.A1, S.A2, S.A3, S.half,
  S.A1, S.A2, S.A3, S.full,
  S.B1, S.B2, S.B3, S.B4,
  S.A1, S.A2, S.A3, S.full,
]
const alto = [
  A.A1, A.A2, A.A3, A.half,
  A.A1, A.A2, A.A3, A.full,
  A.B1, A.B2, A.B3, A.B4,
  A.A1, A.A2, A.A3, A.full,
]
const tenor = [
  T.A1, T.A2, T.A3, T.half,
  T.A1, T.A2, T.A3, T.full,
  T.B1, T.B2, T.B3, T.B4,
  T.A1, T.A2, T.A3, T.full,
]
const bass = [
  B.A1, B.A2, B.A3tied, B.halfTied,
  B.A1, B.A2, B.A3, B.full,
  B.B1, B.B2, B.B3, B.B4,
  B.A1, B.A2, B.A3, B.full,
]

// Schiller's text, one syllable per soprano note. The eighth-note pairs in
// m10 and m11 are melismas, so the second eighth takes no syllable.
const LYRICS = [
  ['Freu', 'de,', 'schö', 'ner'],
  ['Göt', 'ter', 'fun', 'ken,'],
  ['Toch', 'ter', 'aus', 'E'],
  ['ly', 'si', 'um,'],
  ['Wir', 'be', 'tre', 'ten'],
  ['feu', 'er', 'trun', 'ken,'],
  ['Himm', 'li', 'sche,', 'dein'],
  ['Hei', 'lig', 'tum!'],
  ['Dei', 'ne', 'Zau', 'ber'],
  ['bin', 'den', null, 'wie', 'der,'],
  ['was', 'die', null, 'Mo', 'de'],
  ['streng', 'ge', 'teilt;'],
  ['Al', 'le', 'Men', 'schen'],
  ['wer', 'den', 'Brü', 'der,'],
  ['wo', 'dein', 'sanf', 'ter'],
  ['Flü', 'gel', 'weilt.'],
]

/** A syllable ending in punctuation closes a word; otherwise it continues. */
function syllabicOf(text, prev, next) {
  const endsWord = /[.,;!?]$/.test(text) || next === undefined || next === null
    ? true
    : /^[A-ZÄÖÜ]/.test(next) || /[.,;!?]$/.test(text)
  const startsWord = prev === undefined || prev === null || /[.,;!?]$/.test(prev)
  if (startsWord && endsWord) return 'single'
  if (startsWord) return 'begin'
  if (endsWord) return 'end'
  return 'middle'
}

/** Where a voice sits in closed score: soprano and alto share the treble staff, tenor and bass the bass staff. */
const VOICES = [
  { name: 'S', measures: soprano, voice: 1, staff: 1, stem: 'up', lyrics: LYRICS },
  { name: 'A', measures: alto, voice: 2, staff: 1, stem: 'down', lyrics: null },
  { name: 'T', measures: tenor, voice: 3, staff: 2, stem: 'up', lyrics: null },
  { name: 'B', measures: bass, voice: 4, staff: 2, stem: 'down', lyrics: null },
]

function renderNote(n, { voice, staff, stem }, withLyric) {
  const lines = ['      <note>']
  if (n.pitch === 'r') {
    lines.push('        <rest/>')
  } else {
    const p = parsePitch(n.pitch)
    lines.push('        <pitch>')
    lines.push(`          <step>${p.step}</step>`)
    if (p.alter !== 0) lines.push(`          <alter>${p.alter}</alter>`)
    lines.push(`          <octave>${p.octave}</octave>`)
    lines.push('        </pitch>')
  }
  lines.push(`        <duration>${n.d}</duration>`)
  if (n.tieStop) lines.push('        <tie type="stop"/>')
  if (n.tieStart) lines.push('        <tie type="start"/>')
  lines.push(`        <voice>${voice}</voice>`)
  lines.push(`        <type>${n.type}</type>`)
  if (n.dots) lines.push('        <dot/>')
  if (n.pitch !== 'r') lines.push(`        <stem>${stem}</stem>`)
  lines.push(`        <staff>${staff}</staff>`)
  if (n.tieStop || n.tieStart) {
    lines.push('        <notations>')
    if (n.tieStop) lines.push('          <tied type="stop"/>')
    if (n.tieStart) lines.push('          <tied type="start"/>')
    lines.push('        </notations>')
  }
  if (withLyric) {
    lines.push('        <lyric number="1">')
    lines.push(`          <syllabic>${withLyric.syllabic}</syllabic>`)
    lines.push(`          <text>${withLyric.text}</text>`)
    lines.push('        </lyric>')
  }
  lines.push('      </note>')
  return lines.join('\n')
}

/**
 * One part on a grand staff, the way a hymnal prints it. Nothing in the file says
 * which line is whose beyond the voice numbers; working that out is the reader's job.
 */
function renderChoir() {
  const out = ['  <part id="P1">']
  for (let i = 0; i < 16; i++) {
    out.push(`    <measure number="${i + 1}">`)
    if (i === 0) {
      out.push('      <attributes>')
      out.push(`        <divisions>${DIVISIONS}</divisions>`)
      out.push('        <key><fifths>2</fifths><mode>major</mode></key>')
      out.push('        <time><beats>4</beats><beat-type>4</beat-type></time>')
      out.push('        <staves>2</staves>')
      out.push('        <clef number="1"><sign>G</sign><line>2</line></clef>')
      out.push('        <clef number="2"><sign>F</sign><line>4</line></clef>')
      out.push('      </attributes>')
      out.push('      <sound tempo="100"/>')
    }
    VOICES.forEach((v, k) => {
      if (k > 0) out.push(`      <backup><duration>${DIVISIONS * 4}</duration></backup>`)
      const words = v.lyrics ? v.lyrics[i] : null
      v.measures[i].forEach((spec, j) => {
        let lyric = null
        if (words && words[j]) {
          lyric = { text: words[j], syllabic: syllabicOf(words[j], words[j - 1], words[j + 1]) }
        }
        out.push(renderNote(note(spec), v, lyric))
      })
    })
    if (i === 15) {
      out.push('      <barline location="right"><bar-style>light-heavy</bar-style></barline>')
    }
    out.push('    </measure>')
  }
  out.push('  </part>')
  return out.join('\n')
}

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">
  <work>
    <work-title>Ode to Joy</work-title>
  </work>
  <identification>
    <creator type="composer">Ludwig van Beethoven</creator>
    <creator type="lyricist">Friedrich Schiller</creator>
    <rights>Public domain</rights>
    <encoding>
      <software>understudy/scripts/make-score.mjs</software>
      <encoding-description>16-bar SATB excerpt in closed score, Symphony No. 9 finale</encoding-description>
    </encoding>
  </identification>
  <part-list>
    <score-part id="P1"><part-name>Choir</part-name></score-part>
  </part-list>
${renderChoir()}
</score-partwise>
`

// Sanity-check every measure before writing: 4/4 at 4 divisions is 16 per bar.
for (const [name, part] of [['S', soprano], ['A', alto], ['T', tenor], ['B', bass]]) {
  part.forEach((specs, i) => {
    const total = specs.reduce((sum, s) => sum + note(s).d, 0)
    if (total !== DIVISIONS * 4) {
      throw new Error(`${name} m${i + 1}: ${total} divisions, expected ${DIVISIONS * 4}`)
    }
  })
  if (part.length !== 16) throw new Error(`${name}: ${part.length} measures, expected 16`)
}

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, xml)
console.log(`wrote ${OUT}`)
console.log(`  SATB in closed score (2 staves) x 16 bars, D major, 4/4`)
console.log(`  notes: ${[soprano, alto, tenor, bass].flat(2).length}`)
