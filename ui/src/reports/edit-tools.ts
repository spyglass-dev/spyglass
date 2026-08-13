/**
 * Tools for editing the report ALREADY ON SCREEN.
 *
 * `distri.ts` covers building a report and appending to it. Without the set
 * here an agent asked *"this report should have a class filter"* has no move
 * available, so it answers with advice — describing a change it is perfectly
 * able to make. Look, then restructure: `get_report` first, then the one tool
 * that does the job.
 *
 * Same structural `AgentTool` shape as the rest of the toolkit — no dependency
 * on any agent runtime; the host casts at the call site.
 */
import type { AgentTool, ReportHost, ToolContext } from '../distri'
import { isReportWidget, stateOf, validateWidgetQueries, withProvenance } from '../distri'
import { FILTER_SPEC_SCHEMA, validateFilterSpec } from '../report.schema'
import { checkFacetKeys, warnBakedDateRange } from './guards'
import { resolveWidget, widgetId, withWidgetIds } from './session'
import type { FacetSpec, Report, ReportWidget } from '../report'

const ok = (data: unknown) => [{ part_type: 'data' as const, data }]

/** Widget reference: `id` (stable) or `index` (positional). Both accepted. */
const WIDGET_REF = {
  id: { type: 'string', description: 'The widget id from get_report. PREFERRED — survives reorder.' },
  index: { type: 'number', description: '0-based position. Use only if you have no id.' },
}

/**
 * Read the report, with ids assigned, so every tool below addresses the same
 * widgets `get_report` reported. Returns null when nothing is open.
 */
function openReport(host: ReportHost): { report: Report; widgets: ReportWidget[] } | null {
  const report = host.getReport()
  if (!report) return null
  return { report, widgets: withWidgetIds(report.widgets) }
}

/** The one message every tool gives when there is nothing to act on. */
const NOTHING_OPEN = {
  ok: false,
  error:
    'No report is open, so there is nothing to change. If they asked for a NEW report, use ' +
    'create_report; otherwise open one first.',
  state: { status: 'none' as const },
}

/** `get_report` — look at what is on screen before changing it. */
export function getReportTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'get_report',
    description:
      'Read the report session: whether a report is open (`status`: none | draft | saved), its title, its declared filters, and every widget with its id AND WHAT IT RETURNED LAST TIME IT RAN (`outcome.status`: ok | empty | error | unresolved, with row counts). ' +
      'CALL THIS FIRST whenever the user refers to what is on screen — "this report", "add a filter", "remove that widget", "reorder", "rename it" — and whenever you want to know whether what you just built actually works. ' +
      'If `status` is draft or saved, a report IS open: change it with the edit tools. Do NOT call create_report, which replaces it. ' +
      'A widget whose outcome is `empty` renders "No data" to the user: that is a bug to fix, not a result to report. It is cheap, runs no queries, and returns the ids the edit tools take.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      // `get_report` IS the look: full detail, samples included.
      const state = stateOf(host, 'full')
      if (state.status === 'none') {
        return ok({ ok: true, state, note: 'No report is open. Only create_report is available.' })
      }
      const empty = state.widgets.filter((w) => w.outcome.status === 'empty').map((w) => w.title || w.id)
      const failed = state.widgets.filter((w) => w.outcome.status === 'error').map((w) => w.title || w.id)
      return ok({
        ok: true,
        state,
        ...(empty.length
          ? { attention: `These widgets returned NO ROWS and render "No data": ${empty.join(', ')}. Fix them before telling the user the report is done.` }
          : {}),
        ...(failed.length ? { errors: `These widgets failed: ${failed.join(', ')}.` } : {}),
      })
    },
  }
}

/** `edit_report_widget` — replace ONE widget in place. */
export function editWidgetTool(host: ReportHost, ctx: ToolContext = {}): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'edit_report_widget',
    description:
      'REPLACE one widget — identified by its `id` (preferred) or 0-based `index` from get_report — with the FULL replacement widget, change applied. Only that widget changes; everything else is untouched. Do NOT put a `dateRange` in the query: the report\'s date filter owns the window. Returns the report state, so check the widget actually returned rows.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...WIDGET_REF,
        widget: { type: 'object' },
        prompt: { type: 'string', description: "The user's ask, verbatim (stored as provenance)." },
      },
      required: ['widget'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { id?: string; index?: number; widget?: unknown; prompt?: string }
      const open = openReport(host)
      if (!open) return ok(NOTHING_OPEN)
      if (!isReportWidget(a.widget)) return ok({ ok: false, error: 'Provide a valid `widget`.' })
      const found = resolveWidget(open.widgets, a)
      if ('error' in found) return ok({ ok: false, error: found.error, state: stateOf(host) })
      const invalid = validateWidgetQueries([a.widget], ctx.meta)
      if (invalid) return ok(invalid)
      const warning = warnBakedDateRange([a.widget])
      const keepId = widgetId(open.widgets[found.index])
      const [replacement] = withProvenance([a.widget], a.prompt)
      const widgets = open.widgets.map((w, idx) =>
        idx === found.index ? ({ ...replacement, id: keepId } as ReportWidget) : w,
      )
      host.setReport({ ...open.report, widgets })
      return ok({ ok: true, id: keepId, ...(warning ? { warning } : {}), state: stateOf(host) })
    },
  }
}

/** `remove_report_widget` — composition is also subtraction. */
export function removeWidgetTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'remove_report_widget',
    description: 'Delete ONE widget, by its `id` (preferred) or 0-based `index` from get_report.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { ...WIDGET_REF },
    },
    handler: async (input) => {
      const open = openReport(host)
      if (!open) return ok(NOTHING_OPEN)
      const found = resolveWidget(open.widgets, (input ?? {}) as { id?: string; index?: number })
      if ('error' in found) return ok({ ok: false, error: found.error, state: stateOf(host) })
      const widgets = open.widgets.filter((_, idx) => idx !== found.index)
      host.setReport({ ...open.report, widgets })
      return ok({ ok: true, state: stateOf(host) })
    },
  }
}

/** `move_report_widget` — order is the report's argument, so let the agent set it. */
export function moveWidgetTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'move_report_widget',
    description:
      'Reorder: move one widget — by `id` (preferred) or `from` index — to position `to` (0-based). A report reads top to bottom: headline metrics, then the breakdown that explains them, then the detail.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'The widget to move (from get_report). PREFERRED.' },
        from: { type: 'number', description: 'Its current position, if you have no id.' },
        to: { type: 'number', description: 'Where it should end up.' },
      },
      required: ['to'],
    },
    handler: async (input) => {
      const open = openReport(host)
      if (!open) return ok(NOTHING_OPEN)
      const a = (input ?? {}) as { id?: string; from?: number; to?: number }
      const found = resolveWidget(open.widgets, { id: a.id, index: a.from })
      if ('error' in found) return ok({ ok: false, error: found.error, state: stateOf(host) })
      const n = open.widgets.length
      const dest = Math.max(0, Math.min(typeof a.to === 'number' ? a.to : n - 1, n - 1))
      const widgets = [...open.widgets]
      const [moved] = widgets.splice(found.index, 1)
      widgets.splice(dest, 0, moved)
      host.setReport({ ...open.report, widgets })
      return ok({ ok: true, from: found.index, to: dest, state: stateOf(host) })
    },
  }
}

/**
 * `set_report_filters` — declare which filters the report OFFERS.
 *
 * A facet is a DECLARATION, not a value: the user picks values in the bar and
 * the framework applies them to every widget whose cube has the dimension.
 * Baking the filter into each query instead produces a report that cannot be
 * re-pointed and a filter bar that does nothing — `applyFilters` skips a facet
 * when the query already filters that member.
 */
export function setReportFiltersTool(host: ReportHost, ctx: ToolContext = {}): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'set_report_filters',
    description:
      'Declare the filter bar for the OPEN report — which filters it offers and which are mandatory. Use for "add a filter for X", "make it filterable by X", "scope this to X". A facet is a DECLARATION: { key, label, required?, single?, source?, options? }, where `key` is a dimension the reader picks a VALUE of — class_id, status, student_id. NEVER a time dimension: every report already has a date range, and a facet over a date can only be an empty menu. Prefer this over baking a filter into widget queries. Replaces the whole spec, so include every facet you want kept.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { facets: FILTER_SPEC_SCHEMA },
      required: ['facets'],
    },
    handler: async (input) => {
      const report = host.getReport()
      if (!report) return ok(NOTHING_OPEN)
      const facets = (input as { facets?: unknown })?.facets
      const v = validateFilterSpec(facets)
      if (!v.valid) {
        const detail = v.errors.map((e) => `${e.path} ${e.message}`).join('; ')
        return ok({ ok: false, error: `Invalid facets: ${detail}` })
      }
      const badKey = checkFacetKeys(facets as FacetSpec[], ctx.meta)
      if (badKey) return ok({ ok: false, error: badKey })
      host.setReport({ ...report, facets: facets as FacetSpec[] })
      return ok({ ok: true, facets: (facets as FacetSpec[]).map((f) => f.key), state: stateOf(host) })
    },
  }
}

/** `rename_report` — the title is part of the artefact. */
export function renameReportTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'rename_report',
    description:
      'Retitle the open report, and optionally set its one-line description. Say what the report is ABOUT, not what kind of thing it is.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { title: { type: 'string' }, description: { type: 'string' } },
      required: ['title'],
    },
    handler: async (input) => {
      const report = host.getReport()
      if (!report) return ok(NOTHING_OPEN)
      const { title, description } = (input ?? {}) as { title?: string; description?: string }
      const next: Report = { ...report }
      if (title?.trim()) next.title = title.trim()
      if (description !== undefined) next.description = description
      host.setReport(next)
      return ok({ ok: true, title: next.title, state: stateOf(host) })
    },
  }
}

/** Every editing tool, in the order the agent reads them. */
export function buildEditTools(host: ReportHost, ctx: ToolContext = {}): AgentTool[] {
  return [
    getReportTool(host),
    editWidgetTool(host, ctx),
    removeWidgetTool(host),
    moveWidgetTool(host),
    setReportFiltersTool(host, ctx),
    renameReportTool(host),
  ]
}
