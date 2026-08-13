/**
 * The report tool contract.
 *
 * These tools are the agent's only hands on a report, so the things worth
 * asserting are the ones an agent gets wrong: editing the report on screen
 * instead of rebuilding it, out-of-range indexes, facets declared rather than
 * baked into queries, and a `navigate_to` that points at something that was
 * actually saved.
 *
 * Imported through `../index` on purpose — `distri.ts` and `reports/edit-tools.ts`
 * import each other, and a module cycle that resolves in isolation can still
 * blow up through the package entry point.
 */
import { describe, it, expect } from 'vitest'
import { buildReportTools, type AgentTool, type Report, type ReportHost } from '../index'

/** A host that behaves like the real one: holds a report, records callbacks. */
function makeHost(initial: Report | null = null) {
  const state = {
    report: initial,
    built: [] as Array<{ report: Report; id?: string }>,
    saved: [] as Array<{ id: string; report: Report }>,
  }
  const host: ReportHost = {
    getReport: () => state.report,
    setReport: (r) => {
      state.report = r
    },
    onBuilt: (report, id) => {
      state.built.push({ report, id })
    },
  }
  return { host, state }
}

const byName = (tools: AgentTool[], name: string) => {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`no tool named ${name} (have: ${tools.map((x) => x.name).join(', ')})`)
  return t
}

/** Tools return distri data parts; the payload is what the agent reads. */
const call = async (tool: AgentTool, input: unknown) =>
  (await tool.handler(input))[0].data as Record<string, unknown>

const widget = (title: string) => ({ type: 'bound', as: 'metric', query: { measures: ['A.count'] }, title })

const report = (widgets: unknown[] = []): Report =>
  ({ title: 'Report', widgets }) as unknown as Report

describe('buildReportTools — what a host gets', () => {
  it('exposes the full set, with get_report ahead of create_report', () => {
    const { host } = makeHost()
    const names = buildReportTools(host).map((t) => t.name)
    expect(names).toEqual([
      'get_report',
      'create_report',
      'add_report_widget',
      'edit_report_widget',
      'remove_report_widget',
      'move_report_widget',
      'set_report_filters',
      'rename_report',
    ])
  })

  it('host-owned tools come first — a checkpoint has to be read before the build tools', () => {
    const { host } = makeHost()
    const checkpoint = { name: 'confirm_report' } as unknown as AgentTool
    const names = buildReportTools(host, {}, { extraTools: [checkpoint] }).map((t) => t.name)
    expect(names[0]).toBe('confirm_report')
  })

  it('explore_data and add_report_view appear only when ctx enables them', () => {
    const { host } = makeHost()
    expect(buildReportTools(host).map((t) => t.name)).not.toContain('explore_data')
    const withRunner = buildReportTools(host, { runQuery: async () => ({ rows: [] }) as never })
    expect(withRunner.map((t) => t.name)).toContain('explore_data')
  })
})

describe('get_report — the session state', () => {
  it('returns the state: status, facets, and every widget with an id', async () => {
    const { host } = makeHost({
      title: 'Class health',
      facets: [{ key: 'class_id', label: 'Class' }],
      widgets: [widget('Submissions'), { type: 'note', markdown: 'hi' }],
    } as unknown as Report)
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    const state = out.state as Record<string, unknown>
    expect(out.ok).toBe(true)
    expect(state.status).toBe('draft')
    expect(state.title).toBe('Class health')
    expect(state.widget_count).toBe(2)
    expect(state.facets).toEqual([{ key: 'class_id', label: 'Class' }])
    const w = (state.widgets as Array<Record<string, unknown>>)[0]
    expect(w).toMatchObject({ index: 0, type: 'bound', measures: ['A.count'] })
    expect(w.id).toEqual(expect.stringMatching(/^w_/))
  })

  it('reports status "saved" once the host has an id for it', async () => {
    const { host } = makeHost(report([widget('a')]))
    host.getSavedId = () => 'rpt-9'
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    expect(out.state).toMatchObject({ status: 'saved', id: 'rpt-9' })
  })

  it('says nothing is open as a STATE, not a failure — none is where create_report belongs', async () => {
    const { host } = makeHost(null)
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    expect(out.ok).toBe(true)
    expect(out.state).toMatchObject({ status: 'none', widget_count: 0 })
    expect(String(out.note)).toMatch(/create_report/)
  })

  it('carries each widget\'s outcome, so an empty widget is visible', async () => {
    const { host, state } = makeHost(report([widget('Scores'), widget('Submissions')]))
    // The canvas resolved these; the host keeps what it learned.
    const ids = () => (host.getReport()!.widgets as Array<{ id?: string }>).map((w) => w.id!)
    await call(byName(buildReportTools(host), 'get_report'), {}) // assigns ids
    const [a, b] = ids()
    host.getOutcomes = () => ({
      [a]: { status: 'empty', row_count: 0, applied: { facets: ['class_id'], dateField: 'created_at' } },
      [b]: { status: 'ok', row_count: 107 },
    })
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    const widgets = (out.state as { widgets: Array<Record<string, unknown>> }).widgets
    expect(widgets[0].outcome).toMatchObject({ status: 'empty', row_count: 0 })
    expect(widgets[1].outcome).toMatchObject({ status: 'ok', row_count: 107 })
    // Not merely present in the payload — called out, because the agent that
    // built this one reported success while every panel said "No data".
    expect(String(out.attention)).toMatch(/No data|NO ROWS/i)
    expect(state.report).toBeTruthy()
  })

  it('defaults every outcome to unresolved when the host reports none', async () => {
    const { host } = makeHost(report([widget('a')]))
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    const widgets = (out.state as { widgets: Array<Record<string, unknown>> }).widgets
    expect(widgets[0].outcome).toEqual({ status: 'unresolved' })
    expect(out.attention).toBeUndefined()
  })
})

describe('create_report', () => {
  it('saves under a host-minted id and returns the route to it', async () => {
    const { host, state } = makeHost()
    const saved: Array<{ id: string; report: Report }> = []
    const tools = buildReportTools(host, {}, {
      newId: () => 'rep-1',
      save: async (id, r) => saved.push({ id, report: r }),
      reportPath: (id) => `/admin/reports/${id}`,
    })
    const out = await call(byName(tools, 'create_report'), {
      title: 'Weekly',
      widgets: [widget('Submissions')],
      prompt: 'how are we doing',
    })
    expect(out).toMatchObject({ ok: true, widget_count: 1, navigate_to: '/admin/reports/rep-1' })
    // Saved BEFORE opening: a route to an unsaved report is a 404.
    expect(saved).toEqual([{ id: 'rep-1', report: state.report! }])
    expect(state.built).toEqual([{ report: state.report!, id: 'rep-1' }])
  })

  it("adopts the host's default facets, and the agent's when it passes them", async () => {
    const defaults = [{ key: 'class_id', label: 'Class', required: true }]
    const { host, state } = makeHost()
    const tools = buildReportTools(host, {}, { defaultFacets: defaults })
    await call(byName(tools, 'create_report'), { title: 'A', widgets: [widget('x')] })
    expect(state.report!.facets).toEqual(defaults)

    await call(byName(tools, 'create_report'), {
      title: 'B',
      widgets: [widget('x')],
      facets: [{ key: 'student_id', label: 'Student', required: true, single: true }],
    })
    expect(state.report!.facets).toEqual([
      { key: 'student_id', label: 'Student', required: true, single: true },
    ])
  })

  it('rejects a malformed facet spec rather than opening a report with a dead filter bar', async () => {
    const { host, state } = makeHost()
    const tools = buildReportTools(host, {}, {})
    const out = await call(byName(tools, 'create_report'), {
      title: 'A',
      widgets: [widget('x')],
      facets: [{ label: 'no key here' }],
    })
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('Invalid facets')
    expect(state.report).toBeNull()
  })

  it('stamps provenance on data widgets', async () => {
    const { host, state } = makeHost()
    await call(byName(buildReportTools(host), 'create_report'), {
      title: 'A',
      widgets: [widget('x')],
      prompt: 'the ask, verbatim',
    })
    const w = state.report!.widgets[0] as unknown as { provenance?: { prompt?: string; author?: string } }
    expect(w.provenance).toMatchObject({ prompt: 'the ask, verbatim', author: 'agent' })
  })

  it('seeds from an entity only when the host supplies entityReport', async () => {
    const { host } = makeHost()
    const bare = await call(byName(buildReportTools(host), 'create_report'), { title: 'A' })
    expect(bare).toEqual({ ok: false, error: 'Provide `widgets`.' })

    const { host: h2, state } = makeHost()
    const tools = buildReportTools(h2, {}, {
      entityReport: (e, title) => report([widget(`${e.kind}:${e.id}`)]) && { title, widgets: [widget(`${e.kind}:${e.id}`)] } as unknown as Report,
    })
    expect(byName(tools, 'create_report').parameters.properties).toHaveProperty('entity')
    const out = await call(byName(tools, 'create_report'), {
      title: 'Class report',
      entity: { kind: 'class', id: 'c1' },
    })
    expect(out).toMatchObject({ ok: true, widget_count: 1 })
    expect((state.report!.widgets[0] as { title?: string }).title).toBe('class:c1')
  })

  it('refuses queries the model does not have, with suggestions to repair', async () => {
    const { host, state } = makeHost()
    const meta = {
      cubes: [
        {
          name: 'Orders',
          measures: [{ member: 'Orders.count' }],
          dimensions: [{ member: 'Orders.status' }],
        },
      ],
    } as never
    const out = await call(byName(buildReportTools(host, { meta }), 'create_report'), {
      title: 'A',
      widgets: [{ type: 'bound', as: 'metric', query: { measures: ['Orders.cnt'] } }],
    })
    expect(out.ok).toBe(false)
    // Not just "some failure" — the repair loop's half: name the member, offer the fix.
    expect(String(out.error)).toContain('Orders.cnt')
    expect(out.suggestions).toContain('Orders.count')
    expect(state.report).toBeNull()
  })
})

describe('edit_report_widget', () => {
  it('replaces exactly one widget and leaves its neighbours alone', async () => {
    const { host, state } = makeHost(report([widget('a'), widget('b'), widget('c')]))
    const out = await call(byName(buildReportTools(host), 'edit_report_widget'), {
      index: 1,
      widget: widget('B!'),
    })
    expect(out.ok).toBe(true)
    expect(out.state).toMatchObject({ widget_count: 3 })
    expect(state.report!.widgets.map((w) => (w as { title?: string }).title)).toEqual(['a', 'B!', 'c'])
  })

  it('refuses an index the report does not have', async () => {
    const { host, state } = makeHost(report([widget('a')]))
    const out = await call(byName(buildReportTools(host), 'edit_report_widget'), {
      index: 4,
      widget: widget('x'),
    })
    expect(out.ok).toBe(false)
    expect(state.report!.widgets).toHaveLength(1)
  })

  it('refuses a widget of a kind the renderer cannot draw', async () => {
    const { host } = makeHost(report([widget('a')]))
    const out = await call(byName(buildReportTools(host), 'edit_report_widget'), {
      index: 0,
      widget: { type: 'pie-of-vibes' },
    })
    expect(out).toEqual({ ok: false, error: 'Provide a valid `widget`.' })
  })
})

describe('remove_report_widget and move_report_widget', () => {
  it('removes by index', async () => {
    const { host, state } = makeHost(report([widget('a'), widget('b')]))
    const out = await call(byName(buildReportTools(host), 'remove_report_widget'), { index: 0 })
    expect(out.ok).toBe(true)
    expect(out.state).toMatchObject({ widget_count: 1 })
    expect((state.report!.widgets[0] as { title?: string }).title).toBe('b')
  })

  it('moves a widget and reports where it landed', async () => {
    const { host, state } = makeHost(report([widget('a'), widget('b'), widget('c')]))
    const out = await call(byName(buildReportTools(host), 'move_report_widget'), { from: 2, to: 0 })
    expect(out).toMatchObject({ ok: true, from: 2, to: 0 })
    expect(out.state).toBeTruthy()
    expect(state.report!.widgets.map((w) => (w as { title?: string }).title)).toEqual(['c', 'a', 'b'])
  })

  it('clamps a destination past the end instead of dropping the widget', async () => {
    const { host, state } = makeHost(report([widget('a'), widget('b')]))
    await call(byName(buildReportTools(host), 'move_report_widget'), { from: 0, to: 99 })
    expect(state.report!.widgets.map((w) => (w as { title?: string }).title)).toEqual(['b', 'a'])
  })
})

describe('set_report_filters — declared, not baked in', () => {
  it('replaces the whole spec and leaves widget queries untouched', async () => {
    const { host, state } = makeHost(report([widget('a')]))
    const beforeQuery = JSON.stringify((state.report!.widgets[0] as { query: unknown }).query)
    const out = await call(byName(buildReportTools(host), 'set_report_filters'), {
      facets: [
        { key: 'workspace_id', label: 'Workspace', required: true, single: true },
        { key: 'class_id', label: 'Class' },
      ],
    })
    expect(out).toMatchObject({ ok: true, facets: ['workspace_id', 'class_id'] })
    expect(state.report!.facets).toHaveLength(2)
    // The QUERY is untouched. (The widget itself gains an id on first read —
    // that is the repair, and it is why facets are declared, not baked in.)
    expect(JSON.stringify((state.report!.widgets[0] as { query: unknown }).query)).toBe(beforeQuery)
  })

  it('rejects an invalid spec rather than writing a filter bar that cannot render', async () => {
    const { host, state } = makeHost(report([widget('a')]))
    const out = await call(byName(buildReportTools(host), 'set_report_filters'), {
      facets: [{ key: 'ok' }, { label: 'missing key' }],
    })
    expect(out.ok).toBe(false)
    expect(state.report!.facets).toBeUndefined()
  })
})

describe('rename_report', () => {
  it('retitles without touching widgets, and sets a description when given one', async () => {
    const { host, state } = makeHost(report([widget('a')]))
    const out = await call(byName(buildReportTools(host), 'rename_report'), {
      title: '  Term 3 engagement  ',
      description: 'Weekly, by class.',
    })
    expect(out).toMatchObject({ ok: true, title: 'Term 3 engagement' })
    expect(state.report!.description).toBe('Weekly, by class.')
    expect(state.report!.widgets).toHaveLength(1)
  })

  it('ignores a blank title rather than clearing the report name', async () => {
    const { host, state } = makeHost(report([widget('a')]))
    await call(byName(buildReportTools(host), 'rename_report'), { title: '   ' })
    expect(state.report!.title).toBe('Report')
  })
})

describe('every editing tool refuses to work on nothing', () => {
  const inputs: Record<string, unknown> = {
    edit_report_widget: { index: 0, widget: widget('x') },
    remove_report_widget: { index: 0 },
    move_report_widget: { from: 0, to: 1 },
    set_report_filters: { facets: [{ key: 'a', label: 'A' }] },
    rename_report: { title: 'x' },
  }
  for (const [name, input] of Object.entries(inputs)) {
    it(`${name} refuses, and points at create_report`, async () => {
      const { host } = makeHost(null)
      const out = await call(byName(buildReportTools(host), name), input)
      expect(out.ok).toBe(false)
      expect(String(out.error)).toMatch(/No report is open/)
      expect(String(out.error)).toMatch(/create_report/)
    })
  }
})
