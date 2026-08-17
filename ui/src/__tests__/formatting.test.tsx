/**
 * Rendering fixes found by looking at a real dashboard instead of a test
 * fixture. Each of these shipped, and each was visible in a screenshot:
 *
 *  - an average rendered `2.591`
 *  - a monthly cohort's bars were labelled `2026-04-01 00:…`
 *  - a `CREATED AT` column of timestamps rendered `—` (see the compiler test
 *    for the other half of that one — the value never reached the client)
 */
import { describe, it, expect } from 'vitest'
import { formatValue, formatNumber, formatDateValue, type ChartSpec, type TableSpec } from '../types'
import { draftToWidgetSpec, type QueryResultLite, type WidgetDraft } from '../querybuilder'

describe('a number a person reads at a glance', () => {
  it('gives an average one decimal, not the raw float', () => {
    // The shipped tile read "2.591" — `toLocaleString()` keeps three digits.
    expect(formatNumber(2.5906976744186047)).toBe('2.6')
    expect(formatValue(2.5906976744186047, 'number')).toBe('2.6')
  })

  it('drops a pointless .0 and keeps counts exact', () => {
    expect(formatNumber(3.0)).toBe('3')
    expect(formatNumber(1284)).toBe('1,284')
    expect(formatNumber(44)).toBe('44')
  })

  it('compacts only once the exact digits stop being the message', () => {
    expect(formatNumber(99_999)).toBe('99,999')
    expect(formatNumber(1_284_000)).toBe('1.3M')
  })

  it('keeps a tenth of a percent instead of rounding it away', () => {
    expect(formatValue(20.4, 'percent')).toBe('20.4%')
    expect(formatValue(20, 'percent')).toBe('20%')
  })

  it('renders a time cell as a date, and leaves a non-date alone', () => {
    expect(formatDateValue('2026-04-01 00:00:00+00')).toMatch(/Apr/)
    expect(formatValue('not a date', 'date')).toBe('not a date')
  })
})

const timeResult: QueryResultLite = {
  columns: [
    { key: 'W.workspace_id', kind: 'dimension' },
    { key: 'W.created_at', kind: 'time' },
    { key: 'W.days_active', kind: 'measure' },
  ],
  rows: [{ 'W.workspace_id': 'w1', 'W.created_at': '2026-04-01 00:00:00+00', 'W.days_active': 3 }],
}

describe('a table column of timestamps', () => {
  it('formats as a date without the widget having to say so', () => {
    const spec = draftToWidgetSpec(
      { as: 'table', query: { dimensions: ['W.workspace_id', 'W.created_at'] } } as WidgetDraft,
      timeResult,
    ) as TableSpec
    expect(spec.columns.find((c) => c.key === 'W.created_at')?.format).toBe('date')
  })

  it('still lets a widget override the format', () => {
    const spec = draftToWidgetSpec(
      {
        as: 'table',
        query: { dimensions: ['W.created_at'] },
        columns: { 'W.created_at': { format: 'text' } },
      } as WidgetDraft,
      timeResult,
    ) as TableSpec
    expect(spec.columns.find((c) => c.key === 'W.created_at')?.format).toBe('text')
  })
})

describe('bars over time', () => {
  const months = ['2026-04-01 00:00:00+00', '2026-05-01 00:00:00+00', '2026-06-01 00:00:00+00']
  const chart = (mark: 'bar' | 'line', x: string[]) =>
    (
      draftToWidgetSpec(
        { as: 'chart', mark, x: 'C.month', y: 'C.count', query: { measures: ['C.count'] } } as WidgetDraft,
        {
          columns: [
            { key: 'C.month', kind: 'time' },
            { key: 'C.count', kind: 'measure' },
          ],
          rows: x.map((m) => ({ 'C.month': m, 'C.count': 1 })),
        },
      ) as ChartSpec
    ).chart

  it('is a temporal axis, not a column of raw timestamp labels', async () => {
    // The cohort chart printed `2026-04-01 00:…` under every bar because a
    // non-line mark was forced to `nominal`.
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest(chart('bar', months))
    expect((vl.encoding as Record<string, { type: string }>).x.type).toBe('temporal')
  })

  it('carries the bucket as a timeUnit so bars have a band, not a hairline', async () => {
    const { toVegaLiteForTest } = await import('../components/Chart')
    const monthly = toVegaLiteForTest(chart('bar', months))
    expect((monthly.encoding as Record<string, { timeUnit?: string }>).x.timeUnit).toBe('yearmonth')

    const daily = toVegaLiteForTest(
      chart('bar', ['2026-04-01 00:00:00+00', '2026-04-02 00:00:00+00', '2026-04-03 00:00:00+00']),
    )
    expect((daily.encoding as Record<string, { timeUnit?: string }>).x.timeUnit).toBe('yearmonthdate')
  })

  it('leaves a line alone — no timeUnit, still temporal', async () => {
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest(chart('line', months))
    const x = (vl.encoding as Record<string, { type: string; timeUnit?: string }>).x
    expect(x.type).toBe('temporal')
    expect(x.timeUnit).toBeUndefined()
  })

  it('does not mistake a category for a date', async () => {
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest({
      mark: 'bar',
      x: 'B.band',
      y: 'B.count',
      series: [
        { 'B.band': 'never active', 'B.count': 5 },
        { 'B.band': 'one day only', 'B.count': 30 },
      ],
    })
    expect((vl.encoding as Record<string, { type: string }>).x.type).toBe('nominal')
  })
})

describe('a chart draws the rows in the order the query returned them', () => {
  const bands = [
    { band: 'Never active', n: 5 },
    { band: '1 day', n: 30 },
    { band: '2-4 days', n: 6 },
    { band: '5-14 days', n: 1 },
    { band: '15+ days', n: 2 },
  ]

  it('keeps an ordinal axis in its own order, not alphabetical', async () => {
    // Vega-Lite sorts a nominal axis alphabetically by default, which threw
    // away the query's ORDER BY: this exact histogram rendered
    // `1 day · 15+ days · 2-4 days · 5-14 days` and lost its shape.
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest({ mark: 'bar', x: 'band', y: 'n', series: bands })
    expect((vl.encoding as Record<string, { sort?: unknown }>).x.sort).toBeNull()
  })

  it('leaves a temporal axis to the scale, and stops its labels colliding', async () => {
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest({
      mark: 'line',
      x: 'day',
      y: 'n',
      series: [
        { day: '2026-04-01 00:00:00+00', n: 1 },
        { day: '2026-05-01 00:00:00+00', n: 2 },
      ],
    })
    const x = (vl.encoding as Record<string, { sort?: unknown; axis?: { labelOverlap?: string } }>).x
    expect(x.sort).toBeUndefined()
    expect(x.axis?.labelOverlap).toBe('greedy')
  })
})

describe('a note heading followed by its own sentence', () => {
  it('renders the heading, not the hashes', async () => {
    // `### Retention\nA rate is a snapshot` is ONE block, and the whole-block
    // pattern did not match it, so the report showed `### Retention`.
    const { render, screen } = await import('@testing-library/react')
    const { Note } = await import('../components/Note')
    render(<Note spec={{ type: 'note', markdown: '### Retention\nA rate is a snapshot.' }} />)
    expect(screen.getByText('Retention')).toBeTruthy()
    expect(screen.queryByText(/###/)).toBeNull()
    expect(screen.getByText('A rate is a snapshot.')).toBeTruthy()
  })
})

describe('a chart is never wider than the box it is drawn in', () => {
  it('takes the container width even with a handful of categories', async () => {
    // Sizing the plot to the data (150px per category) put a 640px SVG inside
    // a 506px widget: the fifth band and its label were drawn outside the
    // frame, present in the DOM and invisible to the reader.
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest({
      mark: 'bar',
      x: 'band',
      y: 'n',
      series: [
        { band: 'Never active', n: 5 },
        { band: '1 day', n: 30 },
        { band: '2-4 days', n: 6 },
        { band: '5-14 days', n: 1 },
        { band: '15+ days', n: 2 },
      ],
    })
    expect(vl.width).toBe('container')
    // Thickness is what stops two categories becoming slabs, not plot width.
    expect((vl.mark as { size?: number }).size).toBe(88)
  })

  it('leaves grouped bars to the band, which already sizes them', async () => {
    const { toVegaLiteForTest } = await import('../components/Chart')
    const vl = toVegaLiteForTest({
      mark: 'bar',
      x: 'month',
      y: 'n',
      color: 'series',
      stack: false,
      series: [{ month: 'Jan', n: 1, series: 'a' }, { month: 'Jan', n: 2, series: 'b' }],
    })
    expect((vl.mark as { size?: number }).size).toBeUndefined()
  })
})
