// IndexedDB capture queue. Capture is written here FIRST and never fails;
// upload drains the queue opportunistically. Items are removed only after
// Graph confirms (200/201).

const DB_NAME = "threads-intake";
const DB_VER = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue"))
        db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("shares"))
        db.createObjectStore("shares", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("kv"))
        db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out && "result" in out ? out.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

// item: { fileName, content, mediaName, mediaType, mediaBlob, kind, createdAt, attempts }
export async function addCapture(item) {
  const db = await openDb();
  item.createdAt = Date.now();
  item.attempts = 0;
  await tx(db, "queue", "readwrite", (s) => s.add(item));
}

export async function listQueue() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("queue").objectStore("queue").getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function removeItem(id) {
  const db = await openDb();
  await tx(db, "queue", "readwrite", (s) => s.delete(id));
}

export async function bumpAttempt(id) {
  const db = await openDb();
  const item = await new Promise((res, rej) => {
    const r = db.transaction("queue").objectStore("queue").get(id);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  if (item) {
    item.attempts = (item.attempts || 0) + 1;
    await tx(db, "queue", "readwrite", (s) => s.put(item));
  }
}

export async function queueCount() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("queue").objectStore("queue").count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Incoming Android share_target payloads (written by the service worker).
export async function addShare(payload) {
  const db = await openDb();
  payload.createdAt = Date.now();
  await tx(db, "shares", "readwrite", (s) => s.add(payload));
}

export async function takeShares() {
  const db = await openDb();
  const all = await new Promise((res, rej) => {
    const r = db.transaction("shares").objectStore("shares").getAll();
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  await tx(db, "shares", "readwrite", (s) => s.clear());
  return all;
}

export async function kvSet(key, value) {
  const db = await openDb();
  await tx(db, "kv", "readwrite", (s) => s.put(value, key));
}

export async function kvGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
