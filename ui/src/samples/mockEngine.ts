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
        { name: 'revenue', member: 'Payments.revenue', title: 'Revenue', format: 'currency', featured: true, unit: '$', description: 'Total amount paid.' },
        { name: 'avg', member: 'Payments.avg', title: 'Average payment', format: 'currency', unit: '$' },
      ],
      dimensions: [
        { name: 'store', member: 'Payments.store', type: 'string', featured: true },
        { name: 'rating', member: 'Payments.rating', type: 'string', description: 'MPAA film rating.' },
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

/** A mock query runner — resolves after a short delay with plausible rows.
 *  Honors `equals` filters (drill-down) and `mode: 'rows'` (records drawer),
 *  so the drill stories behave like a real engine. */
export function mockRunQuery(delayMs = 350) {
  return (query: WidgetQuery): Promise<QueryResultLite> =>
    new Promise((resolve) => {
      setTimeout(() => {
        if (query.mode === 'rows') {
          // Record-level rows, as the engine's drill_members projection.
          const keys = ['Rentals.rental_id', 'Rentals.customer_name', 'Rentals.rented_at', 'Rentals.amount']
          const names = ['Karl Seal', 'Eleanor Hunt', 'Clara Shaw', 'Marion Snyder', 'Rhonda Kennedy', 'Tommy Collazo']
          const rows = Array.from({ length: 6 }, (_, i) => ({
            'Rentals.rental_id': `r-${1041 + i * 7}`,
            'Rentals.customer_name': names[i],
            'Rentals.rented_at': `2022-06-${String(3 + i * 4).padStart(2, '0')}`,
            'Rentals.amount': (fakeValue('avg', i + 2) % 9) + 0.99,
          }))
          resolve({ columns: keys.map((key) => ({ key, kind: 'dimension' })), rows })
          return
        }
        const measures = query.measures ?? []
        const dimension = query.dimensions?.[0]
        const columns = [
          ...(dimension ? [{ key: dimension, kind: 'dimension' }] : []),
          ...measures.map((m) => ({ key: m, kind: 'measure' })),
        ]
        // Drill-down filters narrow the grouped dimension's categories.
        const equalsOn = (member: string) =>
          (query.filters ?? [])
            .filter((f) => f.member === member && f.operator === 'equals')
            .flatMap((f) => f.values ?? [])
        let cats: (string | undefined)[] = dimension ? DIM_VALUES[dimension] ?? ['A', 'B', 'C'] : [undefined]
        if (dimension) {
          const wanted = equalsOn(dimension)
          if (wanted.length) cats = cats.filter((c) => wanted.includes(c as string))
        }
        const rows = cats.map((cat, i) => {
          const row: Record<string, unknown> = {}
          if (dimension && cat !== undefined) row[dimension] = cat
          measures.forEach((m) => (row[m] = fakeValue(m, i + 1)))
          return row
        })
        // A plausible compiled statement, so the Explain panel has something
        // to show (the real engine returns QueryResult.sql).
        const cube = (measures[0] ?? dimension ?? 'Payments.count').split('.')[0]
        const sql = [
          `select ${[dimension, ...measures].filter(Boolean).map((m) => `${String(m).split('.')[1]}`).join(', ')}`,
          `from ${cube.toLowerCase()} as "${cube}"`,
          ...(query.filters?.length
            ? [`where ${query.filters.map((f, i) => `${f.member.split('.')[1]} ${f.operator} $${i + 1}`).join(' and ')}`]
            : []),
          ...(dimension ? [`group by ${dimension.split('.')[1]}`] : []),
        ].join('\n')
        resolve({ columns, rows, sql })
      }, delayMs)
    })
}
