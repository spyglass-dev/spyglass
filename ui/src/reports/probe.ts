/**
 * Check-running what an agent just built.
 *
 * The canvas resolves every widget in order to draw it, and hosts feed those
 * results back as outcomes. But a tool returns BEFORE the canvas has drawn
 * anything, so the state a mutating tool hands back says `unresolved` for the
 * very widgets the agent just made, and the agent tells the user "it returned
 * data" without anyone having run it. That is how a report with a failing
 * widget got announced as working.
 *
 * So the tools run each new or changed widget's query themselves, once, with a
 * small row cap, and remember the result per host. `stateOf` falls back to
 * these whenever the canvas has not reported yet, and the tool result names the
 * widgets that need fixing.
 */
import { normalizeQuery, type QueryResultLite, type WidgetQuery } from '../querybuilder'
import type { ReportWidget } from '../report'
import { widgetId, type WidgetOutcome } from './session'

/** Rows a check-run fetches at most. It answers "does this return anything". */
export const PROBE_ROW_CAP = 25

const stores = new WeakMap<object, Map<string, WidgetOutcome>>()

/** The check-run results for one host, keyed by widget id. */
export function probeOutcomes(host: object): Map<string, WidgetOutcome> {
  let m = stores.get(host)
  if (!m) {
    m = new Map()
    stores.set(host, m)
  }
  return m
}

const queryOf = (w: ReportWidget): WidgetQuery | undefined => {
  const t = (w as { type?: string }).type
  if (t !== 'bound' && t !== 'view') return undefined
  return (w as { query?: WidgetQuery }).query
}

/** Run one query and classify it. Never throws. */
export async function probeQuery(
  query: WidgetQuery,
  runQuery: (q: WidgetQuery) => Promise<QueryResultLite>,
): Promise<WidgetOutcome> {
  try {
    const result = await runQuery({ ...normalizeQuery(query), limit: Math.min(query.limit ?? PROBE_ROW_CAP, PROBE_ROW_CAP) })
    const rows = result.rows ?? []
    return rows.length
      ? { status: 'ok', row_count: result.total ?? rows.length, sample: rows.slice(0, 2) }
      : { status: 'empty', row_count: 0 }
  } catch (e) {
    return { status: 'error', error: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Check-run the query-carrying widgets among `widgets` and record the results
 * against `host`. Widgets without a query (notes, static tables) are skipped.
 * Runs in parallel; returns the outcomes it produced.
 */
export async function probeWidgets(
  host: object,
  widgets: ReportWidget[],
  runQuery: (q: WidgetQuery) => Promise<QueryResultLite>,
): Promise<Map<string, WidgetOutcome>> {
  const store = probeOutcomes(host)
  const out = new Map<string, WidgetOutcome>()
  await Promise.all(
    widgets.map(async (w) => {
      const id = widgetId(w)
      const q = queryOf(w)
      if (!id || !q) return
      const outcome = await probeQuery(q, runQuery)
      store.set(id, outcome)
      out.set(id, outcome)
    }),
  )
  return out
}

/** Forget results for widgets that no longer exist or were replaced. */
export function forgetProbes(host: object, ids: Iterable<string>): void {
  const store = probeOutcomes(host)
  for (const id of ids) store.delete(id)
}

/**
 * The widgets among `ids` that failed or came back empty, in the shape a tool
 * result carries, with the instruction that goes with it. Null when all is well.
 */
export function needsFix(
  outcomes: Map<string, WidgetOutcome>,
  titles: Map<string, string | undefined>,
): { needs_fix: Array<{ id: string; title?: string; status: string; error?: string }>; next: string } | null {
  const bad = [...outcomes.entries()].filter(([, o]) => o.status === 'error' || o.status === 'empty')
  if (!bad.length) return null
  return {
    needs_fix: bad.map(([id, o]) => ({
      id,
      ...(titles.get(id) ? { title: titles.get(id) } : {}),
      status: o.status,
      ...(o.error ? { error: o.error } : {}),
    })),
    next:
      'These widgets do not work yet. Fix each one now with edit_report_widget (repair the query: ' +
      'check member names with explore_data, drop a pinned dateRange, loosen a filter), or remove it ' +
      'with remove_report_widget. Do NOT tell the user the report works while any widget is listed here.',
  }
}
