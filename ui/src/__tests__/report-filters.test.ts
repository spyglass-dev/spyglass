import { describe, it, expect } from 'vitest'
import { applyFilters, resolveBound, type BoundWidget, type CubeCapsMap } from '../report'

const CAPS: CubeCapsMap = {
  Orders: { dims: ['status', 'region'], timeField: 'created_at' },
  Totals: { dims: ['region'] }, // no timeField
}

const widget = (query: BoundWidget['query'], extra: Partial<BoundWidget> = {}): BoundWidget => ({
  type: 'bound',
  as: 'metric',
  query,
  ...extra,
})

describe('applyFilters — returns what it applied', () => {
  it('no active filters: identity query, empty applied, no skip flag', () => {
    const w = widget({ measures: ['Orders.count'], filters: [] })
    const out = applyFilters(w, {}, CAPS)
    expect(out.query).toBe(w.query)
    expect(out.applied).toEqual({ facets: [] })
  })

  it('reports the member the date range landed on', () => {
    const w = widget({ measures: ['Orders.count'], filters: [] })
    const out = applyFilters(w, { datePreset: 'last_30d' }, CAPS)
    expect(out.applied.dateRange).toBe('Orders.created_at')
    expect(out.applied.dateRangeSkipped).toBeUndefined()
    const ops = (out.query.filters ?? []).filter((f) => f.member === 'Orders.created_at').map((f) => f.operator)
    expect(ops).toEqual(['gte', 'lt'])
  })

  it('reports applied facet keys, and omits ones the query groups by', () => {
    const w = widget({ measures: ['Orders.count'], dimensions: ['Orders.status'], filters: [] })
    const out = applyFilters(w, { facets: { status: ['open'], region: ['emea'] } }, CAPS)
    expect(out.applied.facets).toEqual(['region'])
    expect(out.query.filters).toContainEqual({ member: 'Orders.region', operator: 'in', values: ['emea'] })
    expect(out.query.filters?.some((f) => f.member === 'Orders.status')).toBe(false)
  })

  it('an active range a cube cannot receive is reported, not silent: no_time_field', () => {
    const w = widget({ measures: ['Totals.count'], filters: [] })
    const out = applyFilters(w, { datePreset: 'last_30d' }, CAPS)
    expect(out.applied.dateRange).toBeUndefined()
    expect(out.applied.dateRangeSkipped).toBe('no_time_field')
  })

  it('a per-widget opt-out is reported: opted_out (ignore and dateField: null)', () => {
    const ignored = widget({ measures: ['Orders.count'], filters: [] }, { filters: { ignore: true } })
    expect(applyFilters(ignored, { datePreset: 'last_30d' }, CAPS).applied.dateRangeSkipped).toBe('opted_out')
    const noDate = widget({ measures: ['Orders.count'], filters: [] }, { filters: { dateField: null } })
    expect(applyFilters(noDate, { datePreset: 'last_30d' }, CAPS).applied.dateRangeSkipped).toBe('opted_out')
  })

  it('a query that already pins the time member is reported: widget_pinned', () => {
    const w = widget({
      measures: ['Orders.count'],
      filters: [{ member: 'Orders.created_at', operator: 'gte', values: ['2026-01-01'] }],
    })
    const out = applyFilters(w, { datePreset: 'last_30d' }, CAPS)
    expect(out.applied.dateRange).toBeUndefined()
    expect(out.applied.dateRangeSkipped).toBe('widget_pinned')
  })

  it('a cube the host declared nothing about is reported: unknown_cube', () => {
    const w = widget({ measures: ['Mystery.count'], filters: [] })
    const out = applyFilters(w, { datePreset: 'last_30d' }, CAPS)
    expect(out.applied.dateRangeSkipped).toBe('unknown_cube')
  })

  it('no skip flag when the report has facets active but no date range', () => {
    const w = widget({ measures: ['Totals.count'], filters: [] })
    const out = applyFilters(w, { facets: { region: ['emea'] } }, CAPS)
    expect(out.applied.dateRangeSkipped).toBeUndefined()
  })
})

describe('resolveBound — applied metadata reaches the resolved spec', () => {
  const runQuery = async () => ({ columns: [{ key: 'Totals.count', kind: 'measure' }], rows: [{ 'Totals.count': 7 }] })

  it('attaches applied to the widget spec so a frame can render an unfiltered marker', async () => {
    const w = widget({ measures: ['Totals.count'], filters: [] })
    const spec = await resolveBound(w, { runQuery, filters: { datePreset: 'last_30d' }, cubeCaps: CAPS })
    expect(spec.applied?.dateRangeSkipped).toBe('no_time_field')

    const ok = await resolveBound(widget({ measures: ['Orders.count'], filters: [] }), {
      runQuery,
      filters: { datePreset: 'last_30d' },
      cubeCaps: CAPS,
    })
    expect(ok.applied?.dateRange).toBe('Orders.created_at')
    expect(ok.applied?.dateRangeSkipped).toBeUndefined()
  })
})
