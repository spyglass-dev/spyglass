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
import { WidgetCard } from './WidgetCard'
import type { WidgetExporter } from '../exporters'
import { planGrid } from '../layout'

const grid: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
  gap: 16,
}

function span(w?: number): CSSProperties {
  const cols = Math.max(1, Math.min(4, w ?? 4))
  return { gridColumn: `span ${cols} / span ${cols}`, minWidth: 0 }
}

const stack: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }

export function ReportView({
  doc,
  registry,
  exporters,
}: {
  doc: ReportDoc
  registry?: WidgetRegistry
  /** Widget export menu entries (default CSV, PNG, JSON; `[]` hides it). */
  exporters?: WidgetExporter[]
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
        {planGrid(doc.widgets.map((s) => ({ w: s.w, metric: s.type === 'metric' }))).map((cell) => {
          const card = (i: number, style: CSSProperties) => {
            const spec: WidgetSpec = doc.widgets[i]
            return (
              <section key={spec.id ?? i} style={style}>
                <WidgetCard spec={spec} exporters={exporters}>
                  <Widget spec={spec} registry={registry} framed />
                </WidgetCard>
              </section>
            )
          }
          if (cell.kind === 'stack') {
            return (
              <div key={`stack-${cell.indices[0]}`} style={{ ...span(cell.w), ...stack }}>
                {cell.indices.map((i) => card(i, { flex: 1, minWidth: 0 }))}
              </div>
            )
          }
          return card(cell.index, { ...span(cell.w), ...(cell.compact ? { alignSelf: 'start' } : {}) })
        })}
      </div>
    </div>
  )
}
