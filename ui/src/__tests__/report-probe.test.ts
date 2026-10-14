/**
 * Check-running what the agent builds, the rebuild guard, and query retry.
 *
 * The failure these pin: an agent built a widget whose query answered 500,
 * the tool said `ok: true` with every outcome `unresolved`, and the agent told
 * the user the report worked. And a follow-up ("add a chart to this") rebuilt
 * the report as a new one instead of editing it.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildReportTools, isTransientError, withRetry, type AgentTool, type Report, type ReportHost } from '../index'
import type { QueryResultLite, WidgetQuery } from '../querybuilder'

function makeHost(initial: Report | null = null) {
  const state = { report: initial }
  const host: ReportHost = {
    getReport: () => state.report,
    setReport: (r) => {
      state.report = r
    },
  }
  return { host, state }
}
const byName = (tools: AgentTool[], name: string) => tools.find((t) => t.name === name)!
const call = async (tool: AgentTool, input: unknown) => (await tool.handler(input))[0].data as Record<string, any>

const res = (rows: Record<string, unknown>[]): QueryResultLite => ({ columns: [], rows }) as unknown as QueryResultLite
/** A runner: `Bad.*` throws a db error, `Empty.*` returns nothing, anything else returns a row. */
const runQuery = vi.fn(async (q: WidgetQuery) => {
  const m = q.measures?.[0] ?? ''
  if (m.startsWith('Bad.')) throw new Error('reporting query failed: postgres error: db error')
  if (m.startsWith('Empty.')) return res([])
  return res([{ [m]: 3 }])
})
const bound = (measure: string, title: string) => ({ type: 'bound', as: 'metric', title, query: { measures: [measure] } })

describe('create_report check-runs every widget it places', () => {
  it('names failing and empty widgets in needs_fix, and their outcomes in state', async () => {
    const { host } = makeHost()
    const tools = buildReportTools(host, { runQuery })
    const out = await call(byName(tools, 'create_report'), {
      title: 'T',
      widgets: [bound('Good.count', 'Good'), bound('Bad.count', 'Broken'), bound('Empty.count', 'Nothing')],
    })
    expect(out.ok).toBe(true)
    expect(out.needs_fix.map((f: any) => [f.title, f.status])).toEqual([
      ['Broken', 'error'],
      ['Nothing', 'empty'],
    ])
    expect(out.needs_fix[0].error).toMatch(/db error/)
    expect(out.next).toMatch(/Do NOT tell the user/)
    const statuses = out.state.widgets.map((w: any) => w.outcome.status)
    expect(statuses).toEqual(['ok', 'error', 'empty'])
  })

  it('says nothing extra when everything works, and marks an unsaved build as a draft', async () => {
    const { host } = makeHost()
    const out = await call(byName(buildReportTools(host, { runQuery }), 'create_report'), {
      title: 'T',
      widgets: [bound('Good.count', 'Good')],
    })
    expect(out.needs_fix).toBeUndefined()
    expect(out.saved).toBe(false)
    expect(out.state.status).toBe('draft')
  })

  it('get_report reports check-run outcomes until the canvas reports its own', async () => {
    const { host } = makeHost()
    const tools = buildReportTools(host, { runQuery })
    await call(byName(tools, 'create_report'), { title: 'T', widgets: [bound('Bad.count', 'Broken')] })
    const look = await call(byName(tools, 'get_report'), {})
    expect(look.state.widgets[0].outcome.status).toBe('error')
    expect(look.errors).toMatch(/Broken/)
  })
})

describe('edit and add check-run the widget they change', () => {
  it('an edit that repairs a broken widget clears it', async () => {
    const { host } = makeHost()
    const tools = buildReportTools(host, { runQuery })
    const built = await call(byName(tools, 'create_report'), { title: 'T', widgets: [bound('Bad.count', 'Broken')] })
    const id = built.state.widgets[0].id
    const fixed = await call(byName(tools, 'edit_report_widget'), { id, widget: bound('Good.count', 'Fixed') })
    expect(fixed.needs_fix).toBeUndefined()
    expect(fixed.state.widgets[0].outcome.status).toBe('ok')
  })

  it('add_report_widget flags an empty widget', async () => {
    const { host } = makeHost({ title: 'R', widgets: [] } as unknown as Report)
    const out = await call(byName(buildReportTools(host, { runQuery }), 'add_report_widget'), {
      widget: bound('Empty.count', 'Nothing'),
    })
    expect(out.needs_fix?.[0]?.status).toBe('empty')
  })
})

describe('create_report will not replace an open report by accident', () => {
  it('refuses while a report with widgets is open, and points at the edit tools', async () => {
    const { host, state } = makeHost({ title: 'Mine', widgets: [bound('Good.count', 'A')] } as unknown as Report)
    const out = await call(byName(buildReportTools(host, { runQuery }), 'create_report'), {
      title: 'Other',
      widgets: [bound('Good.count', 'B')],
    })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/already open/)
    expect(out.error).toMatch(/add_report_widget/)
    expect(state.report?.title).toBe('Mine')
  })

  it('replaces it when the user asked for a new report', async () => {
    const { host, state } = makeHost({ title: 'Mine', widgets: [bound('Good.count', 'A')] } as unknown as Report)
    const out = await call(byName(buildReportTools(host, { runQuery }), 'create_report'), {
      title: 'Other',
      widgets: [bound('Good.count', 'B')],
      new_report: true,
    })
    expect(out.ok).toBe(true)
    expect(state.report?.title).toBe('Other')
  })

  it('builds onto a blank draft without asking', async () => {
    const { host } = makeHost({ title: 'Untitled report', widgets: [] } as unknown as Report)
    const out = await call(byName(buildReportTools(host, { runQuery }), 'create_report'), {
      title: 'New',
      widgets: [bound('Good.count', 'B')],
    })
    expect(out.ok).toBe(true)
  })
})

describe('withRetry', () => {
  it('retries a 503 and returns the eventual result', async () => {
    let n = 0
    const flaky = vi.fn(async () => {
      n += 1
      if (n < 3) throw Object.assign(new Error('Service Unavailable'), { status: 503 })
      return res([{ a: 1 }])
    })
    const run = withRetry(flaky, { delayMs: 1 })
    await expect(run({ measures: ['A.x'] })).resolves.toMatchObject({ rows: [{ a: 1 }] })
    expect(flaky).toHaveBeenCalledTimes(3)
  })

  it('does not retry a query error', async () => {
    const bad = vi.fn(async () => {
      throw Object.assign(new Error('bad member'), { status: 400 })
    })
    await expect(withRetry(bad, { delayMs: 1 })({})).rejects.toThrow('bad member')
    expect(bad).toHaveBeenCalledTimes(1)
  })

  it('gives up after the retries and throws the last error', async () => {
    const down = vi.fn(async () => {
      throw new Error('fetch failed: network down')
    })
    await expect(withRetry(down, { retries: 2, delayMs: 1 })({})).rejects.toThrow(/network down/)
    expect(down).toHaveBeenCalledTimes(3)
  })

  it('classifies errors', () => {
    expect(isTransientError(Object.assign(new Error('x'), { status: 504 }))).toBe(true)
    expect(isTransientError(Object.assign(new Error('x'), { status: 500 }))).toBe(false)
    expect(isTransientError(new Error('request timed out'))).toBe(true)
    expect(isTransientError(new Error('Unknown member Foo.bar'))).toBe(false)
  })
})

describe('filter selection', () => {
  const facets = [{ key: 'class_id', label: 'Class', single: true }]
  it('create_report opens on the selected facet value', async () => {
    const { host, state } = makeHost()
    const out = await call(byName(buildReportTools(host, { runQuery }, { defaultFacets: facets as never }), 'create_report'), {
      title: 'T',
      widgets: [bound('Good.count', 'G')],
      filters: { facets: { class_id: ['c-1'] }, datePreset: 'last_30d' },
    })
    expect(out.ok).toBe(true)
    expect(state.report?.filters).toEqual({ facets: { class_id: ['c-1'] }, datePreset: 'last_30d' })
  })

  it('set_report_filters picks a value without redeclaring the spec', async () => {
    const { host, state } = makeHost({ title: 'R', widgets: [bound('Good.count', 'G')], facets } as unknown as Report)
    const out = await call(byName(buildReportTools(host, { runQuery }), 'set_report_filters'), { selected: { class_id: ['c-2'] } })
    expect(out.ok).toBe(true)
    expect(state.report?.filters?.facets).toEqual({ class_id: ['c-2'] })
    expect(state.report?.facets).toEqual(facets)
  })

  it('refuses a value for a facet the report does not declare', async () => {
    const { host } = makeHost({ title: 'R', widgets: [bound('Good.count', 'G')], facets } as unknown as Report)
    const out = await call(byName(buildReportTools(host, { runQuery }), 'set_report_filters'), { selected: { student_id: ['s'] } })
    expect(out.ok).toBe(false)
    expect(out.error).toMatch(/No facet "student_id"/)
  })
})
