/**
 * Distri report tools — agent-facing tools for building reports from natural
 * language. Structurally compatible with `@distri/core`'s `DistriFnTool` (no
 * hard dependency here — cast at the call site). The host implements
 * `ReportHost` (open/update the report it's showing) and pairs these with a
 * reporting skill (see `spyglass/skills/reporting`).
 */
import type { BoundWidget, Report, ReportWidget, ViewWidget } from './report'
import type { CubeModelMeta, QueryResultLite, WidgetQuery } from './querybuilder'
import { validateQuery } from './validate'
import type { ViewRegistry } from './views'

/** A frontend agent tool (matches `@distri/core` DistriFnTool structurally). */
export interface AgentTool {
  type: 'function'
  isExternal: true
  autoExecute: true
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (input: unknown) => Promise<Array<{ part_type: 'data'; data: unknown }>>
}

/** The report surface the tools read/write (a host session + persistence). */
export interface ReportHost {
  /** The report currently open (null if none). */
  getReport(): Report | null
  /** Open/replace the working report (persist + render). */
  setReport(report: Report): void
  /** Called after `create_report` builds a fresh report (e.g. navigate to it). */
  onBuilt?(report: Report): void
}

/** Agent-readable widget vocabulary for the tool schemas + skills. */
export const WIDGET_VOCAB = [
  'bound — a data widget backed by a query: { type:"bound", as:"metric"|"table"|"chart", query:{ measures:["Cube.measure"], dimensions?:["Cube.dimension"], filters?, timeDimensions? }, title?, w?, label?, format?, mark?, x?, y? }. PREFER this for data.',
  'metric — a static scalar: { type:"metric", value, label?, format?, w? }',
  'table — static rows: { type:"table", columns:[{key,label}], rows:[…], w? }',
  'chart — static series: { type:"chart", chart:{ mark:"bar"|"line"|"area", x?, y, series:[…] }, w? }',
  'note — markdown: { type:"note", markdown, w? }',
].join('\n')

const VALID = new Set(['metric', 'table', 'chart', 'note', 'bound', 'view'])
const isWidget = (w: unknown): w is ReportWidget =>
  !!w && typeof w === 'object' && VALID.has((w as { type?: string }).type ?? '')
const ok = (data: unknown) => [{ part_type: 'data' as const, data }]

/** Optional model + runner context: with `meta`, bound queries VALIDATE
 *  before rendering (bad member → `{ ok:false, error, suggestions }` so the
 *  agent repairs); tools also stamp agent provenance on bound widgets. */
export interface ToolContext {
  meta?: CubeModelMeta
  runQuery?: (query: WidgetQuery) => Promise<QueryResultLite>
  /** Host view registry — enables `add_report_view`, validated against each
   *  view's manifest. */
  views?: ViewRegistry
}

const hasQuery = (w: ReportWidget): w is BoundWidget | (ViewWidget & { query: WidgetQuery }) => {
  const t = (w as { type?: string }).type
  return t === 'bound' || (t === 'view' && (w as ViewWidget).query !== undefined)
}

/** Validate every query-carrying widget; the first failure aborts the tool. */
function validateWidgets(widgets: ReportWidget[], meta: CubeModelMeta | undefined) {
  if (!meta) return null
  for (const w of widgets) {
    if (!hasQuery(w)) continue
    const v = validateQuery(w.query, meta)
    if (!v.ok) return { ok: false as const, error: v.error, suggestions: v.suggestions }
  }
  return null
}

/** Stamp agent provenance on bound/view widgets (part of the doc, not a side
 *  channel). */
function withProvenance(widgets: ReportWidget[], prompt: string | undefined): ReportWidget[] {
  return widgets.map((w) => {
    const t = (w as { type?: string }).type
    return (t === 'bound' || t === 'view') && !(w as BoundWidget).provenance
      ? ({ ...w, provenance: { prompt, author: 'agent', at: Date.now() } } as ReportWidget)
      : w
  })
}

/** `create_report` — build a report from a title + widgets and open it. */
export function createReportTool(host: ReportHost, ctx: ToolContext = {}): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'create_report',
    description:
      'Build a report and open it: pass a `title` and an ordered list of `widgets` (prefer `bound` widgets carrying a query). Pass the user ask as `prompt` for provenance. Widget vocabulary:\n' +
      WIDGET_VOCAB,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        widgets: { type: 'array', items: { type: 'object' } },
        prompt: { type: 'string', description: "The user's ask, verbatim (stored as provenance)." },
      },
      required: ['title'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { title?: string; description?: string; widgets?: unknown; prompt?: string }
      const widgets = Array.isArray(a.widgets) ? a.widgets.filter(isWidget) : []
      const invalid = validateWidgets(widgets, ctx.meta)
      if (invalid) return ok(invalid)
      const report: Report = {
        title: a.title?.trim() || 'Untitled report',
        description: a.description,
        widgets: withProvenance(widgets, a.prompt),
      }
      host.setReport(report)
      host.onBuilt?.(report)
      return ok({ ok: true, widget_count: widgets.length })
    },
  }
}

/** `add_report_widget` — append ONE widget to the open report. */
export function addWidgetTool(host: ReportHost, ctx: ToolContext = {}): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'add_report_widget',
    description:
      'Append ONE widget to the report already open (keeps existing widgets and layout). Pass a single `widget` (prefer a `bound` widget), optional `index`, and the user ask as `prompt` for provenance. Widget vocabulary:\n' +
      WIDGET_VOCAB,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        widget: { type: 'object' },
        index: { type: 'number' },
        prompt: { type: 'string', description: "The user's ask, verbatim (stored as provenance)." },
      },
      required: ['widget'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { widget?: unknown; index?: number; prompt?: string }
      if (!isWidget(a.widget)) return ok({ ok: false, error: 'Provide a valid `widget`.' })
      const invalid = validateWidgets([a.widget], ctx.meta)
      if (invalid) return ok(invalid)
      const current = host.getReport() ?? { title: 'Untitled report', widgets: [] }
      const widgets = [...current.widgets]
      const at = typeof a.index === 'number' ? Math.max(0, Math.min(a.index, widgets.length)) : widgets.length
      widgets.splice(at, 0, ...withProvenance([a.widget], a.prompt))
      host.setReport({ ...current, widgets })
      return ok({ ok: true, widget_count: widgets.length })
    },
  }
}

/** How many rows `explore_data` returns at most — it is a look, not a fetch. */
export const EXPLORE_ROW_CAP = 10

/** `explore_data` — run a query and return a COMPACT summary, so the agent
 *  looks at the shape of an answer before building a widget on it. The single
 *  biggest quality lever in text-driven reporting. */
export function exploreDataTool(ctx: ToolContext): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'explore_data',
    description:
      'Run a cube query and return a compact summary (columns, row count, total, first rows, compiled SQL). ALWAYS look at data with this before building a widget on it. Invalid members return { ok: false, error, suggestions } — repair and retry.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { query: { type: 'object', description: 'A cube query (same shape as a bound widget query).' } },
      required: ['query'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { query?: WidgetQuery }
      if (!a.query || typeof a.query !== 'object') return ok({ ok: false, error: 'Provide a `query` object.' })
      if (ctx.meta) {
        const v = validateQuery(a.query, ctx.meta)
        if (!v.ok) return ok(v)
      }
      if (!ctx.runQuery) return ok({ ok: false, error: 'No query runner configured.' })
      try {
        const result = await ctx.runQuery({ ...a.query, limit: Math.min(a.query.limit ?? EXPLORE_ROW_CAP, 100) })
        return ok({
          ok: true,
          columns: result.columns,
          row_count: result.rows.length,
          total: result.total,
          truncated_at: result.truncated_at,
          rows: result.rows.slice(0, EXPLORE_ROW_CAP),
          sql: result.sql,
        })
      } catch (e) {
        return ok({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    },
  }
}

/** `add_report_view` — place a registered host view, validated against its
 *  manifest (unknown name or missing required members → repairable error). */
export function addViewTool(host: ReportHost, ctx: ToolContext): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'add_report_view',
    description:
      'Add a registered HOST VIEW to the open report: { component, query?, props?, title?, index? }. Views are listed in the model digest with their data contracts. The view receives the report filters and participates in drill.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        component: { type: 'string', description: 'The view name from the digest.' },
        query: { type: 'object' },
        props: { type: 'object' },
        title: { type: 'string' },
        index: { type: 'number' },
        prompt: { type: 'string', description: "The user's ask, verbatim (stored as provenance)." },
      },
      required: ['component'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as {
        component?: string
        query?: WidgetQuery
        props?: Record<string, unknown>
        title?: string
        index?: number
        prompt?: string
      }
      const manifest = a.component ? ctx.views?.[a.component] : undefined
      if (!manifest) {
        return ok({
          ok: false,
          error: `Unknown view \`${a.component ?? ''}\`.`,
          suggestions: Object.keys(ctx.views ?? {}),
        })
      }
      if (a.query && ctx.meta) {
        const v = validateQuery(a.query, ctx.meta)
        if (!v.ok) return ok(v)
      }
      // Pre-run contract check: every required member must be selected (the
      // engine may add __label companions, so this is necessary, not exact).
      const required = manifest.contract?.requires ?? []
      const selected = new Set([...(a.query?.measures ?? []), ...(a.query?.dimensions ?? [])])
      const missing = required.filter((m) => !selected.has(m))
      if (missing.length) {
        return ok({
          ok: false,
          error: `The \`${manifest.name}\` view requires ${missing.join(', ')} in its query.`,
          suggestions: required,
        })
      }
      const widget: ViewWidget = {
        type: 'view',
        component: manifest.name,
        query: a.query,
        props: a.props,
        title: a.title,
        provenance: { prompt: a.prompt, author: 'agent', at: Date.now() },
      }
      const current = host.getReport() ?? { title: 'Untitled report', widgets: [] }
      const widgets = [...current.widgets]
      const at = typeof a.index === 'number' ? Math.max(0, Math.min(a.index, widgets.length)) : widgets.length
      widgets.splice(at, 0, widget)
      host.setReport({ ...current, widgets })
      return ok({ ok: true, widget_count: widgets.length })
    },
  }
}

/** All generic report tools for a host. Pass `ctx` (meta + runner + views) to
 *  enable validation, provenance, `explore_data` and `add_report_view`. */
export function buildReportTools(host: ReportHost, ctx: ToolContext = {}): AgentTool[] {
  const tools = [createReportTool(host, ctx), addWidgetTool(host, ctx)]
  if (ctx.runQuery) tools.push(exploreDataTool(ctx))
  if (ctx.views && Object.keys(ctx.views).length) tools.push(addViewTool(host, ctx))
  return tools
}
