/**
 * Report model + resolver — the framework core. A `Report` is a title + ordered
 * widgets (static specs OR `bound` widgets that carry a query) + optional
 * report-wide filters. `resolveReport` runs each bound widget's query through a
 * host-provided runner and maps the result into a renderable `ReportDoc`.
 *
 * Host-agnostic: the host supplies the query runner and its cube capabilities
 * (which dimensions/time field each cube has). Everything else is generic.
 */
import type {
  WidgetSpec,
  WidgetWidth,
  ValueFormat,
  ChartMark,
  ReportDoc,
  AppliedFilters,
} from './types'
import {
  draftToWidgetSpec,
  type WidgetDraft,
  type WidgetQuery,
  type QueryFilter,
  type QueryResultLite,
} from './querybuilder'
import { resolveDateRange, hasActiveFilters, type FilterFacet, type ReportFilters } from './filters'
import { applyDrillTrail, type DrillTrail } from './drill'
import { checkViewContract, type ViewRegistry } from './views'

// ── Filter spec (declared filters) ───────────────────────────────────────────

/**
 * A facet a report DECLARES — *what* filters the report offers and which are
 * mandatory. Same shape the `FilterBar` renders (`FilterFacet`): a report just
 * carries the declarations, with `source` naming any dynamic option list. The
 * "spec" name marks intent; there is no separate type to keep in sync.
 * Distinct from `ReportFilters`, which holds the *selected values*.
 */
export type FacetSpec = FilterFacet

/**
 * Bind each facet's dynamic `source` to a host-supplied option list. A facet
 * with inline `options` keeps them; one with a `source` gets `sources[source]`
 * (empty until the host loads it). Returns render-ready `FilterFacet`s.
 */
export function resolveFacets(
  specs: FacetSpec[] | undefined,
  sources?: Record<string, { value: string; label: string }[]>,
): FilterFacet[] {
  return (specs ?? []).map((f) => ({
    ...f,
    options: f.options ?? (f.source ? sources?.[f.source] ?? [] : []),
  }))
}

// ── The source report (what a host stores / an agent authors) ────────────────

/** How a widget responds to report-wide filters. */
export interface WidgetFilterBinding {
  /** Opt out of ALL report filters (e.g. an all-time total). */
  ignore?: boolean
  /** Time dimension the date range filters this widget on; `null` disables it.
   *  Defaults to the cube's default time field. */
  dateField?: string | null
  /** Ask the engine for a comparison window over the report's date range —
   *  `__prev_<measure>` columns come back, and a metric renders its delta
   *  chip. Needs an active date range to compare against. */
  compare?: 'previous_period' | 'previous_year'
}

/** Who authored a widget and from what ask — part of the doc, not a side
 *  channel. Surfaced in the Explain panel so "why is this number here" always
 *  has an answer. */
export interface Provenance {
  prompt?: string
  author: 'human' | 'agent'
  at: number
}

/** A data widget bound to a query, plus its visualization + filter behavior. */
export interface BoundWidget extends WidgetDraft {
  type: 'bound'
  /** Grid width (1–4). */
  w?: WidgetWidth
  /** Narrow this widget to one student (passed to the runner). */
  studentId?: string
  filters?: WidgetFilterBinding
  provenance?: Provenance
}

/** A view widget as AUTHORED: a registered host component + optional query.
 *  Resolution runs the query under the report's filters + drill trail and
 *  checks the manifest's contract; the result is a data-bearing `ViewSpec`. */
export interface ViewWidget {
  type: 'view'
  component: string
  query?: WidgetQuery
  props?: Record<string, unknown>
  title?: string
  w?: WidgetWidth
  filters?: WidgetFilterBinding
  provenance?: Provenance
}

export type ReportWidget = WidgetSpec | BoundWidget | ViewWidget

export interface Report {
  title: string
  description?: string
  widgets: ReportWidget[]
  /** Declared filters — what facets the report offers + which are mandatory. */
  facets?: FacetSpec[]
  /** Selected filter values (date range + facet selections). */
  filters?: ReportFilters
  /** The drill trail (default drill-down state) — each step filters every
   *  widget whose cube has the dimension. Poppable via the breadcrumb. */
  drill?: DrillTrail
}

/** Run a query against the host's engine. */
export type QueryRunner = (
  query: WidgetQuery,
  opts?: { studentId?: string },
) => Promise<QueryResultLite>

// ── Filter application (per-cube) ────────────────────────────────────────────

/** What a cube supports, so a report filter knows where it applies. */
export interface CubeCaps {
  /** Filterable dimension names (unqualified, e.g. `status`, `class_id`). */
  dims: string[]
  /** Default time field a date range filters on (omit if not time-scoped). */
  timeField?: string
}
export type CubeCapsMap = Record<string, CubeCaps>

function queryCube(q: WidgetQuery): string | undefined {
  const m = q.measures?.[0] ?? q.dimensions?.[0] ?? q.filters?.[0]?.member
  return m?.split('.')[0]
}
const hasFilterOn = (q: WidgetQuery, member: string) => (q.filters ?? []).some((f) => f.member === member)
const groupsBy = (q: WidgetQuery, member: string) => (q.dimensions ?? []).includes(member)

/** `applyFilters`' result: the merged query plus the receipt of what reached it. */
export interface FilteredQuery {
  query: WidgetQuery
  applied: AppliedFilters
}

/**
 * Merge report filters into a widget's query. A facet only applies where the
 * cube has that dimension AND the widget doesn't group by it (never filter the
 * dimension you're breaking down by). A date range is a WHERE filter (gte/lt)
 * on the cube's time field — never a group-by. Per-widget bindings win.
 *
 * Returns the query **and** which filters actually reached it (`applied`) —
 * in particular, an active date range that could NOT be applied is reported
 * via `applied.dateRangeSkipped` instead of being dropped silently. When
 * nothing applies, `query` is the widget's own object (identity-preserved).
 */
export function applyFilters(
  widget: BoundWidget,
  filters: ReportFilters | undefined,
  caps: CubeCapsMap,
): FilteredQuery {
  const query = widget.query
  const applied: AppliedFilters = { facets: [] }
  if (!filters || !hasActiveFilters(filters)) return { query, applied }

  const rangeActive = resolveDateRange(filters) !== null
  const skipped = (reason: AppliedFilters['dateRangeSkipped']): FilteredQuery => ({
    query,
    applied: rangeActive ? { ...applied, dateRangeSkipped: reason } : applied,
  })
  if (widget.filters?.ignore) return skipped('opted_out')
  const cube = queryCube(query)
  if (!cube) return skipped('unknown_cube')
  const cap = caps[cube]
  if (!cap) return skipped('unknown_cube')

  const nextFilters: QueryFilter[] = [...(query.filters ?? [])]
  for (const [key, values] of Object.entries(filters.facets ?? {})) {
    if (!values.length || !cap.dims.includes(key)) continue
    const member = `${cube}.${key}`
    if (groupsBy(query, member) || hasFilterOn(query, member)) continue
    nextFilters.push({ member, operator: 'in', values })
    applied.facets.push(key)
  }

  const range = resolveDateRange(filters)
  const dateField = widget.filters?.dateField === undefined ? cap.timeField : widget.filters.dateField
  let nextTimeDimensions = query.timeDimensions
  if (range) {
    if (!dateField) {
      applied.dateRangeSkipped = widget.filters?.dateField === null ? 'opted_out' : 'no_time_field'
    } else {
      const member = `${cube}.${dateField}`
      if (hasFilterOn(query, member)) {
        applied.dateRangeSkipped = 'widget_pinned'
      } else {
        const compare = widget.filters?.compare
        const tds = query.timeDimensions ?? []
        const owned = tds.some((td) => td.dimension === member)
        if (owned || compare) {
          // The widget's own dateRange (a template's stored default window)
          // is REPLACED, not intersected — the report filter is the user's
          // word. Anything else shows 90 days under a "Last 30 days" bar
          // with no marker: the fact-5 lie all over again. A declared
          // `filters.compare` rides the same time dimension (the engine
          // needs range + compare together to emit `__prev_` columns).
          nextTimeDimensions = owned
            ? tds.map((td) =>
                td.dimension === member
                  ? { ...td, dateRange: [range[0], range[1]] as [string, string], ...(compare ? { compare } : {}) }
                  : td,
              )
            : [...tds, { dimension: member, dateRange: [range[0], range[1]] as [string, string], ...(compare ? { compare } : {}) }]
        } else {
          nextFilters.push({ member, operator: 'gte', values: [range[0]] })
          nextFilters.push({ member, operator: 'lt', values: [range[1]] })
        }
        applied.dateRange = member
      }
    }
  }
  return {
    query: { ...query, filters: nextFilters, ...(nextTimeDimensions ? { timeDimensions: nextTimeDimensions } : {}) },
    applied,
  }
}

// ── Resolve ──────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  runQuery: QueryRunner
  /** Report-wide filters (defaults to the report's own `filters`). */
  filters?: ReportFilters
  /** Drill trail to apply (defaults to the report's own `drill`). */
  drill?: DrillTrail
  /** Cube capabilities for filter application (none = no report filters). */
  cubeCaps?: CubeCapsMap
  /** Host view registry — required to resolve `view` widgets. */
  views?: ViewRegistry
  /** Map a raw error to a friendly one-liner for the error widget. */
  humanizeError?: (detail: string) => string
}

const isBound = (w: ReportWidget): w is BoundWidget => (w as BoundWidget).type === 'bound'
const isView = (w: ReportWidget): w is ViewWidget => (w as ViewWidget).type === 'view'

/** Resolve one bound widget into a data-bearing spec (honoring filters). The
 *  spec carries `applied` — which report filters reached the query — so a
 *  widget frame can mark scope the filters could not reach. */
export async function resolveBound(
  widget: BoundWidget,
  opts: ResolveOptions,
): Promise<WidgetSpec> {
  const { query, applied } = applyFilters(widget, opts.filters, opts.cubeCaps ?? {})
  const cube = queryCube(query)
  const drilled = opts.drill?.length
    ? applyDrillTrail(query, opts.drill, cube, cube ? opts.cubeCaps?.[cube]?.dims : undefined)
    : query
  const result = await opts.runQuery(drilled, { studentId: widget.studentId })
  const spec: WidgetSpec = { ...draftToWidgetSpec({ ...widget, query: drilled }, result), applied }
  return widget.w ? { ...spec, w: widget.w } : spec
}

/** Resolve one view widget: run its query under the report's filters + drill
 *  trail, check the manifest's contract, and hand back a data-bearing
 *  `ViewSpec`. An unknown component or an unmet contract sets `error` — the
 *  frame renders `widget_error`, never a blank cell. */
export async function resolveView(widget: ViewWidget, opts: ResolveOptions): Promise<WidgetSpec> {
  const base: WidgetSpec = {
    type: 'view',
    component: widget.component,
    title: widget.title,
    w: widget.w,
    props: widget.props,
  }
  const manifest = opts.views?.[widget.component]
  if (!manifest) {
    return { ...base, error: { message: `Unknown view \`${widget.component}\` — is it registered?` } }
  }
  if (!widget.query) {
    const contractError = checkViewContract(manifest, { columns: [] })
    return contractError ? { ...base, error: { message: contractError } } : base
  }
  const bound: BoundWidget = { type: 'bound', as: 'table', query: widget.query, filters: widget.filters }
  const { query, applied } = applyFilters(bound, opts.filters, opts.cubeCaps ?? {})
  const cube = queryCube(query)
  const drilled = opts.drill?.length
    ? applyDrillTrail(query, opts.drill, cube, cube ? opts.cubeCaps?.[cube]?.dims : undefined)
    : query
  const result = await opts.runQuery(drilled)
  const contractError = checkViewContract(manifest, result)
  if (contractError) return { ...base, applied, error: { message: contractError } }
  return { ...base, applied, data: { rows: result.rows, columns: result.columns, total: result.total } }
}

/** Resolve a whole report into a renderable `ReportDoc`. A widget whose query
 *  fails degrades to a `widget_error` custom spec so one bad query can't blank
 *  the report (render it with a host `widget_error` renderer). */
export async function resolveReport(report: Report, opts: ResolveOptions): Promise<ReportDoc> {
  const filters = opts.filters ?? report.filters
  const drill = opts.drill ?? report.drill
  const widgets = await Promise.all(
    report.widgets.map(async (w): Promise<WidgetSpec> => {
      if (isView(w)) {
        try {
          return await resolveView(w, { ...opts, filters, drill })
        } catch (e) {
          const detail = e instanceof Error ? e.message : String(e)
          return {
            type: 'view',
            component: w.component,
            title: w.title,
            w: w.w,
            props: w.props,
            error: { message: opts.humanizeError?.(detail) ?? "Couldn't load this view's data.", detail },
          }
        }
      }
      if (!isBound(w)) return w
      try {
        return await resolveBound(w, { ...opts, filters, drill })
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e)
        return {
          type: 'custom',
          component: 'widget_error',
          title: w.title,
          w: w.w,
          data: { message: opts.humanizeError?.(detail) ?? "Couldn't load this widget's data.", detail },
        }
      }
    }),
  )
  return { title: report.title, description: report.description, widgets }
}

/**
 * The records query behind a measure click: the widget's fully-filtered scope
 * (report filters + drill trail), narrowed to the clicked row's dimension
 * values, switched to `mode: 'rows'`. The engine projects only the cube's
 * `drill_members` — and REFUSES a cube that declares none — so this is
 * PII-bounded by the model, not by the UI.
 */
export function rowsQueryFor(
  widget: BoundWidget,
  row: Record<string, unknown>,
  opts: { filters?: ReportFilters; drill?: DrillTrail; cubeCaps?: CubeCapsMap },
  limit = 50,
): WidgetQuery {
  const { query } = applyFilters(widget, opts.filters, opts.cubeCaps ?? {})
  const cube = queryCube(query)
  const drilled = opts.drill?.length
    ? applyDrillTrail(query, opts.drill, cube, cube ? opts.cubeCaps?.[cube]?.dims : undefined)
    : query
  const filters: QueryFilter[] = [...(drilled.filters ?? [])]
  for (const dim of drilled.dimensions ?? []) {
    if (row[dim] === undefined) continue
    filters.push({ member: dim, operator: 'equals', values: [row[dim] as string | number | boolean | null] })
  }
  return {
    filters,
    timeDimensions: drilled.timeDimensions,
    mode: 'rows',
    limit,
  }
}

// ── Draft <-> bound widget ───────────────────────────────────────────────────

export function widgetToDraft(b: BoundWidget): WidgetDraft {
  const { as, query, title, label, format, mark, x, y, pivot } = b
  return { as, query, title, label, format, mark, x, y, pivot }
}
export function draftToBound(draft: WidgetDraft, prev?: BoundWidget): BoundWidget {
  return {
    type: 'bound',
    ...draft,
    w: prev?.w ?? (draft.as === 'metric' ? 1 : draft.as === 'chart' ? 2 : 4),
    studentId: prev?.studentId,
    filters: prev?.filters,
  }
}

export type { ValueFormat, ChartMark }
