/**
 * DataGrid invariants. The load-bearing one: sort and paging WRITE QUERY
 * DELTAS — the grid never re-sorts or slices its rows client-side. A header
 * click on page 3 must produce page 1 of the new ordering, from the server.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import {
  DataGrid,
  pageLabel,
  tableToCsv,
  virtualWindow,
  visibleColumns,
  VIRTUALIZE_AT,
} from '../components/DataGrid'
import { applyGridDelta, draftToWidgetSpec } from '../querybuilder'
import type { TableSpec } from '../types'

const spec = (extra?: Partial<TableSpec>): TableSpec => ({
  type: 'table',
  columns: [
    { key: 'Orders.customer_id', label: 'Customer' },
    { key: 'Orders.customer_id__label', label: 'customer_id__label' },
    { key: 'Orders.revenue', label: 'Revenue', align: 'right', format: 'currency' },
  ],
  rows: [
    { 'Orders.customer_id': 'c-1', 'Orders.customer_id__label': 'Karl Seal', 'Orders.revenue': 221 },
    { 'Orders.customer_id': 'c-2', 'Orders.customer_id__label': 'Eleanor Hunt', 'Orders.revenue': 216 },
  ],
  ...extra,
})

describe('server-driven sort', () => {
  it('cycles none → asc → desc → clear, resetting to the first page each time', () => {
    const onQuery = vi.fn()
    const { rerender } = render(<DataGrid spec={spec({ page: { offset: 50, limit: 25 } })} onQuery={onQuery} />)

    fireEvent.click(screen.getByText('Revenue'))
    expect(onQuery).toHaveBeenLastCalledWith({
      order: [{ member: 'Orders.revenue', desc: false }],
      offset: 0,
    })

    rerender(
      <DataGrid
        spec={spec({ sort: { key: 'Orders.revenue', desc: false } })}
        onQuery={onQuery}
      />,
    )
    fireEvent.click(screen.getByText(/Revenue/))
    expect(onQuery).toHaveBeenLastCalledWith({
      order: [{ member: 'Orders.revenue', desc: true }],
      offset: 0,
    })

    rerender(
      <DataGrid spec={spec({ sort: { key: 'Orders.revenue', desc: true } })} onQuery={onQuery} />,
    )
    fireEvent.click(screen.getByText(/Revenue/))
    expect(onQuery).toHaveBeenLastCalledWith({ order: [], offset: 0 })
  })

  it('does not sort client-side: rows render in given order regardless of clicks', () => {
    render(<DataGrid spec={spec()} onQuery={() => {}} />)
    const cells = screen.getAllByText(/Karl Seal|Eleanor Hunt/).map((el) => el.textContent)
    expect(cells).toEqual(['Karl Seal', 'Eleanor Hunt'])
  })

  it('renders no sort affordance without onQuery (static data)', () => {
    render(<DataGrid spec={spec()} />)
    expect(screen.getByText('Revenue').getAttribute('role')).toBeNull()
  })
})

describe('server-driven paging', () => {
  it('next/prev emit offset deltas from the current page', () => {
    const onQuery = vi.fn()
    render(<DataGrid spec={spec({ page: { offset: 25, limit: 25 }, total: 312 })} onQuery={onQuery} />)
    fireEvent.click(screen.getByText('Next ›'))
    expect(onQuery).toHaveBeenLastCalledWith({ offset: 50 })
    fireEvent.click(screen.getByText('‹ Prev'))
    expect(onQuery).toHaveBeenLastCalledWith({ offset: 0 })
  })

  it('shows "26–27 of 312" from the engine total', () => {
    render(<DataGrid spec={spec({ page: { offset: 25, limit: 25 }, total: 312 })} onQuery={() => {}} />)
    expect(screen.getByText('26–27 of 312')).toBeTruthy()
  })

  it('disables Next on the last page', () => {
    render(<DataGrid spec={spec({ page: { offset: 310, limit: 25 }, total: 312 })} onQuery={() => {}} />)
    expect((screen.getByText('Next ›') as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows the truncation notice when the engine clamped', () => {
    render(<DataGrid spec={spec({ truncatedAt: 5000 })} />)
    expect(screen.getByText(/truncated at 5,000 rows/)).toBeTruthy()
  })
})

describe('pageLabel', () => {
  it('formats ranges and totals', () => {
    expect(pageLabel(0, 25, 312)).toBe('1–25 of 312')
    expect(pageLabel(25, 25)).toBe('26–50')
    expect(pageLabel(0, 1, 1)).toBe('1 of 1')
    expect(pageLabel(0, 0, 312)).toBe('0 of 312')
    expect(pageLabel(0, 0)).toBe('0 rows')
  })
})

describe('label resolution', () => {
  it('hides __label columns and renders the label in the base column', () => {
    render(<DataGrid spec={spec()} />)
    expect(screen.getByText('Karl Seal')).toBeTruthy()
    expect(screen.queryByText('c-1')).toBeNull()
    expect(screen.queryByText('customer_id__label')).toBeNull()
  })

  it('falls back to the raw id when no label row value exists', () => {
    const s = spec()
    s.rows = [{ 'Orders.customer_id': 'c-9', 'Orders.revenue': 1 }]
    render(<DataGrid spec={s} />)
    expect(screen.getByText('c-9')).toBeTruthy()
  })

  it('visibleColumns keeps a lone __label column with no base', () => {
    const cols = visibleColumns({
      type: 'table',
      columns: [{ key: 'x__label', label: 'X' }],
      rows: [],
    })
    expect(cols.length).toBe(1)
  })
})

describe('tableToCsv', () => {
  it('escapes quotes/commas/newlines and resolves labels', () => {
    const s = spec()
    s.rows = [
      {
        'Orders.customer_id': 'c-1',
        'Orders.customer_id__label': 'Seal, "Karl"',
        'Orders.revenue': null,
      },
    ]
    expect(tableToCsv(s)).toBe('Customer,Revenue\n"Seal, ""Karl""",')
  })
})

describe('virtualWindow', () => {
  it('windows a tall list with overscan and exact pad heights', () => {
    const w = virtualWindow(1000, 340, 480, 34)
    expect(w.start).toBe(0) // 340/34=10, minus overscan
    expect(w.end).toBe(35) // ceil(820/34)=25, plus overscan
    expect(w.padTop).toBe(0)
    expect(w.padBottom).toBe((1000 - 35) * 34)
  })

  it('clamps to the row count at the tail', () => {
    const w = virtualWindow(100, 1e9)
    expect(w.end).toBe(100)
    expect(w.start).toBeLessThanOrEqual(100)
  })

  it('mounts only a window of rows past the threshold', () => {
    const rows = Array.from({ length: VIRTUALIZE_AT + 300 }, (_, i) => ({
      'Orders.customer_id': `c-${i}`,
      'Orders.revenue': i,
    }))
    const { container } = render(
      <DataGrid spec={{ type: 'table', columns: [{ key: 'Orders.customer_id', label: 'Customer' }], rows }} />,
    )
    const mounted = container.querySelectorAll('tbody tr').length
    expect(mounted).toBeLessThan(100) // window + 2 pad rows, not 500
  })
})

describe('applyGridDelta', () => {
  const base = { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id'], limit: 25 }

  it('writes order and offset into the query', () => {
    const q = applyGridDelta(base, { order: [{ member: 'Orders.revenue', desc: true }], offset: 0 })
    expect(q.order).toEqual([{ member: 'Orders.revenue', desc: true }])
    expect(q.offset).toBeUndefined() // offset 0 stays implicit
    const paged = applyGridDelta(q, { offset: 50 })
    expect(paged.offset).toBe(50)
  })

  it('clears the sort with an empty order array', () => {
    const q = applyGridDelta({ ...base, order: [{ member: 'Orders.revenue' }] }, { order: [] })
    expect(q.order).toBeUndefined()
  })
})

describe('draftToWidgetSpec table paging state', () => {
  it('carries total/truncated/page/sort from the result and query', () => {
    const s = draftToWidgetSpec(
      {
        as: 'table',
        query: {
          measures: ['Orders.revenue'],
          dimensions: ['Orders.customer_id'],
          limit: 25,
          offset: 25,
          includeTotal: true,
          order: [{ member: 'Orders.revenue', desc: true }],
        },
      },
      {
        columns: [
          { key: 'Orders.customer_id', kind: 'dimension' },
          { key: 'Orders.revenue', kind: 'measure' },
        ],
        rows: [],
        total: 312,
        truncated_at: 5000,
      },
    )
    expect(s).toMatchObject({
      type: 'table',
      total: 312,
      truncatedAt: 5000,
      page: { offset: 25, limit: 25 },
      sort: { key: 'Orders.revenue', desc: true },
    })
  })
})

describe('draftToWidgetSpec drill entity', () => {
  it('maps the result column drill_entity onto TableColumn.drillEntity', () => {
    const s = draftToWidgetSpec(
      { as: 'table', query: { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id', 'Orders.status'] } },
      {
        columns: [
          { key: 'Orders.customer_id', kind: 'dimension', drill_entity: 'customer' },
          { key: 'Orders.status', kind: 'dimension' },
          { key: 'Orders.revenue', kind: 'measure' },
        ],
        rows: [],
      },
    )
    if (s.type !== 'table') throw new Error('expected table')
    expect(s.columns.find((c) => c.key === 'Orders.customer_id')?.drillEntity).toBe('customer')
    expect(s.columns.find((c) => c.key === 'Orders.status')?.drillEntity).toBeUndefined()
  })
})
