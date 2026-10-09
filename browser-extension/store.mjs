// This database belongs to this Chrome profile. Never use storage.sync.
export function createStore(databaseName = "zhepage-draft-extension") {
  let opened;
  const open = () => opened ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("records");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("浏览器未能保存同步记录，请检查剩余空间。"));
  });
  const transaction = async (mode, operation) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("records", mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(new Error("浏览器未能保存同步记录，请检查剩余空间。"));
      operation(tx.objectStore("records"), (value) => { result = value; });
    });
  };
  return {
    get: (key) => transaction("readonly", (store, done) => { const request = store.get(key); request.onsuccess = () => done(request.result); }),
    set: (key, value) => transaction("readwrite", (store) => { store.put(value, key); }),
    delete: (key) => transaction("readwrite", (store) => { store.delete(key); }),
    list: (prefix) => transaction("readonly", (store, done) => {
      const values = [];
      const request = store.openCursor(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) { done(values); return; }
        values.push({ key: cursor.key, value: cursor.value }); cursor.continue();
      };
    }),
  };
}
