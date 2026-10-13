/**
 * Chart — bar / hbar / line / area / point / arc / progress from a compact
 * JSON encoding.
 *
 * The encoding (mark + x/y/color over a series) is deliberately small and
 * stable so the agent can author it reliably. It compiles to a Vega-Lite spec
 * and renders via `react-vega`; `progress` stays a dependency-free CSS bar
 * (Vega-Lite has no progress mark), and a raw `vlSpec` escape hatch renders
 * verbatim for charts the compact encoding can't express. The `ChartSpec`
 * contract and call sites are unchanged either way.
 */
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { VegaEmbedProps } from 'react-vega'
import { formatDateValue, formatValue, parseTimestamp, type ChartSpec, type ValueFormat } from '../types'
import { tokens } from '../tokens'
import type { DrillEvent } from '../drill'

// Lazy-load react-vega (and Vega) so the heavy renderer is only fetched when a
// chart actually renders — keeps it out of the host's initial bundle. react-vega
// 8 exposes `VegaEmbed` (spec + options) rather than the old `VegaLite`.
const VegaEmbed = lazy(() => import('react-vega').then((m) => ({ default: m.VegaEmbed })))

/** A Vega-Lite spec as a plain JSON object (cast to react-vega's spec type at
 *  the render boundary). */
type VlSpec = Record<string, unknown>

const EMBED_OPTIONS = {
  actions: false,
  renderer: 'svg',
  mode: 'vega-lite',
  // The tooltip is themed by TOOLTIP_CSS below (class `custom-theme`).
  tooltip: { theme: 'custom' },
} as const

/**
 * Vega's stock tooltip is a grey box of `field: value` pairs in a monospace
 * font. This one reads like the rest of the widget set: the category as a
 * heading, then each value with its name. Injected once per document.
 */
const TOOLTIP_CSS = `
#vg-tooltip-element.vg-tooltip.custom-theme {
  font: 12px/1.45 ui-sans-serif, system-ui, sans-serif;
  color: var(--rpt-text, #374151);
  background: var(--rpt-bg, #fff);
  border: 1px solid var(--rpt-border, #e5e7eb);
  border-radius: 8px;
  box-shadow: 0 8px 24px -6px rgba(15, 23, 42, 0.18);
  padding: 8px 10px;
  max-width: 280px;
}
#vg-tooltip-element.vg-tooltip.custom-theme table tr td.key {
  color: var(--rpt-text-muted, #6b7280);
  font-weight: 500;
  padding-right: 10px;
  text-align: left;
}
#vg-tooltip-element.vg-tooltip.custom-theme table tr td.value {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  text-align: right;
}
#vg-tooltip-element.vg-tooltip.custom-theme h2 {
  font-size: 12px;
  font-weight: 700;
  margin: 0 0 4px;
}
`
let tooltipStyled = false
function ensureTooltipStyle() {
  if (tooltipStyled || typeof document === 'undefined') return
  const el = document.createElement('style')
  el.setAttribute('data-spyglass-tooltip', '')
  el.textContent = TOOLTIP_CSS
  document.head.appendChild(el)
  tooltipStyled = true
}

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
  legend: { labelColor: '#6b7280', titleColor: '#6b7280', labelFontSize: 11, symbolSize: 70, symbolType: 'circle', orient: 'top', direction: 'horizontal', columnPadding: 14 },
  bar: { color: CHART_SERIES[0], cornerRadiusTopLeft: 3, cornerRadiusTopRight: 3 },
  line: { color: CHART_SERIES[0], strokeWidth: 2 },
  area: { color: CHART_SERIES[0], opacity: 0.2, line: { color: CHART_SERIES[0], strokeWidth: 2 } },
  point: { color: CHART_SERIES[0], size: 70, filled: true },
  range: { category: [...CHART_SERIES] },
} as const

/**
 * The Vega config, with its ink resolved from the host's `--rpt-chart-*`
 * custom properties. Vega paints attribute values into SVG, so a `var()`
 * reference cannot travel through the spec the way the CSS tokens do — the
 * values are read once from the computed style of the chart's own container.
 * With nothing defined, the stock light theme renders unchanged:
 *
 * - `--rpt-chart-axis-text` — axis + legend labels (default `#6b7280`)
 * - `--rpt-chart-grid`     — gridlines (default `#f3f4f6`)
 * - `--rpt-chart-domain`   — axis line + ticks (default `#e5e7eb`)
 */
/** `rgb(…)` / `rgba(…)` / `#rrggbb` → the same color at `alpha`. */
function withAlpha(color: string, alpha: number): string {
  const rgb = color.match(/rgba?\(([^)]+)\)/)
  if (rgb) {
    const [r, g, b] = rgb[1].split(',').map((v) => v.trim())
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const hex = color.match(/^#([0-9a-f]{6})$/i)
  if (hex) {
    const n = parseInt(hex[1], 16)
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`
  }
  return color
}

/** The chart config for a palette: series colors and the mark defaults. */
function chartConfig(palette: readonly string[], ink?: { axisText: string; grid: string; domain: string }): Record<string, unknown> {
  const base = CHART_CONFIG as unknown as Record<string, Record<string, unknown>>
  return {
    ...CHART_CONFIG,
    bar: { ...base.bar, color: palette[0] },
    line: { ...base.line, color: palette[0] },
    area: { ...base.area, color: palette[0], line: { color: palette[0], strokeWidth: 2 } },
    point: { ...base.point, color: palette[0] },
    range: { category: [...palette] },
    ...(ink
      ? {
          axis: { ...base.axis, labelColor: ink.axisText, titleColor: ink.axisText, gridColor: ink.grid, domainColor: ink.domain, tickColor: ink.domain },
          legend: { ...base.legend, labelColor: ink.axisText, titleColor: ink.axisText },
        }
      : {}),
  }
}

/**
 * The Vega config and series palette, resolved from the host's custom
 * properties on the chart's own container. Vega paints attribute values into
 * SVG, where `var()` does not resolve, so every value is turned into a
 * concrete color through a probe element first — which also resolves a
 * host's `hsl(var(--chart-1))`. With nothing defined, the stock theme renders:
 *
 * - `--rpt-chart-series`   — comma-separated series colors (default the CVD palette)
 * - `--rpt-chart-axis-text` — axis + legend labels (default `#6b7280`)
 * - `--rpt-chart-grid`     — gridlines (default `#f3f4f6`)
 * - `--rpt-chart-domain`   — axis line + ticks (default `#e5e7eb`)
 */
function useChartConfig(): {
  ref: React.RefObject<HTMLDivElement | null>
  config: Record<string, unknown>
  palette: readonly string[]
} {
  const ref = useRef<HTMLDivElement>(null)
  const [theme, setTheme] = useState<{ config: Record<string, unknown>; palette: readonly string[] }>({
    config: CHART_CONFIG as unknown as Record<string, unknown>,
    palette: CHART_SERIES,
  })
  useLayoutEffect(() => {
    const host = ref.current
    if (!host) return
    const style = getComputedStyle(host)
    const raw = (name: string) => style.getPropertyValue(name).trim()
    const seriesRaw = raw('--rpt-chart-series')
    const inkRaw = [raw('--rpt-chart-axis-text'), raw('--rpt-chart-grid'), raw('--rpt-chart-domain')]
    if (!seriesRaw && inkRaw.every((v) => !v)) return
    const probe = document.createElement('span')
    probe.style.display = 'none'
    host.appendChild(probe)
    const resolve = (value: string, fallback: string) => {
      if (!value) return fallback
      probe.style.color = ''
      probe.style.color = value
      return getComputedStyle(probe).color || fallback
    }
    const palette = seriesRaw
      ? splitColors(seriesRaw).map((c, i) => resolve(c, CHART_SERIES[i % CHART_SERIES.length]))
      : CHART_SERIES
    const ink = {
      axisText: resolve(inkRaw[0], '#6b7280'),
      grid: resolve(inkRaw[1], '#f3f4f6'),
      domain: resolve(inkRaw[2], '#e5e7eb'),
    }
    probe.remove()
    setTheme({ config: chartConfig(palette, ink), palette })
  }, [])
  return { ref, ...theme }
}

/** Split a color list on top-level commas — `hsl(1 2% 3%), rgb(1, 2, 3)`. */
function splitColors(list: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of list) {
    if (ch === '(') depth++
    if (ch === ')') depth--
    if (ch === ',' && depth === 0) {
      out.push(cur.trim())
      cur = ''
    } else cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

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
      // `$1.2M`, not `$1,200,000` — an axis label is read at a glance. d3's
      // SI prefix writes zero as `$0k` and a billion as `G`; fix both.
      return { labelExpr: "datum.value == 0 ? '$0' : replace(format(datum.value, '$.3~s'), 'G', 'B')" }
    case 'number':
      return { labelExpr: "datum.value == 0 ? '0' : replace(format(datum.value, '.3~s'), 'G', 'B')" }
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

/** Past this many slices a donut is a colour wheel, so the tail becomes
 *  "Other" — the honest way to keep the form usable. */
const MAX_SLICES = 6

/** Keep the biggest `keep - 1` categories and sum the rest into "Other",
 *  preserving the incoming order of the survivors. */
function foldTail(
  values: Record<string, unknown>[],
  category: string,
  value: string,
  keep: number,
): Record<string, unknown>[] {
  if (values.length <= keep) return values
  const ranked = [...values].sort((a, b) => (Number(b[value]) || 0) - (Number(a[value]) || 0))
  const kept = new Set(ranked.slice(0, keep - 1).map((r) => String(r[category])))
  const head = values.filter((r) => kept.has(String(r[category])))
  const tail = values
    .filter((r) => !kept.has(String(r[category])))
    .reduce((sum, r) => sum + (Number(r[value]) || 0), 0)
  return [...head, { [category]: 'Other', [value]: tail }]
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

/**
 * Is the LAST bucket still in progress? A week that started on Monday holds
 * two days of orders on Wednesday, and drawn like the others it reads as a
 * collapse. The bucket is in progress when its start plus one step (the
 * series' own spacing) is still in the future.
 */
export function lastBucketInProgress(
  values: Record<string, unknown>[],
  field: string,
  now: number = Date.now(),
): unknown {
  const ms = [...new Set(values.map((r) => parseTimestamp(String(r[field]))))]
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b)
  if (ms.length < 3) return undefined
  let step = Infinity
  for (let i = 1; i < ms.length; i++) step = Math.min(step, ms[i] - ms[i - 1])
  const last = ms[ms.length - 1]
  if (last + step <= now) return undefined
  return values.find((r) => parseTimestamp(String(r[field])) === last)?.[field]
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
/** A legend entry a reader can read: `Events.lessons_authored` is "Lessons
 *  authored", not the member name with its underscores showing. */
function seriesLabel(member: string | null | undefined): string {
  // Agent-authored specs arrive with `y: null`; a label is not worth a crash.
  const key = String(member ?? '')
  const field = key.split('.').pop() ?? key
  const words = field.replace(/_/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function foldSeries(
  values: Record<string, unknown>[],
  ys: string[],
  xField: string,
  chart?: ChartSpec['chart'],
): { values: Record<string, unknown>[]; y: string; color: string } {
  const out: Record<string, unknown>[] = []
  const label = `${xField}__label`
  for (const row of values) {
    for (const y of ys) {
      out.push({
        [xField]: row[xField],
        ...(label in row ? { [label]: row[label] } : {}),
        _series: chart ? titleOf(chart, y) : seriesLabel(y),
        _value: row[y],
        // Each measure keeps its own format through the fold.
        __tt__value: tooltipValue(row[y], chart ? formatOf(chart, y) : undefined),
      })
    }
  }
  return { values: out, y: '_value', color: '_series' }
}

// ── Tooltip + axis text ──────────────────────────────────────────────────────

/** The display name of a field: the model's title, else the humanized key. */
function titleOf(chart: ChartSpec['chart'], field: string): string {
  return chart.titles?.[field] ?? chart.titles?.[field.replace(/__label$/, '')] ?? seriesLabel(field)
}

function formatOf(chart: ChartSpec['chart'], field: string): ValueFormat | undefined {
  return chart.formats?.[field] ?? chart.format
}

/** Precise, never compact: the tooltip is where the exact figure lives. */
function tooltipValue(v: unknown, format?: ValueFormat): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string' && isTimestamp(v)) return formatDateValue(v)
  const n = typeof v === 'number' ? v : Number(v)
  if (typeof v === 'string' && Number.isNaN(n)) return v
  if (format === 'currency' || format === 'percent') return formatValue(n, format)
  return Number.isInteger(n) ? n.toLocaleString() : (Math.round(n * 10) / 10).toLocaleString()
}

/** The field the x axis SHOWS: a labelled id draws its `__label`. */
function displayField(values: Record<string, unknown>[], x: string): string {
  const label = `${x}__label`
  return values.length > 0 && values.every((r) => label in r) ? label : x
}

/**
 * Stamp each row with the strings its tooltip shows. Vega's own formatting
 * cannot append `%` without scaling, has no locale currency, and would print
 * `589210.0000000038`; precomputing keeps the tooltip identical to the table.
 */
function withTooltipText(
  values: Record<string, unknown>[],
  fields: { field: string; format?: ValueFormat }[],
): Record<string, unknown>[] {
  return values.map((r) => {
    const out: Record<string, unknown> = { ...r }
    for (const { field, format } of fields) out[`__tt_${field}`] = tooltipValue(r[field], format)
    return out
  })
}

const tt = (field: string, title: string) => ({ field: esc(`__tt_${field}`), type: 'nominal', title })

/** Compile a compact `ChartSpec.chart` into a Vega-Lite spec. */
export function toVegaLiteForTest(chart: ChartSpec['chart']): VlSpec {
  return toVegaLite(chart)
}

/** `datum["Orders.region"]` — Vega expressions index dotted keys by string. */
const datumRef = (field: string) => `datum[${JSON.stringify(field)}]`

/** Fade everything but the highlighted categories (the drill selection). */
function highlightOpacity(field: string, highlight: unknown[] | undefined): Record<string, unknown> | undefined {
  if (!highlight?.length) return undefined
  const set = JSON.stringify(highlight.map(String))
  return { condition: { test: `indexof(${set}, '' + ${datumRef(field)}) >= 0`, value: 1 }, value: 0.28 }
}

const SCHEMA = 'https://vega.github.io/schema/vega-lite/v6.json'

function toVegaLite(chart: ChartSpec['chart'], palette: readonly string[] = CHART_SERIES): VlSpec {
  const { mark, x, stack, format } = chart
  let { y, color } = chart as { y: string | string[]; color?: string }
  // Synthesize an index field when no x is given (parity with label fallback).
  const hasX = Boolean(x)
  const xField = hasX ? (x as string) : '_i'
  let values = chart.series.map((r, i) => (hasX ? r : { ...r, _i: i + 1 }))
  const xShow = hasX ? displayField(values, xField) : xField
  const xTitle = hasX ? titleOf(chart, xField) : ''

  let folded = false
  if (Array.isArray(y)) {
    if (y.length > 1) {
      const f = foldSeries(values, y, xField, chart)
      values = f.values
      y = f.y
      color = color ?? f.color
      folded = true
    } else {
      y = y[0] ?? ''
    }
  }
  const yField = y as string
  const yFormat = folded ? format : formatOf(chart, yField)
  const yTitle = folded ? 'Value' : titleOf(chart, yField)
  const colorTitle = color ? (folded ? 'Series' : titleOf(chart, color)) : ''
  const prevKey = `__prev_${yField}`
  const ghost =
    !folded &&
    chart.comparison !== false &&
    (mark === 'line' || mark === 'area' || mark === 'bar') &&
    values.some((r) => r[prevKey] !== undefined && r[prevKey] !== null)

  values = withTooltipText(values, [
    { field: xShow },
    ...(folded ? [] : [{ field: yField, format: yFormat }]),
    ...(color && !folded ? [{ field: color }] : []),
    ...(chart.y2 ? [{ field: chart.y2, format: formatOf(chart, chart.y2) }] : []),
    ...(ghost ? [{ field: prevKey, format: yFormat }] : []),
  ])
  const tooltip = [
    tt(xShow, xTitle || 'Category'),
    ...(color ? [tt(color, colorTitle)] : []),
    tt(yField, yTitle),
    ...(chart.y2 ? [tt(chart.y2, titleOf(chart, chart.y2))] : []),
    ...(ghost ? [tt(prevKey, 'Previous period')] : []),
  ]
  const opacity = highlightOpacity(xField, chart.highlight)

  // ── Part-to-whole: a donut ────────────────────────────────────────────
  //
  // Angles are read badly and a pie of ten close slices is the classic bad
  // chart, so this one is BOUNDED rather than trusted: slices past the sixth
  // fold into "Other", the categories keep the order the query returned them
  // in, and the tooltip carries the share so nobody has to estimate an angle.
  if (mark === 'arc') {
    const sliced = foldTail(values, xShow, yField, MAX_SLICES)
    const total = sliced.reduce((sum, r) => sum + (Number(r[yField]) || 0), 0) || 1
    return {
      $schema: SCHEMA,
      data: {
        values: sliced.map((r) => ({
          ...r,
          _share: ((Number(r[yField]) || 0) / total) * 100,
          __tt__share: `${(Math.round(((Number(r[yField]) || 0) / total) * 1000) / 10).toFixed(1)}%`,
          [`__tt_${xShow}`]: r[`__tt_${xShow}`] ?? String(r[xShow]),
          [`__tt_${yField}`]: r[`__tt_${yField}`] ?? tooltipValue(r[yField], yFormat),
        })),
      },
      mark: { type: 'arc', innerRadius: 58, padAngle: 0.012, cornerRadius: 3, stroke: 'var(--rpt-bg, #fff)', strokeWidth: 1, tooltip: true },
      encoding: {
        theta: { field: esc(yField), type: 'quantitative', stack: true },
        color: {
          field: esc(xShow),
          type: 'nominal',
          title: null,
          sort: null,
          legend: { orient: 'bottom', direction: 'horizontal', columns: 2, labelLimit: 120, symbolType: 'circle' },
        },
        ...(opacity ? { opacity } : {}),
        tooltip: [tt(xShow, xTitle || 'Category'), tt(yField, yTitle), tt('_share', 'Share')],
      },
      width: 'container',
      height: chart.height ?? 240,
      autosize: { type: 'fit', contains: 'padding' },
      config: CHART_CONFIG,
    }
  }

  // ── Long category names: bars on their side ───────────────────────────
  //
  // A vertical bar chart gives each label the width of one band, so long
  // names come out ellipsised. Horizontal bars give the label the whole left
  // gutter and the plot grows downward, which is also the right shape for a
  // ranking: you read the order down the page.
  if (mark === 'hbar') {
    return {
      $schema: SCHEMA,
      data: { values },
      mark: { type: 'bar', tooltip: true, cornerRadiusTopRight: 3, cornerRadiusBottomRight: 3 },
      encoding: {
        y: {
          field: esc(xShow),
          type: 'nominal',
          title: null,
          sort: null,
          axis: { labelLimit: 180, domain: false, ticks: false, labelPadding: 6 },
        },
        x: { field: esc(yField), type: 'quantitative', title: null, axis: { ...valueAxis(yFormat), grid: true, tickCount: 4 } },
        ...(color ? { color: { field: esc(color), type: 'nominal', title: null } } : {}),
        ...(opacity ? { opacity } : {}),
        tooltip,
      },
      width: 'container',
      // One row per category rather than a fixed height: twenty rows squeezed
      // into 220px is a barcode.
      height: { step: 24 },
      autosize: { type: 'fit-x', contains: 'padding' },
      config: CHART_CONFIG,
    }
  }

  const vmark = mark === 'progress' ? 'bar' : mark
  const xt = xType(values, hasX ? xField : undefined, mark)
  // The bucket in progress draws dashed (lines) or faded (bars), and says
  // "so far" in its tooltip.
  const partialX = xt === 'temporal' && chart.partial !== false ? lastBucketInProgress(values, xField) : undefined
  if (partialX !== undefined) {
    const xs = [...new Set(values.map((r) => String(r[xField])))].sort(
      (a, b) => parseTimestamp(a) - parseTimestamp(b),
    )
    const prevX = xs[xs.length - 2]
    values = values.map((r) => {
      const at = String(r[xField])
      const partial = at === String(partialX)
      return {
        ...r,
        _partial: partial,
        _tail: partial || at === prevX,
        ...(partial ? { [`__tt_${xShow}`]: `${r[`__tt_${xShow}`] ?? at} (so far)` } : {}),
      }
    })
  }
  // A bar needs a BAND to sit in. On a bare continuous time scale Vega draws
  // 1px hairlines, so a bar over time carries the bucket as a timeUnit —
  // inferred from the spacing of the data, since the widget does not say.
  const timeUnit = vmark === 'bar' && xt === 'temporal' ? inferTimeUnit(values, xField) : undefined
  const xEnc: Record<string, unknown> = {
    field: esc(xt === 'nominal' ? xShow : xField),
    type: xt,
    title: null,
    ...(timeUnit ? { timeUnit } : {}),
    // Straight, ellipsis-truncated category labels — never rotated text
    // (the default -90° spin is the loudest "unstyled Vega" signal).
    //
    // `sort: null` means "the order the rows arrived in". Vega-Lite's
    // default is ALPHABETICAL, which silently threw away the query's own
    // `ORDER BY`. The engine sorted the rows on purpose; the chart's job is
    // to draw them.
    ...(xt === 'nominal'
      ? {
          sort: null,
          // Every category keeps its label, ellipsised to its band, rather than
          // every other one being dropped.
          axis: { labelAngle: 0, labelLimit: { expr: "max(bandwidth('x') + 8, 40)" }, labelOverlap: false, ticks: false },
          scale: { paddingInner: 0.35, paddingOuter: 0.15 },
        }
      : {}),
    // A temporal axis with more ticks than room overlaps its labels into
    // porridge. Greedy overlap removal and flat labels keep it readable.
    ...(xt === 'temporal' ? { axis: { labelOverlap: 'greedy', labelAngle: 0, grid: false, tickCount: 6 } } : {}),
  }
  const yEnc: Record<string, unknown> = {
    field: esc(yField),
    type: 'quantitative',
    title: chart.y2 ? yTitle : null,
    axis: { ...valueAxis(yFormat), tickCount: 5 },
  }
  const encoding: Record<string, unknown> = { x: xEnc, y: yEnc, tooltip }
  if (opacity) encoding.opacity = opacity
  else if (partialX !== undefined && vmark === 'bar') {
    encoding.opacity = { condition: { test: 'datum._partial', value: 0.4 }, value: 1 }
  }
  if (color) {
    encoding.color = { field: esc(color), type: 'nominal', title: null }
    // Grouped bars: offset by the color field and don't stack.
    if (mark === 'bar' && stack === false) {
      encoding.xOffset = { field: esc(color) }
      yEnc.stack = null
    } else if ((mark === 'bar' || mark === 'area') && stack === false) {
      yEnc.stack = null
    }
  }

  // A couple of categories stretched across a full-width container become
  // slabs, so bar THICKNESS is capped — but the plot still takes the width of
  // its container. A chart must never be wider than the thing it is drawn in.
  const slabRisk = vmark === 'bar' && xt === 'nominal' && !color && values.length <= 6
  const trend = vmark === 'line' || vmark === 'area'
  const markDef: Record<string, unknown> = {
    type: vmark,
    tooltip: true,
    ...(slabRisk ? { size: 88 } : {}),
    ...(mark === 'point' ? { filled: true } : {}),
    ...(trend ? { interpolate: 'monotone' } : {}),
    // Points on a short line make each value a target; on a long one they are noise.
    ...(vmark === 'line' && values.length <= 31 ? { point: { filled: true, size: 26 } } : {}),
    // A single-series area fades to nothing at the baseline instead of
    // sitting there as a flat slab of color.
    ...(vmark === 'area' && !color
      ? {
          line: { color: palette[0], strokeWidth: 2 },
          color: {
            x1: 1, y1: 1, x2: 1, y2: 0,
            gradient: 'linear',
            stops: [
              { offset: 0, color: withAlpha(palette[0], 0.02) },
              { offset: 1, color: withAlpha(palette[0], 0.32) },
            ],
          },
          opacity: 1,
        }
      : {}),
  }

  const height = chart.height ?? 240
  const dashedTail = partialX !== undefined && trend
  const layered = ghost || Boolean(chart.y2) || Boolean(chart.target) || dashedTail
  if (!layered) {
    return {
      $schema: SCHEMA,
      data: { values },
      mark: markDef,
      encoding,
      width: 'container',
      height,
      autosize: { type: 'fit', contains: 'padding' },
      config: CHART_CONFIG,
    }
  }

  // ── Layers: previous period, a second measure, a target ───────────────
  const mainEncoding = { ...encoding }
  delete mainEncoding.x
  const notPartial = { filter: '!datum._partial' }
  const layer: Record<string, unknown>[] = [
    { ...(dashedTail ? { transform: [notPartial] } : {}), mark: markDef, encoding: mainEncoding },
  ]
  if (dashedTail) {
    // The last two points, dashed: the trend continues, but the number at
    // the end is not final.
    layer.push({
      transform: [{ filter: 'datum._tail' }],
      mark: {
        type: 'line',
        strokeDash: [3, 3],
        strokeWidth: 2,
        interpolate: 'monotone',
        tooltip: true,
        ...(color ? {} : { color: palette[0] }),
        point: { filled: true, size: 26, ...(color ? {} : { color: palette[0] }) },
      },
      encoding: {
        y: { field: esc(yField), type: 'quantitative' },
        ...(color ? { color: { field: esc(color), type: 'nominal', title: null } } : {}),
        tooltip,
      },
    })
  }
  // A line over bars sits at the CENTRE of each band, not its left edge.
  const overBand = timeUnit ? { x: { ...xEnc, bandPosition: 0.5 } } : {}
  if (ghost) {
    layer.push({
      ...(partialX !== undefined ? { transform: [notPartial] } : {}),
      mark: { type: 'line', strokeDash: [4, 3], strokeWidth: 1.5, color: '#9ca3af', interpolate: 'monotone', tooltip: true },
      encoding: { ...overBand, y: { field: esc(prevKey), type: 'quantitative' }, tooltip },
    })
  }
  if (chart.y2) {
    layer.push({
      mark: { type: 'line', color: palette[1], strokeWidth: 2, interpolate: 'monotone', point: { filled: true, size: 28, color: palette[1] }, tooltip: true },
      encoding: {
        ...overBand,
        y: {
          field: esc(chart.y2),
          type: 'quantitative',
          title: titleOf(chart, chart.y2),
          axis: { ...valueAxis(formatOf(chart, chart.y2)), orient: 'right', grid: false, tickCount: 5, titleColor: palette[1] },
        },
        tooltip,
      },
    })
  }
  if (chart.target) {
    const { value, label } = chart.target
    layer.push({ mark: { type: 'rule', strokeDash: [5, 4], strokeWidth: 1.25, color: '#6b7280' }, encoding: { y: { datum: value } } })
    layer.push({
      mark: { type: 'text', align: 'right', baseline: 'bottom', dy: -4, fontSize: 11, fontWeight: 600, color: '#6b7280' },
      encoding: {
        y: { datum: value },
        x: { value: 'width' },
        text: { value: `${label ?? 'Target'} · ${tooltipValue(value, yFormat)}` },
      },
    })
  }
  return {
    $schema: SCHEMA,
    data: { values },
    encoding: { x: xEnc },
    layer,
    ...(chart.y2 ? { resolve: { scale: { y: 'independent' } } } : {}),
    width: 'container',
    height,
    autosize: { type: 'fit', contains: 'padding' },
    config: CHART_CONFIG,
  }
}

/** The DrillEvent for a clicked mark, or null when the mark is not a category
 *  (a point in time, the "Other" slice, a reference line). */
function drillFor(chart: ChartSpec['chart'], datum: Record<string, unknown> | undefined): DrillEvent | null {
  const x = chart.x
  if (!datum || !x || !x.includes('.')) return null
  const value = datum[x]
  if (value === undefined || value === null || value === 'Other') return null
  if (typeof value === 'string' && isTimestamp(value)) return null
  const member = x.replace(/__label$/, '')
  const label = datum[`${member}__label`]
  return {
    member,
    value: value as DrillEvent['value'],
    ...(label !== undefined ? { label: String(label) } : {}),
    ...(chart.entities?.[member] ? { entity: chart.entities[member] } : {}),
  }
}

export function Chart({ spec, onDrill }: { spec: ChartSpec; onDrill?: (event: DrillEvent) => void }) {
  const { mark, x, y, series, max, vlSpec } = spec.chart
  const { ref, config, palette } = useChartConfig()
  useLayoutEffect(ensureTooltipStyle, [])

  // Click a bar / slice / point to drill into that category. The handler is
  // read through a ref so a new callback does not re-embed the chart.
  const drillRef = useRef(onDrill)
  drillRef.current = onDrill
  const chartRef = useRef(spec.chart)
  chartRef.current = spec.chart
  const drillable = Boolean(onDrill) && Boolean(x?.includes('.')) && mark !== 'line' && mark !== 'area'
  const onEmbed = useCallback(
    (result: { view: { addEventListener: (type: string, cb: (e: unknown, item: unknown) => void) => void } }) => {
      if (!drillable) return
      result.view.addEventListener('click', (_e, item) => {
        const datum = (item as { datum?: Record<string, unknown> } | null)?.datum
        const event = drillFor(chartRef.current, datum)
        if (event) drillRef.current?.(event)
      })
    },
    [drillable],
  )

  // Raw Vega-Lite escape hatch — render verbatim, injecting series as the
  // default dataset when the spec doesn't carry its own data.
  const rawSpec = useMemo<VlSpec | null>(() => {
    if (!vlSpec) return null
    // Theme as a DEFAULT — a raw spec carrying its own `config` wins outright.
    const s = { width: 'container', config, ...vlSpec } as VlSpec
    if (!('data' in s)) s.data = { values: series }
    return s
  }, [vlSpec, series, config])

  const compiled = useMemo<VlSpec | null>(
    () => (vlSpec || mark === 'progress' || series.length === 0 ? null : toVegaLite(spec.chart, palette)),
    [vlSpec, mark, series, spec.chart, palette],
  )

  if (series.length === 0 && !vlSpec) {
    return <div style={{ color: tokens.textFaint, fontSize: 13 }}>No data.</div>
  }
  // Every value zero: a flat line on an axis of 0.000000 says less than a
  // sentence does. Zero is still the answer, so say it.
  const valueKeys = [...(Array.isArray(y) ? y : [y]), spec.chart.y2].filter((k): k is string => !!k)
  if (!vlSpec && mark !== 'progress' && valueKeys.length > 0 && series.every((r) => valueKeys.every((k) => !Number(r[k])))) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 120, color: tokens.textMuted, fontSize: 13 }}>
        Zero across this window{valueKeys.length > 1 ? ' for every series' : ''}.
      </div>
    )
  }

  if (rawSpec) {
    return (
      <div ref={ref} style={{ width: '100%' }}>
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
              <div style={{ height: 8, borderRadius: 999, background: tokens.muted, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: 'var(--rpt-primary, #6366f1)' }} />
              </div>
              <span style={{ fontSize: 12, color: tokens.textMuted, width: 44, textAlign: 'right' }}>{Math.round(values[i])}</span>
            </div>
          )
        })}
      </div>
    )
  }

  const yKey = Array.isArray(y) ? (y.length === 1 ? y[0] : undefined) : y
  const ghost =
    spec.chart.comparison !== false &&
    !!yKey &&
    (mark === 'line' || mark === 'area' || mark === 'bar') &&
    series.some((r) => r[`__prev_${yKey}`] != null)

  return (
    <div ref={ref} style={{ width: '100%', cursor: drillable ? 'pointer' : undefined }}>
      {ghost && (
        <div style={{ display: 'flex', gap: 14, fontSize: 11, color: tokens.textMuted, marginBottom: 2 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, height: 2, borderRadius: 2, background: palette[0] }} /> This period
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 14, borderTop: '2px dashed #9ca3af' }} /> Previous period
          </span>
        </div>
      )}
      {compiled && (
        <Suspense fallback={<div style={{ height: spec.chart.height ?? 240 }} />}>
          <VegaEmbed
            spec={{ ...compiled, config } as VegaEmbedProps['spec']}
            options={EMBED_OPTIONS}
            onError={() => {}}
            onEmbed={onEmbed as VegaEmbedProps['onEmbed']}
            style={{ width: '100%' }}
          />
        </Suspense>
      )}
    </div>
  )
}
