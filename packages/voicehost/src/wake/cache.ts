// The browser page's copy of the wake files between visits: IndexedDB, keyed by each file's
// sha256. The node's listener has a self-signed certificate, and Chromium keeps nothing from
// such a page in its HTTP cache, so without this every open would fetch 18 MB again. The app
// needs none of it: its files are its own assets.

import type { FileCache } from "./detector.ts";

const STORE = "files";

export function indexedDbCache(idb: IDBFactory = indexedDB, name = "cophyla-wake"): FileCache {
  let db: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = idb.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB would not open"));
    });
  const store = async (mode: IDBTransactionMode): Promise<IDBObjectStore> => {
    db ??= open();
    db.catch(() => (db = undefined));
    return (await db).transaction(STORE, mode).objectStore(STORE);
  };
  const done = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
    });

  return {
    get: async (key) => {
      const value: unknown = await done((await store("readonly")).get(key));
      return value instanceof ArrayBuffer ? value : undefined;
    },
    put: async (key, bytes) => {
      await done((await store("readwrite")).put(bytes, key));
    },
    keep: async (keys) => {
      const s = await store("readwrite");
      // Deleted inside the callback, while the transaction is certainly still active.
      await new Promise<void>((resolve, reject) => {
        const req = s.getAllKeys();
        req.onsuccess = () => {
          for (const key of req.result) if (!keys.includes(String(key))) s.delete(key);
          resolve();
        };
        req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"));
      });
    },
  };
}
