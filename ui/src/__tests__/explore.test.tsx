/**
 * Topic-16 invariants: the digest is GENERATED from /meta (cannot drift),
 * validation returns repairable errors with suggestions, explore_data
 * summarizes instead of dumping, tools stamp provenance, and — the big one —
 * the ask bar and the chips edit ONE query object.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { modelDigest } from '../digest'
import { validateQuery } from '../validate'
import { autoViz, type CubeModelMeta, type QueryResultLite } from '../querybuilder'
import { buildReportTools, exploreDataTool, EXPLORE_ROW_CAP, type ReportHost } from '../distri'
import { Explore } from '../components/Explore'
import type { BoundWidget, Report } from '../report'

const META: CubeModelMeta = {
  cubes: [
    {
      name: 'Payments',
      title: 'Payments',
      description: 'One row per payment.',
      measures: [
        { name: 'count', member: 'Payments.count' },
        { name: 'revenue', member: 'Payments.revenue', featured: true, unit: '$', description: 'Total paid.' },
      ],
      dimensions: [
        { name: 'tenant_id', member: 'Payments.tenant_id', tenant: true },
        { name: 'rating', member: 'Payments.rating', filterable: true },
        { name: 'customer_id', member: 'Payments.customer_id', label: 'Customers.name', drill_entity: 'customer' },
        { name: 'created_at', member: 'Payments.created_at', type: 'time' },
      ],
      segments: [{ name: 'paid', member: 'Payments.paid', description: 'settled payments' }],
      joins: [{ target: 'Customers', relationship: 'many_to_one' }],
      drill_members: ['Payments.payment_id', 'Payments.created_at'],
    },
  ],
}

describe('modelDigest', () => {
  const digest = modelDigest(META)

  it('is generated from /meta: descriptions, units, labels, drill, segments, joins', () => {
    expect(digest).toContain('## Payments — One row per payment.')
    expect(digest).toContain('Payments.revenue')
    expect(digest).toContain('($)')
    expect(digest).toContain('— Total paid.')
    expect(digest).toContain('(labelled by Customers.name)')
    expect(digest).toContain('→ customer')
    expect(digest).toContain('segments: Payments.paid (settled payments)')
    expect(digest).toContain('joins: many_to_one → Customers')
    expect(digest).toContain('row mode projects: Payments.payment_id, Payments.created_at')
  })

  it('features first and hides tenant plumbing', () => {
    expect(digest.indexOf('Payments.revenue')).toBeLessThan(digest.indexOf('Payments.count'))
    expect(digest).not.toContain('tenant_id')
  })
})

describe('validateQuery', () => {
  it('accepts a valid query', () => {
    expect(validateQuery({ measures: ['Payments.revenue'], dimensions: ['Payments.rating'] }, META)).toEqual({
      ok: true,
    })
  })

  it('suggests close names for an unknown member', () => {
    const v = validateQuery({ measures: ['Payments.revenu'] }, META)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.suggestions).toContain('Payments.revenue')
  })

  it('flags a measure/dimension mix-up as a move, not a typo', () => {
    const v = validateQuery({ measures: ['Payments.rating'] }, META)
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.error).toMatch(/is a dimension/)
  })

  it('rejects a non-time member in timeDimensions with time suggestions', () => {
    const v = validateQuery(
      { measures: ['Payments.revenue'], timeDimensions: [{ dimension: 'Payments.rating' }] },
      META,
    )
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.suggestions).toContain('Payments.created_at')
  })
})

describe('autoViz', () => {
  it('maps query shape to visualization', () => {
    expect(autoViz({ measures: ['Payments.revenue'] })).toEqual({ as: 'metric' })
    expect(
      autoViz({ measures: ['Payments.revenue'], timeDimensions: [{ dimension: 'Payments.created_at', granularity: 'month' }] }),
    ).toEqual({ as: 'chart', mark: 'line' })
    expect(autoViz({ measures: ['Payments.revenue'], dimensions: ['Payments.rating'] })).toEqual({
      as: 'chart',
      mark: 'bar',
    })
    expect(
      autoViz({ measures: ['Payments.revenue'], dimensions: ['Payments.rating', 'Payments.customer_id'] }),
    ).toEqual({ as: 'pivot' })
  })
})

describe('explore_data', () => {
  const result: QueryResultLite = {
    columns: [{ key: 'Payments.revenue', kind: 'measure' }],
    rows: Array.from({ length: 30 }, (_, i) => ({ 'Payments.revenue': i })),
    total: 312,
    sql: 'select …',
  }

  it('returns a compact summary, capped rows, with the SQL', async () => {
    const tool = exploreDataTool({ meta: META, runQuery: async () => result })
    const [out] = await tool.handler({ query: { measures: ['Payments.revenue'] } })
    expect(out.data).toMatchObject({ ok: true, row_count: 30, total: 312, sql: 'select …' })
    expect((out.data as { rows: unknown[] }).rows.length).toBe(EXPLORE_ROW_CAP)
  })

  it('returns { ok:false, error, suggestions } for a bad member — repairable', async () => {
    const runQuery = vi.fn()
    const tool = exploreDataTool({ meta: META, runQuery })
    const [out] = await tool.handler({ query: { measures: ['Payments.revenu'] } })
    expect(out.data).toMatchObject({ ok: false })
    expect((out.data as { suggestions: string[] }).suggestions).toContain('Payments.revenue')
    expect(runQuery).not.toHaveBeenCalled()
  })
})

describe('report tools with context', () => {
  const host = (): ReportHost & { report: Report | null } => {
    const h = {
      report: null as Report | null,
      getReport: () => h.report,
      setReport: (r: Report) => {
        h.report = r
      },
    }
    return h
  }

  /** Select by NAME: the tool list is ordered for the agent (get_report leads),
   *  not for the tests, so positional access silently grabs the wrong tool. */
  const tool = (h: ReportHost, name: string, ctx = { meta: META }) => {
    const t = buildReportTools(h, ctx).find((x) => x.name === name)
    if (!t) throw new Error(`no tool ${name}`)
    return t
  }

  it('create_report stamps agent provenance with the prompt', async () => {
    const h = host()
    const create = tool(h, 'create_report')
    await create.handler({
      title: 'T',
      prompt: 'revenue by rating',
      widgets: [{ type: 'bound', as: 'chart', query: { measures: ['Payments.revenue'] } }],
    })
    const w = h.report?.widgets[0] as BoundWidget
    expect(w.provenance).toMatchObject({ author: 'agent', prompt: 'revenue by rating' })
    expect(typeof w.provenance?.at).toBe('number')
  })

  it('create_report refuses an invalid bound query with suggestions', async () => {
    const h = host()
    const create = tool(h, 'create_report')
    const [out] = await create.handler({
      title: 'T',
      widgets: [{ type: 'bound', as: 'chart', query: { measures: ['Payments.revenu'] } }],
    })
    expect(out.data).toMatchObject({ ok: false })
    expect(h.report).toBeNull()
  })

  it('buildReportTools includes explore_data only with a runner', () => {
    expect(buildReportTools(host(), {}).map((t) => t.name)).toEqual([
      'get_report',
      'create_report',
      'add_report_widget',
      'edit_report_widget',
      'remove_report_widget',
      'move_report_widget',
      'set_report_filters',
      'rename_report',
    ])
    expect(buildReportTools(host(), { runQuery: async () => ({ columns: [], rows: [] }) }).map((t) => t.name)).toContain(
      'explore_data',
    )
  })
})

describe('Explore: ask and chips edit ONE object', () => {
  const runQuery = vi.fn(async (): Promise<QueryResultLite> => ({
    columns: [
      { key: 'Payments.rating', kind: 'dimension' },
      { key: 'Payments.revenue', kind: 'measure' },
    ],
    rows: [{ 'Payments.rating': 'PG', 'Payments.revenue': 10 }],
    sql: 'select rating, revenue from payments',
  }))

  it('an ask replaces the draft, which the chips then edit', async () => {
    const onAsk = vi.fn(async () => ({
      as: 'chart' as const,
      query: { measures: ['Payments.revenue'], dimensions: ['Payments.rating'] },
    }))
    render(<Explore meta={META} runQuery={runQuery} onAsk={onAsk} />)

    fireEvent.change(screen.getByPlaceholderText(/Ask for data/), { target: { value: 'revenue by rating' } })
    fireEvent.click(screen.getByText('Ask'))
    // The agent's draft becomes the chip sentence…
    await waitFor(() => expect(screen.getByText('by rating')).toBeTruthy())
    expect(onAsk).toHaveBeenCalledWith('revenue by rating', expect.anything())
    // …and the SQL lands in the Explain panel.
    await waitFor(() => expect(screen.getByText(/select rating, revenue/)).toBeTruthy())

    // Removing the chip edits the SAME query the ask produced.
    fireEvent.click(screen.getByLabelText('Remove by rating'))
    await waitFor(() => {
      const last = runQuery.mock.calls.at(-1)?.[0] as { dimensions?: string[] }
      expect(last.dimensions ?? []).toEqual([])
    })
  })

  it('shows a repairable validation error instead of running a broken query', async () => {
    render(
      <Explore
        meta={META}
        runQuery={runQuery}
        initial={{ as: 'metric', query: { measures: ['Payments.revenu'] } }}
      />,
    )
    expect(await screen.findByText(/Unknown measure/)).toBeTruthy()
    expect(screen.getByText(/Payments.revenue/)).toBeTruthy()
  })
})
