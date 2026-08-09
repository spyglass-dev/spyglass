/**
 * Bound-view stories — named for the STATE each one shows. The sample
 * "leaderboard" view is a host component bound to a query: it receives the
 * report filters and the drill callback (it participates in the system), and
 * its manifest's contract gates the data — unmet renders widget_error, never
 * a blank cell.
 */
import { useState } from 'react'
import { ReportCanvas } from './components/ReportCanvas'
import { registerView, type ViewProps, type ViewRegistry } from './views'
import { MOCK_CAPS, mockRunQuery } from './samples/mockEngine'
import { tokens } from './tokens'
import { formatValue } from './types'
import type { Report } from './report'

const meta = { title: 'Reporting/Views' }
export default meta

/** A host view: top rows as a ranked list with bars, drillable rows. */
function Leaderboard({ rows, columns, drill, props }: ViewProps) {
  const p = (props ?? {}) as { measure?: string; label?: string }
  const measureKey = p.measure ?? columns.find((c) => c.kind === 'measure')?.key ?? ''
  const labelKey = columns.find((c) => c.kind !== 'measure')?.key ?? ''
  const max = Math.max(1, ...rows.map((r) => (typeof r[measureKey] === 'number' ? (r[measureKey] as number) : 0)))
  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 10, background: tokens.bg, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {rows.map((row, i) => {
        const value = typeof row[measureKey] === 'number' ? (row[measureKey] as number) : 0
        return (
          <button
            key={i}
            type="button"
            onClick={() => drill({ member: labelKey, value: (row[labelKey] ?? null) as string | null })}
            style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 10 }}
          >
            <span style={{ width: 18, fontSize: 12, fontWeight: 700, color: tokens.textFaint }}>{i + 1}</span>
            <span style={{ width: 90, fontSize: 13, color: tokens.text }}>{String(row[labelKey] ?? '—')}</span>
            <span style={{ flex: 1, height: 8, borderRadius: 4, background: tokens.muted, overflow: 'hidden' }}>
              <span style={{ display: 'block', height: '100%', width: `${(value / max) * 100}%`, background: tokens.accent, opacity: 0.75 }} />
            </span>
            <span style={{ width: 70, textAlign: 'right', fontSize: 12, fontWeight: 600, color: tokens.text }}>
              {formatValue(value, 'currency')}
            </span>
          </button>
        )
      })}
      {rows.length === 0 && <span style={{ fontSize: 13, color: tokens.textFaint }}>No data.</span>}
    </div>
  )
}

const VIEWS: ViewRegistry = registerView(
  {},
  {
    name: 'leaderboard',
    title: 'Leaderboard',
    description: 'Ranks the first dimension by the first measure, with bars. Rows drill.',
    contract: { requires: ['Payments.rating'] },
    propsSchema: { type: 'object', properties: { measure: { type: 'string' } } },
    component: Leaderboard,
  },
)

function Canvas({ initial }: { initial: Report }) {
  const [report, setReport] = useState(initial)
  return (
    <ReportCanvas report={report} onChange={setReport} runQuery={mockRunQuery(120)} cubeCaps={MOCK_CAPS} views={VIEWS} />
  )
}

/** A live host view beside an ordinary table — same filters, same drill. */
export const LiveViewWithDrill = {
  render: () => (
    <Canvas
      initial={{
        title: 'Ratings',
        widgets: [
          {
            type: 'view',
            component: 'leaderboard',
            title: 'Revenue leaderboard',
            w: 2,
            query: { measures: ['Payments.revenue'], dimensions: ['Payments.rating'] },
          },
          {
            type: 'bound',
            as: 'table',
            title: 'Same query as a table',
            w: 2,
            query: { measures: ['Payments.revenue'], dimensions: ['Payments.rating'] },
          },
        ],
      }}
    />
  ),
}

/** The manifest's contract unmet — widget_error, never a blank cell. */
export const UnmetContractRendersError = {
  render: () => (
    <Canvas
      initial={{
        title: 'Broken on purpose',
        widgets: [
          {
            type: 'view',
            component: 'leaderboard',
            title: 'Missing the required dimension',
            query: { measures: ['Payments.revenue'] },
          },
        ],
      }}
    />
  ),
}

/** A component nobody registered. */
export const UnknownViewRendersError = {
  render: () => (
    <Canvas
      initial={{
        title: 'Unknown view',
        widgets: [{ type: 'view', component: 'crystal_ball', title: 'Not registered' }],
      }}
    />
  ),
}
