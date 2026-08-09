/**
 * Bound views — host React components bound to a query, resolved by Spyglass
 * like any bound widget (contracts v2 §3). `CustomSpec` carries frozen data;
 * a VIEW is live: it receives the report filters AND the drill callback — it
 * participates in the system, it is not an escape hatch from it.
 *
 * `registerView()` takes a MANIFEST (description, data contract, propsSchema).
 * The manifest is what puts a view in the model digest and lets an agent
 * place it by name. An unmet contract renders `widget_error`, never a blank
 * cell.
 */
import type { ComponentType } from 'react'
import type { DrillEvent } from './drill'
import type { ReportFilters } from './filters'
import type { QueryResultLite, WidgetQuery } from './querybuilder'
import type { WidgetErrorData } from './components/WidgetError'

/** What a view component receives — the frozen ViewProps contract. */
export interface ViewProps<P = unknown> {
  rows: Record<string, unknown>[]
  columns: { key: string; kind: string }[]
  total?: number
  loading: boolean
  error?: WidgetErrorData
  /** The report filters in effect — views respect report scope. */
  filters: ReportFilters
  /** Views participate in drill, same as every table. */
  drill: (event: DrillEvent) => void
  refresh: () => void
  props: P
}

/** The registration manifest — what the digest shows and agents place by. */
export interface ViewManifest {
  /** Registry key (`ViewSpec.component`). */
  name: string
  title?: string
  /** One or two sentences for the digest — what this view shows. */
  description: string
  /** The data contract: `requires` are member keys the resolved columns MUST
   *  include (unmet → `widget_error`); `suggests` improve the view but don't
   *  gate it. */
  contract?: { requires?: string[]; suggests?: string[] }
  /** JSON Schema for `ViewSpec.props` (documentation + agent guidance). */
  propsSchema?: Record<string, unknown>
  component: ComponentType<ViewProps>
}

export type ViewRegistry = Record<string, ViewManifest>

/** Register a view; returns a new registry (registries are plain data). */
export function registerView(registry: ViewRegistry, manifest: ViewManifest): ViewRegistry {
  return { ...registry, [manifest.name]: manifest }
}

/**
 * Check a resolved result against the manifest's contract. Returns the error
 * text when unmet (the caller renders `widget_error` from it), null when met.
 */
export function checkViewContract(
  manifest: ViewManifest,
  result: Pick<QueryResultLite, 'columns'>,
): string | null {
  const required = manifest.contract?.requires ?? []
  if (!required.length) return null
  const present = new Set(result.columns.map((c) => c.key))
  const missing = required.filter((m) => !present.has(m))
  if (!missing.length) return null
  return `The "${manifest.title ?? manifest.name}" view requires ${missing
    .map((m) => `\`${m}\``)
    .join(', ')} in its query result.`
}

/** The views section of the model digest — generated from manifests, so an
 *  agent can place a view by name with the right data. */
export function viewsDigest(registry: ViewRegistry): string {
  const manifests = Object.values(registry)
  if (!manifests.length) return ''
  const lines = ['# Host views', 'Place with { type: "view", component, query, props }.']
  for (const m of manifests) {
    const bits = [`- ${m.name}`]
    if (m.title) bits.push(`"${m.title}"`)
    bits.push(`— ${m.description}`)
    if (m.contract?.requires?.length) bits.push(`(requires: ${m.contract.requires.join(', ')})`)
    if (m.contract?.suggests?.length) bits.push(`(suggests: ${m.contract.suggests.join(', ')})`)
    lines.push(bits.join(' '))
    if (m.propsSchema) lines.push(`  props schema: ${JSON.stringify(m.propsSchema)}`)
  }
  return lines.join('\n')
}

/** A view widget's query is optional — a pure-props view (e.g. an action
 *  panel) still renders, with empty rows. */
export type ViewQuery = WidgetQuery | undefined
