/** `?smoke` — run representative queries through the browser engine and show
 *  pass/fail. The quickest way to see the compiler's SQL working on DuckDB. */
import { useEffect, useState } from 'react'
import type { WidgetQuery } from '@spyglassjs/ui'
import type { BrowserEngine } from './engine/browserEngine'

const CASES: [string, WidgetQuery][] = [
  ['revenue by month, last 12 months', { measures: ['Orders.revenue', 'Orders.count'], timeDimensions: [{ dimension: 'Orders.ordered_at', granularity: 'month', dateRange: 'last 12 months' }], order: [{ member: 'Orders.ordered_at' }] }],
  ['orders by region, total', { measures: ['Orders.count', 'Orders.aov'], dimensions: ['Orders.region'], order: [{ member: 'Orders.count', desc: true }], includeTotal: true }],
  ['revenue vs previous 30 days', { measures: ['Orders.revenue', 'Orders.margin'], timeDimensions: [{ dimension: 'Orders.ordered_at', dateRange: 'last 30 days', compare: 'previous_period' }] }],
  ['conversion by day, gaps filled', { measures: ['Traffic.conversion_rate'], timeDimensions: [{ dimension: 'Traffic.day', granularity: 'day', dateRange: 'last 14 days', fill_gaps: true } as never] }],
  ['weekly revenue vs last year', { measures: ['Orders.revenue'], timeDimensions: [{ dimension: 'Orders.ordered_at', granularity: 'week', dateRange: 'last 8 weeks', compare: 'previous_year' }] }],
  ['records in Europe', { mode: 'rows', dimensions: ['Orders.id', 'Orders.customer_id', 'Orders.ordered_at', 'Orders.revenue_value'], filters: [{ member: 'Orders.region', operator: 'equals', values: ['Europe'] }], limit: 5 } as WidgetQuery],
  ['revenue by category x channel', { measures: ['OrderItems.revenue', 'OrderItems.margin'], dimensions: ['OrderItems.category', 'OrderItems.channel'], order: [{ member: 'OrderItems.revenue', desc: true }], limit: 8 }],
  ['top customers (labelled)', { measures: ['Orders.revenue'], dimensions: ['Orders.customer_id'], order: [{ member: 'Orders.revenue', desc: true }], limit: 5 }],
  ['traffic under a report date range', { measures: ['Traffic.conversion_rate'], dimensions: ['Traffic.channel'], filters: [{ member: 'Traffic.day', operator: 'gte', values: [new Date(Date.now() - 30 * 864e5).toISOString()] }, { member: 'Traffic.day', operator: 'lt', values: [new Date().toISOString()] }] }],
  ['traffic metric compare + range', { measures: ['Traffic.conversion_rate'], timeDimensions: [{ dimension: 'Traffic.day', dateRange: [new Date(Date.now() - 30 * 864e5).toISOString(), new Date().toISOString()], compare: 'previous_period' }] }],
  ['traffic trend by day in range', { measures: ['Traffic.conversion_rate'], timeDimensions: [{ dimension: 'Traffic.day', granularity: 'day', dateRange: [new Date(Date.now() - 30 * 864e5).toISOString(), new Date().toISOString()] }], order: [{ member: 'Traffic.day' }] }],
  ['orders under a report date range', { measures: ['Orders.revenue'], filters: [{ member: 'Orders.ordered_at', operator: 'gte', values: [new Date(Date.now() - 30 * 864e5).toISOString()] }, { member: 'Orders.ordered_at', operator: 'lt', values: [new Date().toISOString()] }] }],
  ['contains filter', { measures: ['OrderItems.units'], dimensions: ['OrderItems.product'], filters: [{ member: 'OrderItems.product', operator: 'contains', values: ['tent'] }] }],
]

export function Smoke({ engine }: { engine: BrowserEngine }) {
  const [results, setResults] = useState<{ name: string; ok: boolean; detail: string; ms: number }[]>([])
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const out: { name: string; ok: boolean; detail: string; ms: number }[] = []
      for (const [name, query] of CASES) {
        const t0 = performance.now()
        try {
          const r = await engine.runQuery(query)
          out.push({ name, ok: true, ms: performance.now() - t0, detail: `${r.rows.length} rows${r.total != null ? ` / total ${r.total}` : ''} · ${JSON.stringify(r.rows.slice(0, 2))}` })
        } catch (e) {
          out.push({ name, ok: false, ms: performance.now() - t0, detail: e instanceof Error ? e.message : String(e) })
        }
        if (!cancelled) setResults([...out])
      }
      try {
        const v = await engine.values('Orders.region')
        out.push({ name: 'values(Orders.region)', ok: true, ms: 0, detail: JSON.stringify(v) })
      } catch (e) {
        out.push({ name: 'values(Orders.region)', ok: false, ms: 0, detail: e instanceof Error ? e.message : String(e) })
      }
      if (!cancelled) setResults([...out])
    })()
    return () => {
      cancelled = true
    }
  }, [engine])
  const done = results.length === CASES.length + 1
  return (
    <div style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: 16 }}>
      <h1 data-smoke-done={done ? 'yes' : 'no'}>smoke {results.filter((r) => r.ok).length}/{CASES.length + 1}</h1>
      {results.map((r) => (
        <div key={r.name} data-ok={r.ok} style={{ margin: '6px 0', color: r.ok ? '#065f46' : '#b91c1c' }}>
          {r.ok ? 'PASS' : 'FAIL'} {r.name} ({r.ms.toFixed(0)}ms) — {r.detail.slice(0, 400)}
        </div>
      ))}
    </div>
  )
}
