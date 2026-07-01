/** A report filter bar. Given the filterable dimensions of the report's cubes,
 *  it renders one control per dimension (by type) and emits `QueryFilter[]` that
 *  the caller passes to `/reports/{id}/run`. Tenant dimensions are excluded —
 *  those are driven by the scope input in the header. */
import { useState } from 'react'
import type { QueryFilter } from './server'
import { S } from './theme'

export interface FilterableDim {
  member: string
  name: string
  type: 'string' | 'number' | 'time' | 'boolean'
}

/** Per-member draft value(s). Time carries a from/to pair. */
type Draft = Record<string, { v?: string; from?: string; to?: string }>

function buildFilters(dims: FilterableDim[], draft: Draft): QueryFilter[] {
  const out: QueryFilter[] = []
  for (const d of dims) {
    const s = draft[d.member]
    if (!s) continue
    if (d.type === 'time') {
      if (s.from) out.push({ member: d.member, operator: 'gte', values: [s.from] })
      if (s.to) out.push({ member: d.member, operator: 'lt', values: [s.to] })
      continue
    }
    const v = s.v?.trim()
    if (!v) continue
    if (d.type === 'boolean') out.push({ member: d.member, operator: 'equals', values: [v === 'true'] })
    else if (d.type === 'number' && !Number.isNaN(Number(v))) out.push({ member: d.member, operator: 'equals', values: [Number(v)] })
    else out.push({ member: d.member, operator: 'contains', values: [v] })
  }
  return out
}

export function FilterBar({ dims, onApply }: { dims: FilterableDim[]; onApply: (f: QueryFilter[]) => void }) {
  const [draft, setDraft] = useState<Draft>({})
  if (dims.length === 0) return null

  const set = (member: string, patch: { v?: string; from?: string; to?: string }) =>
    setDraft((d) => ({ ...d, [member]: { ...d[member], ...patch } }))

  const control = (d: FilterableDim) => {
    const s = draft[d.member] ?? {}
    if (d.type === 'time') {
      return (
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
          <input type="date" value={s.from ?? ''} onChange={(e) => set(d.member, { from: e.target.value })} style={{ ...S.input, width: 130 }} />
          <span style={S.muted}>→</span>
          <input type="date" value={s.to ?? ''} onChange={(e) => set(d.member, { to: e.target.value })} style={{ ...S.input, width: 130 }} />
        </span>
      )
    }
    if (d.type === 'boolean') {
      return (
        <select value={s.v ?? ''} onChange={(e) => set(d.member, { v: e.target.value })} style={{ ...S.input, width: 110 }}>
          <option value="">any</option>
          <option value="true">true</option>
          <option value="false">false</option>
        </select>
      )
    }
    return (
      <input
        value={s.v ?? ''}
        onChange={(e) => set(d.member, { v: e.target.value })}
        placeholder={d.type === 'number' ? '=' : 'contains…'}
        style={{ ...S.input, width: 140 }}
      />
    )
  }

  return (
    <div style={{ ...S.card, display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'flex-end', marginBottom: 14 }}>
      {dims.map((d) => (
        <label key={d.member} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={S.label} title={d.member}>{d.name}</span>
          {control(d)}
        </label>
      ))}
      <div style={{ display: 'flex', gap: 6, marginLeft: 'auto' }}>
        <button style={S.btn} onClick={() => { setDraft({}); onApply([]) }}>Clear</button>
        <button style={S.btnPrimary} onClick={() => onApply(buildFilters(dims, draft))}>Apply</button>
      </div>
    </div>
  )
}
