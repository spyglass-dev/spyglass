/**
 * Report model + resolver — the framework core. A `Report` is a title + ordered
 * widgets (static specs OR `bound` widgets that carry a query) + optional
 * report-wide filters. `resolveReport` runs each bound widget's query through a
 * host-provided runner and maps the result into a renderable `ReportDoc`.
 *
 * Host-agnostic: the host supplies the query runner and its cube capabilities
 * (which dimensions/time field each cube has). Everything else is generic.
 */
import type { WidgetSpec, WidgetWidth, ValueFormat, ChartMark, ReportDoc } from './types'
import {
  draftToWidgetSpec,
  type WidgetDraft,
  type WidgetQuery,
  type QueryFilter,
  type QueryResultLite,
} from './querybuilder'
import { resolveDateRange, hasActiveFilters, type FilterFacet, type ReportFilters } from './filters'

// ── Filter spec (declared filters) ───────────────────────────────────────────

/**
 * A facet a report DECLARES — *what* filters the report offers and which are
 * mandatory. Distinct from `ReportFilters`, which holds the *selected values*.
 * A report carries a `facets` array of these; the host turns them into live
 * `FilterFacet` controls with `resolveFacets`, binding dynamic option lists.
 */
export interface FacetSpec {
  /** Dimension key the host filters on (e.g. `status`, `class_id`). */
  key: string
  label: string
  /** Mandatory — always shown, prompted until set (host may auto-pick). */
  required?: boolean
  /** Always shown on the bar (not tucked behind "+ Filter"), but not prompted. */
  alwaysOn?: boolean
  /** Single-select (default: multi). */
  single?: boolean
  /** Force the control style (default: chips ≤6 options, menu otherwise). */
  variant?: 'chips' | 'menu'
  /** Inline static options (e.g. a fixed status list). */
  options?: { value: string; label: string }[]
  /** Name of a dynamic option list the host binds at render (e.g. `classes`).
   *  Kept out of the doc so options stay live, not frozen. */
  source?: string
}

/**
 * Resolve declared facet specs into live `FilterFacet` controls, binding each
 * spec's `source` to a host-supplied option list. A spec with inline `options`
 * uses those; one with a `source` pulls from `sources[source]` (empty until the
 * host loads it).
 */
export function resolveFacets(
  specs: FacetSpec[] | undefined,
  sources?: Record<string, { value: string; label: string }[]>,
): FilterFacet[] {
  return (specs ?? []).map((f) => ({
    key: f.key,
    label: f.label,
    required: f.required,
    alwaysOn: f.alwaysOn,
    single: f.single,
    variant: f.variant,
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
}

/** A data widget bound to a query, plus its visualization + filter behavior. */
export interface BoundWidget extends WidgetDraft {
  type: 'bound'
  /** Grid width (1–4). */
  w?: WidgetWidth
  /** Narrow this widget to one student (passed to the runner). */
  studentId?: string
  filters?: WidgetFilterBinding
}

export type ReportWidget = WidgetSpec | BoundWidget

export interface Report {
  title: string
  description?: string
  widgets: ReportWidget[]
  /** Declared filters — what facets the report offers + which are mandatory. */
  facets?: FacetSpec[]
  /** Selected filter values (date range + facet selections). */
  filters?: ReportFilters
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

/**
 * Merge report filters into a widget's query. A facet only applies where the
 * cube has that dimension AND the widget doesn't group by it (never filter the
 * dimension you're breaking down by). A date range is a WHERE filter (gte/lt)
 * on the cube's time field — never a group-by. Per-widget bindings win.
 */
export function applyFilters(
  widget: BoundWidget,
  filters: ReportFilters | undefined,
  caps: CubeCapsMap,
): WidgetQuery {
  const query = widget.query
  if (!filters || widget.filters?.ignore || !hasActiveFilters(filters)) return query
  const cube = queryCube(query)
  if (!cube) return query
  const cap = caps[cube]
  if (!cap) return query

  const nextFilters: QueryFilter[] = [...(query.filters ?? [])]
  for (const [key, values] of Object.entries(filters.facets ?? {})) {
    if (!values.length || !cap.dims.includes(key)) continue
    const member = `${cube}.${key}`
    if (groupsBy(query, member) || hasFilterOn(query, member)) continue
    nextFilters.push({ member, operator: 'in', values })
  }

  const range = resolveDateRange(filters)
  const dateField = widget.filters?.dateField === undefined ? cap.timeField : widget.filters.dateField
  if (range && dateField) {
    const member = `${cube}.${dateField}`
    if (!hasFilterOn(query, member)) {
      nextFilters.push({ member, operator: 'gte', values: [range[0]] })
      nextFilters.push({ member, operator: 'lt', values: [range[1]] })
    }
  }
  return { ...query, filters: nextFilters }
}

// ── Resolve ──────────────────────────────────────────────────────────────────

export interface ResolveOptions {
  runQuery: QueryRunner
  /** Report-wide filters (defaults to the report's own `filters`). */
  filters?: ReportFilters
  /** Cube capabilities for filter application (none = no report filters). */
  cubeCaps?: CubeCapsMap
  /** Map a raw error to a friendly one-liner for the error widget. */
  humanizeError?: (detail: string) => string
}

const isBound = (w: ReportWidget): w is BoundWidget => (w as BoundWidget).type === 'bound'

/** Resolve one bound widget into a data-bearing spec (honoring filters). */
export async function resolveBound(
  widget: BoundWidget,
  opts: ResolveOptions,
): Promise<WidgetSpec> {
  const query = applyFilters(widget, opts.filters, opts.cubeCaps ?? {})
  const result = await opts.runQuery(query, { studentId: widget.studentId })
  const spec = draftToWidgetSpec(widget, result)
  return widget.w ? { ...spec, w: widget.w } : spec
}

/** Resolve a whole report into a renderable `ReportDoc`. A widget whose query
 *  fails degrades to a `widget_error` custom spec so one bad query can't blank
 *  the report (render it with a host `widget_error` renderer). */
export async function resolveReport(report: Report, opts: ResolveOptions): Promise<ReportDoc> {
  const filters = opts.filters ?? report.filters
  const widgets = await Promise.all(
    report.widgets.map(async (w): Promise<WidgetSpec> => {
      if (!isBound(w)) return w
      try {
        return await resolveBound(w, { ...opts, filters })
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

// ── Draft <-> bound widget ───────────────────────────────────────────────────

export function widgetToDraft(b: BoundWidget): WidgetDraft {
  const { as, query, title, label, format, mark, x, y } = b
  return { as, query, title, label, format, mark, x, y }
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
