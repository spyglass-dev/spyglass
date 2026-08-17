/**
 * Two writers, one client-minted id.
 *
 * A template report has a STABLE id (`report-tpl-overview`), so the first
 * person to open the link creates it — and two people opening it at the same
 * moment both find nothing, both POST, and the loser used to give up with a
 * duplicate-key 500 in the log. Same shape when a component saves twice on
 * mount, which is every component in development.
 */
import { describe, it, expect, vi } from 'vitest'
import { createServerReportStore } from '../reports/serverStore'
import type { ReportStore } from '../reports/store'

const memoryStore = (): ReportStore => {
  const docs = new Map<string, unknown>()
  return {
    saveReport: async (id, body) => void docs.set(id, body),
    loadReport: async (id) =>
      docs.has(id) ? { id, title: 't', body: docs.get(id) as never, updated_at: 1 } : null,
    listReports: async () => [],
    deleteReport: async (id) => void docs.delete(id),
  } as unknown as ReportStore
}

describe('saving under an id another writer just created', () => {
  it('falls back to an update instead of losing the write', async () => {
    const calls: string[] = []
    const api = vi.fn(async (path: string, opts?: { method?: string }) => {
      const method = opts?.method ?? 'GET'
      calls.push(`${method} ${path}`)
      // Not there on the first PUT…
      if (method === 'PUT' && calls.filter((c) => c.startsWith('PUT')).length === 1) {
        throw new Error('404 not found')
      }
      // …but another writer created it before our POST landed.
      if (method === 'POST') throw new Error('duplicate key value violates unique constraint')
      return {} as never
    })
    const store = createServerReportStore(api as never, '/superadmin/reports', memoryStore())

    await store.saveReport('report-tpl-overview', { title: 'Platform overview' } as never)

    expect(calls).toEqual([
      'PUT /superadmin/reports/report-tpl-overview',
      'POST /superadmin/reports',
      'PUT /superadmin/reports/report-tpl-overview',
    ])
  })

  it('still never throws when the server is simply down', async () => {
    const api = vi.fn(async () => {
      throw new Error('network down')
    })
    const store = createServerReportStore(api as never, '/superadmin/reports', memoryStore())
    await expect(
      store.saveReport('r1', { title: 'x' } as never),
    ).resolves.toBeUndefined()
  })
})
