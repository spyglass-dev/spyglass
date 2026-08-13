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
import type { FacetSpec } from './report'
import { FILTER_SPEC_SCHEMA, validateFilterSpec } from './report.schema'
import { findReferenceQueriesTool, type ExampleIndex } from './reports/references'
import {
  editWidgetTool,
  getReportTool,
  moveWidgetTool,
  removeWidgetTool,
  renameReportTool,
  setReportFiltersTool,
} from './reports/edit-tools'

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
  /** Called after `create_report` builds a fresh report. `id` is present when
   *  the host supplied `ReportToolsConfig.save` — hosts navigate on it. */
  onBuilt?(report: Report, id?: string): void
}

/**
 * Per-host wiring for the report tools. Everything here is policy the host owns
 * and the toolkit must not guess: where a built report lives, what filters a new
 * one is born with, how it is persisted, and any tools the host owns itself.
 */
export interface ReportToolsConfig {
  /** Route a freshly built report opens at — returned to the agent as
   *  `navigate_to` so it can tell the user where the thing went. */
  reportPath?: (id: string) => string
  /** The facet spec a NEW report declares when the agent does not pass one. A
   *  report with no facets cannot be re-pointed, so hosts should set this. */
  defaultFacets?: FacetSpec[]
  /** Persist a new report under a host-minted id. */
  save?: (id: string, report: Report) => Promise<unknown>
  /** Mint the id `save` uses. Client-minted, so a draft authored offline keeps
   *  its identity when it reaches the server. */
  newId?: () => string
  /** Tools the host owns, placed at the FRONT — e.g. a plan-before-build
   *  checkpoint, which is a UI tool with a component the toolkit cannot own. */
  extraTools?: AgentTool[]
  /**
   * Seed a report ABOUT one entity when the agent names an entity instead of
   * passing widgets ("a report on this class"). Supplying this adds an `entity`
   * parameter to `create_report`; the host owns what an entity report contains,
   * because that is the part that knows the domain.
   */
  entityReport?: (entity: { kind: string; id: string }, title: string) => Report | null
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
/** A well-formed widget of a kind the renderer knows. Agents emit noise. */
export const isReportWidget = (w: unknown): w is ReportWidget =>
  !!w && typeof w === 'object' && VALID.has((w as { type?: string }).type ?? '')
const isWidget = isReportWidget
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
  /** Reference-query index built from `/meta` — enables `find_reference_queries`.
   *  Built once per fetch by `useReportModel`, not per tool call. */
  examples?: ExampleIndex
}

const hasQuery = (w: ReportWidget): w is BoundWidget | (ViewWidget & { query: WidgetQuery }) => {
  const t = (w as { type?: string }).type
  return t === 'bound' || (t === 'view' && (w as ViewWidget).query !== undefined)
}

/** Validate every query-carrying widget; the first failure aborts the tool. */
export function validateWidgetQueries(widgets: ReportWidget[], meta: CubeModelMeta | undefined) {
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
export function withProvenance(widgets: ReportWidget[], prompt: string | undefined): ReportWidget[] {
  return widgets.map((w) => {
    const t = (w as { type?: string }).type
    return (t === 'bound' || t === 'view') && !(w as BoundWidget).provenance
      ? ({ ...w, provenance: { prompt, author: 'agent', at: Date.now() } } as ReportWidget)
      : w
  })
}

/** `create_report` — build a report from a title + widgets and open it. */
export function createReportTool(
  host: ReportHost,
  ctx: ToolContext = {},
  config: ReportToolsConfig = {},
): AgentTool {
  const properties: Record<string, unknown> = {
    title: { type: 'string' },
    description: { type: 'string' },
    widgets: { type: 'array', items: { type: 'object' } },
    facets: {
      ...FILTER_SPEC_SCHEMA,
      description:
        "OPTIONAL declared filters for this report — what the filter bar offers and which are mandatory. Omit to use the host's default spec. Override only when the report needs a DIFFERENT scope. Do NOT bake facet filters into widget queries; the facets apply them.",
    },
    prompt: { type: 'string', description: "The user's ask, verbatim (stored as provenance)." },
  }
  if (config.entityReport) {
    properties.entity = {
      type: 'object',
      additionalProperties: false,
      properties: { kind: { type: 'string' }, id: { type: 'string' } },
      required: ['kind', 'id'],
      description:
        'Seed a default report ABOUT one entity, when no `widgets` are given — e.g. { "kind":"class", "id":"…" }.',
    }
  }
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'create_report',
    description:
      'Build a report and open it: pass a `title` and an ordered list of `widgets` (prefer `bound` widgets carrying a query)' +
      (config.entityReport ? ', or an `entity` to seed a default report about it' : '') +
      '. The report also carries a `facets` filter spec — build widgets UNSCOPED and let the facets scope them. Pass the user ask as `prompt` for provenance. Returns { ok, navigate_to }. Widget vocabulary:\n' +
      WIDGET_VOCAB,
    parameters: { type: 'object', additionalProperties: false, properties, required: ['title'] },
    handler: async (input) => {
      try {
        const a = (input ?? {}) as {
          title?: string
          description?: string
          widgets?: unknown
          facets?: unknown
          entity?: { kind?: string; id?: string }
          prompt?: string
        }
        const title = a.title?.trim() || 'Untitled report'

        // Declared filters: the agent's override (validated against the filter
        // spec schema), else the host's default. A report with neither cannot
        // be re-pointed, which is why hosts set `defaultFacets`.
        let facets = config.defaultFacets
        if (a.facets !== undefined) {
          const v = validateFilterSpec(a.facets)
          if (!v.valid) {
            const detail = v.errors.map((e) => `${e.path} ${e.message}`).join('; ')
            return ok({ ok: false, error: `Invalid facets: ${detail}` })
          }
          facets = a.facets as FacetSpec[]
        }

        const widgets = Array.isArray(a.widgets) ? a.widgets.filter(isWidget) : []
        const invalid = validateWidgetQueries(widgets, ctx.meta)
        if (invalid) return ok(invalid)

        let report: Report
        if (widgets.length > 0) {
          report = {
            title,
            ...(a.description ? { description: a.description } : {}),
            widgets: withProvenance(widgets, a.prompt),
          }
        } else if (config.entityReport && a.entity?.kind && a.entity.id) {
          const seeded = config.entityReport({ kind: a.entity.kind, id: a.entity.id }, title)
          if (!seeded) return ok({ ok: false, error: `No default report for "${a.entity.kind}".` })
          report = { ...seeded }
          if (a.description) report.description = a.description
        } else {
          return ok({
            ok: false,
            error: config.entityReport
              ? 'Provide `widgets`, or an `entity` to seed a default report.'
              : 'Provide `widgets`.',
          })
        }
        if (facets) report.facets = facets

        // Persist BEFORE opening when the host stores reports: the agent's
        // reply carries a route, and a route to a report that was never saved
        // is a 404 the operator meets instead of their answer.
        let id: string | undefined
        if (config.save && config.newId) {
          id = config.newId()
          await config.save(id, report)
        }
        host.setReport(report)
        host.onBuilt?.(report, id)
        return ok({
          ok: true,
          widget_count: report.widgets.length,
          ...(id && config.reportPath ? { navigate_to: config.reportPath(id) } : {}),
          status: 'draft_open',
        })
      } catch (err) {
        return ok({ ok: false, error: err instanceof Error ? err.message : String(err) })
      }
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
      const invalid = validateWidgetQueries([a.widget], ctx.meta)
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

/** Cubes the open report already queries — context for example ranking. */
function activeCubes(report: Report | null): string[] {
  const out = new Set<string>()
  for (const w of report?.widgets ?? []) {
    if (!hasQuery(w)) continue
    const q = w.query
    for (const m of [...(q.measures ?? []), ...(q.dimensions ?? [])]) out.add(m.split('.')[0])
  }
  return [...out]
}

/**
 * Every report tool a host needs, in one call.
 *
 * `ctx` enables the optional ones — `meta` turns on query validation, `runQuery`
 * adds `explore_data`, `views` adds `add_report_view`. `config` carries the
 * host's policy: where a built report lives, its default facets, how it is
 * saved, and any tools the host owns itself (those come FIRST, because a
 * plan-before-build checkpoint has to be read before the build tools).
 *
 * The reading tool leads the editing tools deliberately: an agent that lists
 * `create_report` first will rebuild a report it was asked to amend.
 */
export function buildReportTools(
  host: ReportHost,
  ctx: ToolContext = {},
  config: ReportToolsConfig = {},
): AgentTool[] {
  const tools: AgentTool[] = [
    ...(config.extraTools ?? []),
    getReportTool(host),
    ...(ctx.examples
      ? [
          findReferenceQueriesTool(ctx.examples, {
            activeCubes: () => activeCubes(host.getReport()),
          }),
        ]
      : []),
    createReportTool(host, ctx, config),
    addWidgetTool(host, ctx),
    editWidgetTool(host, ctx),
    removeWidgetTool(host),
    moveWidgetTool(host),
    setReportFiltersTool(host),
    renameReportTool(host),
  ]
  if (ctx.runQuery) tools.push(exploreDataTool(ctx))
  if (ctx.views && Object.keys(ctx.views).length) tools.push(addViewTool(host, ctx))
  return tools
}
