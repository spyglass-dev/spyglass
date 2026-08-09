/** Metric — a single scalar with optional delta. Add these one-by-one. */
import type { CSSProperties } from 'react'
import { formatValue, type MetricSpec } from '../types'
import { tokens } from '../tokens'

const card: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  padding: '12px 14px',
  border: `1px solid ${tokens.border}`,
  borderRadius: 10,
  background: tokens.bg,
}

const trendColor = (t?: string) =>
  t === 'up' ? tokens.positive : t === 'down' ? tokens.negative : tokens.textMuted

export function Metric({ spec }: { spec: MetricSpec }) {
  return (
    <div style={card}>
      <span style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.05em', color: tokens.textMuted }}>
        {spec.label ?? spec.title ?? ''}
      </span>
      <span style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 26, fontWeight: 800 }}>
        {formatValue(spec.value, spec.format)}
        {spec.delta && (
          <span style={{ fontSize: 12, fontWeight: 600, color: trendColor(spec.delta.trend) }}>
            {spec.delta.value > 0 ? '+' : ''}
            {spec.delta.value}
            {spec.delta.suffix ?? ''}
          </span>
        )}
      </span>
    </div>
  )
}
