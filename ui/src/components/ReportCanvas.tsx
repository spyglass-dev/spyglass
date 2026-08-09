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
import type { ReportDoc, WidgetSpec } from '../types'
import type { WidgetRegistry } from '../registry'
import { Widget } from './Widget'
import type { GridQueryDelta } from './DataGrid'
import { applyGridDelta } from '../querybuilder'
import { FilterBar } from './FilterBar'
import { ReportLoading } from './ReportLoading'
import { WidgetError } from './WidgetError'
import { DEFAULT_REPORT_FILTERS, type FilterFacet, type ReportFilters } from '../filters'
import {
  resolveReport,
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
  /** Facets for the filter bar; omit to hide filters. */
  facets?: FilterFacet[]
  humanizeError?: (detail: string) => string
  /** Host handles adding a widget (e.g. opens a describe dialog). */
  onAddWidget?: () => void
  /** Host handles editing a widget in place. */
  onEditWidget?: (widget: ReportWidget, index: number) => void
  /** True while the host's agent is building — shows a "building…" indicator. */
  generating?: boolean
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
  facets,
  humanizeError,
  onAddWidget,
  onEditWidget,
  generating,
}: ReportCanvasProps) {
  const [resolved, setResolved] = useState<ReportDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const mergedRegistry = useMemo<WidgetRegistry>(() => ({ widget_error: WidgetError, ...registry }), [registry])
  const filters = report.filters ?? (facets ? DEFAULT_REPORT_FILTERS : undefined)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    resolveReport(report, { runQuery, cubeCaps, filters, humanizeError })
      .then((r) => !cancelled && setResolved(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, tick])

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

  const widgets = resolved?.widgets ?? []
  const failed = widgets.filter((w) => w.type === 'custom' && (w as { component?: string }).component === 'widget_error').length

  return (
    <div className="flex flex-col">
      {facets && filters && (
        <FilterBar filters={filters} onChange={setFilters} facets={facets} onReset={() => setFilters(DEFAULT_REPORT_FILTERS)} />
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
              const editable = onEditWidget && source?.type === 'bound'
              return (
                <section key={spec.id ?? i} style={span(spec.w)} className="group/w relative">
                  {spec.title && spec.type !== 'metric' && (
                    <div className="mb-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">{spec.title}</div>
                  )}
                  <Widget
                    spec={spec}
                    registry={mergedRegistry}
                    onGridQuery={source?.type === 'bound' ? gridQueryAt(i) : undefined}
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
    </div>
  )
}
