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
 * So the tools resolve each new or changed widget themselves, once, the way the
 * canvas will, and remember the result per host. `stateOf` falls back to
 * these whenever the canvas has not reported yet, and the tool result names the
 * widgets that need fixing.
 */
import { resolveReport, type ReportWidget } from '../report'
import type { ReportHost, ToolContext } from '../distri'
import { outcomesFrom } from './outcome'
import { type WidgetOutcome } from './session'

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

/**
 * Check-run the widgets among `widgets` the way the canvas will draw them, and
 * record the results against `host`.
 *
 * "The way the canvas will" is the point: the report's own filters (date
 * window, selected facets, drill) apply, and the result is classified by the
 * same `outcomesFrom` the canvas uses. Running the raw query instead said "ok"
 * for a widget that rows existed for somewhere, while the canvas — scoped to
 * the last 30 days — showed zeros. Widgets with nothing to run (notes, static
 * tables) come back `ok`.
 */
export async function probeWidgets(
  host: ReportHost,
  widgets: ReportWidget[],
  ctx: Pick<ToolContext, 'runQuery' | 'cubeCaps' | 'views' | 'members'>,
): Promise<Map<string, WidgetOutcome>> {
  const store = probeOutcomes(host)
  if (!ctx.runQuery || !widgets.length) return new Map()
  const report = host.getReport()
  const filters = report?.filters
  const resolved = await resolveReport(
    { title: report?.title ?? '', widgets },
    {
      runQuery: ctx.runQuery,
      filters,
      drill: report?.drill,
      cubeCaps: ctx.cubeCaps,
      views: ctx.views,
      members: ctx.members,
    },
  )
  const out = outcomesFrom({ source: widgets, resolved: resolved.widgets, filters, cubeCaps: ctx.cubeCaps })
  for (const [id, o] of out) store.set(id, o)
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
      ...(o.note ? { note: o.note } : {}),
    })),
    next:
      'These widgets do not work yet. Fix each one now with edit_report_widget (repair the query: ' +
      'check member names with explore_data, drop a pinned dateRange, loosen a filter), or remove it ' +
      'with remove_report_widget. Do NOT tell the user the report works while any widget is listed here.',
  }
}
