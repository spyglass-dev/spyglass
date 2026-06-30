/** Small shared inline-style kit (keeps the studio dependency-light). */
import type { CSSProperties } from 'react'

export const S = {
  muted: { color: '#6b7280', fontSize: 13 } as CSSProperties,
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 } as CSSProperties,
  card: { border: '1px solid #e5e7eb', borderRadius: 10, padding: '12px 14px', background: '#fff' } as CSSProperties,
  label: { fontSize: 11, textTransform: 'uppercase', letterSpacing: '.5px', color: '#6366f1', margin: '10px 0 4px' } as CSSProperties,
  pill: { display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12, background: '#f4f5f7', border: '1px solid #e5e7eb', borderRadius: 6, padding: '2px 7px', margin: '2px 4px 2px 0' } as CSSProperties,
  pillTenant: { display: 'inline-flex', alignItems: 'center', gap: 6, fontFamily: 'ui-monospace, monospace', fontSize: 12, background: '#eef2ff', border: '1px solid #c7d2fe', borderRadius: 6, padding: '2px 7px', margin: '2px 4px 2px 0' } as CSSProperties,
  ty: { color: '#9ca3af', fontSize: 10, fontStyle: 'normal' } as CSSProperties,
  badge: { fontSize: 9, textTransform: 'uppercase', background: '#6366f1', color: '#fff', borderRadius: 4, padding: '1px 5px', fontWeight: 700 } as CSSProperties,
  input: { fontSize: 13, padding: '6px 8px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff' } as CSSProperties,
  btn: { fontSize: 13, padding: '6px 12px', border: '1px solid #e5e7eb', borderRadius: 6, background: '#fff', cursor: 'pointer' } as CSSProperties,
  btnPrimary: { fontSize: 13, padding: '6px 12px', border: '1px solid #6366f1', borderRadius: 6, background: '#6366f1', color: '#fff', cursor: 'pointer' } as CSSProperties,
  chk: { display: 'block', padding: '3px 0', fontFamily: 'ui-monospace, monospace', fontSize: 12, cursor: 'pointer' } as CSSProperties,
  err: { color: '#e11d48', fontSize: 13 } as CSSProperties,
}
