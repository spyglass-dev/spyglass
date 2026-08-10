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

export function Note({ spec }: { spec: NoteSpec }) {
  const blocks = spec.markdown.split(/\n{2,}/)
  return (
    <div style={{ fontSize: 14, lineHeight: 1.6, color: tokens.text }}>
      {blocks.map((block, bi) => {
        const heading = /^(#{1,3})\s+(.*)$/.exec(block.trim())
        if (heading) {
          const level = heading[1].length
          return (
            <div
              key={bi}
              style={{
                fontWeight: 700,
                fontSize: level === 1 ? 18 : level === 2 ? 16 : 14,
                margin: bi === 0 ? '0 0 6px' : '10px 0 6px',
              }}
            >
              {renderInline(heading[2], `h${bi}`)}
            </div>
          )
        }
        return (
          <p key={bi} style={{ whiteSpace: 'pre-wrap', margin: bi === 0 ? 0 : '8px 0 0' }}>
            {renderInline(block, `p${bi}`)}
          </p>
        )
      })}
    </div>
  )
}
