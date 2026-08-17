/**
 * Note — a markdown text block. The base renderer is dependency-free but
 * renders the SUBSET a report note actually uses — headings, **bold**,
 * *italic* / _italic_, `code` — instead of showing raw marker characters
 * (a teacher's note wearing literal underscores read as a bug, because it
 * is one). A host can register a richer `note` custom widget (e.g.
 * react-markdown) to override.
 */
import type { ReactNode } from 'react'
import type { NoteSpec } from '../types'
import { tokens } from '../tokens'

/** Inline emphasis: bold → italic → code, non-nested — enough for notes. */
function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  // One pass over bold / italic / code tokens; earliest match wins.
  const token = /(\*\*([^*]+)\*\*)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(`([^`\n]+)`)/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = token.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    const key = `${keyBase}-${i++}`
    if (m[2] !== undefined) out.push(<strong key={key}>{m[2]}</strong>)
    else if (m[4] !== undefined) out.push(<em key={key}>{m[4]}</em>)
    else if (m[6] !== undefined) out.push(<em key={key}>{m[6]}</em>)
    else if (m[8] !== undefined)
      out.push(
        <code key={key} style={{ fontSize: '0.9em', background: tokens.muted, padding: '1px 4px', borderRadius: 4 }}>
          {m[8]}
        </code>,
      )
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

/** Split into blocks a note actually uses: each heading LINE is its own block,
 *  and runs of other lines are paragraphs. Splitting on blank lines alone was
 *  not enough — `### Section\nOne line about it` is one block whose whole text
 *  does not match the heading pattern, so it rendered with its hashes showing,
 *  which is the exact bug the plain-text renderer exists to avoid. */
function blocksOf(markdown: string): { heading?: number; text: string }[] {
  const out: { heading?: number; text: string }[] = []
  for (const para of markdown.split(/\n{2,}/)) {
    let buffer: string[] = []
    const flush = () => {
      if (buffer.join('\n').trim()) out.push({ text: buffer.join('\n') })
      buffer = []
    }
    for (const line of para.split('\n')) {
      const h = /^(#{1,3})\s+(.*)$/.exec(line.trim())
      if (h) {
        flush()
        out.push({ heading: h[1].length, text: h[2] })
      } else {
        buffer.push(line)
      }
    }
    flush()
  }
  return out
}

export function Note({ spec }: { spec: NoteSpec }) {
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6, color: tokens.text }}>
      {blocksOf(spec.markdown).map((block, bi) =>
        block.heading ? (
          <div
            key={bi}
            style={{
              fontWeight: 700,
              fontSize: block.heading === 1 ? 18 : block.heading === 2 ? 16 : 14,
              margin: bi === 0 ? '0 0 6px' : '10px 0 6px',
            }}
          >
            {renderInline(block.text, `h${bi}`)}
          </div>
        ) : (
          <p
            key={bi}
            style={{
              whiteSpace: 'pre-wrap',
              margin: bi === 0 ? 0 : '4px 0 0',
              color: tokens.textMuted,
            }}
          >
            {renderInline(block.text, `p${bi}`)}
          </p>
        ),
      )}
    </div>
  )
}
