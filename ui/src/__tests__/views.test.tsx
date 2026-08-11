/**
 * Bound-view invariants (contracts v2 §3): views receive the report filters
 * AND the drill callback (they participate in the system, not an escape
 * hatch); the manifest's contract gates the data; an unmet contract renders
 * widget_error, NEVER a blank cell.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { checkViewContract, registerView, viewsDigest, type ViewProps, type ViewRegistry } from '../views'
import { modelDigest } from '../digest'
import { resolveReport, type Report } from '../report'
import { ReportCanvas } from '../components/ReportCanvas'
import { Widget } from '../components/Widget'
import { addViewTool, buildReportTools, type ReportHost } from '../distri'
import type { QueryResultLite } from '../querybuilder'
import type { ViewSpec } from '../types'

function Leaderboard({ rows, total, filters, drill, props }: ViewProps) {
  return (
    <div>
      <div>leaderboard:{rows.length} rows{total !== undefined ? ` of ${total}` : ''}</div>
      <div>preset:{filters.datePreset ?? 'none'}</div>
      <div>props:{String((props as { top?: number } | undefined)?.top ?? '-')}</div>
      <button
        type="button"
        onClick={() => drill({ member: 'Orders.customer_id', value: 'c1', entity: 'customer' })}
      >
        drill-c1
      </button>
    </div>
  )
}

const VIEWS: ViewRegistry = registerView(
  {},
  {
    name: 'leaderboard',
    title: 'Leaderboard',
    description: 'Top entities by a measure.',
    contract: { requires: ['Orders.customer_id'], suggests: ['Orders.revenue'] },
    propsSchema: { type: 'object', properties: { top: { type: 'number' } } },
    component: Leaderboard,
  },
)

const RESULT: QueryResultLite = {
  columns: [
    { key: 'Orders.customer_id', kind: 'dimension' },
    { key: 'Orders.revenue', kind: 'measure' },
  ],
  rows: [{ 'Orders.customer_id': 'c1', 'Orders.revenue': 10 }],
  total: 42,
}

describe('checkViewContract', () => {
  it('passes when required members are present, fails naming the missing ones', () => {
    const m = VIEWS.leaderboard
    expect(checkViewContract(m, RESULT)).toBeNull()
    expect(checkViewContract(m, { columns: [{ key: 'Orders.revenue', kind: 'measure' }] })).toMatch(
      /requires `Orders\.customer_id`/,
    )
  })
})

describe('resolveView via resolveReport', () => {
  const report: Report = {
    title: 'r',
    widgets: [
      {
        type: 'view',
        component: 'leaderboard',
        query: { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id'] },
        props: { top: 5 },
      },
    ],
  }

  it('resolves a view into a data-bearing ViewSpec', async () => {
    const doc = await resolveReport(report, { runQuery: async () => RESULT, views: VIEWS })
    const spec = doc.widgets[0] as ViewSpec
    expect(spec.type).toBe('view')
    expect(spec.data?.rows.length).toBe(1)
    expect(spec.data?.total).toBe(42)
    expect(spec.error).toBeUndefined()
  })

  it('an unmet contract sets error (rendered as widget_error, never blank)', async () => {
    const noDim: QueryResultLite = { columns: [{ key: 'Orders.revenue', kind: 'measure' }], rows: [] }
    const doc = await resolveReport(report, { runQuery: async () => noDim, views: VIEWS })
    const spec = doc.widgets[0] as ViewSpec
    expect(spec.error?.message).toMatch(/requires/)
    render(<Widget spec={spec} views={VIEWS} />)
    expect(screen.getByText(/requires/)).toBeTruthy()
  })

  it('an unknown component sets error instead of resolving', async () => {
    const doc = await resolveReport(
      { title: 'r', widgets: [{ type: 'view', component: 'nope' }] },
      { runQuery: async () => RESULT, views: VIEWS },
    )
    expect((doc.widgets[0] as ViewSpec).error?.message).toMatch(/Unknown view/)
  })

  it('applies report filters to the view query (views respect scope)', async () => {
    const runQuery = vi.fn(async () => RESULT)
    await resolveReport(report, {
      runQuery,
      views: VIEWS,
      cubeCaps: { Orders: { dims: ['status'] } },
      filters: { datePreset: 'all', facets: { status: ['paid'] } },
    })
    const q = runQuery.mock.calls[0][0] as { filters?: { member: string }[] }
    expect(q.filters).toEqual([{ member: 'Orders.status', operator: 'in', values: ['paid'] }])
  })
})

describe('Widget renders views with ViewProps', () => {
  const spec: ViewSpec = {
    type: 'view',
    component: 'leaderboard',
    data: { rows: RESULT.rows, columns: RESULT.columns, total: 42 },
    props: { top: 5 },
  }

  it('hands rows, total, filters, drill and props to the component', () => {
    const onDrill = vi.fn()
    render(
      <Widget spec={spec} views={VIEWS} filters={{ datePreset: 'last_90d' }} onDrill={onDrill} />,
    )
    expect(screen.getByText('leaderboard:1 rows of 42')).toBeTruthy()
    expect(screen.getByText('preset:last_90d')).toBeTruthy()
    expect(screen.getByText('props:5')).toBeTruthy()
    fireEvent.click(screen.getByText('drill-c1'))
    expect(onDrill).toHaveBeenCalledWith({ member: 'Orders.customer_id', value: 'c1', entity: 'customer' })
  })

  it('renders widget_error for an unregistered view — never a blank cell', () => {
    const { container } = render(<Widget spec={{ ...spec, component: 'gone' }} views={VIEWS} />)
    expect(screen.getByText(/Unknown view/)).toBeTruthy()
    expect(container.textContent).not.toBe('')
  })
})

describe('views in the digest and the add_report_view tool', () => {
  it('viewsDigest lists name, description, contract; modelDigest appends it', () => {
    const d = viewsDigest(VIEWS)
    expect(d).toContain('- leaderboard "Leaderboard" — Top entities by a measure.')
    expect(d).toContain('requires: Orders.customer_id')
    const full = modelDigest({ cubes: [] }, VIEWS)
    expect(full).toContain('# Host views')
  })

  it('add_report_view places a valid view with provenance', async () => {
    const h: ReportHost & { report: Report | null } = {
      report: null,
      getReport: () => h.report,
      setReport: (r) => {
        h.report = r
      },
    }
    const tool = addViewTool(h, { views: VIEWS })
    await tool.handler({
      component: 'leaderboard',
      query: { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id'] },
      prompt: 'top customers',
    })
    const w = h.report?.widgets[0] as { type: string; provenance?: { author: string } }
    expect(w.type).toBe('view')
    expect(w.provenance?.author).toBe('agent')
  })

  it('add_report_view refuses a query missing required members', async () => {
    const h: ReportHost = { getReport: () => null, setReport: () => {} }
    const tool = addViewTool(h, { views: VIEWS })
    const [out] = await tool.handler({ component: 'leaderboard', query: { measures: ['Orders.revenue'] } })
    expect(out.data).toMatchObject({ ok: false })
    expect((out.data as { error: string }).error).toMatch(/requires Orders\.customer_id/)
  })

  it('buildReportTools includes add_report_view only with a registry', () => {
    const h: ReportHost = { getReport: () => null, setReport: () => {} }
    expect(buildReportTools(h, {}).map((t) => t.name)).not.toContain('add_report_view')
    expect(buildReportTools(h, { views: VIEWS }).map((t) => t.name)).toContain('add_report_view')
  })
})

describe('ReportCanvas renders a live view end to end', () => {
  it('resolves the view and the component drills through the default path', async () => {
    const onChange = vi.fn()
    const report: Report = {
      title: 'r',
      widgets: [
        {
          type: 'view',
          component: 'leaderboard',
          query: { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id'] },
        },
      ],
    }
    render(
      <ReportCanvas report={report} onChange={onChange} runQuery={async () => RESULT} views={VIEWS} />,
    )
    const btn = await screen.findByText('drill-c1')
    fireEvent.click(btn)
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({
          drill: [{ member: 'Orders.customer_id', value: 'c1', entity: 'customer' }],
        }),
      ),
    )
  })
})
