/**
 * The report session state machine, the idempotent upsert, and the two guards.
 *
 * Every case here is one an agent actually produced. The report that prompted
 * this work read "No data" in all five widgets while the agent reported
 * success, because it pinned `dateRange: "This week"` into every query, declared
 * a facet on a time dimension, and then had no way to look at what it had made.
 */
import { describe, it, expect } from 'vitest'
import {
  buildReportTools,
  findDuplicate,
  newWidgetId,
  resolveWidget,
  sessionState,
  widgetFingerprint,
  withWidgetIds,
  checkFacetKeys,
  warnBakedDateRange,
  NO_REPORT,
  type AgentTool,
  type CubeModelMeta,
  type Report,
  type ReportHost,
  type ReportWidget,
  type WidgetOutcome,
} from '../index'

const bound = (over: Record<string, unknown> = {}) =>
  ({ type: 'bound', as: 'metric', query: { measures: ['Submissions.count'] }, ...over }) as unknown as ReportWidget

const doc = (widgets: unknown[] = []): Report => ({ title: 'R', widgets }) as unknown as Report

function makeHost(initial: Report | null = null) {
  const state: { report: Report | null; savedId: string | null; outcomes: Record<string, WidgetOutcome> } = {
    report: initial,
    savedId: null,
    outcomes: {},
  }
  const host: ReportHost = {
    getReport: () => state.report,
    setReport: (r) => {
      state.report = r
    },
    getSavedId: () => state.savedId,
    getOutcomes: () => state.outcomes,
  }
  return { host, state }
}

const byName = (tools: AgentTool[], n: string) => tools.find((t) => t.name === n)!
const call = async (t: AgentTool, i: unknown) => (await t.handler(i))[0].data as Record<string, unknown>
const ids = (host: ReportHost) => (host.getReport()!.widgets as Array<{ id: string }>).map((w) => w.id)

/** A model with one time dimension and one ordinary one. */
const META = {
  cubes: [
    {
      name: 'Submissions',
      measures: [{ member: 'Submissions.count' }],
      dimensions: [
        { member: 'Submissions.class_id', type: 'string' },
        { member: 'Submissions.submitted_at', type: 'time' },
        { member: 'Submissions.created_at', type: 'time' },
      ],
    },
  ],
} as unknown as CubeModelMeta

// ── widget identity ──────────────────────────────────────────────────────

describe('widget identity', () => {
  it('mints an id only for widgets that lack one, and keeps the rest', () => {
    const kept = bound({ id: 'w_keep' })
    const out = withWidgetIds([kept, bound()])
    expect(out[0]).toBe(kept)
    expect((out[1] as { id: string }).id).toMatch(/^w_/)
  })

  it('returns the SAME array when nothing is missing — a read must not dirty a doc', () => {
    const widgets = [bound({ id: 'a' }), bound({ id: 'b' })]
    expect(withWidgetIds(widgets)).toBe(widgets)
  })

  it('re-mints a duplicated id, because two widgets sharing one are one widget', () => {
    const out = withWidgetIds([bound({ id: 'dup' }), bound({ id: 'dup', as: 'table' })])
    expect((out[0] as { id: string }).id).toBe('dup')
    expect((out[1] as { id: string }).id).not.toBe('dup')
  })

  it('ids are unique', () => {
    const seen = new Set(Array.from({ length: 200 }, () => newWidgetId()))
    expect(seen.size).toBeGreaterThan(190)
  })
})

describe('structural fingerprint', () => {
  it('ignores key order and provenance — same render, same widget', () => {
    const a = { type: 'bound', as: 'metric', query: { measures: ['A.c'], dimensions: ['A.d'] } }
    const b = { query: { dimensions: ['A.d'], measures: ['A.c'] }, as: 'metric', type: 'bound' }
    expect(widgetFingerprint(a as never)).toBe(widgetFingerprint(b as never))
    expect(widgetFingerprint({ ...a, provenance: { at: 1 } } as never)).toBe(widgetFingerprint(a as never))
    expect(widgetFingerprint({ ...a, id: 'w_1' } as never)).toBe(widgetFingerprint(a as never))
  })

  it('does NOT collapse two widgets that merely share a title', () => {
    const submitted = bound({ title: 'Submissions', query: { measures: ['Submissions.submitted'] } })
    const graded = bound({ title: 'Submissions', query: { measures: ['Submissions.graded'] } })
    expect(findDuplicate([submitted], graded)).toBeNull()
  })
})

describe('resolveWidget', () => {
  const widgets = [bound({ id: 'a' }), bound({ id: 'b' }), bound({ id: 'c' })]

  it('prefers the id when both are given, because an index moves and an id does not', () => {
    expect(resolveWidget(widgets, { id: 'c', index: 0 })).toEqual({ index: 2 })
  })

  it('explains an unknown id instead of silently hitting the wrong widget', () => {
    const out = resolveWidget(widgets, { id: 'nope' })
    expect('error' in out && out.error).toMatch(/get_report/)
  })

  it('falls back to the index, and bounds it', () => {
    expect(resolveWidget(widgets, { index: 1 })).toEqual({ index: 1 })
    expect('error' in resolveWidget(widgets, { index: 9 })).toBe(true)
  })
})

// ── the state machine ────────────────────────────────────────────────────

describe('sessionState', () => {
  it('none when nothing is open — a state, not a failure', () => {
    expect(sessionState({ report: null })).toEqual(NO_REPORT)
  })

  it('draft while unsaved, saved once the host has an id', () => {
    expect(sessionState({ report: doc([]) }).status).toBe('draft')
    expect(sessionState({ report: doc([]), savedId: 'r1' })).toMatchObject({ status: 'saved', id: 'r1' })
  })

  it('is pure — it runs no query and mutates nothing', () => {
    const d = doc([bound({ id: 'a' })])
    const before = JSON.stringify(d)
    sessionState({ report: d })
    expect(JSON.stringify(d)).toBe(before)
  })

  it('defaults an unreported widget to unresolved rather than to fine', () => {
    const s = sessionState({ report: doc([bound({ id: 'a' })]), outcomes: {} })
    expect(s.widgets[0].outcome).toEqual({ status: 'unresolved' })
  })

  it('accepts outcomes as a Map or a plain object', () => {
    const d = doc([bound({ id: 'a' })])
    const m = sessionState({ report: d, outcomes: new Map([['a', { status: 'ok', row_count: 3 } as WidgetOutcome]]) })
    const o = sessionState({ report: d, outcomes: { a: { status: 'ok', row_count: 3 } } })
    expect(m.widgets[0].outcome).toEqual(o.widgets[0].outcome)
  })
})

// ── the upsert ───────────────────────────────────────────────────────────

describe('add_report_widget is idempotent', () => {
  it('adds once, then dedupes the identical retry instead of doubling it', async () => {
    const { host } = makeHost(doc([]))
    const add = byName(buildReportTools(host), 'add_report_widget')
    const first = await call(add, { widget: bound({ title: 'Classes' }) })
    const second = await call(add, { widget: bound({ title: 'Classes' }) })
    expect(first.action).toBe('added')
    expect(second).toMatchObject({ action: 'deduped', id: first.id })
    expect(host.getReport()!.widgets).toHaveLength(1)
  })

  it('replaces in place when given an id — the retry-safe path for an edit', async () => {
    const { host } = makeHost(doc([bound({ id: 'w_1', title: 'Old' }), bound({ id: 'w_2' })]))
    const out = await call(byName(buildReportTools(host), 'add_report_widget'), {
      id: 'w_1',
      widget: bound({ title: 'New' }),
    })
    expect(out).toMatchObject({ action: 'replaced', id: 'w_1' })
    expect(host.getReport()!.widgets).toHaveLength(2)
    expect((host.getReport()!.widgets[0] as { title: string }).title).toBe('New')
    expect(ids(host)[0]).toBe('w_1')
  })

  it('refuses an id the report does not have rather than appending a surprise', async () => {
    const { host } = makeHost(doc([bound({ id: 'w_1' })]))
    const out = await call(byName(buildReportTools(host), 'add_report_widget'), {
      id: 'w_nope',
      widget: bound(),
    })
    expect(out.ok).toBe(false)
    expect(host.getReport()!.widgets).toHaveLength(1)
  })

  it('returns the state after the change, so no second call is needed to see it', async () => {
    const { host } = makeHost(doc([]))
    const out = await call(byName(buildReportTools(host), 'add_report_widget'), { widget: bound() })
    expect(out.state).toMatchObject({ status: 'draft', widget_count: 1 })
  })

  it('two genuinely different widgets both land', async () => {
    const { host } = makeHost(doc([]))
    const add = byName(buildReportTools(host), 'add_report_widget')
    await call(add, { widget: bound({ query: { measures: ['Submissions.submitted'] } }) })
    await call(add, { widget: bound({ query: { measures: ['Submissions.graded'] } }) })
    expect(host.getReport()!.widgets).toHaveLength(2)
  })
})

// ── the guards ───────────────────────────────────────────────────────────

describe('a facet cannot be a time dimension', () => {
  it('names the offending key and says what to do instead', () => {
    const msg = checkFacetKeys([{ key: 'submitted_at', label: 'Week' }] as never, META)
    expect(msg).toMatch(/submitted_at/)
    expect(msg).toMatch(/date/i)
  })

  it('passes an ordinary dimension, and passes when there is no model to check against', () => {
    expect(checkFacetKeys([{ key: 'class_id', label: 'Class' }] as never, META)).toBeNull()
    expect(checkFacetKeys([{ key: 'submitted_at', label: 'Week' }] as never, undefined)).toBeNull()
  })

  it('set_report_filters refuses it, so the bar cannot become an empty menu', async () => {
    const { host } = makeHost(doc([bound({ id: 'a' })]))
    const out = await call(byName(buildReportTools(host, { meta: META }), 'set_report_filters'), {
      facets: [{ key: 'submitted_at', label: 'Week', required: true }],
    })
    expect(out.ok).toBe(false)
    expect(host.getReport()!.facets).toBeUndefined()
  })

  it('create_report refuses it too — this is the spec that shipped an empty report', async () => {
    const { host } = makeHost()
    const out = await call(byName(buildReportTools(host, { meta: META }), 'create_report'), {
      title: 'Weekly',
      widgets: [bound()],
      facets: [
        { key: 'class_id', label: 'Class', required: true },
        { key: 'submitted_at', label: 'Week', required: true },
      ],
    })
    expect(out.ok).toBe(false)
    expect(host.getReport()).toBeNull()
  })
})

describe('a widget must not pin its own window', () => {
  it('warns, naming the dimension and what it costs', () => {
    const msg = warnBakedDateRange([
      bound({ query: { measures: ['Submissions.count'], timeDimensions: [{ dimension: 'Submissions.submitted_at', dateRange: 'This week' }] } }),
    ])
    expect(msg).toMatch(/submitted_at/)
    expect(msg).toMatch(/date filter/i)
  })

  it('says nothing about a granularity — the shape of a trend is not a window', () => {
    expect(
      warnBakedDateRange([
        bound({ query: { measures: ['Submissions.count'], timeDimensions: [{ dimension: 'Submissions.created_at', granularity: 'day' }] } }),
      ]),
    ).toBeNull()
  })

  it('create_report still builds, but hands the warning back with the state', async () => {
    const { host } = makeHost()
    const out = await call(byName(buildReportTools(host, { meta: META }), 'create_report'), {
      title: 'Weekly',
      widgets: [
        bound({ query: { measures: ['Submissions.count'], timeDimensions: [{ dimension: 'Submissions.submitted_at', dateRange: 'This week' }] } }),
      ],
    })
    // Advisory, not a refusal: one widget deliberately showing a different
    // period from the rest of the report is legitimate.
    expect(out.ok).toBe(true)
    expect(String(out.warning)).toMatch(/dateRange/)
  })
})

// ── what the agent is told after it builds ───────────────────────────────

describe('the report that shipped empty would now be caught', () => {
  it('get_report calls out the widgets rendering "No data"', async () => {
    const { host, state } = makeHost(doc([bound({ id: 'w_1', title: 'Submissions This Week' })]))
    state.outcomes = { w_1: { status: 'empty', row_count: 0, applied: { facets: ['class_id'] } } }
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    expect(String(out.attention)).toMatch(/Submissions This Week/)
    expect((out.state as { widgets: Array<{ outcome: WidgetOutcome }> }).widgets[0].outcome.applied).toEqual({
      facets: ['class_id'],
    })
  })

  it('and stays quiet when every widget returned rows', async () => {
    const { host, state } = makeHost(doc([bound({ id: 'w_1' })]))
    state.outcomes = { w_1: { status: 'ok', row_count: 107 } }
    const out = await call(byName(buildReportTools(host), 'get_report'), {})
    expect(out.attention).toBeUndefined()
  })
})

// ── outcomes, derived from what the canvas drew ──────────────────────────

describe('outcomesFrom — the widget that rendered "No data"', () => {
  it('calls an empty table empty and a full one ok, with a sample', async () => {
    const { outcomesFrom } = await import('../reports/outcome')
    const source = [bound({ id: 'w_a', as: 'table' }), bound({ id: 'w_b', as: 'table' })]
    const resolved = [
      { type: 'table', columns: [], rows: [] },
      { type: 'table', columns: [], rows: [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }] },
    ]
    const out = outcomesFrom({ source, resolved: resolved as never })
    expect(out.get('w_a')).toMatchObject({ status: 'empty', row_count: 0 })
    expect(out.get('w_b')).toMatchObject({ status: 'ok', row_count: 4 })
    expect(out.get('w_b')!.sample).toHaveLength(3)
  })

  it('reads a failed widget as an error, not as empty', async () => {
    const { outcomesFrom } = await import('../reports/outcome')
    const out = outcomesFrom({
      source: [bound({ id: 'w_a' })],
      resolved: [{ type: 'custom', component: 'widget_error', data: { detail: 'unknown member' } }] as never,
    })
    expect(out.get('w_a')).toMatchObject({ status: 'error', error: 'unknown member' })
  })

  it('treats a metric of 0 as an answer, and a missing value as empty', async () => {
    const { outcomesFrom } = await import('../reports/outcome')
    const out = outcomesFrom({
      source: [bound({ id: 'w_zero' }), bound({ id: 'w_null' })],
      resolved: [
        { type: 'metric', value: 0, label: 'Submissions' },
        { type: 'metric', value: null },
      ] as never,
    })
    expect(out.get('w_zero')!.status).toBe('ok')
    expect(out.get('w_null')!.status).toBe('empty')
  })

  it('skips a widget with no id rather than keying an outcome wrongly', async () => {
    const { outcomesFrom } = await import('../reports/outcome')
    const out = outcomesFrom({
      source: [bound(), bound({ id: 'w_b' })],
      resolved: [{ type: 'table', columns: [], rows: [] }, { type: 'table', columns: [], rows: [{ a: 1 }] }] as never,
    })
    expect(out.size).toBe(1)
    expect(out.get('w_b')!.status).toBe('ok')
  })
})
