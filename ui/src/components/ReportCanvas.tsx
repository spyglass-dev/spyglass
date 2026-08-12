/**
 * ReportCanvas — the editable report surface. Resolves a `Report` (running its
 * bound widgets through a host `runQuery`) and renders the widgets on a 4-column
 * grid with contextual controls: hover "+" to add, per-widget Edit + Delete,
 * a report-wide filter bar, Refresh, an error banner, and a first-class error
 * card for widgets that fail. The host wires add/edit (e.g. a describe dialog);
 * delete/refresh/filters are handled inline. Tailwind design tokens.
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'
import { RefreshCw, Plus, Trash2, Pencil, TriangleAlert, Sparkles } from 'lucide-react'
import type { ReportDoc, TableSpec, WidgetSpec } from '../types'
import type { WidgetRegistry } from '../registry'
import { Widget } from './Widget'
import { DataGrid, type GridQueryDelta } from './DataGrid'
import { routeDrill, type DrillEvent, type DrillRouter } from '../drill'
import type { ViewRegistry } from '../views'
import { applyGridDelta, draftToWidgetSpec } from '../querybuilder'
import { parseReportSearch, reportStateToSearch, type GridUrlState } from '../urlstate'
import { FilterBar } from './FilterBar'
import { ReportLoading } from './ReportLoading'
import { WidgetError } from './WidgetError'
import { AllTimeChip } from './AllTimeChip'
import { DEFAULT_REPORT_FILTERS, type FilterFacet, type ReportFilters } from '../filters'
import {
  resolveReport,
  rowsQueryFor,
  type BoundWidget,
  type Report,
  type ReportWidget,
  type QueryRunner,
  type CubeCapsMap,
} from '../report'

function span(w?: number): CSSProperties {
  const cols = Math.max(1, Math.min(4, w ?? 4))
  return { gridColumn: `span ${cols} / span ${cols}`, minWidth: 0 }
}

export interface ReportCanvasProps {
  report: Report
  onChange: (report: Report) => void
  runQuery: QueryRunner
  cubeCaps?: CubeCapsMap
  /** Host widget renderers (merged with the built-in `widget_error`). */
  registry?: WidgetRegistry
  /** Host view registry — bound views resolve and render through this. */
  views?: ViewRegistry
  /** Facets for the filter bar; omit to hide filters. */
  facets?: FilterFacet[]
  humanizeError?: (detail: string) => string
  /** Host handles adding a widget (e.g. opens a describe dialog). */
  onAddWidget?: () => void
  /** Host handles editing a widget in place. */
  onEditWidget?: (widget: ReportWidget, index: number) => void
  /** True while the host's agent is building — shows a "building…" indicator. */
  generating?: boolean
  /** Host drill routing (entity → handler). An event whose entity has no
   *  route falls back to the default drill-down (filter in place +
   *  breadcrumb). Omit entirely for default drill-down everywhere. */
  drillRouter?: DrillRouter
  /** Mirror filters, drill trail, page and sort to the URL (`?rpt=…`) via
   *  history.replaceState, and restore them on mount — a copied link
   *  reproduces the exact view. Off by default (hosts with their own
   *  routing wire `parseReportSearch`/`reportStateToSearch` themselves). */
  syncUrl?: boolean
}

function InsertBar({ onClick }: { onClick?: () => void }) {
  if (!onClick) return <div className="col-span-4 h-1" />
  return (
    <div className="group/insert relative col-span-4 flex h-2 items-center justify-center">
      <button
        type="button"
        onClick={onClick}
        aria-label="Add widget here"
        className="flex h-6 w-6 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-sm transition-opacity hover:border-primary hover:text-primary group-hover/insert:opacity-100"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
      <span className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-primary/30 opacity-0 transition-opacity group-hover/insert:opacity-100" />
    </div>
  )
}

export function ReportCanvas({
  report,
  onChange,
  runQuery,
  cubeCaps,
  registry,
  views,
  facets,
  humanizeError,
  onAddWidget,
  onEditWidget,
  generating,
  drillRouter,
  syncUrl,
}: ReportCanvasProps) {
  const [resolved, setResolved] = useState<ReportDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [drawer, setDrawer] = useState<{ title: string; spec?: TableSpec; error?: string; loading?: boolean } | null>(null)
  const [urlRestored, setUrlRestored] = useState(!syncUrl)

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const mergedRegistry = useMemo<WidgetRegistry>(() => ({ widget_error: WidgetError, ...registry }), [registry])
  const filters = report.filters ?? (facets ? DEFAULT_REPORT_FILTERS : undefined)

  // Restore URL state once, before the first resolve — a copied link
  // reproduces filters, drill trail, page and sort.
  useEffect(() => {
    if (!syncUrl || urlRestored) return
    const state = parseReportSearch(window.location.search)
    let next = report
    if (state.filters) next = { ...next, filters: state.filters }
    if (state.drill) next = { ...next, drill: state.drill }
    if (state.grids) {
      next = {
        ...next,
        widgets: next.widgets.map((w, i) => {
          const g = state.grids?.[i]
          if (!g || w.type !== 'bound') return w
          return {
            ...w,
            query: applyGridDelta(w.query, {
              ...(g.o !== undefined ? { offset: g.o } : {}),
              ...(g.s ? { order: [{ member: g.s.m, desc: g.s.d }] } : {}),
            }),
          }
        }),
      }
    }
    if (next !== report) onChange(next)
    setUrlRestored(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirror filters, drill trail, page and sort back to the URL.
  useEffect(() => {
    if (!syncUrl || !urlRestored) return
    const grids: Record<number, GridUrlState> = {}
    report.widgets.forEach((w, i) => {
      if (w.type !== 'bound') return
      const offset = w.query.offset
      const sort = w.query.order?.[0]
      if (offset || sort)
        grids[i] = {
          ...(offset ? { o: offset } : {}),
          ...(sort ? { s: { m: sort.member, ...(sort.desc ? { d: true } : {}) } } : {}),
        }
    })
    const search = reportStateToSearch({ filters: report.filters, drill: report.drill, grids })
    window.history.replaceState(null, '', window.location.pathname + search + window.location.hash)
  }, [syncUrl, urlRestored, report])

  useEffect(() => {
    if (!urlRestored) return
    let cancelled = false
    setLoading(true)
    setError(null)
    resolveReport(report, { runQuery, cubeCaps, views, filters, humanizeError })
      .then((r) => !cancelled && setResolved(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, tick, urlRestored])

  const removeAt = (index: number) =>
    onChange({ ...report, widgets: report.widgets.filter((_, i) => i !== index) })
  const setFilters = (next: ReportFilters) => onChange({ ...report, filters: next })

  // Server-driven grids: a sort/page delta patches the bound widget's QUERY
  // (never the rendered rows) and the report re-resolves.
  const gridQueryAt = (index: number) => (delta: GridQueryDelta) => {
    const source = report.widgets[index]
    if (source?.type !== 'bound') return
    onChange({
      ...report,
      widgets: report.widgets.map((w, i) =>
        i === index && w.type === 'bound' ? { ...w, query: applyGridDelta(w.query, delta) } : w,
      ),
    })
  }

  // Dimension-cell drill: the host's router wins for entities it routes;
  // everything else drill-DOWNS — append to the trail, re-run in place.
  const onDrill = (event: DrillEvent) => {
    routeDrill(event, drillRouter, (e) => {
      const trail = report.drill ?? []
      if (trail.some((s) => s.member === e.member && s.value === e.value)) return
      onChange({ ...report, drill: [...trail, e] })
    })
  }
  const popDrill = (length: number) => onChange({ ...report, drill: (report.drill ?? []).slice(0, length) })

  // Measure-cell click: open the records drawer via a `mode: 'rows'` query.
  // The engine bounds the projection to the cube's drill_members and refuses
  // a cube that declares none — the drawer inherits that, it can't widen it.
  const measureClickAt = (index: number) => async (row: Record<string, unknown>) => {
    const source = report.widgets[index]
    if (source?.type !== 'bound') return
    const bound = source as BoundWidget
    const title = bound.title ? `Records — ${bound.title}` : 'Records'
    setDrawer({ title, loading: true })
    try {
      const query = rowsQueryFor(bound, row, { filters, drill: report.drill, cubeCaps })
      const result = await runQuery(query, { studentId: bound.studentId })
      setDrawer({ title, spec: draftToWidgetSpec({ as: 'table', query }, result) as TableSpec })
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      setDrawer({ title, error: humanizeError?.(detail) ?? detail })
    }
  }

  const widgets = resolved?.widgets ?? []
  const failed = widgets.filter((w) => w.type === 'custom' && (w as { component?: string }).component === 'widget_error').length

  return (
    <div className="flex flex-col">
      {/* The bar also carries the drill trail, so it must render for a report
          with NO facets the moment the user drills into something — otherwise
          the trail (and its undo) vanishes exactly when it is needed. */}
      {(facets || (report.drill?.length ?? 0) > 0) && (
        <FilterBar
          filters={filters ?? DEFAULT_REPORT_FILTERS}
          onChange={setFilters}
          facets={facets}
          drill={report.drill ?? []}
          onPopDrill={popDrill}
          // Reset to the host's DEFAULTS *and* drop the drill trail. Clearing
          // only `filters` left the report narrowed by whatever the user last
          // clicked — the trail is an equality predicate exactly like a facet,
          // so a "Clear" that skips it does not clear the report.
          onReset={() => onChange({ ...report, filters: DEFAULT_REPORT_FILTERS, drill: [] })}
        />
      )}

      <div className="flex flex-col gap-3 p-1 pt-3">
        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={refresh}
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        {error && <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</div>}

        {failed > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-amber-200/70 bg-amber-50/50 px-3 py-2 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/20 dark:text-amber-200">
            <TriangleAlert className="h-4 w-4 shrink-0 text-amber-500" />
            <span className="flex-1">{failed} of {widgets.length} widget{widgets.length === 1 ? '' : 's'} couldn’t load.</span>
            <button type="button" onClick={refresh} className="inline-flex items-center gap-1.5 rounded-md border border-amber-300/70 bg-background px-2 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100/50 dark:text-amber-200">
              <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Retry
            </button>
          </div>
        )}

        {loading && !resolved ? (
          <ReportLoading message="Loading report…" />
        ) : (
          <div className="grid grid-cols-4 gap-4">
            <InsertBar onClick={onAddWidget} />
            {widgets.map((spec: WidgetSpec, i) => {
              const source = report.widgets[i]
              // Bound widgets edit through the host's query flow; notes edit
              // too — a report's prose (a summary, a teacher's note) is
              // authored content, not derived data.
              const editable = onEditWidget && (source?.type === 'bound' || source?.type === 'note')
              const showTitle = spec.title && spec.type !== 'metric'
              const skipped = spec.applied?.dateRangeSkipped
              return (
                <section key={spec.id ?? i} style={span(spec.w)} className="group/w relative">
                  {(showTitle || skipped) && (
                    <div className="mb-1.5 flex items-center gap-2">
                      {showTitle && (
                        <span className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{spec.title}</span>
                      )}
                      {skipped && <AllTimeChip reason={skipped} />}
                    </div>
                  )}
                  <Widget
                    spec={spec}
                    registry={mergedRegistry}
                    views={views}
                    filters={filters}
                    onGridQuery={source?.type === 'bound' ? gridQueryAt(i) : undefined}
                    onDrill={source?.type === 'bound' || source?.type === 'view' ? onDrill : undefined}
                    onMeasureClick={source?.type === 'bound' ? measureClickAt(i) : undefined}
                    onRefresh={refresh}
                  />
                  <div className="absolute right-1 top-1 flex gap-1 opacity-0 transition-opacity group-hover/w:opacity-100">
                    {editable && (
                      <button type="button" onClick={() => onEditWidget!(source, i)} aria-label="Edit widget" className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:border-primary hover:text-primary">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <button type="button" onClick={() => removeAt(i)} aria-label="Remove widget" className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-background text-muted-foreground shadow-sm hover:border-rose-300 hover:text-rose-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </section>
              )
            })}
            {onAddWidget && (
              <button type="button" onClick={onAddWidget} style={span(4)} className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-border py-6 text-sm font-medium text-muted-foreground transition-colors hover:border-primary/60 hover:bg-primary/5 hover:text-primary">
                <Plus className="h-4 w-4" /> Add widget
              </button>
            )}
          </div>
        )}

        {generating && (
          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm text-primary">
            <Sparkles className="h-4 w-4 animate-pulse" /> Building your widget…
          </div>
        )}
      </div>

      {drawer && (
        <div className="fixed inset-y-0 right-0 z-50 flex w-full max-w-2xl flex-col gap-3 overflow-y-auto border-l border-border bg-background p-4 shadow-2xl">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">{drawer.title}</div>
            <button
              type="button"
              onClick={() => setDrawer(null)}
              className="rounded-md border border-border bg-background px-2.5 py-1 text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Close
            </button>
          </div>
          {drawer.loading && <ReportLoading message="Loading records…" />}
          {drawer.error && (
            <div className="rounded-lg border border-amber-200/70 bg-amber-50/50 px-3 py-2 text-sm text-amber-800">
              {drawer.error}
            </div>
          )}
          {drawer.spec && <DataGrid spec={drawer.spec} />}
        </div>
      )}
    </div>
  )
}
