/** Point-and-click query builder: pick a cube + measures/dimensions, run it
 *  against /query (scoped by the header value), and render the result. */
import { useMemo, useState } from 'react'
import { Widget, type WidgetSpec, type TableColumn } from '@spyglass/ui'
import { server, type ModelMeta } from './server'
import { S } from './theme'

interface QueryResult {
  columns: { key: string; kind: string }[]
  rows: Record<string, unknown>[]
  sql?: string
}

function resultToTable(result: QueryResult): WidgetSpec {
  const columns: TableColumn[] = result.columns.map((c) => ({
    key: c.key,
    label: c.key.split('.').pop() ?? c.key,
    align: c.kind === 'measure' ? 'right' : 'left',
  }))
  return { type: 'table', title: 'Query result', columns, rows: result.rows }
}

export function QueryBuilder({
  meta,
  scopeValue,
  onAddWidget,
}: {
  meta: ModelMeta | null
  scopeValue: string
  onAddWidget?: (spec: WidgetSpec) => void
}) {
  const cubes = meta?.cubes ?? []
  const [cubeName, setCubeName] = useState('')
  const [measures, setMeasures] = useState<Set<string>>(new Set())
  const [dimensions, setDimensions] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const cube = useMemo(() => cubes.find((c) => c.name === cubeName) ?? cubes[0], [cubes, cubeName])
  const tenant = cube?.dimensions.find((d) => d.tenant)

  const toggle = (set: Set<string>, key: string, setter: (s: Set<string>) => void) => {
    const next = new Set(set)
    next.has(key) ? next.delete(key) : next.add(key)
    setter(next)
  }

  const run = async () => {
    if (!cube) return
    setError(null)
    setResult(null)
    const scope: Record<string, string> = {}
    if (tenant && scopeValue.trim()) scope[tenant.member] = scopeValue.trim()
    try {
      const res = (await server.query({
        query: { measures: [...measures], dimensions: [...dimensions] },
        scope,
      })) as QueryResult
      setResult(res)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  if (!cube) return <div style={S.muted}>Loading cubes…</div>
  const widget = result ? resultToTable(result) : null

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 18 }}>
      <div style={S.card}>
        <div style={S.label}>Cube</div>
        <select
          value={cube.name}
          onChange={(e) => { setCubeName(e.target.value); setMeasures(new Set()); setDimensions(new Set()); setResult(null) }}
          style={{ ...S.input, width: '100%' }}
        >
          {cubes.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </select>

        <div style={S.label}>Measures</div>
        {cube.measures.map((m) => (
          <label key={m.member} style={S.chk}>
            <input type="checkbox" checked={measures.has(m.member)} onChange={() => toggle(measures, m.member, setMeasures)} /> {m.name}
          </label>
        ))}
        <div style={S.label}>Dimensions</div>
        {cube.dimensions.map((d) => (
          <label key={d.member} style={S.chk}>
            <input type="checkbox" checked={dimensions.has(d.member)} onChange={() => toggle(dimensions, d.member, setDimensions)} /> {d.name}{d.tenant ? ' 🔒' : ''}
          </label>
        ))}
        <button style={{ ...S.btnPrimary, width: '100%', marginTop: 10 }} onClick={run}>Run query</button>
        {tenant && (
          <div style={{ ...S.muted, marginTop: 8 }}>
            scope: <code>{tenant.name}</code> = {scopeValue.trim() ? <code>{scopeValue.trim()}</code> : <em>(none)</em>}
          </div>
        )}
      </div>

      <div>
        {error && <div style={S.err}>{error}</div>}
        {widget ? (
          <>
            <Widget spec={widget} />
            {onAddWidget && <button style={{ ...S.btn, marginTop: 10 }} onClick={() => onAddWidget(widget)}>Add result to report</button>}
            {result?.sql && <pre style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'pre-wrap', marginTop: 10 }}>{result.sql}</pre>}
          </>
        ) : (
          !error && <div style={S.muted}>Pick measures/dimensions and run.</div>
        )}
      </div>
    </div>
  )
}
