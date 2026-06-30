/**
 * Chart — bar / line / area / progress from a compact JSON encoding.
 *
 * The encoding (mark + x/y over a series) is deliberately small and stable so
 * the agent can author it reliably. The renderer here is a dependency-free
 * SVG/CSS implementation; it can be swapped for Vega-Lite (react-vega) behind
 * the same `ChartSpec` without changing report JSON or call sites.
 */
import { type ChartSpec } from '../types'

function nums(series: Record<string, unknown>[], key: string): number[] {
  return series.map((r) => {
    const v = r[key]
    return typeof v === 'number' ? v : Number(v) || 0
  })
}

function labels(series: Record<string, unknown>[], key?: string): string[] {
  if (!key) return series.map((_, i) => String(i + 1))
  return series.map((r) => String(r[key] ?? ''))
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const { mark, x, y, series, max } = spec.chart
  const values = nums(series, y)
  const cats = labels(series, x)

  if (series.length === 0) {
    return <div style={{ color: '#9ca3af', fontSize: 13 }}>No data.</div>
  }

  if (mark === 'progress') {
    const ceiling = max ?? 100
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {series.map((_, i) => {
          const pct = Math.max(0, Math.min(100, (values[i] / ceiling) * 100))
          return (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '8rem 1fr auto', gap: 10, alignItems: 'center' }}>
              <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cats[i]}</span>
              <div style={{ height: 8, borderRadius: 999, background: '#eef2f7', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--rpt-primary, #6366f1)' }} />
              </div>
              <span style={{ fontSize: 12, color: '#6b7280', width: 44, textAlign: 'right' }}>{Math.round(values[i])}</span>
            </div>
          )
        })}
      </div>
    )
  }

  if (mark === 'bar') {
    const peak = Math.max(1, ...values)
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {series.map((_, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '8rem 1fr auto', gap: 10, alignItems: 'center' }}>
            <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cats[i]}</span>
            <div style={{ height: 10, borderRadius: 999, background: '#eef2f7', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.max(2, (values[i] / peak) * 100)}%`, background: 'var(--rpt-primary, #6366f1)' }} />
            </div>
            <span style={{ fontSize: 12, color: '#6b7280', width: 44, textAlign: 'right' }}>{Math.round(values[i])}</span>
          </div>
        ))}
      </div>
    )
  }

  // line / area
  const peak = Math.max(1, ...values)
  const points = values
    .map((v, i) => {
      const px = (i / Math.max(1, values.length - 1)) * 100
      const py = 100 - (v / peak) * 100
      return `${px},${py}`
    })
    .join(' ')
  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" style={{ width: '100%', height: 96 }}>
      {mark === 'area' && (
        <polygon points={`0,100 ${points} 100,100`} fill="var(--rpt-primary, #6366f1)" opacity={0.15} />
      )}
      <polyline
        points={points}
        fill="none"
        stroke="var(--rpt-primary, #6366f1)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}
