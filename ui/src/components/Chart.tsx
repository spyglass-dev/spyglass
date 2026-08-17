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
import { parseTimestamp, type ChartSpec, type ValueFormat } from '../types'
import { tokens } from '../tokens'

// Lazy-load react-vega (and Vega) so the heavy renderer is only fetched when a
// chart actually renders — keeps it out of the host's initial bundle. react-vega
// 8 exposes `VegaEmbed` (spec + options) rather than the old `VegaLite`.
const VegaEmbed = lazy(() => import('react-vega').then((m) => ({ default: m.VegaEmbed })))

/** A Vega-Lite spec as a plain JSON object (cast to react-vega's spec type at
 *  the render boundary). */
type VlSpec = Record<string, unknown>

const EMBED_OPTIONS = { actions: false, renderer: 'svg', mode: 'vega-lite' } as const

/** Categorical series palette — CVD-validated (lightness band, chroma floor,
 *  adjacent-pair separation; contrast relief comes from axis labels + the CSV
 *  table view). Fixed assignment order, never cycled. */
export const CHART_SERIES = [
  '#2a78d6', // blue
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#4a3aa7', // violet
] as const

/** The shared Vega-Lite config — recessive axes/grid, thin rounded bars, text
 *  in muted ink, series colors from the validated palette. Default Vega (fat
 *  saturated bars, dark rotated labels, boxed view) reads as unfinished next
 *  to the rest of the widget set. */
const CHART_CONFIG = {
  background: 'transparent',
  font: 'ui-sans-serif, system-ui, sans-serif',
  view: { stroke: null },
  axis: {
    labelColor: '#6b7280',
    titleColor: '#6b7280',
    labelFontSize: 11,
    gridColor: '#f3f4f6',
    domainColor: '#e5e7eb',
    tickColor: '#e5e7eb',
    tickSize: 4,
  },
  legend: { labelColor: '#6b7280', titleColor: '#6b7280', labelFontSize: 11, symbolSize: 80 },
  bar: { color: CHART_SERIES[0], cornerRadiusTopLeft: 3, cornerRadiusTopRight: 3 },
  line: { color: CHART_SERIES[0], strokeWidth: 2 },
  area: { color: CHART_SERIES[0], opacity: 0.2, line: { color: CHART_SERIES[0], strokeWidth: 2 } },
  point: { color: CHART_SERIES[0], size: 70, filled: true },
  range: { category: [...CHART_SERIES] },
} as const

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
  const vals = series.map((r) => r[x])
  // Dates are temporal WHATEVER the mark. A monthly cohort chart is bars over
  // time, and treating its x as nominal printed the raw bucket
  // (`2026-04-01 00:00:00+00`, ellipsised to `2026-04-01 00:…`) as a category
  // label. Time is time; only the mark drawn on it differs.
  const allDate =
    vals.length > 0 && vals.every((v) => typeof v === 'string' && isTimestamp(v))
  if (allDate) return 'temporal'
  const trend = mark === 'line' || mark === 'area' || mark === 'point'
  if (!trend) return 'nominal'
  const allNum = vals.every(
    (v) => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))),
  )
  return allNum ? 'quantitative' : 'nominal'
}

/** A date-shaped string — `Date.parse` alone says yes to "2" and to a category
 *  called "May", which would turn an ordinary bar chart into a broken timeline. */
function isTimestamp(v: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([ T]|$)/.test(v) && !Number.isNaN(parseTimestamp(v))
}

const DAY = 86_400_000
/** The bucket a time series is stepped in, read off the smallest gap between
 *  two distinct points. Undefined for a single point (nothing to measure). */
function inferTimeUnit(values: Record<string, unknown>[], field: string): string | undefined {
  const ms = [...new Set(values.map((r) => parseTimestamp(String(r[field]))))]
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)
  if (ms.length < 2) return undefined
  let step = Infinity
  for (let i = 1; i < ms.length; i++) step = Math.min(step, ms[i] - ms[i - 1])
  if (step <= DAY / 2) return 'yearmonthdatehours'
  if (step <= DAY * 1.5) return 'yearmonthdate'
  if (step <= DAY * 10) return 'yearweek'
  if (step <= DAY * 45) return 'yearmonth'
  if (step <= DAY * 120) return 'yearquarter'
  return 'year'
}

/** Escape dots in a field name so Vega-Lite treats it as a flat key, not a
 *  nested accessor. Our members look like `Submissions.submitted` but the row
 *  keys are flat, so an unescaped dot would look up `datum.Submissions.submitted`
 *  (undefined) and render an empty chart. */
const esc = (field: unknown) => String(field ?? '').replace(/\./g, '\\.')

/**
 * `y` as an ARRAY means "these measures on one chart" — two lines, submissions
 * against graded. An agent asks for it constantly and it is the obvious reading
 * of the field, so support it rather than refuse it: fold the rows into long
 * form (one row per measure per x) and let `color` split the series.
 *
 * Before this, an array `y` reached `field.replace` and threw, which took the
 * whole page down — one agent-authored widget, a white screen, no report.
 */
function foldSeries(
  values: Record<string, unknown>[],
  ys: string[],
  xField: string,
): { values: Record<string, unknown>[]; y: string; color: string } {
  const out: Record<string, unknown>[] = []
  for (const row of values) {
    for (const y of ys) {
      out.push({ [xField]: row[xField], _series: y.split('.').pop() ?? y, _value: row[y] })
    }
  }
  return { values: out, y: '_value', color: '_series' }
}

/** Compile a compact `ChartSpec.chart` into a Vega-Lite spec. */
export function toVegaLiteForTest(chart: ChartSpec['chart']): VlSpec {
  return toVegaLite(chart)
}

function toVegaLite(chart: ChartSpec['chart']): VlSpec {
  const { mark, x, stack, format } = chart
  let { y, color } = chart as { y: string | string[]; color?: string }
  // Synthesize an index field when no x is given (parity with label fallback).
  const hasX = Boolean(x)
  const xField = hasX ? (x as string) : '_i'
  let values = chart.series.map((r, i) => (hasX ? r : { ...r, _i: i + 1 }))

  if (Array.isArray(y)) {
    if (y.length > 1) {
      const folded = foldSeries(values, y, xField)
      values = folded.values
      y = folded.y
      color = color ?? folded.color
    } else {
      y = y[0] ?? ''
    }
  }

  const vmark = mark === 'progress' ? 'bar' : mark
  const xt = xType(values, hasX ? xField : undefined, mark)
  // A bar needs a BAND to sit in. On a bare continuous time scale Vega draws
  // 1px hairlines, so a bar over time carries the bucket as a timeUnit —
  // inferred from the spacing of the data, since the widget does not say.
  const timeUnit = vmark === 'bar' && xt === 'temporal' ? inferTimeUnit(values, xField) : undefined
  const encoding: Record<string, unknown> = {
    x: {
      field: esc(xField),
      type: xt,
      title: null,
      ...(timeUnit ? { timeUnit } : {}),
      // Straight, ellipsis-truncated category labels — never rotated text
      // (the default -90° spin is the loudest "unstyled Vega" signal).
      ...(xt === 'nominal'
        ? { axis: { labelAngle: 0, labelLimit: 96, labelOverlap: 'parity' }, scale: { paddingInner: 0.35, paddingOuter: 0.15 } }
        : {}),
    },
    y: { field: esc(y), type: 'quantitative', title: null, axis: valueAxis(format) },
  }
  if (color) {
    encoding.color = { field: esc(color), type: 'nominal', title: null }
    // Grouped bars: offset by the color field and don't stack.
    if (mark === 'bar' && stack === false) {
      encoding.xOffset = { field: esc(color) }
      ;(encoding.y as Record<string, unknown>).stack = null
    } else if ((mark === 'bar' || mark === 'area') && stack === false) {
      ;(encoding.y as Record<string, unknown>).stack = null
    }
  }

  // A couple of categories stretched across a full-width container become
  // slabs — size the plot to the data instead (a fixed step per category,
  // capped), and let it sit left in the frame like any other small chart.
  const fewBars = vmark === 'bar' && xt === 'nominal' && values.length <= 5
  return {
    $schema: 'https://vega.github.io/schema/vega-lite/v6.json',
    data: { values },
    mark: { type: vmark, tooltip: true, ...(mark === 'point' ? { filled: true } : {}) },
    encoding,
    width: fewBars ? Math.min(values.length * 150, 640) : 'container',
    height: 220,
    autosize: { type: 'fit', contains: 'padding' },
    config: CHART_CONFIG,
  }
}

export function Chart({ spec }: { spec: ChartSpec }) {
  const { mark, x, y, series, max, vlSpec } = spec.chart

  // Raw Vega-Lite escape hatch — render verbatim, injecting series as the
  // default dataset when the spec doesn't carry its own data.
  const rawSpec = useMemo<VlSpec | null>(() => {
    if (!vlSpec) return null
    // Theme as a DEFAULT — a raw spec carrying its own `config` wins outright.
    const s = { width: 'container', config: CHART_CONFIG, ...vlSpec } as VlSpec
    if (!('data' in s)) s.data = { values: series }
    return s
  }, [vlSpec, series])

  const compiled = useMemo<VlSpec | null>(
    () => (vlSpec || mark === 'progress' || series.length === 0 ? null : toVegaLite(spec.chart)),
    [vlSpec, mark, series, spec.chart],
  )

  if (series.length === 0 && !vlSpec) {
    return <div style={{ color: tokens.textFaint, fontSize: 13 }}>No data.</div>
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
    // `progress` is one bar per row against a ceiling — a single value field.
    // An array `y` (multi-series) takes the first measure rather than throwing.
    const values = nums(series, Array.isArray(y) ? y[0] ?? '' : y)
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
              <span style={{ fontSize: 12, color: tokens.textMuted, width: 44, textAlign: 'right' }}>{Math.round(values[i])}</span>
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
