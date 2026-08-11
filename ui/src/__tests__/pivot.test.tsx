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
    expect(c1.cells[0]).toMatchObject({ state: 'value', value: 10 })
    expect(c1.cells[1]).toMatchObject({ state: 'null' })
    expect(c2.cells[0]).toEqual({ state: 'absent' })
    expect(c2.cells[1]).toMatchObject({ state: 'value', value: 0 })
    // Present cells keep their SOURCE row — what makes a cell a drill target.
    expect((c1.cells[0] as { row?: unknown }).row).toMatchObject({ 'Orders.customer_id': 'c1' })
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

// Ratio (weighted) totals: two "assignments" with very different weight.
// c1: earned 1/1 (100%) and 1/9 (11.1%). A mean of cell percentages says
// ~55.6 — the weighted truth is 2 of 10 marks = 20.
const weighted = [
  { 'S.student': 'c1', 'S.activity': 'a1', 'S.pct': 100, 'S.earned': 1, 'S.possible': 1 },
  { 'S.student': 'c1', 'S.activity': 'a2', 'S.pct': 11.11, 'S.earned': 1, 'S.possible': 9 },
  { 'S.student': 'c2', 'S.activity': 'a1', 'S.pct': 0, 'S.earned': 0, 'S.possible': 1 },
]
const ratio = { ratio: { num: 'S.earned', den: 'S.possible', scale: 100 } }
const wspec = (extra?: Partial<PivotSpec>): PivotSpec => ({
  type: 'pivot',
  rows: ['S.student'],
  cols: ['S.activity'],
  measure: 'S.pct',
  data: weighted,
  ...extra,
})

describe('ratio (weighted) totals', () => {
  it('a row total is Σnum/Σden — not the mean of cell percentages', () => {
    const b = buildPivot(wspec({ totals: { row: ratio } }))
    expect(b.rows[0].total).toBeCloseTo(20) // 2/10 marks, NOT ~55.6
    expect(b.rows[1].total).toBeCloseTo(0)
  })

  it('column and grand totals re-derive from source rows (no ratio-of-ratios)', () => {
    const b = buildPivot(wspec({ totals: { row: ratio, col: ratio } }))
    expect(b.colTotals?.[0]).toBeCloseTo(50) // a1: 1 of 2 marks
    expect(b.colTotals?.[1]).toBeCloseTo(100 / 9) // a2: 1 of 9
    expect(b.grandTotal).toBeCloseTo((2 / 11) * 100) // all: 2 of 11 marks
  })

  it('an absent combination contributes nothing to a ratio total', () => {
    // c2 never met a2: their total is over a1 only (0/1), not 0/10.
    const b = buildPivot(wspec({ totals: { row: ratio } }))
    expect(b.rows[1].total).toBeCloseTo(0)
    const denOnlyPresent = buildPivot(
      wspec({ totals: { row: ratio }, data: weighted.slice(0, 2) }),
    )
    expect(denOnlyPresent.rows[0].total).toBeCloseTo(20)
  })
})

describe('cell drill', () => {
  it('clicking a present cell hands back its SOURCE row and the measure', () => {
    const clicks: unknown[] = []
    render(
      <Pivot
        spec={spec(sparse)}
        onMeasureClick={(row, measure) => clicks.push({ row, measure })}
      />,
    )
    screen.getByText('10').click()
    expect(clicks).toHaveLength(1)
    expect(clicks[0]).toMatchObject({
      measure: 'Orders.total_amount',
      row: { 'Orders.customer_id': 'c1', 'Orders.product_id': 'p1' },
    })
  })

  it('an absent cell is not a drill target', () => {
    const clicks: unknown[] = []
    render(<Pivot spec={spec(sparse)} onMeasureClick={(row) => clicks.push(row)} />)
    // c2×p1 is absent → renders the dash, unclickable.
    const dash = screen.getByText('—')
    expect(dash.getAttribute('role')).toBeNull()
    dash.click()
    expect(clicks).toHaveLength(0)
  })
})

describe('pivot options through the draft', () => {
  it('draftToWidgetSpec carries totals/scale/empty onto the spec', () => {
    const s = draftToWidgetSpec(
      {
        as: 'pivot',
        query: { measures: ['Orders.total_amount'], dimensions: ['Orders.customer_id', 'Orders.product_id'] },
        pivot: { totals: { row: ratio }, scale: 'sequential', empty: 'dash' },
      },
      {
        columns: [
          { key: 'Orders.customer_id', kind: 'dimension' },
          { key: 'Orders.product_id', kind: 'dimension' },
          { key: 'Orders.total_amount', kind: 'measure' },
        ],
        rows: sparse,
      },
    )
    expect(s).toMatchObject({ type: 'pivot', totals: { row: ratio }, scale: 'sequential', empty: 'dash' })
  })
})

describe('pivot polish (mock parity)', () => {
  const spec = {
    type: 'pivot' as const,
    rows: ['Sales.rep_id'],
    cols: ['Sales.product_id'],
    measure: 'Sales.rate',
    format: 'percent' as const,
    scale: 'diverging' as const,
    totals: { row: 'avg' as const, col: 'avg' as const, rowLabel: 'Average', colLabel: 'Team average' },
    data: [
      { 'Sales.rep_id': 'r1', 'Sales.rep_id__label': 'Ada', 'Sales.product_id': 'p1', 'Sales.product_id__label': 'Widgets', 'Sales.rate': 80 },
      { 'Sales.rep_id': 'r2', 'Sales.rep_id__label': 'Grace', 'Sales.product_id': 'p1', 'Sales.product_id__label': 'Widgets', 'Sales.rate': 40 },
    ],
  }

  it('renders host-supplied edge labels instead of the generic Total/Avg', () => {
    render(<Pivot spec={spec} />)
    expect(screen.getByText('Average')).toBeTruthy()
    expect(screen.getByText('Team average')).toBeTruthy()
    expect(screen.queryByText('Avg')).toBeNull()
  })

  it('footers the axis counts in the dimension’s own words, plus the shading legend', () => {
    render(<Pivot spec={spec} />)
    expect(screen.getByText(/2 reps/)).toBeTruthy()
    expect(screen.getByText(/1 product/)).toBeTruthy()
    expect(screen.getByText(/shaded low → high/)).toBeTruthy()
    expect(screen.getByText(/— no record/)).toBeTruthy()
  })
})
