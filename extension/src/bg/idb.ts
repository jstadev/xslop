// Minimal IndexedDB key-value store for the non-extractable CryptoKey (structured clone keeps it opaque).
const DB = 'xslop';
const STORE = 'kv';

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? req.error);
    });
  } finally {
    db.close();
  }
}

export const idbGet = <T>(key: string): Promise<T | undefined> => run('readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
export const idbSet = (key: string, value: unknown): Promise<IDBValidKey> => run('readwrite', (s) => s.put(value, key));
