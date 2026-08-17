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
