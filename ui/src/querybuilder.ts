/**
 * Query-builder model — a host-agnostic description of what a data widget is:
 * a cube query (`WidgetQuery`) + how to visualize it (`WidgetDraft`). The
 * `QueryBuilder` component edits a `WidgetDraft`; a host runs the query and the
 * pure `draftToWidgetSpec` turns the result into a renderable `WidgetSpec`.
 */
import type { WidgetSpec, ValueFormat, ChartMark } from './types'

// ── Catalog (mirrors the engine's /meta) ────────────────────────────────────

export interface MeasureMeta {
  name: string
  member: string
  type?: string
  title?: string
  format?: string
  description?: string
  featured?: boolean
  unit?: string
  filterable?: boolean
  drill_members?: string[]
}
export interface DimensionMeta {
  name: string
  member: string
  type?: string
  title?: string
  tenant?: boolean
  label?: string
  drill_entity?: string
  description?: string
  featured?: boolean
  unit?: string
  filterable?: boolean
}
export interface CubeMeta {
  name: string
  title?: string
  description?: string
  measures: MeasureMeta[]
  dimensions: DimensionMeta[]
  joins?: { target: string; relationship: string }[]
  drill_members?: string[]
  segments?: { name: string; member: string; description?: string }[]
}
export interface CubeModelMeta {
  cubes: CubeMeta[]
}

// ── The query + widget draft ─────────────────────────────────────────────────

export interface QueryFilter {
  member: string
  operator: string
  values?: (string | number | boolean | null)[]
}

export interface WidgetQuery {
  measures?: string[]
  dimensions?: string[]
  filters?: QueryFilter[]
  timeDimensions?: { dimension: string; granularity?: string; dateRange?: [string, string] }[]
  order?: { member: string; desc?: boolean }[]
  limit?: number
  /** Rows to skip — server-driven paging (engine `offset`). */
  offset?: number
  /** Ask the engine for the total row/group count (`QueryResult.total`). */
  includeTotal?: boolean
  /** `rows` returns row-level records (projecting only the cube's published
   *  `drill_members`) — the records drawer behind a measure click. */
  mode?: 'aggregate' | 'rows'
}

/** A data widget being authored: the query + its visualization. Maps 1:1 to a
 *  host's "bound widget" (host adds its own `type: 'bound'` tag). */
export interface WidgetDraft {
  as: 'metric' | 'table' | 'chart' | 'pivot'
  query: WidgetQuery
  title?: string
  label?: string
  format?: ValueFormat
  mark?: ChartMark
  x?: string
  y?: string
}

/** The shape a host's query runner returns (matches the engine's QueryResult). */
export interface QueryResultLite {
  columns: { key: string; kind: string }[]
  rows: Record<string, unknown>[]
  /** Total matching rows/groups (present when the query asked `includeTotal`). */
  total?: number
  has_more?: boolean
  /** Set when the engine's row cap clamped the result. */
  truncated_at?: number
  /** The compiled SQL — the engine has always returned it; the Explain panel
   *  finally shows it. */
  sql?: string
}

/** Merge a DataGrid sort/paging delta into a widget's query — the "sort and
 *  paging write query deltas, not array operations" contract. An empty
 *  `order` array clears the sort back to the query default. */
export function applyGridDelta(
  query: WidgetQuery,
  delta: { order?: { member: string; desc?: boolean }[]; offset?: number; limit?: number },
): WidgetQuery {
  const next = { ...query }
  if (delta.order !== undefined) {
    if (delta.order.length === 0) delete next.order
    else next.order = delta.order
  }
  if (delta.offset !== undefined) {
    if (delta.offset === 0) delete next.offset
    else next.offset = delta.offset
  }
  if (delta.limit !== undefined) next.limit = delta.limit
  return next
}

const short = (member: string) => member.split('.').pop() ?? member

/** Turn a query result into a data-bearing WidgetSpec, per the draft's viz. */
export function draftToWidgetSpec(draft: WidgetDraft, result: QueryResultLite): WidgetSpec {
  if (draft.as === 'metric') {
    const measure = draft.query.measures?.[0]
    const raw = measure ? result.rows[0]?.[measure] : undefined
    const value = typeof raw === 'number' ? raw : raw == null ? 0 : Number(raw) || 0
    return {
      type: 'metric',
      title: draft.title,
      w: 1,
      value,
      label: draft.label ?? (measure ? short(measure) : draft.title),
      format: draft.format ?? 'number',
    }
  }
  if (draft.as === 'table') {
    const order = draft.query.order?.[0]
    return {
      type: 'table',
      title: draft.title,
      w: 4,
      columns: result.columns.map((c) => ({
        key: c.key,
        label: short(c.key),
        align: c.kind === 'measure' ? 'right' : 'left',
        kind: c.kind,
      })),
      rows: result.rows,
      total: result.total,
      truncatedAt: result.truncated_at,
      page:
        draft.query.offset !== undefined || draft.query.limit !== undefined
          ? { offset: draft.query.offset ?? 0, limit: draft.query.limit }
          : undefined,
      sort: order ? { key: order.member, desc: order.desc ?? false } : undefined,
    }
  }
  if (draft.as === 'pivot') {
    // The pivot is a rendering of an ordinary two-dimension group-by:
    // first dimension → rows, second → columns, first measure → cells.
    // With fewer than 2 dimensions or no measure it degrades to a table.
    const dims = draft.query.dimensions ?? []
    const measure = draft.query.measures?.[0]
    if (dims.length >= 2 && measure) {
      return {
        type: 'pivot',
        title: draft.title,
        w: 4,
        rows: [dims[0]],
        cols: [dims[1]],
        measure,
        data: result.rows,
        format: draft.format,
      }
    }
    return draftToWidgetSpec({ ...draft, as: 'table' }, result)
  }
  const x = draft.x ?? result.columns.find((c) => c.kind !== 'measure')?.key
  const y =
    draft.y ?? draft.query.measures?.[0] ?? result.columns.find((c) => c.kind === 'measure')?.key ?? ''
  return {
    type: 'chart',
    title: draft.title,
    w: 2,
    chart: { mark: draft.mark ?? 'bar', x, y, series: result.rows, format: draft.format },
  }
}

/** A blank draft for a cube (nothing selected yet). */
export function emptyDraft(): WidgetDraft {
  return { as: 'metric', query: { measures: [], dimensions: [], filters: [] } }
}

/**
 * Auto-select a visualization for a query's shape (Explore's viz switcher
 * default — manual override always available): 1 measure + nothing → metric;
 * a granular time dimension → line; 1 dimension → bar; 2 dimensions → pivot;
 * anything else → table.
 */
export function autoViz(query: WidgetQuery): { as: WidgetDraft['as']; mark?: ChartMark } {
  const measures = query.measures?.length ?? 0
  const dims = query.dimensions?.length ?? 0
  const timed = (query.timeDimensions ?? []).some((t) => t.granularity)
  if (measures >= 1 && dims === 0 && timed) return { as: 'chart', mark: 'line' }
  if (measures === 1 && dims === 0) return { as: 'metric' }
  if (measures >= 1 && dims === 1 && !timed) return { as: 'chart', mark: 'bar' }
  if (measures >= 1 && dims === 2) return { as: 'pivot' }
  return { as: 'table' }
}

/** The cube a draft targets, from its first selected member (or undefined). */
export function draftCube(draft: WidgetDraft): string | undefined {
  const m = draft.query.measures?.[0] ?? draft.query.dimensions?.[0]
  return m?.split('.')[0]
}
