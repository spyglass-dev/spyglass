/**
 * Pivot invariants. The one that matters most: **a missing cell is not a
 * zero.** An absent combination, a present-but-null measure, and a real 0 are
 * three different states — a gradebook that conflates them lies.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { buildPivot, MAX_PIVOT_COLS, Pivot } from '../components/Pivot'
import { draftToWidgetSpec } from '../querybuilder'
import type { PivotSpec } from '../types'

const base: Omit<PivotSpec, 'data'> = {
  type: 'pivot',
  rows: ['Orders.customer_id'],
  cols: ['Orders.product_id'],
  measure: 'Orders.total_amount',
}

const spec = (data: PivotSpec['data'], extra?: Partial<PivotSpec>): PivotSpec => ({
  ...base,
  data,
  ...extra,
})

// c1×p1 = 10, c1×p2 = null (present, unknown), c2×p2 = 0 (real zero);
// c2×p1 never appears (absent).
const sparse = [
  { 'Orders.customer_id': 'c1', 'Orders.product_id': 'p1', 'Orders.total_amount': 10 },
  { 'Orders.customer_id': 'c1', 'Orders.product_id': 'p2', 'Orders.total_amount': null },
  { 'Orders.customer_id': 'c2', 'Orders.product_id': 'p2', 'Orders.total_amount': 0 },
]

describe('buildPivot', () => {
  it('keeps absent, null, and zero as three distinct states', () => {
    const b = buildPivot(spec(sparse))
    const [c1, c2] = b.rows
    expect(c1.cells[0]).toEqual({ state: 'value', value: 10 })
    expect(c1.cells[1]).toEqual({ state: 'null' })
    expect(c2.cells[0]).toEqual({ state: 'absent' })
    expect(c2.cells[1]).toEqual({ state: 'value', value: 0 })
  })

  it('excludes absent and null cells from totals by default', () => {
    const b = buildPivot(spec(sparse, { totals: { row: 'avg', col: 'avg' } }))
    // c1: only the 10 counts (null excluded) → avg 10, NOT 5.
    expect(b.rows[0].total).toBe(10)
    // c2: only the real 0 counts (absent excluded) → avg 0.
    expect(b.rows[1].total).toBe(0)
    // p1 column: 10 only (c2×p1 absent) → 10, NOT 5.
    expect(b.colTotals?.[0]).toBe(10)
    // grand: avg of row totals (10, 0) → 5.
    expect(b.grandTotal).toBe(5)
  })

  it("counts absent as 0 in totals only under empty: 'zero' — null never", () => {
    const b = buildPivot(spec(sparse, { empty: 'zero', totals: { row: 'avg' } }))
    // c1: 10 and a null → null still excluded → 10.
    expect(b.rows[0].total).toBe(10)
    // c2: absent (now 0) + real 0 → avg 0.
    expect(b.rows[1].total).toBe(0)
  })

  it('sums edges when asked', () => {
    const b = buildPivot(spec(sparse, { totals: { row: 'sum', col: 'sum' } }))
    expect(b.rows[0].total).toBe(10)
    expect(b.colTotals).toEqual([10, 0])
    expect(b.grandTotal).toBe(10)
  })

  it('prefers the __label companion for headers', () => {
    const b = buildPivot(
      spec([
        {
          'Orders.customer_id': 'c1',
          'Orders.customer_id__label': 'Karl Seal',
          'Orders.product_id': 'p1',
          'Orders.product_id__label': 'Widget',
          'Orders.total_amount': 3,
        },
      ]),
    )
    expect(b.rows[0].item.label).toBe('Karl Seal')
    expect(b.cols[0].label).toBe('Widget')
  })

  it('keeps first-appearance order from the query result', () => {
    const b = buildPivot(
      spec([
        { 'Orders.customer_id': 'z', 'Orders.product_id': 'p9', 'Orders.total_amount': 1 },
        { 'Orders.customer_id': 'a', 'Orders.product_id': 'p1', 'Orders.total_amount': 2 },
      ]),
    )
    expect(b.rows.map((r) => r.item.key)).toEqual(['z', 'a'])
    expect(b.cols.map((c) => c.key)).toEqual(['p9', 'p1'])
  })

  it('truncates visibly beyond the caps, never silently', () => {
    const wide: PivotSpec['data'] = []
    for (let i = 0; i < MAX_PIVOT_COLS + 5; i++) {
      wide.push({ 'Orders.customer_id': 'c1', 'Orders.product_id': `p${i}`, 'Orders.total_amount': i })
    }
    const b = buildPivot(spec(wide))
    expect(b.cols.length).toBe(MAX_PIVOT_COLS)
    expect(b.truncatedCols).toBe(5)
    expect(b.truncatedRows).toBe(0)
  })

  it('tracks min/max of real values only (for shading)', () => {
    const b = buildPivot(spec(sparse))
    expect(b.min).toBe(0)
    expect(b.max).toBe(10)
  })
})

describe('<Pivot />', () => {
  it('renders dash for absent, n/a for null, and the formatted zero', () => {
    render(<Pivot spec={spec(sparse, { format: 'number' })} />)
    expect(screen.getByText('—')).toBeTruthy()
    expect(screen.getByText('n/a')).toBeTruthy()
    expect(screen.getByText('0')).toBeTruthy()
    expect(screen.getByText('10')).toBeTruthy()
  })

  it("renders absent as 0 under empty: 'zero' while null stays n/a", () => {
    render(<Pivot spec={spec(sparse, { empty: 'zero' })} />)
    expect(screen.queryByText('—')).toBeNull()
    expect(screen.getByText('n/a')).toBeTruthy()
    expect(screen.getAllByText('0').length).toBe(2) // the real zero + the filled absence
  })

  it('shows the truncation notice when capped', () => {
    const wide: PivotSpec['data'] = []
    for (let i = 0; i < MAX_PIVOT_COLS + 3; i++) {
      wide.push({ 'Orders.customer_id': 'c1', 'Orders.product_id': `p${i}`, 'Orders.total_amount': i })
    }
    render(<Pivot spec={spec(wide)} />)
    expect(screen.getByText(/3 more columns/)).toBeTruthy()
  })

  it('renders an empty state for no data', () => {
    render(<Pivot spec={spec([])} />)
    expect(screen.getByText('No data.')).toBeTruthy()
  })
})

describe('draftToWidgetSpec pivot branch', () => {
  const result = {
    columns: [
      { key: 'Orders.customer_id', kind: 'dimension' },
      { key: 'Orders.product_id', kind: 'dimension' },
      { key: 'Orders.total_amount', kind: 'measure' },
    ],
    rows: sparse,
  }

  it('maps dims[0]→rows, dims[1]→cols, measures[0]→measure', () => {
    const spec = draftToWidgetSpec(
      {
        as: 'pivot',
        query: {
          measures: ['Orders.total_amount'],
          dimensions: ['Orders.customer_id', 'Orders.product_id'],
        },
      },
      result,
    )
    expect(spec).toMatchObject({
      type: 'pivot',
      w: 4,
      rows: ['Orders.customer_id'],
      cols: ['Orders.product_id'],
      measure: 'Orders.total_amount',
    })
  })

  it('degrades to a table with fewer than two dimensions', () => {
    const spec = draftToWidgetSpec(
      { as: 'pivot', query: { measures: ['Orders.total_amount'], dimensions: ['Orders.customer_id'] } },
      result,
    )
    expect(spec.type).toBe('table')
  })
})
