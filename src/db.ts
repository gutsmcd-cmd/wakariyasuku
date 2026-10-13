// IndexedDB storage: hist (past rewrites), kv (settings, personal words). No localStorage.
const DB = 'wakariyasuku'
const STORES = ['hist', 'kv'] as const
type Store = (typeof STORES)[number]

let dbp: Promise<IDBDatabase> | null = null
function open(): Promise<IDBDatabase> {
  if (dbp) return dbp
  dbp = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => {
      dbp = null
      reject(req.error ?? new Error('idb open'))
    }
  })
  return dbp
}

function tx<T>(store: Store, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const r = fn(db.transaction(store, mode).objectStore(store))
        r.onsuccess = () => resolve(r.result as T)
        r.onerror = () => reject(r.error)
      }),
  )
}

export const get = <T>(store: Store, key: string) => tx<T | undefined>(store, 'readonly', (s) => s.get(key))
export const put = (store: Store, key: string, v: unknown) => tx<void>(store, 'readwrite', (s) => s.put(v, key))
export const del = (store: Store, key: string) => tx<void>(store, 'readwrite', (s) => s.delete(key))
export const all = <T>(store: Store) => tx<T[]>(store, 'readonly', (s) => s.getAll())
export const delPrefix = (store: Store, prefix: string) =>
  tx<void>(store, 'readwrite', (s) => s.delete(IDBKeyRange.bound(prefix, prefix + '\uffff')))

/** Best-effort. A denial must not block the app. */
export async function askPersist(): Promise<void> {
  try {
    if (navigator.storage && typeof navigator.storage.persist === 'function') {
      if (!(await navigator.storage.persisted())) await navigator.storage.persist()
    }
  } catch {
    /* ignore */
  }
}
