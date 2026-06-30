/**
 * Reporting Studio — the Spyglass UI. Browse the cube catalog, build queries,
 * run server-side reports, and edit report JSON with a live preview. Talks to
 * spyglass-server (`/meta`, `/query`, `/reports`). In dev it calls through the
 * Vite `/api` proxy; built + embedded into the server it's same-origin.
 */
import { useEffect, useMemo, useState } from 'react'
import { ReportView, type ReportDoc, type WidgetRegistry, type WidgetSpec } from '@spyglass/ui'
import { reportsDb, type StoredReport } from './idb'
import { server, type ModelMeta } from './server'
import { CubesView } from './CubesView'
import { QueryBuilder } from './QueryBuilder'
import { ReportsView } from './ReportsView'
import { S } from './theme'

const STARTER: ReportDoc = {
  title: 'New report',
  widgets: [
    { type: 'metric', value: 0, label: 'Metric', w: 1 },
    { type: 'note', markdown: 'Edit the JSON on the left — the report renders live here.' },
  ],
}
const registry: WidgetRegistry = {}
const uid = () => `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`

type Tab = 'cubes' | 'build' | 'reports' | 'editor'

export function App() {
  const [tab, setTab] = useState<Tab>('cubes')
  const [meta, setMeta] = useState<ModelMeta | null>(null)
  const [scope, setScope] = useState('') // tenant value applied to every cube's tenant dim

  // Editor state (local IndexedDB reports).
  const [id, setId] = useState<string>(() => uid())
  const [text, setText] = useState<string>(() => JSON.stringify(STARTER, null, 2))
  const [list, setList] = useState<StoredReport[]>([])

  useEffect(() => {
    server.meta().then(setMeta).catch(() => setMeta(null))
    void reportsDb.list().then(setList)
  }, [])

  const tenantNames = useMemo(() => {
    const names = new Set<string>()
    meta?.cubes.forEach((c) => c.dimensions.forEach((d) => d.tenant && names.add(d.name)))
    return [...names]
  }, [meta])

  const doc = useMemo<ReportDoc | null>(() => {
    try { return JSON.parse(text) as ReportDoc } catch { return null }
  }, [text])

  const addWidget = (spec: WidgetSpec) => {
    try {
      const parsed = JSON.parse(text) as ReportDoc
      parsed.widgets = [...(parsed.widgets ?? []), spec]
      setText(JSON.stringify(parsed, null, 2))
      setTab('editor')
    } catch { /* invalid JSON — ignore */ }
  }
  const saveLocal = async () => { if (doc) { await reportsDb.put({ id, doc, updated_at: Date.now() }); setList(await reportsDb.list()) } }
  const loadLocal = async (rid: string) => { const r = await reportsDb.get(rid); if (r) { setId(r.id); setText(JSON.stringify(r.doc, null, 2)) } }
  const exportJson = () => {
    const blob = new Blob([text], { type: 'application/json' })
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
    a.download = `${doc?.title?.replace(/[^\w-]+/g, '-').toLowerCase() || 'report'}.json`; a.click(); URL.revokeObjectURL(a.href)
  }

  const TabBtn = ({ id: t, label }: { id: Tab; label: string }) => (
    <button onClick={() => setTab(t)} style={{ background: 'none', border: 'none', padding: '10px 14px', cursor: 'pointer', color: tab === t ? '#111827' : '#6b7280', borderBottom: `2px solid ${tab === t ? '#6366f1' : 'transparent'}`, fontWeight: tab === t ? 600 : 400 }}>{label}</button>
  )

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', height: '100vh', display: 'flex', flexDirection: 'column', color: '#111827' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <strong style={{ fontSize: 16 }}>🔭 Spyglass Studio</strong>
        <span style={S.muted}>{meta ? `${meta.cubes.length} cubes` : 'connecting…'}</span>
        <span style={{ flex: 1 }} />
        <label style={{ ...S.muted, display: 'flex', alignItems: 'center', gap: 6 }} title={tenantNames.length ? `applied to: ${tenantNames.join(', ')}` : 'tenant scope'}>
          scope{tenantNames.length ? ` (${tenantNames.join(', ')})` : ''}
          <input value={scope} onChange={(e) => setScope(e.target.value)} placeholder="all" style={{ ...S.input, width: 120 }} />
        </label>
      </header>

      <div style={{ display: 'flex', borderBottom: '1px solid #e5e7eb', padding: '0 10px' }}>
        <TabBtn id="cubes" label="Cubes" />
        <TabBtn id="build" label="Build query" />
        <TabBtn id="reports" label="Reports" />
        <TabBtn id="editor" label="Editor" />
      </div>

      <main style={{ flex: 1, overflow: 'auto', padding: 20, background: '#fafafa' }}>
        {tab === 'cubes' && <CubesView meta={meta} />}
        {tab === 'build' && <QueryBuilder meta={meta} scopeValue={scope} onAddWidget={addWidget} />}
        {tab === 'reports' && <ReportsView meta={meta} scopeValue={scope} />}
        {tab === 'editor' && (
          <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', gap: 16, height: '100%' }}>
            <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
                <button style={S.btn} onClick={() => { setId(uid()); setText(JSON.stringify(STARTER, null, 2)) }}>New</button>
                <button style={S.btn} onClick={saveLocal} disabled={!doc}>Save</button>
                <button style={S.btn} onClick={exportJson} disabled={!doc}>Export</button>
                <select style={{ ...S.input, marginLeft: 'auto' }} value={id} onChange={(e) => void loadLocal(e.target.value)}>
                  <option value={id}>— current —</option>
                  {list.map((r) => <option key={r.id} value={r.id}>{r.doc.title || r.id}</option>)}
                </select>
              </div>
              <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
                style={{ flex: 1, fontFamily: 'ui-monospace, monospace', fontSize: 12, padding: 12, border: '1px solid #e5e7eb', borderRadius: 8, resize: 'none' }} />
              {!doc && <div style={{ ...S.err, marginTop: 6 }}>Invalid JSON</div>}
            </div>
            <div style={{ overflow: 'auto' }}>
              {doc ? <ReportView doc={doc} registry={registry} /> : <div style={S.muted}>Fix the JSON to preview.</div>}
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
