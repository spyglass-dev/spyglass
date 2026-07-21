/** Server reports — list the bound reports saved on spyglass-server, run one
 *  (resolving its queries under the chosen scope + filter bar), and render it
 *  live. */
import { useEffect, useMemo, useState } from 'react'
import { ReportView, type ReportDoc, type WidgetRegistry } from '@spyglass/ui'
import {
  server,
  scopeForWorkspace,
  type ModelMeta,
  type ReportSummary,
  type BoundReportTemplate,
  type QueryFilter,
} from './server'
import { FilterBar, type FilterableDim } from './FilterBar'
import { S } from './theme'

const registry: WidgetRegistry = {}

/** Cubes referenced anywhere in a report template's widget queries. */
function cubesUsed(tpl: BoundReportTemplate): Set<string> {
  const cubes = new Set<string>()
  const add = (m?: string) => { const c = m?.split('.')[0]; if (c) cubes.add(c) }
  for (const w of tpl.widgets ?? []) {
    w.query?.measures?.forEach(add)
    w.query?.dimensions?.forEach(add)
    w.query?.timeDimensions?.forEach((t) => add(t.dimension))
    w.query?.filters?.forEach((f) => add(f.member))
  }
  return cubes
}

/** Non-tenant dimensions of the report's cubes — what the filter bar offers. */
function filterableDims(tpl: BoundReportTemplate | null, meta: ModelMeta | null): FilterableDim[] {
  if (!tpl || !meta) return []
  const cubes = cubesUsed(tpl)
  const seen = new Set<string>()
  const dims: FilterableDim[] = []
  for (const cube of meta.cubes) {
    if (!cubes.has(cube.name)) continue
    for (const d of cube.dimensions) {
      if (d.tenant || seen.has(d.member)) continue
      seen.add(d.member)
      dims.push({ member: d.member, name: `${cube.name}.${d.name}`, type: d.type as FilterableDim['type'] })
    }
  }
  return dims
}

export function ReportsView({ meta, scopeValue }: { meta: ModelMeta | null; scopeValue: string }) {
  const [list, setList] = useState<ReportSummary[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [doc, setDoc] = useState<ReportDoc | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [template, setTemplate] = useState<BoundReportTemplate | null>(null)
  const [filters, setFilters] = useState<QueryFilter[]>([])

  const refresh = () => server.listReports().then(setList).catch((e) => setError(String(e)))
  useEffect(() => { void refresh() }, [])

  const dims = useMemo(() => filterableDims(template, meta), [template, meta])

  const run = async (id: string, activeFilters: QueryFilter[]) => {
    setError(null); setDoc(null)
    try {
      setDoc(await server.runReport(id, scopeForWorkspace(meta, scopeValue), activeFilters))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const select = async (id: string) => {
    setActive(id); setFilters([]); setTemplate(null)
    try { setTemplate(await server.getReport(id)) } catch { /* template optional for filters */ }
    await run(id, [])
  }

  const applyFilters = (f: QueryFilter[]) => { setFilters(f); if (active) void run(active, f) }

  // Re-run when the header scope changes for the open report.
  useEffect(() => { if (active) void run(active, filters) }, [scopeValue]) // eslint-disable-line react-hooks/exhaustive-deps

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
            onClick={() => void select(r.id)}
            style={{ ...S.btn, width: '100%', textAlign: 'left', marginBottom: 6, ...(active === r.id ? { borderColor: '#6366f1', background: '#eef2ff' } : {}) }}
          >
            {r.title}
          </button>
        ))}
      </div>
      <div>
        {active && <FilterBar dims={dims} onApply={applyFilters} />}
        {error && <div style={S.err}>{error}</div>}
        {doc ? <ReportView doc={doc} registry={registry} /> : !error && <div style={S.muted}>Pick a report to run it.</div>}
      </div>
    </div>
  )
}
