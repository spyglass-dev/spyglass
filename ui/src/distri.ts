/**
 * Distri report tools — agent-facing tools for building reports from natural
 * language. Structurally compatible with `@distri/core`'s `DistriFnTool` (no
 * hard dependency here — cast at the call site). The host implements
 * `ReportHost` (open/update the report it's showing) and pairs these with a
 * reporting skill (see `spyglass/skills/reporting`).
 */
import type { Report, ReportWidget } from './report'

/** A frontend agent tool (matches `@distri/core` DistriFnTool structurally). */
export interface AgentTool {
  type: 'function'
  isExternal: true
  autoExecute: true
  name: string
  description: string
  parameters: Record<string, unknown>
  handler: (input: unknown) => Promise<Array<{ part_type: 'data'; data: unknown }>>
}

/** The report surface the tools read/write (a host session + persistence). */
export interface ReportHost {
  /** The report currently open (null if none). */
  getReport(): Report | null
  /** Open/replace the working report (persist + render). */
  setReport(report: Report): void
  /** Called after `create_report` builds a fresh report (e.g. navigate to it). */
  onBuilt?(report: Report): void
}

/** Agent-readable widget vocabulary for the tool schemas + skills. */
export const WIDGET_VOCAB = [
  'bound — a data widget backed by a query: { type:"bound", as:"metric"|"table"|"chart", query:{ measures:["Cube.measure"], dimensions?:["Cube.dimension"], filters?, timeDimensions? }, title?, w?, label?, format?, mark?, x?, y? }. PREFER this for data.',
  'metric — a static scalar: { type:"metric", value, label?, format?, w? }',
  'table — static rows: { type:"table", columns:[{key,label}], rows:[…], w? }',
  'chart — static series: { type:"chart", chart:{ mark:"bar"|"line"|"area", x?, y, series:[…] }, w? }',
  'note — markdown: { type:"note", markdown, w? }',
].join('\n')

const VALID = new Set(['metric', 'table', 'chart', 'note', 'bound'])
const isWidget = (w: unknown): w is ReportWidget =>
  !!w && typeof w === 'object' && VALID.has((w as { type?: string }).type ?? '')
const ok = (data: unknown) => [{ part_type: 'data' as const, data }]

/** `create_report` — build a report from a title + widgets and open it. */
export function createReportTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'create_report',
    description:
      'Build a report and open it: pass a `title` and an ordered list of `widgets` (prefer `bound` widgets carrying a query). Widget vocabulary:\n' +
      WIDGET_VOCAB,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        widgets: { type: 'array', items: { type: 'object' } },
      },
      required: ['title'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { title?: string; description?: string; widgets?: unknown }
      const widgets = Array.isArray(a.widgets) ? a.widgets.filter(isWidget) : []
      const report: Report = { title: a.title?.trim() || 'Untitled report', description: a.description, widgets }
      host.setReport(report)
      host.onBuilt?.(report)
      return ok({ ok: true, widget_count: widgets.length })
    },
  }
}

/** `add_report_widget` — append ONE widget to the open report. */
export function addWidgetTool(host: ReportHost): AgentTool {
  return {
    type: 'function',
    isExternal: true,
    autoExecute: true,
    name: 'add_report_widget',
    description:
      'Append ONE widget to the report already open (keeps existing widgets and layout). Pass a single `widget` (prefer a `bound` widget) and optional `index`. Widget vocabulary:\n' +
      WIDGET_VOCAB,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: { widget: { type: 'object' }, index: { type: 'number' } },
      required: ['widget'],
    },
    handler: async (input) => {
      const a = (input ?? {}) as { widget?: unknown; index?: number }
      if (!isWidget(a.widget)) return ok({ ok: false, error: 'Provide a valid `widget`.' })
      const current = host.getReport() ?? { title: 'Untitled report', widgets: [] }
      const widgets = [...current.widgets]
      const at = typeof a.index === 'number' ? Math.max(0, Math.min(a.index, widgets.length)) : widgets.length
      widgets.splice(at, 0, a.widget)
      host.setReport({ ...current, widgets })
      return ok({ ok: true, widget_count: widgets.length })
    },
  }
}

/** All generic report tools for a host. */
export function buildReportTools(host: ReportHost): AgentTool[] {
  return [createReportTool(host), addWidgetTool(host)]
}
