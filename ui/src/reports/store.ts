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
import { withWidgetIds } from './session'

/**
 * The saved document. Hosts may carry extra keys of their own, and the store is
 * generic over the body so a host's own doc type flows through `loadReport` and
 * `listReports` intact rather than being widened back to this base on the way
 * out.
 */
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

export interface SavedReport<B extends ReportBody = ReportBody> {
  id: string
  title: string
  body: B
  updated_at: number
}

export interface ReportStore<B extends ReportBody = ReportBody> {
  saveReport(id: string, body: B): Promise<void>
  loadReport(id: string): Promise<SavedReport<B> | null>
  listReports(): Promise<SavedReport<B>[]>
  deleteReport(id: string): Promise<void>
}

/**
 * Coerce a stored body into the current `ReportBody` shape. Reports saved
 * before the framework flip used a `blocks` array (no `widgets`); rather than
 * crash the list/builder on `body.widgets.length`, normalize to a doc with an
 * empty widget list so legacy reports render (empty) and can be deleted.
 */
function normalizeDoc<B extends ReportBody>(raw: unknown, fallbackTitle: string): B {
  const d = (raw ?? {}) as Partial<ReportBody>
  return {
    // Spread first: a host's own keys survive a round trip through the store.
    ...(d as object),
    title: typeof d.title === 'string' && d.title ? d.title : fallbackTitle,
    description: typeof d.description === 'string' ? d.description : undefined,
    // Backfill widget ids on load, so a report saved before ids existed becomes
    // addressable the first time it is opened — no migration, no version bump.
    widgets: withWidgetIds(Array.isArray(d.widgets) ? d.widgets : []),
    // Preserve the declared filter spec + selected values across a reload —
    // dropping them silently reverted custom specs to the default and lost the
    // teacher's filter selections.
    ...(Array.isArray(d.facets) ? { facets: d.facets } : {}),
    ...(d.filters && typeof d.filters === 'object' ? { filters: d.filters } : {}),
    created_at: typeof d.created_at === 'number' ? d.created_at : undefined,
    updated_at: typeof d.updated_at === 'number' ? d.updated_at : undefined,
  } as B
}

/** Mint a new report id. */
export function newReportId(): string {
  return `report-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

/** Bind the report CRUD to one IDB collection. */
export function createReportStore<B extends ReportBody = ReportBody>(
  collection: ReportCollection,
): ReportStore<B> {
  return {
    async saveReport(id: string, body: B): Promise<void> {
      const updated_at = Date.now()
      const next: B = { ...body, updated_at }
      await collection.put({
        id,
        data: { title: body.title || 'Untitled report', body: next, updated_at },
      })
    },

    async loadReport(id: string): Promise<SavedReport<B> | null> {
      const row = await collection.get(id).catch(() => null)
      if (!row?.data) return null
      const d = row.data
      const title = typeof d.title === 'string' ? d.title : 'Untitled report'
      return {
        id,
        title,
        body: normalizeDoc<B>(d.body, title),
        updated_at: typeof d.updated_at === 'number' ? d.updated_at : 0,
      }
    },

    async listReports(): Promise<SavedReport<B>[]> {
      const rows = await collection.list().catch(() => [])
      const out: SavedReport<B>[] = []
      for (const row of rows) {
        if (!row.data) continue
        const d = row.data
        const title = typeof d.title === 'string' ? d.title : 'Untitled report'
        out.push({
          id: row.id,
          title,
          body: normalizeDoc<B>(d.body, title),
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
