/**
 * URL state — filters, drill trail, page and sort serialize to one
 * querystring parameter, so a copied link reproduces the exact view.
 * Non-negotiable for anything shareable (spec §4.6).
 *
 * The whole state lives under a single `rpt` parameter as compact JSON —
 * URL-encoded once, order-stable, and absent entirely when everything is at
 * its default (a clean URL stays clean).
 */
import type { ReportFilters } from './filters'
import { DEFAULT_REPORT_FILTERS, hasActiveFilters } from './filters'
import type { DrillTrail } from './drill'

/** Per-widget grid state worth sharing: page offset + sort. Keyed by the
 *  widget's index in the report (stable for a saved doc). */
export interface GridUrlState {
  o?: number
  s?: { m: string; d?: boolean }
}

export interface ReportUrlState {
  filters?: ReportFilters
  drill?: DrillTrail
  grids?: Record<number, GridUrlState>
}

export const URL_PARAM = 'rpt'

/** A report at its default filters keeps a clean URL. */
const compactFilters = (f: ReportFilters | undefined) =>
  f && hasActiveFilters(f) && JSON.stringify(f) !== JSON.stringify(DEFAULT_REPORT_FILTERS)
    ? f
    : undefined

/** State → `rpt` parameter value, or null when everything is default. */
export function serializeReportState(state: ReportUrlState): string | null {
  const out: Record<string, unknown> = {}
  const f = compactFilters(state.filters)
  if (f) out.f = f
  if (state.drill?.length) out.d = state.drill
  if (state.grids && Object.keys(state.grids).length) out.g = state.grids
  return Object.keys(out).length ? JSON.stringify(out) : null
}

/** Full querystring (`?rpt=…` or '') for a state — convenience for hosts. */
export function reportStateToSearch(state: ReportUrlState): string {
  const v = serializeReportState(state)
  return v ? `?${URL_PARAM}=${encodeURIComponent(v)}` : ''
}

/** Parse a querystring (or a raw `rpt` value) back into state. Garbage in →
 *  empty state out; a broken link must never crash the report. */
export function parseReportSearch(search: string): ReportUrlState {
  try {
    const raw = search.startsWith('?') || search.includes('=')
      ? new URLSearchParams(search.replace(/^\?/, '')).get(URL_PARAM)
      : search
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { f?: ReportFilters; d?: DrillTrail; g?: Record<number, GridUrlState> }
    const state: ReportUrlState = {}
    if (parsed.f && typeof parsed.f === 'object') state.filters = { ...DEFAULT_REPORT_FILTERS, ...parsed.f }
    if (Array.isArray(parsed.d)) state.drill = parsed.d.filter((s) => s && typeof s.member === 'string')
    if (parsed.g && typeof parsed.g === 'object') state.grids = parsed.g
    return state
  } catch {
    return {}
  }
}
