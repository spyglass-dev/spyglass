/**
 * The two mistakes that produce a report which compiles, validates, answers 200
 * and shows nothing.
 *
 * Both were made by a real agent in one turn, and neither is catchable by query
 * validation, because every member involved exists:
 *
 *  1. It wrote `dateRange: "This week"` into every widget. The report's own date
 *     filter then means nothing — the baked window wins — so the filter bar is
 *     decorative and a report scoped to a quiet week reads as broken.
 *  2. It declared a facet whose key was a TIME dimension (`submitted_at`,
 *     labelled "Week"). A facet filters by identity — pick a class, pick a
 *     status. A time dimension is the date picker's job, and a facet over one
 *     can only ever be an empty menu.
 *
 * These are advisory where they can be and refusals where they must be: a
 * widget with a baked date range is *sometimes* right (a genuine
 * "all time vs this week" comparison), so it warns. A facet on a time dimension
 * is never right, so it fails.
 */
import type { CubeModelMeta, WidgetQuery } from '../querybuilder'
import type { FacetSpec, ReportWidget } from '../report'

/** Time dimensions in the model, as bare names and as `Cube.member`. */
function timeDimensions(meta: CubeModelMeta | undefined): Set<string> {
  const out = new Set<string>()
  for (const cube of meta?.cubes ?? []) {
    for (const d of cube.dimensions ?? []) {
      if (d.type !== 'time') continue
      out.add(d.member)
      const bare = d.member.includes('.') ? d.member.split('.').pop()! : d.member
      if (bare) out.add(bare)
    }
  }
  return out
}

/**
 * A facet key must be something a person picks a VALUE of. Returns an error
 * message, or null when the spec is fine.
 *
 * Without `meta` this cannot check anything and says so by passing — a host
 * that has not loaded the model should not have its agent blocked.
 */
export function checkFacetKeys(
  facets: FacetSpec[],
  meta: CubeModelMeta | undefined,
): string | null {
  if (!meta) return null
  const times = timeDimensions(meta)
  const offenders = facets.filter((f) => times.has(f.key)).map((f) => f.key)
  if (!offenders.length) return null
  return (
    `${offenders.join(', ')} ${offenders.length > 1 ? 'are time dimensions' : 'is a time dimension'}, ` +
    'so it cannot be a facet — a facet is a value the reader picks (a class, a status), and every ' +
    'report already has a date range of its own. Drop it from `facets`; if the report should default ' +
    'to a window, set the date filter instead.'
  )
}

const queryOf = (w: ReportWidget): WidgetQuery | undefined =>
  (w as { query?: WidgetQuery }).query

/** The time dimensions a widget pins a `dateRange` on. */
export function bakedDateRanges(widget: ReportWidget): string[] {
  const q = queryOf(widget)
  if (!q?.timeDimensions) return []
  return q.timeDimensions.filter((td) => td.dateRange !== undefined).map((td) => td.dimension)
}

/**
 * Warn when widgets pin their own window.
 *
 * Advisory, and returned to the agent as `warning` alongside `ok: true`: the
 * widget is built, and the agent is told what it just made the filter bar do.
 * A refusal here would block the legitimate case — one widget deliberately
 * showing all time beside one showing this week.
 */
export function warnBakedDateRange(widgets: ReportWidget[]): string | null {
  const pinned = widgets.flatMap(bakedDateRanges)
  if (!pinned.length) return null
  const unique = [...new Set(pinned)]
  return (
    `${pinned.length} widget${pinned.length > 1 ? 's' : ''} pin their own dateRange on ` +
    `${unique.join(', ')}, so the report's date filter will NOT apply to them and the reader ` +
    'cannot change the window. Drop `dateRange` from the widget queries and let the report\'s date ' +
    'filter own it — keep it only where a widget must show a different period from the rest of the ' +
    'report on purpose. Use granularity (day/week) for the shape of a trend; that is not a window.'
  )
}
