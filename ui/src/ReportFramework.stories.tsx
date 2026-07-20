/**
 * Stories for the reporting framework — the reusable pieces a host wires up to
 * build a reports experience: the full canvas, the query builder, the filter
 * bar + date-range picker, and the widget error card. Backed by a mock engine
 * (no server) over a Pagila-style catalog.
 *
 * CSF3, framework-agnostic (no hard Storybook import).
 */
import { useState } from 'react'
import { MiniReportApp } from './samples/MiniReportApp'
import { MOCK_META, mockRunQuery } from './samples/mockEngine'
import { QueryBuilder } from './components/QueryBuilder'
import { FilterBar } from './components/FilterBar'
import { DateRangePicker } from './components/DateRangePicker'
import { WidgetError } from './components/WidgetError'
import { emptyDraft, type WidgetDraft } from './querybuilder'
import { DEFAULT_REPORT_FILTERS, type FilterFacet, type ReportFilters } from './filters'

const meta = { title: 'Reporting/Framework' }
export default meta

/** The whole thing wired up — filters, live widgets, add/edit via the builder. */
export const ReportBuilder = { render: () => <MiniReportApp /> }

/** The query builder in isolation (cube → measures/dimensions → viz → preview). */
export const QueryBuilderStory = {
  name: 'QueryBuilder',
  render: () => {
    const [draft, setDraft] = useState<WidgetDraft>({ ...emptyDraft(), as: 'chart', mark: 'bar', query: { measures: ['Payments.revenue'], dimensions: ['Payments.rating'], filters: [] } })
    return (
      <div className="max-w-3xl p-4">
        <QueryBuilder meta={MOCK_META} value={draft} onChange={setDraft} runQuery={mockRunQuery()} />
      </div>
    )
  },
}

/** The report-wide filter bar (date range presets + facet chips). */
export const Filters = {
  render: () => {
    const [filters, setFilters] = useState<ReportFilters>(DEFAULT_REPORT_FILTERS)
    const facets: FilterFacet[] = [
      { key: 'status', label: 'Status', options: [{ value: 'returned', label: 'Returned' }, { value: 'out', label: 'Out' }] },
    ]
    return (
      <div className="p-4">
        <FilterBar filters={filters} onChange={setFilters} facets={facets} onReset={() => setFilters(DEFAULT_REPORT_FILTERS)} />
        <pre className="mt-4 rounded-lg bg-muted/40 p-3 text-xs">{JSON.stringify(filters, null, 2)}</pre>
      </div>
    )
  },
}

/** Just the date-range picker (relative presets + custom range). */
export const DatePicker = {
  render: () => {
    const [filters, setFilters] = useState<ReportFilters>({ datePreset: 'last_7d' })
    return (
      <div className="p-8">
        <DateRangePicker filters={filters} onChange={setFilters} />
      </div>
    )
  },
}

/** The widget error card (what a failed widget degrades to). */
export const WidgetErrorCard = {
  name: 'WidgetError',
  render: () => (
    <div className="max-w-md p-4">
      <WidgetError
        spec={{
          type: 'custom',
          component: 'widget_error',
          data: { message: "This widget's query was malformed — try rebuilding it.", detail: 'reporting query failed: unknown member "Scores.avg(score)"' },
        }}
      />
    </div>
  ),
}
