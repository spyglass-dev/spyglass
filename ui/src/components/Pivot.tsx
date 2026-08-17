/**
 * Pivot — rows × columns × one measure, rendered from a flat two-dimension
 * group-by result. The pivot is a RENDERING: the engine knows nothing about
 * it; the same query that feeds a table feeds this.
 *
 * The load-bearing rule: **a missing cell is not a zero.** Three states:
 *   - absent  — the row/col combination never appeared in the data
 *               (renders `—`, or `0` when `empty: 'zero'`)
 *   - null    — the combination exists but the measure is null (renders `n/a`)
 *   - value   — a real number, formatted (a scored 0 renders as `0`)
 * Conflating these is the classic way a gradebook lies.
 */
import type { CSSProperties } from 'react'
import {
  formatDateValue,
  formatValue,
  parseTimestamp,
  type PivotSpec,
  type PivotTotal,
  type ValueFormat,
} from '../types'
import { humanizeMember } from '../querybuilder'
import { tokens } from '../tokens'

/** Hard caps: a pivot is a summary, not a data dump. Beyond these it
 *  truncates visibly (never silently). */
export const MAX_PIVOT_ROWS = 60
export const MAX_PIVOT_COLS = 24

export type PivotCell =
  | { state: 'absent' }
  /** Present-but-null and real values keep their SOURCE data row — what makes
   *  a cell a drill target (the row carries both dimension values). */
  | { state: 'null'; row: Record<string, unknown> }
  | { state: 'value'; value: number | string; row: Record<string, unknown> }

export interface PivotAxisItem {
  /** Composite key of the axis dimension values (join of raw values). */
  key: string
  /** Header text — the `"{key}__label"` companion when present, else the raw value. */
  label: string
}

export interface BuiltPivot {
  cols: PivotAxisItem[]
  rows: { item: PivotAxisItem; cells: PivotCell[]; total?: number }[]
  /** Bottom-edge totals, aligned with `cols`; only when `totals.col` is set. */
  colTotals?: (number | undefined)[]
  /** Bottom-right corner: `totals.col` applied to the row totals. */
  grandTotal?: number
  /** Range of the numeric cell values (for shading). */
  min: number
  max: number
  /** How many rows / columns were cut by the caps (0 = none). */
  truncatedRows: number
  truncatedCols: number
}

const SEP = '\u0000'

function axisKey(row: Record<string, unknown>, members: string[]): string {
  return members.map((m) => String(row[m] ?? '')).join(SEP)
}

function axisLabel(row: Record<string, unknown>, members: string[]): string {
  return members
    .map((m) => {
      const label = row[`${m}__label`]
      const v = label ?? row[m]
      if (v == null) return '—'
      // A time member's raw value is `2026-08-01 00:00:00+00`. A cohort
      // triangle whose rows read like that is a debug dump, not a header.
      return isTimestampish(v) ? formatDateValue(String(v)) : String(v)
    })
    .join(' / ')
}

const isTimestampish = (v: unknown): boolean =>
  typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([ T]|$)/.test(v)

/**
 * Axis order. First appearance is right for a query whose ORDER BY put the
 * axis in the order it wants — but a pivot has TWO axes and the query can only
 * sort one. The other arrives in whatever order the rows happened to carry,
 * which is how a cohort triangle's weeks came out `0 1 2 3 9 4 5 6 7 8`.
 *
 * So: numeric axes sort numerically, dates chronologically, and anything else
 * keeps first-appearance order — the case the query really is controlling.
 */
function sortAxis(items: PivotAxisItem[], values: Map<string, unknown>): PivotAxisItem[] {
  const raw = items.map((i) => values.get(i.key))
  const allNumeric =
    raw.length > 0 && raw.every((v) => v !== null && v !== '' && !Number.isNaN(Number(v)))
  if (allNumeric) {
    return [...items].sort((a, b) => Number(values.get(a.key)) - Number(values.get(b.key)))
  }
  const allDates = raw.length > 0 && raw.every((v) => isTimestampish(v))
  if (allDates) {
    const sorted = [...items].sort(
      (a, b) =>
        parseTimestamp(String(values.get(a.key))) - parseTimestamp(String(values.get(b.key))),
    )
    // Label to the BUCKET, not the instant. A cohort axis of month buckets
    // reads "Jun 2026"; labelling each one "Jun 1" describes a day nothing
    // happened on.
    const dates = sorted.map((i) => new Date(parseTimestamp(String(values.get(i.key)))))
    // UTC throughout: the engine buckets in UTC, and a UTC midnight is 08:00
    // in Singapore — read locally, no bucket ever looks like a bucket.
    const monthly = dates.every(
      (d) => d.getUTCDate() === 1 && d.getUTCHours() === 0 && d.getUTCMinutes() === 0,
    )
    const yearly = monthly && dates.every((d) => d.getUTCMonth() === 0)
    if (!monthly) return sorted
    return sorted.map((item, i) => ({
      ...item,
      label: yearly
        ? String(dates[i].getUTCFullYear())
        : dates[i].toLocaleDateString(undefined, {
            month: 'short',
            year: 'numeric',
            timeZone: 'UTC',
          }),
    }))
  }
  return [...items]
}

function aggregate(values: number[], how: 'avg' | 'sum'): number | undefined {
  if (values.length === 0) return undefined
  const sum = values.reduce((a, b) => a + b, 0)
  return how === 'sum' ? sum : sum / values.length
}

const num = (v: unknown): number => (typeof v === 'number' ? v : Number(v) || 0)

/** A `ratio` total over a slice's SOURCE rows: scale × Σnum ÷ Σden. Absent
 *  combinations contribute nothing (no marks earned, none possible) — which
 *  is exactly why this is a weighted total and not a mean of cells. */
function ratioTotal(
  rows: Record<string, unknown>[],
  ratio: Exclude<PivotTotal, 'avg' | 'sum'>['ratio'],
): number | undefined {
  if (rows.length === 0) return undefined
  const den = rows.reduce((a, r) => a + num(r[ratio.den]), 0)
  if (den === 0) return undefined
  const n = rows.reduce((a, r) => a + num(r[ratio.num]), 0)
  return (n / den) * (ratio.scale ?? 1)
}

/** Rows backing a slice of cells (absent cells carry none). */
function cellRows(cells: PivotCell[]): Record<string, unknown>[] {
  return cells.flatMap((c) => (c.state === 'absent' ? [] : [c.row]))
}

function sliceTotal(
  cells: PivotCell[],
  how: PivotTotal,
  cellNumbers: (cell: PivotCell) => number | undefined,
): number | undefined {
  if (typeof how !== 'string') return ratioTotal(cellRows(cells), how.ratio)
  return aggregate(cells.map(cellNumbers).filter((n): n is number => n !== undefined), how)
}

/** Pure pivot construction — exported for tests and for hosts that want the
 *  matrix without the markup (e.g. an export path). */
export function buildPivot(spec: PivotSpec): BuiltPivot {
  const rowItems: PivotAxisItem[] = []
  const colItems: PivotAxisItem[] = []
  const rowIndex = new Map<string, number>()
  const colIndex = new Map<string, number>()
  const cells = new Map<string, PivotCell>()
  // The raw axis values, kept so the axes can be ordered by what they ARE
  // (a number, a date) rather than by the order the rows arrived in.
  const rowValues = new Map<string, unknown>()
  const colValues = new Map<string, unknown>()

  // First-appearance order on both axes — the query's ORDER BY decides.
  for (const row of spec.data) {
    const rk = axisKey(row, spec.rows)
    const ck = axisKey(row, spec.cols)
    if (!rowIndex.has(rk)) {
      rowIndex.set(rk, rowItems.length)
      rowItems.push({ key: rk, label: axisLabel(row, spec.rows) })
      if (spec.rows.length === 1) rowValues.set(rk, row[spec.rows[0]])
    }
    if (!colIndex.has(ck)) {
      colIndex.set(ck, colItems.length)
      colItems.push({ key: ck, label: axisLabel(row, spec.cols) })
      if (spec.cols.length === 1) colValues.set(ck, row[spec.cols[0]])
    }
    const raw = row[spec.measure]
    const cell: PivotCell =
      raw == null
        ? { state: 'null', row }
        : { state: 'value', value: typeof raw === 'number' ? raw : String(raw), row }
    cells.set(rk + SEP + ck, cell)
  }

  const orderedRows = sortAxis(rowItems, rowValues)
  const orderedCols = sortAxis(colItems, colValues)

  const truncatedRows = Math.max(0, orderedRows.length - MAX_PIVOT_ROWS)
  const truncatedCols = Math.max(0, orderedCols.length - MAX_PIVOT_COLS)
  const keptRows = orderedRows.slice(0, MAX_PIVOT_ROWS)
  const keptCols = orderedCols.slice(0, MAX_PIVOT_COLS)

  // Totals aggregate the numbers that EXIST. An absent combination joins in
  // only under `empty: 'zero'` (where the widget claims absent means 0);
  // a present null never does — unknown is not a quantity.
  const zeroFill = spec.empty === 'zero'
  const cellNumbers = (cell: PivotCell): number | undefined =>
    cell.state === 'value' && typeof cell.value === 'number'
      ? cell.value
      : cell.state === 'absent' && zeroFill
        ? 0
        : undefined

  let min = Infinity
  let max = -Infinity
  const rows = keptRows.map((item) => {
    const rowCells = keptCols.map(
      (c) => cells.get(item.key + SEP + c.key) ?? ({ state: 'absent' } as PivotCell),
    )
    for (const cell of rowCells) {
      if (cell.state === 'value' && typeof cell.value === 'number') {
        if (cell.value < min) min = cell.value
        if (cell.value > max) max = cell.value
      }
    }
    const total = spec.totals?.row ? sliceTotal(rowCells, spec.totals.row, cellNumbers) : undefined
    return { item, cells: rowCells, total }
  })

  let colTotals: (number | undefined)[] | undefined
  let grandTotal: number | undefined
  if (spec.totals?.col) {
    const how = spec.totals.col
    colTotals = keptCols.map((_, ci) => sliceTotal(rows.map((r) => r.cells[ci]), how, cellNumbers))
    if (spec.totals.row) {
      // Ratio grand total re-derives from ALL kept source rows — a ratio of
      // ratios would re-introduce the weighting error at the corner.
      grandTotal =
        typeof how !== 'string'
          ? ratioTotal(cellRows(rows.flatMap((r) => r.cells)), how.ratio)
          : aggregate(rows.map((r) => r.total).filter((n): n is number => n !== undefined), how)
    }
  }

  return {
    cols: keptCols,
    rows,
    colTotals,
    grandTotal,
    min: min === Infinity ? 0 : min,
    max: max === -Infinity ? 0 : max,
    truncatedRows,
    truncatedCols,
  }
}

/** Cell background for the opt-in shading scales. */
export function cellShade(
  value: number,
  min: number,
  max: number,
  scale: PivotSpec['scale'],
): string | undefined {
  if (!scale || scale === 'none' || max === min) return undefined
  if (scale === 'sequential') {
    const t = (value - min) / (max - min)
    return `rgba(59, 130, 246, ${(0.06 + t * 0.3).toFixed(3)})`
  }
  // diverging: red below the midpoint, green above, stronger further out
  const mid = (min + max) / 2
  const t = Math.abs(value - mid) / ((max - min) / 2)
  return value < mid
    ? `rgba(239, 68, 68, ${(t * 0.28).toFixed(3)})`
    : `rgba(34, 197, 94, ${(t * 0.28).toFixed(3)})`
}

function renderCell(cell: PivotCell, empty: PivotSpec['empty'], format?: ValueFormat): string {
  if (cell.state === 'absent') return empty === 'zero' ? formatValue(0, format) : '—'
  if (cell.state === 'null') return 'n/a'
  return formatValue(cell.value, format)
}

const headerStyle: CSSProperties = {
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
}

const stickyFirstCol: CSSProperties = {
  position: 'sticky',
  left: 0,
  background: tokens.bg,
  zIndex: 1,
}

export function Pivot({
  spec,
  onMeasureClick,
}: {
  spec: PivotSpec
  /** Cell drill (records drawer): called with the cell's SOURCE data row —
   *  which carries BOTH axis dimension values — and the pivot measure. The
   *  same contract as a table's measure click, so hosts wire nothing new.
   *  Absent cells have no row and are not drill targets. */
  onMeasureClick?: (row: Record<string, unknown>, columnKey: string) => void
}) {
  const built = buildPivot(spec)
  const totalCell: CSSProperties = {
    padding: '8px 12px',
    textAlign: 'right',
    fontWeight: 600,
    color: tokens.text,
    background: tokens.muted,
  }
  return (
    <div style={{ border: `1px solid ${tokens.border}`, borderRadius: 10 }}>
      <div style={{ overflow: 'auto', maxHeight: 480, borderRadius: 10 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: 'left' }}>
              <th style={{ ...headerStyle, ...stickyFirstCol, background: tokens.muted, zIndex: 2 }} />
              {built.cols.map((c) => (
                <th key={c.key} style={{ ...headerStyle, textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {c.label}
                </th>
              ))}
              {spec.totals?.row && (
                <th style={{ ...headerStyle, textAlign: 'right' }}>
                  {spec.totals.rowLabel ?? (spec.totals.row === 'avg' ? 'Avg' : 'Total')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {built.rows.map((r) => (
              <tr key={r.item.key} style={{ borderTop: `1px solid ${tokens.border}` }}>
                <td style={{ ...stickyFirstCol, padding: '8px 12px', fontWeight: 500, color: tokens.text, whiteSpace: 'nowrap' }}>
                  {r.item.label}
                </td>
                {r.cells.map((cell, ci) => {
                  const drillable = onMeasureClick && cell.state !== 'absent'
                  return (
                    <td
                      key={built.cols[ci].key}
                      onClick={drillable ? () => onMeasureClick(cell.row, spec.measure) : undefined}
                      role={drillable ? 'button' : undefined}
                      title={drillable ? 'Show the records behind this cell' : undefined}
                      style={{
                        padding: '8px 12px',
                        textAlign: 'right',
                        cursor: drillable ? 'pointer' : undefined,
                        textDecoration: drillable ? 'underline' : undefined,
                        textDecorationStyle: 'dotted',
                        textDecorationColor: tokens.border,
                        textUnderlineOffset: 3,
                        color: cell.state === 'value' ? tokens.text : tokens.textFaint,
                        background:
                          cell.state === 'value' && typeof cell.value === 'number'
                            ? cellShade(cell.value, built.min, built.max, spec.scale)
                            : undefined,
                      }}
                    >
                      {renderCell(cell, spec.empty, spec.format)}
                    </td>
                  )
                })}
                {spec.totals?.row && (
                  <td style={totalCell}>
                    {r.total === undefined ? '—' : formatValue(r.total, spec.format)}
                  </td>
                )}
              </tr>
            ))}
            {built.colTotals && (
              <tr style={{ borderTop: `2px solid ${tokens.border}` }}>
                <td style={{ ...stickyFirstCol, ...totalCell, textAlign: 'left' }}>
                  {spec.totals?.colLabel ?? (spec.totals?.col === 'avg' ? 'Avg' : 'Total')}
                </td>
                {built.colTotals.map((t, ci) => (
                  <td key={built.cols[ci].key} style={totalCell}>
                    {t === undefined ? '—' : formatValue(t, spec.format)}
                  </td>
                ))}
                {spec.totals?.row && (
                  <td style={totalCell}>
                    {built.grandTotal === undefined ? '—' : formatValue(built.grandTotal, spec.format)}
                  </td>
                )}
              </tr>
            )}
            {built.rows.length === 0 && (
              <tr>
                <td colSpan={built.cols.length + 1} style={{ padding: '16px', textAlign: 'center', color: tokens.textFaint }}>
                  No data.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {built.rows.length > 0 && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            padding: '6px 12px',
            fontSize: 12,
            color: tokens.textFaint,
            borderTop: `1px solid ${tokens.border}`,
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {spec.scale && spec.scale !== 'none' && (
              <>
                {[0.15, 0.5, 0.9].map((t) => (
                  <span
                    key={t}
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      display: 'inline-block',
                      background: cellShade(built.min + t * (built.max - built.min), built.min, built.max, spec.scale),
                      border: `1px solid ${tokens.border}`,
                    }}
                  />
                ))}
                <span>shaded low → high</span>
                <span>·</span>
              </>
            )}
            <span>— no record</span>
          </span>
          <span>
            {pivotCount(built.rows.length, built.truncatedRows, spec.rows[0])} ·{' '}
            {pivotCount(built.cols.length, built.truncatedCols, spec.cols[0])}
          </span>
        </div>
      )}
      {(built.truncatedRows > 0 || built.truncatedCols > 0) && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: tokens.textFaint, borderTop: `1px solid ${tokens.border}` }}>
          {[
            built.truncatedRows > 0 && `${built.truncatedRows} more rows`,
            built.truncatedCols > 0 && `${built.truncatedCols} more columns`,
          ]
            .filter(Boolean)
            .join(' and ')}{' '}
          not shown (showing the first {MAX_PIVOT_ROWS}×{MAX_PIVOT_COLS}). Narrow the query to see
          the rest.
        </div>
      )}
    </div>
  )
}

/** Footer count: "6 students" / "4 of 40 activities" — the axis dimension's
 *  humanized noun, pluralized (activity → activities, class → classes). */
function pivotCount(kept: number, truncated: number, member: string | undefined): string {
  const noun = humanizeMember(member ?? '').toLowerCase() || 'row'
  const plural =
    kept + truncated === 1
      ? noun
      : /[^aeiou]y$/.test(noun)
        ? `${noun.slice(0, -1)}ies`
        : /(s|x|z|ch|sh)$/.test(noun)
          ? `${noun}es`
          : `${noun}s`
  return truncated > 0 ? `${kept} of ${kept + truncated} ${plural}` : `${kept} ${plural}`
}
