/**
 * Chart — bar / line / area / point / progress from a compact JSON encoding.
 *
 * The encoding (mark + x/y/color over a series) is deliberately small and
 * stable so the agent can author it reliably. It compiles to a Vega-Lite spec
 * and renders via `react-vega`; `progress` stays a dependency-free CSS bar
 * (Vega-Lite has no progress mark), and a raw `vlSpec` escape hatch renders
 * verbatim for charts the compact encoding can't express. The `ChartSpec`
 * contract and call sites are unchanged either way.
 */
import { lazy, Suspense, useMemo } from 'react'
import type { VegaEmbedProps } from 'react-vega'
import { type ChartSpec, type ValueFormat } from '../types'

// Lazy-load react-vega (and Vega) so the heavy renderer is only fetched when a
// chart actually renders — keeps it out of the host's initial bundle. react-vega
// 8 exposes `VegaEmbed` (spec + options) rather than the old `VegaLite`.
const VegaEmbed = lazy(() => import('react-vega').then((m) => ({ default: m.VegaEmbed })))

/** A Vega-Lite spec as a plain JSON object (cast to react-vega's spec type at
 *  the render boundary). */
type VlSpec = Record<string, unknown>

const EMBED_OPTIONS = { actions: false, renderer: 'svg', mode: 'vega-lite' } as const

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

/** d3-format / labelExpr for the value axis, matching `formatValue` semantics
 *  (percent values are already 0–100, so we append `%` rather than scale). */
function valueAxis(format?: ValueFormat): Record<string, unknown> {
  switch (format) {
    case 'percent':
      return { labelExpr: "datum.value + '%'" }
    case 'currency':
      return { format: '$,.0f' }
    case 'number':
      return { format: ',.0f' }
    default:
      return {}
  }
}

/** Best-effort x encoding type: temporal/quantitative for trend marks when the
 *  data supports it, else nominal categories. */
function xType(
  series: Record<string, unknown>[],
  x: string | undefined,
  mark: string,
): 'nominal' | 'quantitative' | 'temporal' {
  if (!x) return 'nominal'
  const trend = mark === 'line' || mark === 'area' || mark === 'point'
  if (!trend) return 'nominal'
  const vals = series.map((r) => r[x])
  const allNum = vals.every(
    (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))),
  )
  if (allNum) return 'quantitative'
  const allDate = vals.every((v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)))
  return allDate ? 'temporal' : 'nominal'
}

/** Compile a compact `ChartSpec.chart` into a Vega-Lite spec. */
function toVegaLite(chart: ChartSpec['chart']): VlSpec {
  const { mark, x, y, color, stack, format } = chart
  // Synthesize an index field when no x is given (parity with label fallback).
  const hasX = Boolean(x)
  const xField = hasX ? (x as string) : '_i'
  const values = chart.series.map((r, i) => (hasX ? r : { ...r, _i: i + 1 }))

  const vmark = mark === 'progress' ? 'bar' : mark
  const encoding: Record<string, unknown> = {
    x: { field: xField, type: xType(values, hasX ? xField : undefined, mark), title: null },
    y: { field: y, type: 'quantitative', title: null, axis: valueAxis(format) },
  }
  if (color) {
    encoding.color = { field: color, type: 'nominal', title: null }
    // Grouped bars: offset by the color field and don't stack.
    if (mark === 'bar' && stack === false) {
      encoding.xOffset = { field: color }
      ;(encoding.y as Record<string, unknown>).stack = null
    } else if ((mark === 'bar' || mark === 'area') && stack === false) {
      ;(encoding.y as Record<string, unknown>).stack = null
    }
  }

  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values },
    mark: { type: vmark, tooltip: true, ...(mark === 'point' ? { filled: true } : {}) },
    encoding,
    width: 'container',
    height: 220,
    autosize: { type: 'fit', contains: 'padding' },
  }
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const { mark, x, y, series, max, vlSpec } = spec.chart

  // Raw Vega-Lite escape hatch — render verbatim, injecting series as the
  // default dataset when the spec doesn't carry its own data.
  const rawSpec = useMemo<VlSpec | null>(() => {
    if (!vlSpec) return null
    const s = { width: 'container', ...vlSpec } as VlSpec
    if (!('data' in s)) s.data = { values: series }
    return s
  }, [vlSpec, series])

  const compiled = useMemo<VlSpec | null>(
    () => (vlSpec || mark === 'progress' || series.length === 0 ? null : toVegaLite(spec.chart)),
    [vlSpec, mark, series, spec.chart],
  )

  if (series.length === 0 && !vlSpec) {
    return <div style={{ color: '#9ca3af', fontSize: 13 }}>No data.</div>
  }

  if (rawSpec) {
    return (
      <div style={{ width: '100%' }}>
        <Suspense fallback={null}>
          <VegaEmbed spec={rawSpec as VegaEmbedProps['spec']} options={EMBED_OPTIONS} onError={() => {}} style={{ width: '100%' }} />
        </Suspense>
      </div>
    )
  }

  // progress — a compact CSS bar per row (value / max), no chart lib needed.
  if (mark === 'progress') {
    const values = nums(series, y)
    const cats = labels(series, x)
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

  return (
    <div style={{ width: '100%' }}>
      {compiled && (
        <Suspense fallback={null}>
          <VegaEmbed spec={compiled as VegaEmbedProps['spec']} options={EMBED_OPTIONS} onError={() => {}} style={{ width: '100%' }} />
        </Suspense>
      )}
    </div>
  )
}
