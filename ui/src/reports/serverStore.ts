/**
 * Server-first report persistence (#366 topic 23) — the durable,
 * cross-browser, co-teacher-visible home for reports, with the IndexedDB
 * store as the OFFLINE path (not the source of truth anymore).
 *
 * Write-through: every save lands in IDB first (fast, offline-safe), then on
 * the server keyed by the SAME client-minted id. Reads prefer the server and
 * fall back to IDB when the network is down; lists merge server rows with
 * local-only drafts so nothing authored offline disappears.
 */
import type { ReportBody } from './store'
import type { ReportStore, SavedReport } from './store'

/** The server row (`models::Report` serialized). */
interface ServerReport<B extends ReportBody = ReportBody> {
  id: string
  title: string
  doc: B
  visibility: 'private' | 'workspace' | 'link'
  share_token: string | null
  current_version: number
  updated_at: string
}

/** The slice of `apiFetch` the store needs (bodies are pre-serialized —
 *  `ZippyHttpClient.fetch` sets the JSON content-type itself). */
export type ReportApiFetch = <T>(
  path: string,
  options?: { method?: string; body?: string },
) => Promise<T>

const toSaved = <B extends ReportBody>(r: ServerReport<B>): SavedReport<B> => ({
  id: r.id,
  title: r.title,
  body: r.doc,
  updated_at: Date.parse(r.updated_at) || Date.now(),
})

/**
 * Bind the server API (`/admin/reports` or `/superadmin/reports`) over an
 * offline IDB store. Same `ReportStore` interface the builders already use.
 */
export function createServerReportStore<B extends ReportBody = ReportBody>(
  apiFetch: ReportApiFetch,
  base: string,
  offline: ReportStore<B>,
): ReportStore<B> {
  const swallow = (e: unknown) => {
    // Offline or unauthenticated: the IDB copy remains authoritative until
    // the next successful sync. Log for debuggability, never throw — a save
    // must not fail because the network did.
    console.warn(`[reports] server sync failed (${base}):`, e)
  }

  return {
    async saveReport(id: string, body: B): Promise<void> {
      await offline.saveReport(id, body)
      const title = (body as { title?: string }).title || 'Untitled report'
      try {
        await apiFetch<ServerReport<B>>(`${base}/${id}`, {
          method: 'PUT',
          body: JSON.stringify({ title, doc: body }),
        })
      } catch {
        // Unknown on the server yet (or stale id) → create with OUR id so
        // the offline copy and the server row stay one record.
        try {
          await apiFetch<ServerReport<B>>(base, {
            method: 'POST',
            body: JSON.stringify({ id, title, doc: body }),
          })
        } catch (createError) {
          // The row exists NOW even though the PUT above said it did not:
          // two writers raced for one client-minted id. That is ordinary for
          // a shared id — two people opening the same template link, or a
          // component that saves twice on mount — and the loser used to give
          // up with a duplicate-key 500 in the log. Update instead.
          try {
            await apiFetch<ServerReport<B>>(`${base}/${id}`, {
              method: 'PUT',
              body: JSON.stringify({ title, doc: body }),
            })
          } catch {
            swallow(createError)
          }
        }
      }
    },

    async loadReport(id: string): Promise<SavedReport<B> | null> {
      try {
        return toSaved(await apiFetch<ServerReport<B>>(`${base}/${id}`))
      } catch {
        return offline.loadReport(id)
      }
    },

    async listReports(): Promise<SavedReport<B>[]> {
      const local = await offline.listReports().catch(() => [] as SavedReport<B>[])
      try {
        const server = (await apiFetch<ServerReport<B>[]>(base)).map(toSaved)
        const serverIds = new Set(server.map((r) => r.id))
        // Local-only drafts (authored offline, never synced) stay visible.
        return [...server, ...local.filter((r) => !serverIds.has(r.id))].sort(
          (a, b) => b.updated_at - a.updated_at,
        )
      } catch {
        return local
      }
    },

    async deleteReport(id: string): Promise<void> {
      await offline.deleteReport(id)
      try {
        await apiFetch(`${base}/${id}`, { method: 'DELETE' })
      } catch (e) {
        swallow(e)
      }
    },
  }
}
