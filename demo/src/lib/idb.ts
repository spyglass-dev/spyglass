/** Saved reports live in IndexedDB — one object store, keyed by report id.
 *  Shaped as the `ReportCollection` that `createReportStore` binds to. */
import type { ReportCollection, ReportRowData } from '@spyglassjs/ui'

const DB = 'spyglass-demo'
const STORE = 'reports'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = run(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const reportCollection: ReportCollection = {
  put: (row) => tx('readwrite', (s) => s.put(row)),
  get: (id) => tx<{ id: string; data?: ReportRowData } | undefined>('readonly', (s) => s.get(id)),
  list: () => tx<{ id: string; data?: ReportRowData }[]>('readonly', (s) => s.getAll()),
  delete: (id) => tx('readwrite', (s) => s.delete(id)),
}
