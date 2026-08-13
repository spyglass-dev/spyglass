/**
 * The report session state machine.
 *
 * An agent editing a report has to answer one question before it does anything:
 * **is there a report open, and is this a change to it or a new one?** Nothing
 * in the toolkit answered that. The tools each described themselves, the host
 * knew what was on screen, and the agent in between guessed — so "add a chart
 * to this" produced a whole new report, and a request that had already been
 * satisfied got satisfied twice.
 *
 * So the state is explicit, it is returned by `get_report`, and **every
 * mutating tool returns the state it produced.** An agent that has just called
 * a tool never has to ask what happened; the transition is in the result.
 *
 *     none ──create_report──▸ draft ──host saves──▸ saved
 *      ▲                        │                    │
 *      │                        └── add/edit/remove/move/set_filters/rename ──┐
 *      └── host closes ◂──────────────────────────────────────────────────────┘
 *
 * `none` is not an error state. It is the library page, and the only legal
 * build from it is `create_report`. Every other tool says so rather than
 * inventing a report to act on.
 */
import type { FacetSpec, Report, ReportWidget } from '../report'

/** Where the session is. `draft` means open but not yet persisted by the host. */
export type ReportStatus = 'none' | 'draft' | 'saved'

/**
 * What one widget did the last time it ran.
 *
 * `unresolved` is the honest default and is load-bearing: a host that has not
 * reported outcomes must not let an agent infer that every widget is fine. The
 * empty-cube failure — a widget that compiles, validates, answers 200 and
 * returns nothing — is invisible without this.
 */
export interface WidgetOutcome {
  status: 'ok' | 'empty' | 'error' | 'loading' | 'unresolved'
  row_count?: number
  /** First few rows: the shape, not the data. */
  sample?: Record<string, unknown>[]
  error?: string
  /** What the framework applied ON TOP of the query — the commonest reason a
   *  widget an agent believes is correct comes back empty. */
  applied?: { facets?: string[]; dateField?: string | null }
}

/** One widget as the agent sees it: addressable, described, and with outcome. */
export interface WidgetView {
  /** Stable across reorder and edit — prefer this over `index`. */
  id: string
  index: number
  type: string
  as?: string
  title?: string
  measures?: string[]
  dimensions?: string[]
  outcome: WidgetOutcome
}

/** The whole answer to "what am I looking at". */
export interface ReportSessionState {
  status: ReportStatus
  /** Present when `status` is `saved`. */
  id?: string
  title?: string
  description?: string
  facets: FacetSpec[]
  widget_count: number
  widgets: WidgetView[]
}

/** The state when nothing is open — a real state, not a failure. */
export const NO_REPORT: ReportSessionState = {
  status: 'none',
  facets: [],
  widget_count: 0,
  widgets: [],
}

const rand = () => Math.random().toString(36).slice(2, 8)

/** Mint a widget id. Client-side, so a widget authored offline keeps identity. */
export const newWidgetId = (): string => `w_${rand()}`

/** Read a widget's id, if it has one. */
export const widgetId = (w: ReportWidget): string | undefined =>
  (w as { id?: string }).id

/**
 * Give every widget an id, in place of the ones that lack one.
 *
 * Called on load (`normalizeDoc`) and before any addressing decision, so a
 * report saved before ids existed gains them the first time it is opened —
 * no migration, no version bump. Returns the SAME array when nothing changed,
 * so React sees no update and a read cannot dirty a document.
 */
export function withWidgetIds(widgets: ReportWidget[]): ReportWidget[] {
  // The fast path has to check UNIQUENESS too, not just presence: two widgets
  // carrying the same id are one widget as far as every edit tool is concerned,
  // and returning early would leave that unrepaired.
  const present = widgets.map(widgetId).filter((id): id is string => !!id)
  if (present.length === widgets.length && new Set(present).size === widgets.length) return widgets
  const seen = new Set<string>()
  return widgets.map((w) => {
    const id = widgetId(w)
    // A duplicated id is worse than a missing one — it makes two widgets the
    // same widget, and an edit would hit whichever came first.
    if (id && !seen.has(id)) {
      seen.add(id)
      return w
    }
    let next = newWidgetId()
    while (seen.has(next)) next = newWidgetId()
    seen.add(next)
    return { ...w, id: next } as ReportWidget
  })
}

/**
 * Canonical JSON with sorted keys, for structural comparison. Two widgets that
 * render the same thing from the same query serialize identically here even if
 * their keys were written in a different order.
 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
}

/**
 * A widget's identity for dedupe: everything except the fields that are about
 * the *instance* rather than the *content*. `provenance` carries a timestamp,
 * so two identical widgets added a second apart would otherwise differ.
 *
 * Deliberately structural. Comparing titles instead would silently drop the
 * second panel of a comparison — two tables, same title, different measures.
 */
export function widgetFingerprint(widget: ReportWidget): string {
  const { id: _id, provenance: _p, ...rest } = widget as unknown as Record<string, unknown>
  return canonical(rest)
}

/** Find a widget structurally identical to `widget`, if the report has one. */
export function findDuplicate(
  widgets: ReportWidget[],
  widget: ReportWidget,
): { id: string; index: number } | null {
  const fp = widgetFingerprint(widget)
  for (let i = 0; i < widgets.length; i++) {
    if (widgetFingerprint(widgets[i]) === fp) {
      return { id: widgetId(widgets[i]) ?? '', index: i }
    }
  }
  return null
}

const QUERY_TYPES = new Set(['bound', 'view'])

/** Describe one widget for the agent: enough to decide, not the whole query. */
function viewOf(w: ReportWidget, index: number, outcome: WidgetOutcome): WidgetView {
  const anyW = w as unknown as Record<string, unknown>
  const q = anyW.query as { measures?: string[]; dimensions?: string[] } | undefined
  return {
    id: widgetId(w) ?? '',
    index,
    type: String(anyW.type ?? ''),
    as: anyW.as as string | undefined,
    title: (anyW.title ?? anyW.label) as string | undefined,
    ...(QUERY_TYPES.has(String(anyW.type)) ? { measures: q?.measures, dimensions: q?.dimensions } : {}),
    outcome,
  }
}

export interface SessionInput {
  report: Report | null
  /** The host's persisted id, when it has saved this report. */
  savedId?: string | null
  /** What each widget did last time it ran, keyed by widget id. */
  outcomes?: Map<string, WidgetOutcome> | Record<string, WidgetOutcome>
}

/** Build the state an agent reads. Pure: no queries, no fetches, no mutation. */
export function sessionState({ report, savedId, outcomes }: SessionInput): ReportSessionState {
  if (!report) return NO_REPORT
  const get = (id: string): WidgetOutcome => {
    if (!outcomes) return { status: 'unresolved' }
    const found = outcomes instanceof Map ? outcomes.get(id) : outcomes[id]
    return found ?? { status: 'unresolved' }
  }
  const widgets = report.widgets ?? []
  return {
    status: savedId ? 'saved' : 'draft',
    ...(savedId ? { id: savedId } : {}),
    title: report.title,
    description: report.description,
    facets: report.facets ?? [],
    widget_count: widgets.length,
    widgets: widgets.map((w, i) => viewOf(w, i, get(widgetId(w) ?? ''))),
  }
}

/**
 * Resolve which widget a tool means.
 *
 * `id` wins over `index` when both are given: an index is positional and moves
 * under remove and reorder, so an agent holding one from two turns ago is
 * holding a stale pointer. The index remains supported because an agent that
 * has just read `get_report` reasons naturally in positions.
 */
export function resolveWidget(
  widgets: ReportWidget[],
  ref: { id?: string; index?: number },
): { index: number } | { error: string } {
  if (ref.id) {
    const i = widgets.findIndex((w) => widgetId(w) === ref.id)
    if (i >= 0) return { index: i }
    return { error: `No widget with id "${ref.id}". Call get_report for the current ids.` }
  }
  if (typeof ref.index === 'number') {
    if (ref.index >= 0 && ref.index < widgets.length) return { index: ref.index }
    return { error: `index ${ref.index} out of range (the report has ${widgets.length}).` }
  }
  return { error: 'Provide the widget `id` (preferred) or its `index`.' }
}
