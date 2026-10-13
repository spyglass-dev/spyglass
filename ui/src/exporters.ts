/**
 * Exporters — how a widget or a whole report leaves the screen.
 *
 * An exporter is a plain object a host can add to, replace or drop: the card's
 * menu lists every `WidgetExporter` whose `applies` says yes, and a report
 * toolbar lists the `ReportExporter`s. The built-ins cover CSV, PNG, JSON and
 * Markdown with no dependencies; a host with its own document pipeline (PDF,
 * DOCX) registers it alongside rather than wiring a second export path.
 */
import type { ReportDoc, WidgetSpec } from './types'
import { formatValue } from './types'
import { cellValue, visibleColumns } from './components/DataGrid'

export interface WidgetExportContext {
  spec: WidgetSpec
  /** File-name stem and heading: the widget title, or a fallback. */
  title: string
  /** The rendered widget, for exporters that capture pixels (PNG). */
  element?: HTMLElement | null
  /** The widget's FULL result — every page, not just the loaded one. Hosts
   *  that can re-run the query supply it; without it, exports use what is
   *  on screen. */
  fetchAll?: () => Promise<WidgetSpec>
}

export interface WidgetExporter {
  id: string
  label: string
  applies: (spec: WidgetSpec) => boolean
  run: (ctx: WidgetExportContext) => Promise<void> | void
}

export interface ReportExportContext {
  doc: ReportDoc
  title: string
  /** The rendered report, for pixel exporters. */
  element?: HTMLElement | null
}

export interface ReportExporter {
  id: string
  label: string
  run: (ctx: ReportExportContext) => Promise<void> | void
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A file-system-safe name: `Revenue by month` → `revenue_by_month`. */
export function fileStem(title: string): string {
  return title.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase() || 'export'
}

/** Hand a blob to the browser as a download. */
export function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function csvCell(value: unknown): string {
  if (value == null) return ''
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Any data widget as a header + rows grid — the shape CSV and Markdown share.
 * Labels replace ids, and the headers are the names the reader saw.
 */
export function widgetGrid(spec: WidgetSpec): { headers: string[]; rows: unknown[][] } | null {
  switch (spec.type) {
    case 'table': {
      const cols = visibleColumns(spec)
      return { headers: cols.map((c) => c.label), rows: spec.rows.map((r) => cols.map((c) => cellValue(r, c.key))) }
    }
    case 'chart': {
      const { series, x, titles } = spec.chart
      const ys = Array.isArray(spec.chart.y) ? spec.chart.y : [spec.chart.y]
      const keys = [x, spec.chart.color, ...ys, spec.chart.y2].filter((k): k is string => !!k)
      const name = (k: string) => titles?.[k] ?? k.split('.').pop()?.replace(/_/g, ' ') ?? k
      return { headers: keys.map(name), rows: series.map((r) => keys.map((k) => cellValue(r, k))) }
    }
    case 'pivot': {
      const keys = [...spec.rows, ...spec.cols, spec.measure]
      return { headers: keys.map((k) => k.split('.').pop() ?? k), rows: spec.data.map((r) => keys.map((k) => cellValue(r, k))) }
    }
    case 'metric':
      return { headers: [spec.label ?? spec.title ?? 'Value'], rows: [[spec.value]] }
    case 'view':
      return spec.data
        ? { headers: spec.data.columns.map((c) => c.key), rows: spec.data.rows.map((r) => spec.data!.columns.map((c) => r[c.key])) }
        : null
    default:
      return null
  }
}

export function gridToCsv(grid: { headers: string[]; rows: unknown[][] }): string {
  return [grid.headers.map(csvCell).join(','), ...grid.rows.map((r) => r.map(csvCell).join(','))].join('\n')
}

/** Rasterize the first SVG inside `element` at 2x, on the widget surface color. */
async function svgToPng(element: HTMLElement): Promise<Blob | null> {
  const svg = element.querySelector('svg')
  if (!svg) return null
  const box = svg.getBoundingClientRect()
  const clone = svg.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('width', String(box.width))
  clone.setAttribute('height', String(box.height))
  const xml = new XMLSerializer().serializeToString(clone)
  const img = new Image()
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
  await img.decode()
  const scale = 2
  const canvas = document.createElement('canvas')
  canvas.width = Math.ceil(box.width * scale)
  canvas.height = Math.ceil(box.height * scale)
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.fillStyle = getComputedStyle(element).getPropertyValue('--rpt-bg').trim() || '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.scale(scale, scale)
  ctx.drawImage(img, 0, 0, box.width, box.height)
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

// ── Built-ins ────────────────────────────────────────────────────────────────

export const csvExporter: WidgetExporter = {
  id: 'csv',
  label: 'Download CSV',
  applies: (spec) => widgetGrid(spec) !== null && spec.type !== 'metric',
  async run({ spec, title, fetchAll }) {
    const full = fetchAll ? await fetchAll().catch(() => spec) : spec
    const grid = widgetGrid(full)
    if (grid) download(`${fileStem(title)}.csv`, new Blob([gridToCsv(grid)], { type: 'text/csv;charset=utf-8' }))
  },
}

export const pngExporter: WidgetExporter = {
  id: 'png',
  label: 'Download PNG',
  applies: (spec) => spec.type === 'chart' && spec.chart.mark !== 'progress',
  async run({ element, title }) {
    const blob = element ? await svgToPng(element) : null
    if (blob) download(`${fileStem(title)}.png`, blob)
  },
}

export const jsonExporter: WidgetExporter = {
  id: 'json',
  label: 'Copy widget JSON',
  applies: () => true,
  async run({ spec }) {
    await navigator.clipboard?.writeText(JSON.stringify(spec, null, 2))
  },
}

export const DEFAULT_WIDGET_EXPORTERS: WidgetExporter[] = [csvExporter, pngExporter, jsonExporter]

/** A report as Markdown: headline numbers as a list, every grid as a table. */
export function reportToMarkdown(doc: ReportDoc): string {
  const out: string[] = []
  if (doc.title) out.push(`# ${doc.title}`, '')
  if (doc.description) out.push(doc.description, '')
  const metrics = doc.widgets.filter((w) => w.type === 'metric')
  if (metrics.length) {
    for (const m of metrics) {
      if (m.type !== 'metric') continue
      const change = m.delta ? ` (${m.delta.pct !== undefined ? `${m.delta.pct > 0 ? '+' : ''}${m.delta.pct}%` : `${m.delta.value > 0 ? '+' : ''}${m.delta.value}${m.delta.suffix ?? ''}`} ${m.delta.label ?? ''})` : ''
      out.push(`- **${m.label ?? m.title}**: ${formatValue(m.value, m.format)}${change.trimEnd()}`)
    }
    out.push('')
  }
  for (const w of doc.widgets) {
    if (w.type === 'metric') continue
    if (w.type === 'note') {
      out.push(w.markdown, '')
      continue
    }
    const grid = widgetGrid(w)
    if (!grid) continue
    if (w.title) out.push(`## ${w.title}`, '')
    out.push(`| ${grid.headers.join(' | ')} |`, `| ${grid.headers.map(() => '---').join(' | ')} |`)
    for (const r of grid.rows.slice(0, 50)) out.push(`| ${r.map((v) => (v == null ? '' : String(v))).join(' | ')} |`)
    if (grid.rows.length > 50) out.push('', `_${grid.rows.length - 50} more rows not shown._`)
    out.push('')
  }
  return out.join('\n')
}

export const markdownReportExporter: ReportExporter = {
  id: 'markdown',
  label: 'Download Markdown',
  run({ doc, title }) {
    download(`${fileStem(title)}.md`, new Blob([reportToMarkdown(doc)], { type: 'text/markdown;charset=utf-8' }))
  },
}

export const jsonReportExporter: ReportExporter = {
  id: 'json',
  label: 'Download report JSON',
  run({ doc, title }) {
    download(`${fileStem(title)}.json`, new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }))
  },
}

export const DEFAULT_REPORT_EXPORTERS: ReportExporter[] = [markdownReportExporter, jsonReportExporter]
