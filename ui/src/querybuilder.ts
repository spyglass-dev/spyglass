/**
 * Query-builder model — a host-agnostic description of what a data widget is:
 * a cube query (`WidgetQuery`) + how to visualize it (`WidgetDraft`). The
 * `QueryBuilder` component edits a `WidgetDraft`; a host runs the query and the
 * pure `draftToWidgetSpec` turns the result into a renderable `WidgetSpec`.
 */
import type { WidgetSpec, MetricSpec, PivotSpec, TableColumn, ValueFormat, ChartMark } from './types'
import type { AntiExample, ModelVocabulary, QueryExample } from './reports/references'

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
  /** Worked examples of THIS cube's use — see `reports/references`. */
  examples?: QueryExample[]
  /** Plausible-but-wrong member choices on this cube, with the right one. */
  anti_examples?: AntiExample[]
}
export interface CubeModelMeta {
  cubes: CubeMeta[]
  /** Examples that span cubes belong to the model, not to either cube. */
  examples?: QueryExample[]
  anti_examples?: AntiExample[]
  /** What users call things versus what the model calls them. */
  vocabulary?: ModelVocabulary
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
  timeDimensions?: {
    dimension: string
    granularity?: string
    /**
     * Either an absolute `[fromISO, toISO)` pair, or the stored INTENT — a
     * relative phrase (`"last 30 days"`, `"this month"`) the ENGINE resolves
     * against its own clock on every run (grammar in `src/dates.rs`). A saved
     * report keeps the phrase, so "last 30 days" still means the last 30 days
     * a month after it was written.
     */
    dateRange?: [string, string] | string
    /** Engine comparison window — `__prev_<measure>` columns come back. */
    compare?: 'previous_period' | 'previous_year'
  }[]
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
  /** Chart value field. An ARRAY means "these measures on one chart" —
   *  `Chart` folds them into one series per measure (submissions against
   *  graded). It has always rendered that; the draft could not express it. */
  y?: string | string[]
  /** Chart series split: a member whose values become colored series — one
   *  line per workspace, grouped or stacked bars. Pair it with a group-by on
   *  the same member, which is what produces one row per series per x. */
  color?: string
  /** Bar/area with `color`: `false` groups the series side-by-side instead of
   *  stacking them (the default). */
  stack?: boolean
  /** Pivot rendering options (`as: 'pivot'`): edge totals (incl. `ratio`
   *  weighted totals), shading, and how absent combinations render. */
  pivot?: Pick<PivotSpec, 'totals' | 'scale' | 'empty'>
  /** Per-member column overrides (`as: 'table'`): label, format, pill. Keyed
   *  by result-column member key. */
  columns?: Record<string, Partial<Pick<TableColumn, 'label' | 'format' | 'pill'>>>
}

/** The shape a host's query runner returns (matches the engine's QueryResult). */
export interface QueryResultLite {
  /** `drill_entity` mirrors the dimension's `drill: { entity }` annotation —
   *  the engine stamps it on result columns so tables become entity-drillable
   *  without a client-side `/meta` join. */
  columns: { key: string; kind: string; drill_entity?: string }[]
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

/**
 * Human header for a member key: last segment, trailing `_id` dropped (id
 * columns render their `__label` companion anyway), snake_case to sentence
 * case — `Scores.activity_id` → "Activity", `score_weighted` → "Score
 * weighted". Raw `ACTIVITY_ID` headers were the loudest "unfinished" signal
 * in the shipped tables.
 */
export function humanizeMember(member: string): string {
  const field = member.split('.').pop() ?? member
  const words = field.replace(/_id$/, '').split('_').filter(Boolean)
  if (!words.length) return field
  const text = words.join(' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const short = humanizeMember

/** Turn a query result into a data-bearing WidgetSpec, per the draft's viz. */
export function draftToWidgetSpec(draft: WidgetDraft, result: QueryResultLite): WidgetSpec {
  if (draft.as === 'metric') {
    const measure = draft.query.measures?.[0]
    const raw = measure ? result.rows[0]?.[measure] : undefined
    const value = typeof raw === 'number' ? raw : raw == null ? 0 : Number(raw) || 0
    // Comparison window (`compare` on the time dimension) → delta chip:
    // "↓9.4pt vs previous period" beside the headline number.
    let delta: MetricSpec['delta']
    const prevRaw = measure ? result.rows[0]?.[`__prev_${measure}`] : undefined
    const prev = typeof prevRaw === 'number' ? prevRaw : prevRaw == null ? undefined : Number(prevRaw)
    if (prev !== undefined && !Number.isNaN(prev)) {
      const diff = Math.round((value - prev) * 10) / 10
      const compare = draft.query.timeDimensions?.find((td) => td.compare)?.compare
      delta = {
        value: diff,
        trend: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
        suffix: draft.format === 'percent' ? 'pt' : '',
        label: compare === 'previous_year' ? 'vs previous year' : 'vs previous period',
      }
    }
    return {
      type: 'metric',
      title: draft.title,
      w: 1,
      value,
      label: draft.label ?? (measure ? short(measure) : draft.title),
      format: draft.format ?? 'number',
      ...(delta ? { delta } : {}),
    }
  }
  if (draft.as === 'table') {
    const order = draft.query.order?.[0]
    return {
      type: 'table',
      title: draft.title,
      w: 4,
      columns: result.columns.map((c) => {
        const over = draft.columns?.[c.key]
        return {
          key: c.key,
          label: over?.label ?? short(c.key),
          align: c.kind === 'measure' ? 'right' : 'left',
          kind: c.kind,
          drillEntity: c.drill_entity,
          // Measure columns inherit the widget's format ("50" → "50%"), and
          // percent measures band into score pills unless overridden. A time
          // column formats as a date — the engine hands back
          // `2026-08-17 04:07:00+00`, which is a timestamp, not a label.
          format:
            over?.format ??
            (c.kind === 'time' ? 'date' : c.kind === 'measure' ? draft.format : undefined),
          pill:
            over?.pill ??
            (c.kind === 'measure' && (over?.format ?? draft.format) === 'percent' ? 'band' : undefined),
        }
      }),
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
        ...draft.pivot,
      }
    }
    return draftToWidgetSpec({ ...draft, as: 'table' }, result)
  }
  // The x default skips a `color` split member: with `dimensions:
  // [workspace_id]` and a daily bucket, the first non-measure column is the
  // workspace, and defaulting x to it drew one bar per workspace instead of a
  // line per workspace over time.
  const categorical = result.columns.filter((c) => c.kind !== 'measure' && !c.key.endsWith('__label'))
  const x =
    draft.x ??
    (categorical.find((c) => c.key !== draft.color) ?? categorical[0])?.key
  const y =
    draft.y ?? draft.query.measures?.[0] ?? result.columns.find((c) => c.kind === 'measure')?.key ?? ''
  // A split member with a declared label (`workspace_id` → its name) colors by
  // the LABEL: a legend of UUIDs names nothing an operator recognises.
  const color =
    draft.color && result.columns.some((c) => c.key === `${draft.color}__label`)
      ? `${draft.color}__label`
      : draft.color
  return {
    type: 'chart',
    title: draft.title,
    w: 2,
    chart: {
      mark: draft.mark ?? 'bar',
      x,
      y,
      series: result.rows,
      format: draft.format,
      ...(color ? { color } : {}),
      ...(draft.stack === undefined ? {} : { stack: draft.stack }),
    },
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
