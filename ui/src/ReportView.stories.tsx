/**
 * Storybook stories for the reporting widgets. CSF3, framework-agnostic
 * (no hard Storybook import) so the package stays light; a workspace-level
 * Storybook can pick these up.
 *
 * Domain-agnostic sample data from the Pagila DVD-rental database
 * (`tests/pagila/cubes/pagila.yml`) — Payments/Rentals/Customers/Films — so
 * nothing here is tied to a specific host product.
 */
import { ReportView } from './components/ReportView'
import type { ReportDoc } from './types'

const sample: ReportDoc = {
  title: 'Store performance — Q2',
  description: 'Pagila rental store: revenue, rentals, and catalog at a glance.',
  widgets: [
    { type: 'metric', value: 30924, label: 'Revenue', format: 'currency', w: 1, delta: { value: 8, trend: 'up', suffix: 'pp' } },
    { type: 'metric', value: 16044, label: 'Rentals', format: 'number', w: 1 },
    { type: 'metric', value: 599, label: 'Active customers', format: 'number', w: 1 },
    { type: 'metric', value: 4.3, label: 'Avg payment', format: 'currency', w: 1 },
    {
      type: 'chart',
      title: 'Revenue by film rating',
      w: 2,
      chart: { mark: 'bar', x: 'rating', y: 'revenue', format: 'currency', series: [
        { rating: 'PG-13', revenue: 8730 },
        { rating: 'NC-17', revenue: 7290 },
        { rating: 'PG', revenue: 6560 },
        { rating: 'R', revenue: 5140 },
        { rating: 'G', revenue: 3204 },
      ] },
    },
    {
      type: 'table',
      title: 'Top customers by spend',
      w: 2,
      columns: [
        { key: 'name', label: 'Customer' },
        { key: 'spend', label: 'Spend', format: 'currency', align: 'right' },
        { key: 'rentals', label: 'Rentals', align: 'right' },
      ],
      rows: [
        { name: 'Karl Seal', spend: 221.55, rentals: 45 },
        { name: 'Eleanor Hunt', spend: 216.54, rentals: 46 },
        { name: 'Clara Shaw', spend: 195.58, rentals: 42 },
      ],
    },
  ],
}

const meta = {
  title: 'Reporting/ReportView',
  component: ReportView,
}
export default meta

export const StorePerformance = {
  render: () => <ReportView doc={sample} />,
}

const charts: ReportDoc = {
  title: 'Chart gallery',
  description: 'Vega-Lite behind the compact ChartSpec, plus a raw vlSpec.',
  widgets: [
    {
      type: 'chart',
      title: 'Rentals by store (stacked)',
      w: 2,
      chart: {
        mark: 'bar',
        x: 'month',
        y: 'rentals',
        color: 'store',
        series: [
          { month: 'Apr', store: 'Store 1', rentals: 1180 },
          { month: 'Apr', store: 'Store 2', rentals: 1042 },
          { month: 'May', store: 'Store 1', rentals: 1355 },
          { month: 'May', store: 'Store 2', rentals: 1290 },
          { month: 'Jun', store: 'Store 1', rentals: 1401 },
          { month: 'Jun', store: 'Store 2', rentals: 1338 },
        ],
      },
    },
    {
      type: 'chart',
      title: 'Revenue trend',
      w: 2,
      chart: {
        mark: 'line',
        x: 'date',
        y: 'revenue',
        format: 'currency',
        series: [
          { date: '2022-04-01', revenue: 9210 },
          { date: '2022-05-01', revenue: 10870 },
          { date: '2022-06-01', revenue: 10844 },
        ],
      },
    },
    {
      type: 'chart',
      title: 'Raw Vega-Lite (film catalog heatmap)',
      w: 4,
      chart: {
        mark: 'bar',
        y: 'films',
        series: [
          { rating: 'G', duration: '3 days', films: 34 },
          { rating: 'G', duration: '5 days', films: 41 },
          { rating: 'PG', duration: '3 days', films: 52 },
          { rating: 'PG', duration: '5 days', films: 38 },
          { rating: 'R', duration: '3 days', films: 29 },
          { rating: 'R', duration: '5 days', films: 46 },
        ],
        vlSpec: {
          mark: 'rect',
          encoding: {
            x: { field: 'duration', type: 'nominal', title: null },
            y: { field: 'rating', type: 'nominal', title: null },
            color: { field: 'films', type: 'quantitative', title: 'Films' },
          },
          height: 140,
        },
      },
    },
  ],
}

export const ChartGallery = {
  render: () => <ReportView doc={charts} />,
}

/** The "all time" marker: widgets an active date range could not reach say so
 *  right on the frame — beside widgets it did reach — instead of silently
 *  presenting two different time windows as one report. */
const allTime: ReportDoc = {
  title: 'Ranged report with unreachable widgets',
  description: 'Date range: last 30 days. Two widgets cannot receive it and are marked.',
  widgets: [
    { type: 'metric', value: 30924, label: 'Revenue (30d)', format: 'currency', w: 1, applied: { facets: [], dateRange: 'Payments.paid_at' } },
    { type: 'metric', value: 599, label: 'Customers', format: 'number', w: 1, applied: { facets: [], dateRangeSkipped: 'no_time_field' } },
    { type: 'metric', value: 1204, label: 'Lifetime rentals', format: 'number', w: 1, applied: { facets: [], dateRangeSkipped: 'opted_out' } },
    { type: 'metric', value: 87, label: 'Avg basket', format: 'currency', w: 1, applied: { facets: [], dateRange: 'Payments.paid_at' } },
    {
      type: 'table',
      title: 'Rentals this quarter',
      w: 4,
      applied: { facets: [], dateRangeSkipped: 'widget_pinned' },
      columns: [
        { key: 'film', label: 'Film' },
        { key: 'rentals', label: 'Rentals', align: 'right' },
      ],
      rows: [
        { film: 'Bucket Brotherhood', rentals: 34 },
        { film: 'Scalawag Duck', rentals: 32 },
      ],
    },
  ],
}

export const AllTimeMarkers = {
  render: () => <ReportView doc={allTime} />,
}
