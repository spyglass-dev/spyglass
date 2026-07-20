/**
 * A tiny in-memory reporting engine for stories/samples — no server. It answers
 * `WidgetQuery`s over a fake "Pagila" DVD-rental catalog so you can see the
 * framework work end to end. Swap this for your real `/query` + `/meta`.
 */
import type { CubeModelMeta, QueryResultLite, WidgetQuery } from '../querybuilder'
import type { CubeCapsMap } from '../report'

export const MOCK_META: CubeModelMeta = {
  cubes: [
    {
      name: 'Payments',
      title: 'Payments',
      measures: [
        { name: 'count', member: 'Payments.count', title: 'Payments' },
        { name: 'revenue', member: 'Payments.revenue', title: 'Revenue', format: 'currency' },
        { name: 'avg', member: 'Payments.avg', title: 'Average payment', format: 'currency' },
      ],
      dimensions: [
        { name: 'store', member: 'Payments.store', type: 'string' },
        { name: 'rating', member: 'Payments.rating', type: 'string' },
        { name: 'created_at', member: 'Payments.created_at', type: 'time' },
      ],
    },
    {
      name: 'Rentals',
      title: 'Rentals',
      measures: [
        { name: 'count', member: 'Rentals.count', title: 'Rentals' },
        { name: 'customers', member: 'Rentals.customers', title: 'Renting customers' },
      ],
      dimensions: [
        { name: 'store', member: 'Rentals.store', type: 'string' },
        { name: 'status', member: 'Rentals.status', type: 'string' },
        { name: 'created_at', member: 'Rentals.created_at', type: 'time' },
      ],
    },
  ],
}

/** Cube capabilities for report-filter application. */
export const MOCK_CAPS: CubeCapsMap = {
  Payments: { dims: ['store', 'rating', 'status'], timeField: 'created_at' },
  Rentals: { dims: ['store', 'status'], timeField: 'created_at' },
}

const DIM_VALUES: Record<string, string[]> = {
  'Payments.store': ['Store 1', 'Store 2'],
  'Payments.rating': ['G', 'PG', 'PG-13', 'R', 'NC-17'],
  'Rentals.store': ['Store 1', 'Store 2'],
  'Rentals.status': ['returned', 'out'],
}

function fakeValue(member: string, seed: number): number {
  const base = member.includes('revenue') ? 8000 : member.includes('avg') ? 4 : member.includes('customers') ? 300 : 60
  return Math.round(base * (0.4 + ((seed * 37) % 100) / 100))
}

/** A mock query runner — resolves after a short delay with plausible rows. */
export function mockRunQuery(delayMs = 350) {
  return (query: WidgetQuery): Promise<QueryResultLite> =>
    new Promise((resolve) => {
      setTimeout(() => {
        const measures = query.measures ?? []
        const dimension = query.dimensions?.[0]
        const columns = [
          ...(dimension ? [{ key: dimension, kind: 'dimension' }] : []),
          ...measures.map((m) => ({ key: m, kind: 'measure' })),
        ]
        const cats = dimension ? DIM_VALUES[dimension] ?? ['A', 'B', 'C'] : [undefined]
        const rows = cats.map((cat, i) => {
          const row: Record<string, unknown> = {}
          if (dimension && cat !== undefined) row[dimension] = cat
          measures.forEach((m) => (row[m] = fakeValue(m, i + 1)))
          return row
        })
        resolve({ columns, rows })
      }, delayMs)
    })
}
