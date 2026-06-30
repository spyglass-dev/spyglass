/**
 * Reporting Studio (shell) — edit a report's JSON on the left, see the live
 * render on the right. Reports persist in IndexedDB; export/import as JSON.
 *
 * Next iteration (task 5 remainder): an agent editor (same skills as Zippy)
 * that writes/updates the report doc inline, and a query panel that calls the
 * reporting engine's `POST /query`. The widget set + custom-component registry
 * are already shared via @spyglass/ui.
 */
import { useEffect, useMemo, useState } from 'react'
import { ReportView, type ReportDoc, type WidgetRegistry, type WidgetSpec } from '@spyglass/ui'
import { reportsDb, type StoredReport } from './idb'
import { QueryPanel } from './QueryPanel'

const STARTER: ReportDoc = {
  title: 'New report',
  widgets: [
    { type: 'metric', value: 0, label: 'To grade', w: 1 },
    { type: 'note', markdown: 'Edit the JSON on the left — the report renders live here.' },
  ],
}

// Hosts (e.g. Zippy) register custom widgets here; empty in the standalone studio.
const registry: WidgetRegistry = {}

function uid() {
  return `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export function App() {
  const [id, setId] = useState<string>(() => uid())
  const [text, setText] = useState<string>(() => JSON.stringify(STARTER, null, 2))
  const [list, setList] = useState<StoredReport[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'edit' | 'query'>('edit')

  // Append a widget (e.g. a query result) to the current report doc.
  const addWidget = (spec: WidgetSpec) => {
    try {
      const parsed = JSON.parse(text) as ReportDoc
      parsed.widgets = [...(parsed.widgets ?? []), spec]
      setText(JSON.stringify(parsed, null, 2))
      setTab('edit')
    } catch {
      /* invalid JSON — ignore until fixed */
    }
  }

  const doc = useMemo<ReportDoc | null>(() => {
    try {
      const parsed = JSON.parse(text) as ReportDoc
      return parsed
    } catch (e) {
      return null
    }
  }, [text])

  useEffect(() => {
    setError(doc ? null : 'Invalid JSON')
  }, [doc])

  const refreshList = () => reportsDb.list().then(setList)
  useEffect(() => {
    void refreshList()
  }, [])

  const save = async () => {
    if (!doc) return
    await reportsDb.put({ id, doc, updated_at: Date.now() })
    await refreshList()
  }

  const load = async (rid: string) => {
    const r = await reportsDb.get(rid)
    if (r) {
      setId(r.id)
      setText(JSON.stringify(r.doc, null, 2))
    }
  }

  const newReport = () => {
    setId(uid())
    setText(JSON.stringify(STARTER, null, 2))
  }

  const exportJson = () => {
    const blob = new Blob([text], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${doc?.title?.replace(/[^\w-]+/g, '-').toLowerCase() || 'report'}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  const importJson = (file: File) => {
    file.text().then((t) => {
      setText(t)
      setId(uid())
    })
  }

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 16px', borderBottom: '1px solid #e5e7eb' }}>
        <strong style={{ marginRight: 'auto' }}>Reporting Studio</strong>
        <button onClick={newReport}>New</button>
        <button onClick={save} disabled={!doc}>Save</button>
        <button onClick={exportJson} disabled={!doc}>Export</button>
        <label style={{ cursor: 'pointer', border: '1px solid #e5e7eb', borderRadius: 6, padding: '2px 8px' }}>
          Import
          <input
            type="file"
            accept="application/json"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && importJson(e.target.files[0])}
          />
        </label>
      </header>
      <div style={{ display: 'grid', gridTemplateColumns: '380px 1fr', flex: 1, minHeight: 0 }}>
        <div style={{ display: 'flex', flexDirection: 'column', borderRight: '1px solid #e5e7eb', minHeight: 0 }}>
          <div style={{ display: 'flex', gap: 4, padding: 8, borderBottom: '1px solid #f1f5f9' }}>
            <button onClick={() => setTab('edit')} style={{ fontWeight: tab === 'edit' ? 700 : 400 }}>Edit</button>
            <button onClick={() => setTab('query')} style={{ fontWeight: tab === 'query' ? 700 : 400 }}>Query</button>
            <select value={id} onChange={(e) => load(e.target.value)} style={{ marginLeft: 'auto' }}>
              <option value={id}>— current ({id.slice(0, 16)}) —</option>
              {list.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.doc.title || r.id}
                </option>
              ))}
            </select>
          </div>
          {tab === 'edit' ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                spellCheck={false}
                style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, padding: 12, border: 'none', outline: 'none', resize: 'none' }}
              />
              {error && <div style={{ color: '#e11d48', padding: 8, fontSize: 12 }}>{error}</div>}
            </>
          ) : (
            <div style={{ overflow: 'auto', minHeight: 0 }}>
              <QueryPanel onAddWidget={addWidget} />
            </div>
          )}
        </div>
        <div style={{ overflow: 'auto', padding: 24, background: '#fafafa' }}>
          {doc ? <ReportView doc={doc} registry={registry} /> : <div style={{ color: '#9ca3af' }}>Fix the JSON to preview.</div>}
        </div>
      </div>
    </div>
  )
}
