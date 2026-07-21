/**
 * Query-builder model — a host-agnostic description of what a data widget is:
 * a cube query (`WidgetQuery`) + how to visualize it (`WidgetDraft`). The
 * `QueryBuilder` component edits a `WidgetDraft`; a host runs the query and the
 * pure `draftToWidgetSpec` turns the result into a renderable `WidgetSpec`.
 */
import type { WidgetSpec, ValueFormat, ChartMark } from './types'

// ── Catalog (mirrors the engine's /meta) ────────────────────────────────────

export interface CubeMeta {
  name: string
  title?: string
  description?: string
  measures: { name: string; member: string; type?: string; title?: string; format?: string }[]
  dimensions: { name: string; member: string; type?: string; title?: string; tenant?: boolean }[]
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
}

/** A data widget being authored: the query + its visualization. Maps 1:1 to a
 *  host's "bound widget" (host adds its own `type: 'bound'` tag). */
export interface WidgetDraft {
  as: 'metric' | 'table' | 'chart'
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
    return {
      type: 'table',
      title: draft.title,
      w: 4,
      columns: result.columns.map((c) => ({
        key: c.key,
        label: short(c.key),
        align: c.kind === 'measure' ? 'right' : 'left',
      })),
      rows: result.rows,
    }
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

/** The cube a draft targets, from its first selected member (or undefined). */
export function draftCube(draft: WidgetDraft): string | undefined {
  const m = draft.query.measures?.[0] ?? draft.query.dimensions?.[0]
  return m?.split('.')[0]
}
