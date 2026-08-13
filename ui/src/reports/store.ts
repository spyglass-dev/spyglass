/**
 * Report persistence — typed CRUD over a key-value collection.
 *
 * A FACTORY, because a host with more than one report surface must keep them
 * apart: each binds its own collection so one surface's reports never mix with
 * another's in the same browser.
 *
 * `ReportCollection` is deliberately STRUCTURAL — the four methods a store
 * needs, not a class. A host backs it with IndexedDB, localStorage or an
 * object in memory; nothing here imports a storage library.
 */
import type { Report } from '../report'

/** The saved document. Hosts may carry extra keys of their own. */
export type ReportBody = Report & { created_at?: number; updated_at?: number }

/** One saved report row's `data` payload (matches `ReportItemData`). */
export interface ReportRowData extends Record<string, unknown> {
  title: string
  body: unknown
  updated_at: number
}

/** The slice of `IndexedDbStore` the report store needs. */
export interface ReportCollection {
  put(row: { id: string; data: ReportRowData }): Promise<unknown>
  get(id: string): Promise<{ id: string; data?: ReportRowData } | null | undefined>
  list(): Promise<{ id: string; data?: ReportRowData }[]>
  delete(id: string): Promise<unknown>
}

export interface SavedReport {
  id: string
  title: string
  body: ReportBody
  updated_at: number
}

export interface ReportStore {
  saveReport(id: string, body: ReportBody): Promise<void>
  loadReport(id: string): Promise<SavedReport | null>
  listReports(): Promise<SavedReport[]>
  deleteReport(id: string): Promise<void>
}

/**
 * Coerce a stored body into the current `ReportBody` shape. Reports saved
 * before the framework flip used a `blocks` array (no `widgets`); rather than
 * crash the list/builder on `body.widgets.length`, normalize to a doc with an
 * empty widget list so legacy reports render (empty) and can be deleted.
 */
function normalizeDoc(raw: unknown, fallbackTitle: string): ReportBody {
  const d = (raw ?? {}) as Partial<ReportBody>
  return {
    title: typeof d.title === 'string' && d.title ? d.title : fallbackTitle,
    description: typeof d.description === 'string' ? d.description : undefined,
    widgets: Array.isArray(d.widgets) ? d.widgets : [],
    // Preserve the declared filter spec + selected values across a reload —
    // dropping them silently reverted custom specs to the default and lost the
    // teacher's filter selections.
    ...(Array.isArray(d.facets) ? { facets: d.facets } : {}),
    ...(d.filters && typeof d.filters === 'object' ? { filters: d.filters } : {}),
    created_at: typeof d.created_at === 'number' ? d.created_at : undefined,
    updated_at: typeof d.updated_at === 'number' ? d.updated_at : undefined,
  }
}

/** Mint a new report id. */
export function newReportId(): string {
  return `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/** Bind the report CRUD to one IDB collection. */
export function createReportStore(collection: ReportCollection): ReportStore {
  return {
    async saveReport(id: string, body: ReportBody): Promise<void> {
      const updated_at = Date.now()
      const next: ReportBody = { ...body, updated_at }
      await collection.put({
        id,
        data: { title: body.title || 'Untitled report', body: next, updated_at },
      })
    },

    async loadReport(id: string): Promise<SavedReport | null> {
      const row = await collection.get(id).catch(() => null)
      if (!row?.data) return null
      const d = row.data
      const title = typeof d.title === 'string' ? d.title : 'Untitled report'
      return {
        id,
        title,
        body: normalizeDoc(d.body, title),
        updated_at: typeof d.updated_at === 'number' ? d.updated_at : 0,
      }
    },

    async listReports(): Promise<SavedReport[]> {
      const rows = await collection.list().catch(() => [])
      const out: SavedReport[] = []
      for (const row of rows) {
        if (!row.data) continue
        const d = row.data
        const title = typeof d.title === 'string' ? d.title : 'Untitled report'
        out.push({
          id: row.id,
          title,
          body: normalizeDoc(d.body, title),
          updated_at: typeof d.updated_at === 'number' ? d.updated_at : 0,
        })
      }
      return out.sort((a, b) => b.updated_at - a.updated_at)
    },

    async deleteReport(id: string): Promise<void> {
      await collection.delete(id).catch(() => {})
    },
  }
}
