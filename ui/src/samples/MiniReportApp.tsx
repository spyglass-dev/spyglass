/**
 * MiniReportApp — a complete reports UI in ~60 lines, built from @spyglass/ui.
 * It shows how a host wires the framework:
 *   - hold a `Report` in state,
 *   - render it with <ReportCanvas> (filters + live widgets + edit controls),
 *   - back it with a query runner (here the mock engine),
 *   - handle add/edit with <QueryBuilder> (a real app would use its agent +
 *     the distri report tools instead).
 *
 * This is the "how to build a reports framework" reference.
 */
import { useMemo, useState } from 'react'
import { ReportCanvas } from '../components/ReportCanvas'
import { QueryBuilder } from '../components/QueryBuilder'
import {
  draftToBound,
  widgetToDraft,
  type BoundWidget,
  type Report,
  type ReportWidget,
} from '../report'
import { emptyDraft, type WidgetDraft } from '../querybuilder'
import type { FilterFacet } from '../filters'
import { MOCK_CAPS, MOCK_META, mockRunQuery } from './mockEngine'

const SAMPLE: Report = {
  title: 'Store performance',
  filters: { datePreset: 'last_30d' },
  widgets: [
    { type: 'bound', as: 'metric', label: 'Revenue', format: 'currency', query: { measures: ['Payments.revenue'] } },
    { type: 'bound', as: 'metric', label: 'Rentals', query: { measures: ['Rentals.count'] } },
    { type: 'bound', as: 'chart', title: 'Revenue by rating', mark: 'bar', w: 2, query: { measures: ['Payments.revenue'], dimensions: ['Payments.rating'] } },
    { type: 'bound', as: 'table', title: 'Rentals by store', w: 2, query: { measures: ['Rentals.count', 'Rentals.customers'], dimensions: ['Rentals.store'] } },
  ],
}

const FACETS: FilterFacet[] = [
  { key: 'status', label: 'Status', options: [{ value: 'returned', label: 'Returned' }, { value: 'out', label: 'Out' }] },
]

export function MiniReportApp() {
  const [report, setReport] = useState<Report>(SAMPLE)
  const [editing, setEditing] = useState<{ index?: number; draft: WidgetDraft } | null>(null)
  const runQuery = useMemo(() => mockRunQuery(), [])

  const save = () => {
    if (!editing) return
    const widget = draftToBound(editing.draft, editing.index !== undefined ? (report.widgets[editing.index] as BoundWidget) : undefined)
    const widgets: ReportWidget[] =
      editing.index !== undefined
        ? report.widgets.map((w, i) => (i === editing.index ? widget : w))
        : [...report.widgets, widget]
    setReport({ ...report, widgets })
    setEditing(null)
  }

  return (
    <div className="mx-auto max-w-5xl p-4">
      <h1 className="mb-3 text-xl font-bold text-foreground">{report.title}</h1>

      <ReportCanvas
        report={report}
        onChange={setReport}
        runQuery={runQuery}
        cubeCaps={MOCK_CAPS}
        facets={FACETS}
        onAddWidget={() => setEditing({ draft: emptyDraft() })}
        onEditWidget={(w, i) => setEditing({ index: i, draft: widgetToDraft(w as BoundWidget) })}
      />

      {editing && (
        <div className="mt-4 rounded-2xl border border-border bg-card p-4">
          <div className="mb-2 text-sm font-semibold text-foreground">
            {editing.index !== undefined ? 'Edit widget' : 'Add a widget'}
          </div>
          <QueryBuilder meta={MOCK_META} value={editing.draft} onChange={(draft) => setEditing({ ...editing, draft })} runQuery={runQuery} />
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={save} className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:opacity-90">Save widget</button>
            <button type="button" onClick={() => setEditing(null)} className="rounded-md border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted">Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}
