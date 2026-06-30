/** Catalog browser — every cube with its measures, dimensions, and tenant key. */
import type { ModelMeta } from './server'
import { S } from './theme'

export function CubesView({ meta }: { meta: ModelMeta | null }) {
  if (!meta) return <div style={S.muted}>Loading catalog from /meta…</div>
  if (!meta.cubes.length) return <div style={S.muted}>No cubes loaded.</div>
  return (
    <div style={S.grid}>
      {meta.cubes.map((c) => (
        <div key={c.name} style={S.card}>
          <div style={{ fontWeight: 600, fontSize: 15 }}>{c.name}</div>
          {c.title && <div style={S.muted}>{c.title}</div>}

          <div style={S.label}>Measures</div>
          <div>
            {c.measures.map((m) => (
              <span key={m.member} style={S.pill} title={m.member}>
                {m.name}
                <i style={S.ty}>{m.type}</i>
              </span>
            ))}
          </div>

          <div style={S.label}>Dimensions</div>
          <div>
            {c.dimensions.map((d) => (
              <span key={d.member} style={d.tenant ? S.pillTenant : S.pill} title={d.member}>
                {d.name}
                <i style={S.ty}>{d.type}</i>
                {d.tenant && <b style={S.badge}>tenant</b>}
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
