/**
 * Note — a markdown text block. The base renderer shows the source as styled
 * text (dependency-free); a host can register a richer `note` custom widget
 * (e.g. react-markdown) to override.
 */
import type { NoteSpec } from '../types'

export function Note({ spec }: { spec: NoteSpec }) {
  return (
    <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.6, color: '#374151' }}>
      {spec.markdown}
    </div>
  )
}
