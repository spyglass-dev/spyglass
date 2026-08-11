/**
 * Drill stories — named for the STATE each one shows. Drill is model-driven:
 * dimension cells emit `DrillEvent`; with no router the default is
 * drill-DOWN (filter in place + poppable breadcrumb); measure cells open the
 * records drawer (`mode: 'rows'`). Backed by the mock engine.
 */
import { useState } from 'react'
import { ReportCanvas } from './components/ReportCanvas'
import { DrillBreadcrumb } from './components/DrillBreadcrumb'
import { MOCK_CAPS, mockRunQuery } from './samples/mockEngine'
import type { Report } from './report'
import type { DrillTrail } from './drill'

const meta = { title: 'Reporting/Drill' }
export default meta

const baseReport: Report = {
  title: 'Rental operations',
  widgets: [
    {
      type: 'bound',
      as: 'metric',
      title: 'Revenue',
      label: 'Revenue',
      format: 'currency',
      query: { measures: ['Payments.revenue'] },
    },
    {
      type: 'bound',
      as: 'table',
      title: 'Payments by rating',
      query: {
        measures: ['Payments.revenue', 'Payments.count'],
        dimensions: ['Payments.rating'],
      },
    },
    {
      type: 'bound',
      as: 'table',
      title: 'Rentals by store',
      query: { measures: ['Rentals.count'], dimensions: ['Rentals.store'] },
    },
  ],
}

function Canvas({ initial }: { initial: Report }) {
  const [report, setReport] = useState(initial)
  return (
    <ReportCanvas
      report={report}
      onChange={setReport}
      runQuery={mockRunQuery(120)}
      cubeCaps={MOCK_CAPS}
    />
  )
}

/** Clean state — click a rating or a store to drill; click a measure to open
 *  the records drawer. */
export const InteractiveDrillDown = {
  render: () => <Canvas initial={baseReport} />,
}

/** Mid-flow: two drill steps applied. Every widget whose cube shares the
 *  dimension is filtered in place; the breadcrumb pops back. */
export const DrilledTwoStepsWithBreadcrumb = {
  render: () => (
    <Canvas
      initial={{
        ...baseReport,
        drill: [
          { member: 'Payments.store', value: 'Store 1', label: 'Store 1' },
          { member: 'Payments.rating', value: 'PG-13', label: 'PG-13' },
        ],
      }}
    />
  ),
}

/** The breadcrumb alone — `All ▸ store: Store 1 ▸ rating: PG-13`, earlier
 *  segments poppable, the last one is the current scope. */
export const BreadcrumbTrail = {
  render: () => {
    const [trail, setTrail] = useState<DrillTrail>([
      { member: 'Payments.store', value: 'Store 1', label: 'Store 1' },
      { member: 'Payments.rating', value: 'PG-13', label: 'PG-13' },
    ])
    return <DrillBreadcrumb trail={trail} onPop={(n) => setTrail(trail.slice(0, n))} />
  },
}
