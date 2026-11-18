/** A blocked browser storage service must not indefinitely gate the camera. */
export function openDatabase(
  name: string,
  store: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(
      () => fail(new Error("Browser photo storage did not respond.")),
      10_000,
    );
    request.onupgradeneeded = () => {
      if (settled) {
        request.transaction?.abort();
        return;
      }
      if (!request.result.objectStoreNames.contains(store))
        request.result.createObjectStore(store);
    };
    request.onerror = () => fail(request.error);
    request.onblocked = () =>
      fail(new Error("Photo storage is blocked by another tab."));
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
  });
}

/** Resolve writes only after commit; request success alone is not durability. */
export function committedRequest<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = run(tx.objectStore(store));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = tx.onabort = () =>
      reject(
        tx.error ??
          request.error ??
          new Error("Photo storage transaction failed."),
      );
  });
}

/** Read and conditionally delete under the same write lock, across tabs too. */
export function deleteIf<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
  matches: (value: T) => boolean,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite"),
      store = tx.objectStore(storeName);
    let removed = false;
    const request = store.get(key);
    request.onsuccess = () => {
      if (request.result !== undefined && matches(request.result as T)) {
        store.delete(key);
        removed = true;
      }
    };
    tx.oncomplete = () => resolve(removed);
    tx.onerror = tx.onabort = () =>
      reject(tx.error ?? new Error("Photo storage transaction failed."));
  });
}
