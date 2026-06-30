/**
 * QueryPanel — run a Cube-shaped query against a reporting endpoint and turn
 * the result into a widget you can drop into the report. Standalone-friendly:
 * point it at the `reporting-server` (`POST /query`) or any host endpoint that
 * speaks the same contract.
 */
import { useState } from 'react'
import { Widget, type WidgetSpec, type TableColumn } from '@spyglass/ui'

interface QueryResult {
  columns: { key: string; kind: string }[]
  rows: Record<string, unknown>[]
  sql?: string
}

const STARTER_QUERY = JSON.stringify(
  {
    query: { measures: ['Submissions.count'], dimensions: ['Submissions.status'] },
    scope: { 'Submissions.workspace_id': 'demo-workspace' },
  },
  null,
  2,
)

/** Turn a query result into a table widget spec. */
function resultToTable(result: QueryResult): WidgetSpec {
  const columns: TableColumn[] = result.columns.map((c) => ({
    key: c.key,
    label: c.key.split('.').pop() ?? c.key,
    align: c.kind === 'measure' ? 'right' : 'left',
  }))
  return { type: 'table', title: 'Query result', columns, rows: result.rows }
}

export function QueryPanel({
  onAddWidget,
}: {
  onAddWidget?: (spec: WidgetSpec) => void
}) {
  const [endpoint, setEndpoint] = useState('http://127.0.0.1:8088/query')
  const [body, setBody] = useState(STARTER_QUERY)
  const [result, setResult] = useState<QueryResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const run = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      })
      const json = (await res.json()) as QueryResult & { error?: string }
      if (!res.ok || json.error) throw new Error(json.error || `HTTP ${res.status}`)
      setResult(json)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  const widget = result ? resultToTable(result) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8, minHeight: 0 }}>
      <input
        value={endpoint}
        onChange={(e) => setEndpoint(e.target.value)}
        placeholder="Reporting endpoint"
        style={{ fontFamily: 'monospace', fontSize: 12, padding: 6, border: '1px solid #e5e7eb', borderRadius: 6 }}
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        spellCheck={false}
        rows={8}
        style={{ fontFamily: 'monospace', fontSize: 12, padding: 8, border: '1px solid #e5e7eb', borderRadius: 6, resize: 'vertical' }}
      />
      <div style={{ display: 'flex', gap: 8 }}>
        <button onClick={run} disabled={loading}>
          {loading ? 'Running…' : 'Run query'}
        </button>
        {widget && onAddWidget && (
          <button onClick={() => onAddWidget(widget)}>Add result to report</button>
        )}
      </div>
      {error && <div style={{ color: '#e11d48', fontSize: 12 }}>{error}</div>}
      {widget && (
        <div style={{ marginTop: 4 }}>
          <Widget spec={widget} />
          {result?.sql && (
            <pre style={{ fontSize: 11, color: '#6b7280', whiteSpace: 'pre-wrap', marginTop: 8 }}>{result.sql}</pre>
          )}
        </div>
      )}
    </div>
  )
}
