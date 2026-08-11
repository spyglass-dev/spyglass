/**
 * DataGrid stories — named for the STATE each one shows. The server-driven
 * story simulates an engine: header clicks and the pager patch the QUERY
 * (order/offset) and the "server" returns the matching page — the grid itself
 * never sorts or slices client-side.
 *
 * Domain-agnostic sample data in the Pagila DVD-rental shape.
 */
import { useMemo, useState } from 'react'
import { DataGrid, type GridQueryDelta } from './components/DataGrid'
import { applyGridDelta, type WidgetQuery } from './querybuilder'
import type { TableSpec } from './types'

const meta = {
  title: 'Reporting/DataGrid',
  component: DataGrid,
}
export default meta

const FIRST = ['Karl', 'Eleanor', 'Clara', 'Marion', 'Rhonda', 'Tommy', 'Wesley', 'Diane', 'Ana', 'Louis']
const LAST = ['Seal', 'Hunt', 'Shaw', 'Snyder', 'Kennedy', 'Collazo', 'Bull', 'Collins', 'Bradley', 'Leone']

/** 312 deterministic customers with revenue + rentals. */
const CUSTOMERS = Array.from({ length: 312 }, (_, i) => ({
  'Payments.customer_id': `cust-${String(i + 1).padStart(4, '0')}`,
  'Payments.customer_id__label': `${FIRST[i % 10]} ${LAST[Math.floor(i / 10) % 10]} ${Math.floor(i / 100) + 1}`,
  'Payments.revenue': Math.round(((i * 37) % 220) + 15 + (i % 7) * 3),
  'Payments.rentals': ((i * 13) % 45) + 2,
}))

const COLUMNS: TableSpec['columns'] = [
  { key: 'Payments.customer_id', label: 'Customer' },
  { key: 'Payments.customer_id__label', label: 'customer_id__label' },
  { key: 'Payments.revenue', label: 'Revenue', align: 'right', format: 'currency' },
  { key: 'Payments.rentals', label: 'Rentals', align: 'right', format: 'number' },
]

/** The pretend engine: applies order/offset/limit to the full dataset. */
function runQuery(query: WidgetQuery) {
  let rows = [...CUSTOMERS]
  const order = query.order?.[0]
  if (order) {
    rows.sort((a, b) => {
      const av = a[order.member as keyof typeof a]
      const bv = b[order.member as keyof typeof b]
      const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv))
      return order.desc ? -cmp : cmp
    })
  }
  const offset = query.offset ?? 0
  const limit = query.limit ?? rows.length
  return { rows: rows.slice(offset, offset + limit), total: rows.length }
}

function ServerDrivenGrid() {
  const [query, setQuery] = useState<WidgetQuery>({
    dimensions: ['Payments.customer_id'],
    measures: ['Payments.revenue', 'Payments.rentals'],
    limit: 25,
    includeTotal: true,
  })
  const { rows, total } = useMemo(() => runQuery(query), [query])
  const order = query.order?.[0]
  const spec: TableSpec = {
    type: 'table',
    title: 'Top customers',
    columns: COLUMNS,
    rows,
    total,
    page: { offset: query.offset ?? 0, limit: query.limit },
    sort: order ? { key: order.member, desc: order.desc ?? false } : undefined,
    bars: 'Payments.revenue',
  }
  const onQuery = (delta: GridQueryDelta) => setQuery((q) => applyGridDelta(q, delta))
  return <DataGrid spec={spec} onQuery={onQuery} />
}

export const ServerDrivenSortAndPaging = {
  render: () => <ServerDrivenGrid />,
}

export const SortedDescWithBars = {
  render: () => {
    const { rows, total } = runQuery({
      order: [{ member: 'Payments.revenue', desc: true }],
      limit: 10,
    })
    return (
      <DataGrid
        spec={{
          type: 'table',
          columns: COLUMNS,
          rows,
          total,
          page: { offset: 0, limit: 10 },
          sort: { key: 'Payments.revenue', desc: true },
          bars: 'Payments.revenue',
        }}
        onQuery={() => {}}
      />
    )
  },
}

export const TruncatedByRowCap = {
  render: () => (
    <DataGrid
      spec={{
        type: 'table',
        columns: COLUMNS,
        rows: runQuery({ limit: 8 }).rows,
        truncatedAt: 5000,
      }}
    />
  ),
}

export const VirtualizedTallGrid = {
  render: () => {
    // 312 static rows > VIRTUALIZE_AT — only the visible window mounts.
    const { rows } = runQuery({})
    return <DataGrid spec={{ type: 'table', columns: COLUMNS, rows }} />
  },
}

export const StaticNoControls = {
  render: () => (
    <DataGrid
      spec={{
        type: 'table',
        columns: [
          { key: 'name', label: 'Film' },
          { key: 'rentals', label: 'Rentals', align: 'right' },
        ],
        rows: [
          { name: 'Bucket Brotherhood', rentals: 34 },
          { name: 'Rocketeer Mother', rentals: 33 },
        ],
      }}
    />
  ),
}

export const EmptyDataset = {
  render: () => <DataGrid spec={{ type: 'table', columns: COLUMNS, rows: [] }} />,
}
