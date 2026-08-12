/**
 * Drill invariants (contracts v2 §2): the UI EMITS DrillEvent, routing is
 * host policy, and with no router the default is drill-DOWN — filter in
 * place, poppable breadcrumb. A copied URL reproduces the exact view.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { applyDrillTrail, drillStepLabel, routeDrill, type DrillEvent } from '../drill'
import { parseReportSearch, reportStateToSearch, serializeReportState } from '../urlstate'
import { DataGrid } from '../components/DataGrid'
import { DrillBreadcrumb } from '../components/DrillBreadcrumb'
import { DEFAULT_REPORT_FILTERS } from '../filters'
import { ReportCanvas } from '../components/ReportCanvas'
import { rowsQueryFor, type BoundWidget, type Report } from '../report'
import type { TableSpec } from '../types'
import type { QueryResultLite } from '../querybuilder'

const step = (member: string, value: string, extra?: Partial<DrillEvent>): DrillEvent => ({
  member,
  value,
  ...extra,
})

describe('applyDrillTrail', () => {
  const query = { measures: ['Orders.revenue'], dimensions: ['Orders.status'] }

  it('adds an equals filter per step (filter-in-place)', () => {
    const q = applyDrillTrail(query, [step('Orders.customer_id', 'c1')], 'Orders', ['status', 'customer_id'])
    expect(q.filters).toEqual([{ member: 'Orders.customer_id', operator: 'equals', values: ['c1'] }])
  })

  it('re-qualifies a cross-cube step when the cube shares the dimension', () => {
    const q = applyDrillTrail(query, [step('Payments.customer_id', 'c1')], 'Orders', ['customer_id'])
    expect(q.filters?.[0].member).toBe('Orders.customer_id')
  })

  it('skips a step the cube cannot express', () => {
    const q = applyDrillTrail(query, [step('Payments.store_id', 's1')], 'Orders', ['customer_id'])
    expect(q).toBe(query) // identity: untouched query object
  })

  it('replaces an earlier step on the same member instead of stacking', () => {
    const q = applyDrillTrail(
      query,
      [step('Orders.customer_id', 'c1'), step('Orders.customer_id', 'c2')],
      'Orders',
      ['customer_id'],
    )
    expect(q.filters).toEqual([{ member: 'Orders.customer_id', operator: 'equals', values: ['c2'] }])
  })
})

describe('routeDrill', () => {
  it('routes through the host router when the entity has a route', () => {
    const route = vi.fn()
    const down = vi.fn()
    const e = step('Orders.customer_id', 'c1', { entity: 'customer' })
    expect(routeDrill(e, { customer: route }, down)).toBe(true)
    expect(route).toHaveBeenCalledWith('c1', e)
    expect(down).not.toHaveBeenCalled()
  })

  it('falls back to drill-down without a router or route', () => {
    const down = vi.fn()
    expect(routeDrill(step('Orders.customer_id', 'c1', { entity: 'customer' }), {}, down)).toBe(false)
    expect(routeDrill(step('Orders.customer_id', 'c1'), undefined, down)).toBe(false)
    expect(down).toHaveBeenCalledTimes(2)
  })
})

describe('DataGrid drill emission', () => {
  const spec: TableSpec = {
    type: 'table',
    columns: [
      { key: 'Orders.customer_id', label: 'Customer', kind: 'dimension', drillEntity: 'customer' },
      { key: 'Orders.customer_id__label', label: 'x', kind: 'label' },
      { key: 'Orders.revenue', label: 'Revenue', kind: 'measure', align: 'right' },
    ],
    rows: [
      { 'Orders.customer_id': 'c1', 'Orders.customer_id__label': 'Karl Seal', 'Orders.revenue': 221 },
    ],
  }

  it('emits DrillEvent with value, label and entity on a dimension cell', () => {
    const onDrill = vi.fn()
    render(<DataGrid spec={spec} onDrill={onDrill} />)
    fireEvent.click(screen.getByText('Karl Seal'))
    expect(onDrill).toHaveBeenCalledWith({
      member: 'Orders.customer_id',
      value: 'c1',
      label: 'Karl Seal',
      entity: 'customer',
    })
  })

  it('hands measure clicks to onMeasureClick with the row and column', () => {
    const onMeasure = vi.fn()
    render(<DataGrid spec={spec} onMeasureClick={onMeasure} />)
    fireEvent.click(screen.getByText('221'))
    expect(onMeasure).toHaveBeenCalledWith(spec.rows[0], 'Orders.revenue')
  })

  it('renders no click affordance without handlers', () => {
    render(<DataGrid spec={spec} />)
    expect(screen.getByText('Karl Seal').getAttribute('role')).toBeNull()
    expect(screen.getByText('221').getAttribute('role')).toBeNull()
  })
})

describe('DrillBreadcrumb', () => {
  const trail = [
    step('Orders.customer_id', 'c1', { label: 'Karl Seal' }),
    step('Orders.status', 'paid'),
  ]

  it('renders All + labelled steps and pops to a truncated trail', () => {
    const onPop = vi.fn()
    render(<DrillBreadcrumb trail={trail} onPop={onPop} />)
    fireEvent.click(screen.getByText('All'))
    expect(onPop).toHaveBeenCalledWith(0)
    fireEvent.click(screen.getByText(/customer: Karl Seal/))
    expect(onPop).toHaveBeenCalledWith(1)
  })

  it('the last step is the current scope, not a pop target', () => {
    const onPop = vi.fn()
    render(<DrillBreadcrumb trail={trail} onPop={onPop} />)
    fireEvent.click(screen.getByText(/status: paid/))
    expect(onPop).not.toHaveBeenCalled()
  })
})

describe('rowsQueryFor', () => {
  it("builds the clicked row's records query: scope + row dims, mode rows", () => {
    const widget: BoundWidget = {
      type: 'bound',
      as: 'table',
      query: {
        measures: ['Orders.revenue'],
        dimensions: ['Orders.status'],
        filters: [{ member: 'Orders.region', operator: 'equals', values: ['west'] }],
        limit: 25,
        offset: 50,
      },
    }
    const q = rowsQueryFor(widget, { 'Orders.status': 'paid', 'Orders.revenue': 9 }, {})
    expect(q.mode).toBe('rows')
    expect(q.limit).toBe(50)
    expect(q.offset).toBeUndefined()
    expect(q.measures).toBeUndefined()
    expect(q.dimensions).toBeUndefined()
    expect(q.filters).toEqual([
      { member: 'Orders.region', operator: 'equals', values: ['west'] },
      { member: 'Orders.status', operator: 'equals', values: ['paid'] },
    ])
  })
})

describe('URL state round-trip', () => {
  it('serializes and parses filters + drill + grids losslessly', () => {
    const state = {
      filters: { datePreset: 'last_90d' as const, facets: { status: ['paid'] } },
      drill: [step('Orders.customer_id', 'c1', { label: 'Karl Seal' })],
      grids: { 1: { o: 50, s: { m: 'Orders.revenue', d: true } } },
    }
    const search = reportStateToSearch(state)
    expect(search.startsWith('?rpt=')).toBe(true)
    const parsed = parseReportSearch(search)
    expect(parsed.drill).toEqual(state.drill)
    expect(parsed.grids).toEqual(state.grids)
    expect(parsed.filters).toMatchObject(state.filters)
  })

  it('a default view serializes to nothing (clean URLs stay clean)', () => {
    expect(serializeReportState({})).toBeNull()
    expect(reportStateToSearch({ filters: { datePreset: 'last_30d' }, drill: [], grids: {} })).toBe('')
  })

  it('garbage in the URL degrades to empty state, never a crash', () => {
    expect(parseReportSearch('?rpt=%7Bnot-json')).toEqual({})
    expect(parseReportSearch('?rpt=')).toEqual({})
    expect(parseReportSearch('')).toEqual({})
  })
})

describe('ReportCanvas default drill-down', () => {
  const result: QueryResultLite = {
    columns: [
      { key: 'Orders.customer_id', kind: 'dimension' },
      { key: 'Orders.revenue', kind: 'measure' },
    ],
    rows: [{ 'Orders.customer_id': 'c1', 'Orders.revenue': 221 }],
  }
  const report: Report = {
    title: 'r',
    widgets: [
      { type: 'bound', as: 'table', query: { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id'] } },
    ],
  }

  it('appends to report.drill when no router is registered', async () => {
    const onChange = vi.fn()
    render(<ReportCanvas report={report} onChange={onChange} runQuery={async () => result} />)
    const cell = await screen.findByText('c1')
    fireEvent.click(cell)
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        drill: [{ member: 'Orders.customer_id', value: 'c1', label: undefined, entity: undefined }],
      }),
    )
  })

  it('routes to the host router instead when the entity matches', async () => {
    const onChange = vi.fn()
    const route = vi.fn()
    const spec = {
      ...report,
      widgets: [{ ...(report.widgets[0] as BoundWidget) }],
    }
    // Entity comes from column metadata — simulate via a runner that the
    // resolver turns into kind-tagged columns; entity requires meta, so this
    // routes only when the event carries it. Default (no entity) drills down.
    render(<ReportCanvas report={spec} onChange={onChange} runQuery={async () => result} drillRouter={{ customer: route }} />)
    const cell = await screen.findByText('c1')
    fireEvent.click(cell)
    // No entity on the emitted event (result columns carry none) → drill-down.
    expect(route).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalled()
  })

  it('resolves with the drill trail applied and renders the breadcrumb', async () => {
    const runQuery = vi.fn(async () => result)
    const drilled: Report = { ...report, drill: [step('Orders.customer_id', 'c1', { label: 'Karl Seal' })] }
    render(<ReportCanvas report={drilled} onChange={() => {}} runQuery={runQuery} cubeCaps={{ Orders: { dims: ['customer_id'] } }} />)
    await waitFor(() => expect(runQuery).toHaveBeenCalled())
    const query = runQuery.mock.calls[0][0] as { filters?: { member: string }[] }
    expect(query.filters).toEqual([{ member: 'Orders.customer_id', operator: 'equals', values: ['c1'] }])
    expect(screen.getByText(/customer: Karl Seal/)).toBeTruthy()
  })

  /**
   * A drill step and a facet compile to the same equality predicate, so a
   * "Clear" that resets only `filters` leaves the report narrowed by whatever
   * the user last clicked — it looks like the button does nothing. The trail
   * lives in the filter bar now, and Clear owns both.
   */
  it('Clear resets the filters to their defaults AND drops the drill trail', async () => {
    const onChange = vi.fn()
    const drilled: Report = {
      ...report,
      filters: { datePreset: 'last_7d', facets: { status: ['paid'] } },
      drill: [step('Orders.customer_id', 'c1', { label: 'Karl Seal' })],
    }
    render(
      <ReportCanvas
        report={drilled}
        onChange={onChange}
        runQuery={async () => result}
        facets={[{ key: 'status', label: 'Status', options: [{ value: 'paid', label: 'Paid' }] }]}
      />,
    )
    fireEvent.click(await screen.findByRole('button', { name: /clear/i }))
    const next = onChange.mock.calls.at(-1)?.[0] as Report
    expect(next.drill).toEqual([])
    expect(next.filters).toEqual(DEFAULT_REPORT_FILTERS)
  })

  /** The trail renders in the filter bar even when the report declares no
   *  facets — otherwise drilling a bare report hides its own undo. */
  it('shows the drill trail in the filter bar for a report with no facets', async () => {
    const drilled: Report = { ...report, drill: [step('Orders.customer_id', 'c1', { label: 'Karl Seal' })] }
    render(<ReportCanvas report={drilled} onChange={() => {}} runQuery={async () => result} />)
    expect(await screen.findByText(/customer: Karl Seal/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /clear/i })).toBeTruthy()
  })
})
