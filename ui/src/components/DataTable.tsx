/** DataTable — renders columns × rows from JSON. Standard, not bespoke. */
import { formatValue, type TableSpec, type ValueFormat } from '../types'

function cell(value: unknown, format?: ValueFormat): string {
  if (value == null) return '—'
  if (typeof value === 'number' || typeof value === 'string') return formatValue(value, format)
  return String(value)
}

export function DataTable({ spec }: { spec: TableSpec }) {
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--rpt-border, #e5e7eb)', borderRadius: 10 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: 'var(--rpt-muted, #f9fafb)', textAlign: 'left' }}>
            {spec.columns.map((c) => (
              <th
                key={c.key}
                style={{
                  padding: '8px 12px',
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                  color: '#6b7280',
                  textAlign: c.align ?? 'left',
                }}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((row, i) => (
            <tr key={i} style={{ borderTop: '1px solid var(--rpt-border, #e5e7eb)' }}>
              {spec.columns.map((c) => (
                <td key={c.key} style={{ padding: '8px 12px', textAlign: c.align ?? 'left', color: '#374151' }}>
                  {cell(row[c.key], c.format)}
                </td>
              ))}
            </tr>
          ))}
          {spec.rows.length === 0 && (
            <tr>
              <td colSpan={spec.columns.length} style={{ padding: '16px', textAlign: 'center', color: '#9ca3af' }}>
                No data.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
