/** Minimal IndexedDB store for reports — no dependencies. */
import type { ReportDoc } from '@spyglass/ui'

export interface StoredReport {
  id: string
  doc: ReportDoc
  updated_at: number
}

const DB = 'reporting-studio'
const STORE = 'reports'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function tx<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(STORE, mode)
        const req = fn(t.objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(req.error)
      }),
  )
}

export const reportsDb = {
  async list(): Promise<StoredReport[]> {
    const all = await tx<StoredReport[]>('readonly', (s) => s.getAll() as IDBRequest<StoredReport[]>)
    return all.sort((a, b) => b.updated_at - a.updated_at)
  },
  get(id: string): Promise<StoredReport | undefined> {
    return tx<StoredReport | undefined>('readonly', (s) => s.get(id) as IDBRequest<StoredReport | undefined>)
  },
  async put(report: StoredReport): Promise<void> {
    await tx('readwrite', (s) => s.put(report))
  },
  async delete(id: string): Promise<void> {
    await tx('readwrite', (s) => s.delete(id))
  },
}
