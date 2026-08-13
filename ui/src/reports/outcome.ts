/**
 * What a widget actually rendered, derived from the spec the canvas already
 * resolved.
 *
 * This runs no queries. `resolveReport` fetches every bound widget in order to
 * draw it; until now that result was drawn and thrown away, so an agent had no
 * way to distinguish a table of 107 rows from one showing "No data". Keeping it
 * is the whole fix: three times this codebase has shipped a reporting surface
 * that compiled, validated, answered 200 and displayed nothing.
 */
import type { WidgetSpec } from '../types'
import type { ReportWidget } from '../report'
import { applyFilters, type CubeCapsMap } from '../report'
import type { ReportFilters } from '../filters'
import { widgetId } from './session'
import type { WidgetOutcome } from './session'

/** How many rows a resolved spec is showing, or null when it carries no rows. */
function rowsOf(spec: WidgetSpec): number | null {
  switch (spec.type) {
    case 'table':
      return (spec.rows ?? []).length
    case 'chart':
      return (spec.chart?.series ?? []).length
    case 'pivot':
      return (spec as { rows?: unknown[] }).rows?.length ?? null
    case 'metric':
      // A metric of 0 is a real answer, not an absent one; only a missing
      // value means the query gave nothing back.
      return spec.value === null || spec.value === undefined ? 0 : 1
    default:
      return null
  }
}

/** The error a failed widget resolves into (`widget_error`), if it is one. */
function errorOf(spec: WidgetSpec): string | null {
  if (spec.type === 'custom' && spec.component === 'widget_error') {
    const d = spec.data as { detail?: string; message?: string } | undefined
    return d?.detail ?? d?.message ?? 'This widget failed to load.'
  }
  if (spec.type === 'view' && (spec as { error?: { detail?: string } }).error) {
    return (spec as { error?: { detail?: string; message?: string } }).error?.detail ?? 'This view failed to load.'
  }
  return null
}

/** Rows worth showing the agent: the shape, not the data. */
const SAMPLE = 3

function sampleOf(spec: WidgetSpec): Record<string, unknown>[] | undefined {
  if (spec.type === 'table') return (spec.rows ?? []).slice(0, SAMPLE)
  if (spec.type === 'chart') return (spec.chart?.series ?? []).slice(0, SAMPLE)
  if (spec.type === 'metric') return [{ value: spec.value, label: spec.label }]
  return undefined
}

/**
 * What the framework put on top of this widget's own query.
 *
 * The commonest reason a widget an agent believes is correct comes back empty
 * is a facet or a date range it never saw — the report was scoped to a class
 * with no rows, or to a window the data is not in.
 */
function appliedOf(
  source: ReportWidget,
  filters: ReportFilters | undefined,
  caps: CubeCapsMap,
): WidgetOutcome['applied'] {
  if ((source as { type?: string }).type !== 'bound') return undefined
  try {
    const { applied } = applyFilters(source as never, filters, caps)
    return {
      facets: applied.facets?.map((f) => (typeof f === 'string' ? f : (f as { key: string }).key)),
      dateField: (applied as { dateField?: string | null }).dateField ?? null,
    }
  } catch {
    return undefined
  }
}

export interface OutcomeInput {
  /** The authored widgets, in order. */
  source: ReportWidget[]
  /** What `resolveReport` produced for them, in the same order. */
  resolved: WidgetSpec[]
  filters?: ReportFilters
  cubeCaps?: CubeCapsMap
}

/**
 * Pair each authored widget with what it rendered, keyed by widget id.
 *
 * Positional pairing is safe because `resolveReport` maps 1:1 over the widget
 * array; a widget with no id is skipped rather than guessed at, since a wrong
 * key is worse than a missing one.
 */
export function outcomesFrom({ source, resolved, filters, cubeCaps }: OutcomeInput): Map<string, WidgetOutcome> {
  const out = new Map<string, WidgetOutcome>()
  source.forEach((w, i) => {
    const id = widgetId(w)
    const spec = resolved[i]
    if (!id || !spec) return
    const error = errorOf(spec)
    if (error) {
      out.set(id, { status: 'error', error })
      return
    }
    const rows = rowsOf(spec)
    const applied = appliedOf(w, filters, cubeCaps ?? {})
    if (rows === null) {
      // A note or a host component: nothing to be empty about.
      out.set(id, { status: 'ok' })
      return
    }
    out.set(id, {
      status: rows === 0 ? 'empty' : 'ok',
      row_count: rows,
      ...(rows > 0 ? { sample: sampleOf(spec) } : {}),
      ...(applied ? { applied } : {}),
    })
  })
  return out
}
