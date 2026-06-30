/**
 * Client for the spyglass-server HTTP API. Calls go through `/api`, which the
 * Vite dev server proxies to the running spyglass-server (no CORS). Set
 * VITE_SPYGLASS_API to call a different base directly.
 */
import type { ReportDoc } from '@spyglass/ui'

const BASE = (import.meta as { env?: Record<string, string> }).env?.VITE_SPYGLASS_API || '/api'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, init)
  const body = (await res.json()) as T & { error?: string }
  if (!res.ok || (body && body.error)) throw new Error(body?.error || `HTTP ${res.status}`)
  return body
}

export interface ReportSummary {
  id: string
  title: string
}

export interface MeasureMeta {
  name: string
  member: string
  type: string
  title?: string
  format?: string
}
export interface DimensionMeta {
  name: string
  member: string
  type: string
  title?: string
  tenant: boolean
}
export interface CubeMeta {
  name: string
  title?: string
  description?: string
  measures: MeasureMeta[]
  dimensions: DimensionMeta[]
}
export interface ModelMeta {
  cubes: CubeMeta[]
}

export const server = {
  meta: () => json<ModelMeta>('/meta'),
  listReports: () => json<ReportSummary[]>('/reports'),
  getReport: (id: string) => json<unknown>(`/reports/${id}`),
  runReport: (id: string, scope?: Record<string, unknown>) =>
    json<ReportDoc>(`/reports/${id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(scope ? { scope } : {}),
    }),
  query: (body: unknown) =>
    json<{ columns: { key: string; kind: string }[]; rows: Record<string, unknown>[]; sql?: string }>(
      '/query',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    ),
}

/** Build a scope map (every cube's tenant member → workspace) from the catalog. */
export function scopeForWorkspace(meta: ModelMeta | null, workspace: string): Record<string, string> | undefined {
  if (!meta || !workspace.trim()) return undefined
  const scope: Record<string, string> = {}
  for (const cube of meta.cubes) {
    for (const d of cube.dimensions) if (d.tenant) scope[d.member] = workspace.trim()
  }
  return scope
}
