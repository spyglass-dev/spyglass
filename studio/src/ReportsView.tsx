/** Server reports — list the bound reports saved on spyglass-server, run one
 *  (resolving its queries under the chosen scope), and render it live. */
import { useEffect, useState } from 'react'
import { ReportView, type ReportDoc, type WidgetRegistry } from '@spyglass/ui'
import { server, scopeForWorkspace, type ModelMeta, type ReportSummary } from './server'
import { S } from './theme'

const registry: WidgetRegistry = {}

export function ReportsView({ meta, scopeValue }: { meta: ModelMeta | null; scopeValue: string }) {
  const [list, setList] = useState<ReportSummary[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [doc, setDoc] = useState<ReportDoc | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = () => server.listReports().then(setList).catch((e) => setError(String(e)))
  useEffect(() => { void refresh() }, [])

  const run = async (id: string) => {
    setActive(id); setError(null); setDoc(null)
    try {
      setDoc(await server.runReport(id, scopeForWorkspace(meta, scopeValue)))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 18 }}>
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={S.label}>Reports</div>
          <button style={{ ...S.btn, padding: '2px 8px' }} onClick={() => void refresh()}>↻</button>
        </div>
        {list.length === 0 && <div style={S.muted}>No server reports. Build some with the distri reporter agent.</div>}
        {list.map((r) => (
          <button
            key={r.id}
            onClick={() => void run(r.id)}
            style={{ ...S.btn, width: '100%', textAlign: 'left', marginBottom: 6, ...(active === r.id ? { borderColor: '#6366f1', background: '#eef2ff' } : {}) }}
          >
            {r.title}
          </button>
        ))}
      </div>
      <div>
        {error && <div style={S.err}>{error}</div>}
        {doc ? <ReportView doc={doc} registry={registry} /> : !error && <div style={S.muted}>Pick a report to run it.</div>}
      </div>
    </div>
  )
}
