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
import { isReportWidget, validateWidgetQueries, withProvenance } from '../distri'
import { FILTER_SPEC_SCHEMA, validateFilterSpec } from '../report.schema'
import type { FacetSpec, Report, ReportWidget } from '../report'

const ok = (data: unknown) => [{ part_type: 'data' as const, data }]

/** A compact view of one widget — enough to decide what to change, without
 *  returning every query into the context window. */
function describeWidget(w: ReportWidget, index: number) {
  const anyW = w as unknown as Record<string, unknown>
  const q = anyW.query as { measures?: string[]; dimensions?: string[] } | undefined
  return {
    index,
    type: anyW.type,
    as: anyW.as,
    title: anyW.title ?? anyW.label,
    measures: q?.measures,
    dimensions: q?.dimensions,
  }
}

/** `get_report` — look at what is on screen before changing it. */
export function getReportTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'get_report',
    description:
      'Read the report currently open: its title, its declared filters (facets), and a compact list of its widgets with their measures and dimensions. CALL THIS FIRST, BEFORE ANY OTHER REPORT TOOL, whenever the user refers to what is on screen — "this report", "add a filter", "remove that widget", "reorder", "rename it". It is cheap and it returns the widget indexes the edit tools take. Editing the open report is almost always what is wanted; do not plan a new one unless a NEW report was asked for.',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    handler: async () => {
      const report = host.getReport()
      if (!report) return ok({ ok: false, error: 'No report is open.' })
      return ok({
        ok: true,
        title: report.title,
        description: report.description,
        facets: report.facets ?? [],
        widget_count: report.widgets.length,
        widgets: report.widgets.map(describeWidget),
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
      'REPLACE one widget, by its 0-based `index` (from get_report), with the FULL replacement widget with the change applied. Only that widget changes. To append use add_report_widget; to rebuild, create_report.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        index: { type: 'number' },
        widget: { type: 'object' },
        prompt: { type: 'string', description: "The user's ask, verbatim (stored as provenance)." },
      },
      required: ['index', 'widget'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { index?: number; widget?: unknown; prompt?: string }
      const report = host.getReport()
      if (!report) return ok({ ok: false, error: 'No report is open.' })
      if (!isReportWidget(a.widget)) return ok({ ok: false, error: 'Provide a valid `widget`.' })
      const i = a.index
      if (typeof i !== 'number' || i < 0 || i >= report.widgets.length) {
        return ok({ ok: false, error: `index out of range (report has ${report.widgets.length}).` })
      }
      const invalid = validateWidgetQueries([a.widget], ctx.meta)
      if (invalid) return ok(invalid)
      const [replacement] = withProvenance([a.widget], a.prompt)
      const widgets = report.widgets.map((w, idx) => (idx === i ? replacement : w))
      host.setReport({ ...report, widgets })
      return ok({ ok: true, widget_count: widgets.length })
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
    description: 'Delete ONE widget by its 0-based `index` (see get_report).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { index: { type: 'number' } },
      required: ['index'],
    },
    handler: async (input) => {
      const report = host.getReport()
      if (!report) return ok({ ok: false, error: 'No report is open.' })
      const i = (input as { index?: number })?.index
      if (typeof i !== 'number' || i < 0 || i >= report.widgets.length) {
        return ok({ ok: false, error: `index out of range (report has ${report.widgets.length}).` })
      }
      const widgets = report.widgets.filter((_, idx) => idx !== i)
      host.setReport({ ...report, widgets })
      return ok({ ok: true, widget_count: widgets.length })
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
      'Reorder: move the widget at `from` to position `to` (0-based). A report reads top to bottom — headline metrics, then the breakdown that explains them, then the detail.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { from: { type: 'number' }, to: { type: 'number' } },
      required: ['from', 'to'],
    },
    handler: async (input) => {
      const report = host.getReport()
      if (!report) return ok({ ok: false, error: 'No report is open.' })
      const { from, to } = (input ?? {}) as { from?: number; to?: number }
      const n = report.widgets.length
      if (typeof from !== 'number' || from < 0 || from >= n) {
        return ok({ ok: false, error: `from out of range (report has ${n}).` })
      }
      const dest = Math.max(0, Math.min(typeof to === 'number' ? to : n - 1, n - 1))
      const widgets = [...report.widgets]
      const [moved] = widgets.splice(from, 1)
      widgets.splice(dest, 0, moved)
      host.setReport({ ...report, widgets })
      return ok({ ok: true, from, to: dest })
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
export function setReportFiltersTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'set_report_filters',
    description:
      'Declare the filter bar for the OPEN report — which filters it offers and which are mandatory. Use for "add a filter for X", "make it filterable by X", "scope this to X". A facet is a DECLARATION: { key, label, required?, single?, source?, options? }, where `key` is the dimension the cubes filter on. Prefer this over baking a filter into widget queries. Replaces the whole spec, so include every facet you want kept.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { facets: FILTER_SPEC_SCHEMA },
      required: ['facets'],
    },
    handler: async (input) => {
      const report = host.getReport()
      if (!report) return ok({ ok: false, error: 'No report is open.' })
      const facets = (input as { facets?: unknown })?.facets
      const v = validateFilterSpec(facets)
      if (!v.valid) {
        const detail = v.errors.map((e) => `${e.path} ${e.message}`).join('; ')
        return ok({ ok: false, error: `Invalid facets: ${detail}` })
      }
      host.setReport({ ...report, facets: facets as FacetSpec[] })
      return ok({ ok: true, facets: (facets as FacetSpec[]).map((f) => f.key) })
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
      if (!report) return ok({ ok: false, error: 'No report is open.' })
      const { title, description } = (input ?? {}) as { title?: string; description?: string }
      const next: Report = { ...report }
      if (title?.trim()) next.title = title.trim()
      if (description !== undefined) next.description = description
      host.setReport(next)
      return ok({ ok: true, title: next.title })
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
    setReportFiltersTool(host),
    renameReportTool(host),
  ]
}
