/**
 * DataGrid — the table widget, replacing the old static `DataTable`.
 *
 * Sort and paging are SERVER-DRIVEN: a header click or a pager click emits a
 * `GridQueryDelta` (a patch to the widget's cube query — `order` / `offset`),
 * never a client-side array operation. Sorting re-sorts ALL rows, not the
 * visible page; "1–25 of 312" reads the engine's `include_total` count.
 * Without an `onQuery` handler the grid renders static data (no sort
 * affordances, no pager) — the plain-JSON table case.
 *
 * Also: `__label` resolution (UUID columns render their label companion),
 * optional in-cell bars for a measure, sticky header + first column, CSV
 * export of the loaded rows, and lightweight virtualization past ~200 rows.
 */
import { useRef, useState, type CSSProperties } from 'react'
import { formatValue, type PillTone, type TableColumn, type TableSpec, type ValueFormat } from '../types'
import type { DrillEvent } from '../drill'
import { tokens } from '../tokens'

/** A patch the grid asks the host to apply to the widget's query. */
export interface GridQueryDelta {
  /** Replace the query's `order` (empty array = clear back to default). */
  order?: { member: string; desc?: boolean }[]
  /** Jump to this row offset. */
  offset?: number
  limit?: number
}

/** Rows beyond this render through the virtual window. */
export const VIRTUALIZE_AT = 200
const ROW_HEIGHT = 34
const VIEWPORT = 480

/** The slice of `count` rows to mount for a scroll position — pure, tested. */
export function virtualWindow(
  count: number,
  scrollTop: number,
  viewport: number = VIEWPORT,
  rowHeight: number = ROW_HEIGHT,
): { start: number; end: number; padTop: number; padBottom: number } {
  const overscan = 10
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan)
  // Clamp to `end` so a stale scroll position past the data (rows shrank,
  // page changed) degrades to an empty window, never a negative pad.
  const start = Math.min(end, Math.max(0, Math.floor(scrollTop / rowHeight) - overscan))
  return { start, end, padTop: start * rowHeight, padBottom: (count - end) * rowHeight }
}

/** Columns to render: drop `__label` companions (they display INSIDE their
 *  base column) and keep everything else in declared order. */
export function visibleColumns(spec: TableSpec): TableSpec['columns'] {
  const keys = new Set(spec.columns.map((c) => c.key))
  return spec.columns.filter(
    (c) => !(c.key.endsWith('__label') && keys.has(c.key.slice(0, -'__label'.length))),
  )
}

/** Display value for a cell: the `__label` companion wins over the raw id. */
export function cellValue(row: Record<string, unknown>, key: string): unknown {
  const label = row[`${key}__label`]
  return label != null && label !== '' ? label : row[key]
}

/** "1–25 of 312" (or "1–25" when the total is unknown). */
export function pageLabel(offset: number, shown: number, total?: number): string {
  if (shown === 0) return total !== undefined ? `0 of ${total.toLocaleString()}` : '0 rows'
  const from = offset + 1
  const to = offset + shown
  const range = from === to ? `${from.toLocaleString()}` : `${from.toLocaleString()}–${to.toLocaleString()}`
  return total !== undefined ? `${range} of ${total.toLocaleString()}` : range
}

function csvCell(value: unknown): string {
  if (value == null) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** CSV of the LOADED rows (the current page), with label resolution applied —
 *  headers are the column labels, ids are replaced by their `__label`s. */
export function tableToCsv(spec: TableSpec): string {
  const cols = visibleColumns(spec)
  const header = cols.map((c) => csvCell(c.label)).join(',')
  const lines = spec.rows.map((row) => cols.map((c) => csvCell(cellValue(row, c.key))).join(','))
  return [header, ...lines].join('\n')
}

function downloadCsv(spec: TableSpec) {
  const blob = new Blob([tableToCsv(spec)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${(spec.title ?? 'table').replace(/[^\w-]+/g, '_').toLowerCase()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function formatCell(value: unknown, format?: ValueFormat): string {
  if (value == null) return '—'
  if (typeof value === 'number' || typeof value === 'string') return formatValue(value, format)
  return String(value)
}

const PILL_STYLES: Record<PillTone, CSSProperties> = {
  positive: { background: 'rgba(34, 197, 94, 0.14)', color: '#15803d' },
  warning: { background: tokens.warnBg, color: tokens.warnText },
  negative: { background: 'rgba(225, 29, 72, 0.12)', color: '#be123c' },
  neutral: { background: tokens.muted, color: tokens.textMuted },
}

/** Which tone a pill cell wears: score band for numbers, the column's map
 *  for categorical values (unmapped → neutral). */
function pillTone(raw: unknown, pill: NonNullable<TableColumn['pill']>): PillTone {
  if (pill === 'band') {
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isNaN(n)) return 'neutral'
    return n >= 75 ? 'positive' : n >= 50 ? 'warning' : 'negative'
  }
  return pill[String(raw)] ?? 'neutral'
}

function PillCell({ raw, column }: { raw: unknown; column: TableColumn }) {
  if (raw == null) return <>—</>
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 600,
        ...PILL_STYLES[pillTone(raw, column.pill!)],
      }}
    >
      {formatCell(typeof raw === 'string' ? raw.replace(/_/g, ' ') : raw, column.format)}
    </span>
  )
}

const headerCell: CSSProperties = {
  padding: '8px 12px',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: tokens.textMuted,
  background: tokens.muted,
  position: 'sticky',
  top: 0,
  zIndex: 1,
  whiteSpace: 'nowrap',
}

const stickyFirst: CSSProperties = { position: 'sticky', left: 0, background: tokens.bg }

export function DataGrid({
  spec,
  onQuery,
  onDrill,
  onMeasureClick,
}: {
  spec: TableSpec
  /** Present = server-driven: header clicks and the pager emit query deltas.
   *  Absent = static data; no sort affordances, no pager. */
  onQuery?: (delta: GridQueryDelta) => void
  /** Present = dimension cells are drill targets: clicking one emits a
   *  `DrillEvent` (member, value, resolved label, drill entity). */
  onDrill?: (event: DrillEvent) => void
  /** Present = measure cells open row mode (the records drawer) — clicking
   *  one hands back the row and the measure's column key. */
  onMeasureClick?: (row: Record<string, unknown>, columnKey: string) => void
}) {
  const cols = visibleColumns(spec)
  const offset = spec.page?.offset ?? 0
  const limit = spec.page?.limit
  const [scrollTop, setScrollTop] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)

  // Sort cycle per column: none → asc → desc → none. Changing sort jumps
  // back to the first page — page N of a different ordering is meaningless.
  const sortClick = (key: string) => {
    if (!onQuery) return
    const current = spec.sort?.key === key ? spec.sort : undefined
    const order =
      current === undefined
        ? [{ member: key, desc: false }]
        : current.desc
          ? []
          : [{ member: key, desc: true }]
    onQuery({ order, offset: 0 })
  }

  const virtual = spec.rows.length > VIRTUALIZE_AT
  const win = virtual
    ? virtualWindow(spec.rows.length, scrollTop)
    : { start: 0, end: spec.rows.length, padTop: 0, padBottom: 0 }

  // In-cell bars scale against the max of the bar column on this page.
  const barMax = spec.bars
    ? Math.max(
        0,
        ...spec.rows.map((r) => (typeof r[spec.bars!] === 'number' ? (r[spec.bars!] as number) : 0)),
      )
    : 0

  const canPage = onQuery && (offset > 0 || (spec.total !== undefined ? offset + spec.rows.length < spec.total : limit !== undefined && spec.rows.length === limit))
  const pageBtn: CSSProperties = {
    border: `1px solid ${tokens.border}`,
    background: tokens.bg,
    color: tokens.textMuted,
    borderRadius: 6,
    padding: '2px 8px',
    fontSize: 12,
    cursor: 'pointer',
  }

  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 10, background: tokens.bg }}>
      <div
        ref={scroller}
        onScroll={virtual ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop) : undefined}
        style={{ overflow: 'auto', maxHeight: VIEWPORT, borderRadius: '10px 10px 0 0' }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              {cols.map((c, i) => {
                const sorted = spec.sort?.key === c.key ? spec.sort : undefined
                const style: CSSProperties = {
                  ...headerCell,
                  ...(i === 0 ? { ...stickyFirst, background: tokens.muted, zIndex: 2 } : {}),
                  textAlign: c.align ?? 'left',
                  ...(onQuery ? { cursor: 'pointer', userSelect: 'none' } : {}),
                  ...(sorted ? { color: tokens.text } : {}),
                }
                return (
                  <th
                    key={c.key}
                    style={style}
                    onClick={() => sortClick(c.key)}
                    role={onQuery ? 'button' : undefined}
                    aria-sort={sorted ? (sorted.desc ? 'descending' : 'ascending') : undefined}
                  >
                    {c.label}
                    {sorted && <span aria-hidden> {sorted.desc ? '▼' : '▲'}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {win.padTop > 0 && (
              <tr aria-hidden>
                <td colSpan={cols.length} style={{ padding: 0, height: win.padTop }} />
              </tr>
            )}
            {spec.rows.slice(win.start, win.end).map((row, i) => (
              <tr key={win.start + i} style={{ borderTop: `1px solid ${tokens.border}` }}>
                {cols.map((c, ci) => {
                  const raw = cellValue(row, c.key)
                  const barValue =
                    spec.bars === c.key && typeof row[c.key] === 'number' ? (row[c.key] as number) : undefined
                  // Dimensions drill; measures open row mode. Both are
                  // derived from the column kind — never authored per report.
                  const drills = onDrill && c.kind === 'dimension'
                  const opensRows = onMeasureClick && c.kind === 'measure'
                  const click = drills
                    ? () =>
                        onDrill({
                          member: c.key,
                          value: (row[c.key] ?? null) as DrillEvent['value'],
                          label: row[`${c.key}__label`] != null ? String(row[`${c.key}__label`]) : undefined,
                          entity: c.drillEntity,
                        })
                    : opensRows
                      ? () => onMeasureClick(row, c.key)
                      : undefined
                  return (
                    <td
                      key={c.key}
                      onClick={click}
                      role={click ? 'button' : undefined}
                      style={{
                        padding: '8px 12px',
                        textAlign: c.align ?? 'left',
                        color: drills ? tokens.accent : tokens.text,
                        whiteSpace: 'nowrap',
                        height: virtual ? ROW_HEIGHT : undefined,
                        boxSizing: virtual ? 'border-box' : undefined,
                        ...(click ? { cursor: 'pointer' } : {}),
                        ...(drills
                          ? { textDecoration: 'underline', textDecorationColor: tokens.accentSoft, textUnderlineOffset: 3 }
                          : {}),
                        ...(ci === 0 ? stickyFirst : {}),
                        ...(barValue !== undefined && barMax > 0
                          ? {
                              backgroundImage: `linear-gradient(to right, ${tokens.accentSoft} ${(barValue / barMax) * 100}%, transparent ${(barValue / barMax) * 100}%)`,
                            }
                          : {}),
                      }}
                    >
                      {c.pill ? <PillCell raw={raw} column={c} /> : formatCell(raw, c.format)}
                    </td>
                  )
                })}
              </tr>
            ))}
            {win.padBottom > 0 && (
              <tr aria-hidden>
                <td colSpan={cols.length} style={{ padding: 0, height: win.padBottom }} />
              </tr>
            )}
            {spec.rows.length === 0 && (
              <tr>
                <td colSpan={cols.length} style={{ padding: 16, textAlign: 'center', color: tokens.textFaint }}>
                  No data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {spec.truncatedAt !== undefined && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: tokens.textFaint, borderTop: `1px solid ${tokens.border}` }}>
          Results truncated at {spec.truncatedAt.toLocaleString()} rows — this is not the full set.
          Narrow the query or page through it.
        </div>
      )}
      {(canPage || spec.total !== undefined || spec.rows.length > 0) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 8,
            padding: '6px 12px',
            borderTop: `1px solid ${tokens.border}`,
            fontSize: 12,
            color: tokens.textMuted,
          }}
        >
          <span>{pageLabel(offset, spec.rows.length, spec.total)}</span>
          <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {onQuery && limit !== undefined && (
              <>
                <button
                  type="button"
                  style={{ ...pageBtn, ...(offset === 0 ? { opacity: 0.4, cursor: 'default' } : {}) }}
                  disabled={offset === 0}
                  onClick={() => onQuery({ offset: Math.max(0, offset - limit) })}
                >
                  ‹ Prev
                </button>
                <button
                  type="button"
                  style={{
                    ...pageBtn,
                    ...((spec.total !== undefined ? offset + spec.rows.length >= spec.total : spec.rows.length < limit)
                      ? { opacity: 0.4, cursor: 'default' }
                      : {}),
                  }}
                  disabled={spec.total !== undefined ? offset + spec.rows.length >= spec.total : spec.rows.length < limit}
                  onClick={() => onQuery({ offset: offset + limit })}
                >
                  Next ›
                </button>
              </>
            )}
            <button type="button" style={pageBtn} onClick={() => downloadCsv(spec)}>
              CSV
            </button>
          </span>
        </div>
      )}
    </div>
  )
}
