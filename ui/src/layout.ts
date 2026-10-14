/**
 * The default grid: how a report's widgets land on the 4-column grid.
 *
 * Widgets keep their order and their `w`, but a row the widths leave awkward is
 * tidied:
 *
 * - **Metrics beside a chart stack.** Two metric tiles next to a two-column
 *   chart used to stretch to the chart's height — tall cards with a number at
 *   the top and a sparkline at the bottom of a lot of nothing. They now stack
 *   in one column, and the chart takes the width they gave up.
 * - **A short row fills.** A row that adds up to fewer than four columns gives
 *   the spare columns to its widest non-metric widget, so a report never has a
 *   hole on the right.
 * - **Two metrics alone share the row**, two columns each.
 *
 * Pure: indexes in, cells out. The renderer still owns every widget by its
 * index, so editing, removal and drill address the same widget as before.
 */

export interface LayoutItem {
  /** Columns requested (1–4). Absent: 1 for a metric, 4 otherwise. */
  w?: number
  /** True for a single-number tile (a metric). */
  metric: boolean
}

export type LayoutCell =
  /** `compact`: a lone metric sharing its row with a chart — size it to its
   *  content instead of stretching it to the chart's height. */
  | { kind: 'single'; index: number; w: number; compact?: boolean }
  | { kind: 'stack'; indices: number[]; w: number }

const clamp = (w: number) => Math.max(1, Math.min(4, Math.round(w)))
const widthOf = (item: LayoutItem) => clamp(item.w ?? (item.metric ? 1 : 4))

/** Split the widgets into rows of at most four columns, in order. */
function rowsOf(items: LayoutItem[]): number[][] {
  const rows: number[][] = []
  let row: number[] = []
  let used = 0
  items.forEach((item, i) => {
    const w = widthOf(item)
    if (used + w > 4 && row.length) {
      rows.push(row)
      row = []
      used = 0
    }
    row.push(i)
    used += w
  })
  if (row.length) rows.push(row)
  return rows
}

export function planGrid(items: LayoutItem[]): LayoutCell[] {
  const cells: LayoutCell[] = []
  for (const row of rowsOf(items)) {
    const metrics = row.filter((i) => items[i].metric)
    const others = row.filter((i) => !items[i].metric)

    // Two metrics with nothing else: two columns each.
    if (metrics.length === 2 && others.length === 0) {
      metrics.forEach((i) => cells.push({ kind: 'single', index: i, w: 2 }))
      continue
    }

    const rowCells: LayoutCell[] = []
    if (metrics.length >= 2 && others.length > 0) {
      // Stack the metrics in one column where the first of them stood.
      const first = row.indexOf(metrics[0])
      row.forEach((i, pos) => {
        if (items[i].metric) {
          if (pos === first) rowCells.push({ kind: 'stack', indices: metrics, w: 1 })
          return
        }
        rowCells.push({ kind: 'single', index: i, w: widthOf(items[i]) })
      })
    } else {
      const mixed = metrics.length > 0 && others.length > 0
      row.forEach((i) =>
        rowCells.push({
          kind: 'single',
          index: i,
          w: widthOf(items[i]),
          ...(mixed && items[i].metric ? { compact: true } : {}),
        }),
      )
    }

    // Give any spare columns to the widest non-metric widget in the row.
    const used = rowCells.reduce((sum, c) => sum + c.w, 0)
    const spare = 4 - used
    if (spare > 0) {
      const target = rowCells
        .filter((c): c is Extract<LayoutCell, { kind: 'single' }> => c.kind === 'single' && !items[c.index].metric)
        .sort((a, b) => b.w - a.w)[0]
      if (target) target.w = clamp(target.w + spare)
    }
    cells.push(...rowCells)
  }
  return cells
}
