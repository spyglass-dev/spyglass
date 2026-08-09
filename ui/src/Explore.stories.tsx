/**
 * Explore stories — the workbench (ask bar + catalog + chips + auto-viz +
 * Explain). The ask handler here is a toy keyword matcher standing in for a
 * real agent: it returns a draft, and from then on the CHIPS edit that same
 * object — which is the whole point.
 */
import { Explore } from './components/Explore'
import { MOCK_META, mockRunQuery } from './samples/mockEngine'
import type { WidgetDraft } from './querybuilder'

const meta = {
  title: 'Reporting/Explore',
  component: Explore,
}
export default meta

/** A stand-in agent: match member names mentioned in the ask. */
async function toyAsk(prompt: string): Promise<WidgetDraft | null> {
  const p = prompt.toLowerCase()
  const measures: string[] = []
  const dimensions: string[] = []
  for (const cube of MOCK_META.cubes) {
    for (const m of cube.measures) if (p.includes(m.name)) measures.push(m.member)
    for (const d of cube.dimensions) if (d.type !== 'time' && p.includes(d.name)) dimensions.push(d.member)
  }
  if (!measures.length && !dimensions.length) return null
  return { as: 'table', query: { measures, dimensions, filters: [] } }
}

export const EmptyWorkbench = {
  render: () => <Explore meta={MOCK_META} runQuery={mockRunQuery(120)} onAsk={toyAsk} onSave={() => {}} />,
}

export const QueryWithChipsAndExplain = {
  render: () => (
    <Explore
      meta={MOCK_META}
      runQuery={mockRunQuery(120)}
      onAsk={toyAsk}
      onSave={() => {}}
      initial={{
        as: 'chart',
        mark: 'bar',
        query: {
          measures: ['Payments.revenue'],
          dimensions: ['Payments.rating'],
          filters: [{ member: 'Payments.store', operator: 'equals', values: ['Store 1'] }],
          limit: 25,
        },
      }}
    />
  ),
}

export const ValidationErrorWithSuggestions = {
  render: () => (
    <Explore
      meta={MOCK_META}
      runQuery={mockRunQuery(120)}
      initial={{ as: 'metric', query: { measures: ['Payments.revenu'], filters: [] } }}
    />
  ),
}
