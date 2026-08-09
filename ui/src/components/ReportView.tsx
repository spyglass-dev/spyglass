/**
 * ReportView — renders a whole `ReportDoc` on a 4-column responsive grid.
 * Each widget spans `w` (1–4) columns; a title (if set) sits above it. This is
 * the read/render surface; the studio adds editing on top.
 */
import type { CSSProperties } from 'react'
import type { ReportDoc, WidgetSpec } from '../types'
import { tokens } from '../tokens'
import type { WidgetRegistry } from '../registry'
import { Widget } from './Widget'

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 16,
}

function span(w?: number): CSSProperties {
  const cols = Math.max(1, Math.min(4, w ?? 4))
  return { gridColumn: `span ${cols} / span ${cols}`, minWidth: 0 }
}

export function ReportView({
  doc,
  registry,
}: {
  doc: ReportDoc
  registry?: WidgetRegistry
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {(doc.title || doc.description) && (
        <header>
          {doc.title && <h1 style={{ fontSize: 26, fontWeight: 800, margin: 0 }}>{doc.title}</h1>}
          {doc.description && (
            <p style={{ marginTop: 6, color: tokens.textMuted, fontSize: 14 }}>{doc.description}</p>
          )}
        </header>
      )}
      <div style={grid}>
        {doc.widgets.map((spec: WidgetSpec, i) => (
          <section key={spec.id ?? i} style={span(spec.w)}>
            {spec.title && spec.type !== 'metric' && (
              <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: tokens.textMuted, marginBottom: 6 }}>
                {spec.title}
              </div>
            )}
            <Widget spec={spec} registry={registry} />
          </section>
        ))}
      </div>
    </div>
  )
}
