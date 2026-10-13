/**
 * Metric — a headline number: the value, how it moved, and where it has been.
 *
 * The change reads as a percentage for amounts ("+6.1%") and as points for
 * rates ("−0.3pt"), colored by MEANING — a rising return rate is red — and the
 * sparkline shows the same measure across the report's window, so a reader
 * can tell a spike from a trend without opening another chart. The frame
 * (border, padding) belongs to the card the host draws around every widget.
 */
import { useId } from 'react'
import { formatValue, parseTimestamp, type MetricSpec } from '../types'

/** Is the trend's last bucket still in progress (start + one step > now)? */
function trendInProgress(labels: string[] | undefined): boolean {
  if (!labels || labels.length < 3) return false
  const ms = labels.map((l) => parseTimestamp(l))
  if (ms.some((n) => Number.isNaN(n))) return false
  const step = ms[ms.length - 1] - ms[ms.length - 2]
  return ms[ms.length - 1] + step > Date.now()
}
import { tokens } from '../tokens'

function deltaTone(delta: NonNullable<MetricSpec['delta']>): 'good' | 'bad' | 'flat' {
  if (delta.trend === 'flat' || delta.value === 0) return 'flat'
  const up = delta.trend === 'up' || delta.value > 0
  const good = delta.upIsGood === false ? !up : up
  return good ? 'good' : 'bad'
}

const TONE = {
  good: { fg: tokens.positive, bg: 'var(--rpt-positive-soft, rgba(5, 150, 105, 0.1))' },
  bad: { fg: tokens.negative, bg: 'var(--rpt-negative-soft, rgba(225, 29, 72, 0.1))' },
  flat: { fg: tokens.textMuted, bg: tokens.muted },
} as const

/** The size of the change — the arrow beside it carries the direction. */
function deltaText(delta: NonNullable<MetricSpec['delta']>): string {
  if (delta.value === 0 && !delta.pct) return 'No change'
  if (delta.pct !== undefined) return `${Math.abs(delta.pct).toFixed(1)}%`
  const abs = Math.abs(delta.value)
  // A rate that moved 0.04pt is not "0pt".
  const shown = abs !== 0 && abs < 0.1 ? abs.toFixed(2) : String(Math.round(abs * 10) / 10)
  return `${shown}${delta.suffix ?? ''}`
}

/** A 1px-stroke trend with a soft fill. Pure SVG — no chart library for 30 points. */
function Sparkline({ values, partial }: { values: number[]; partial?: boolean }) {
  const id = useId()
  if (values.length < 2) return null
  const w = 120
  const h = 32
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const)
  const path = (p: (readonly [number, number])[]) => p.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  // The bucket still in progress draws dashed, so a half-finished week does
  // not read as a collapse.
  const solid = partial ? pts.slice(0, -1) : pts
  const line = path(solid)
  const tail = partial ? path(pts.slice(-2)) : null
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" width="100%" height={h} aria-hidden style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--rpt-accent, #2a78d6)" stopOpacity={0.22} />
          <stop offset="100%" stopColor="var(--rpt-accent, #2a78d6)" stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${line} L${solid[solid.length - 1][0]},${h} L0,${h} Z`} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="var(--rpt-accent, #2a78d6)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      {tail && (
        <path d={tail} fill="none" stroke="var(--rpt-accent, #2a78d6)" strokeWidth={1.5} strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      )}
      <circle cx={lx} cy={ly} r={2.5} fill="var(--rpt-accent, #2a78d6)" />
    </svg>
  )
}

export function Metric({ spec }: { spec: MetricSpec }) {
  const label = spec.label ?? spec.title ?? ''
  const numeric = typeof spec.value === 'number' ? spec.value : Number(spec.value)
  const target = spec.target && Number.isFinite(numeric) ? spec.target : undefined
  const pct = target ? Math.max(0, Math.min(100, (numeric / (target.value || 1)) * 100)) : 0
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, height: '100%' }}>
      <span
        title={spec.description}
        style={{ fontSize: 13, fontWeight: 500, color: tokens.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 28,
          lineHeight: 1.1,
          fontWeight: 650,
          letterSpacing: '-0.02em',
          color: 'var(--rpt-text-strong, #111827)',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {formatValue(spec.value, spec.format, { compact: true })}
      </span>
      {spec.delta && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 12 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 3,
              padding: '1px 7px',
              borderRadius: 999,
              fontWeight: 600,
              fontVariantNumeric: 'tabular-nums',
              color: TONE[deltaTone(spec.delta)].fg,
              background: TONE[deltaTone(spec.delta)].bg,
            }}
          >
            {spec.delta.trend === 'up' ? '↑' : spec.delta.trend === 'down' ? '↓' : ''}
            {deltaText(spec.delta)}
          </span>
          {spec.delta.label && <span style={{ color: tokens.textFaint }}>{spec.delta.label}</span>}
        </span>
      )}
      {spec.trend && spec.trend.values.length > 1 && (
        // Anchored to the bottom: in a row with a taller chart the tile
        // stretches, and the line belongs at its foot, not mid-card.
        <div style={{ marginTop: 'auto', paddingTop: 4 }}>
          <Sparkline values={spec.trend.values} partial={trendInProgress(spec.trend.labels)} />
        </div>
      )}
      {target && (
        <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ height: 6, borderRadius: 999, background: tokens.muted, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: `${pct}%`, borderRadius: 999, background: pct >= 100 ? tokens.positive : tokens.accent }} />
          </div>
          <span style={{ fontSize: 11, color: tokens.textFaint }}>
            {Math.round(pct)}% of {target.label ?? 'target'} ({formatValue(target.value, spec.format, { compact: true })})
          </span>
        </div>
      )}
    </div>
  )
}
