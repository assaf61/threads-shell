// Service worker: app-shell cache + Android share_target intake.
// Uploads do NOT go through the SW — the IndexedDB queue in the page is the
// single source of truth; the SW only stores incoming shares and serves the shell.

const CACHE = "ti-shell-v6";
const SHELL = [
  "./", "./index.html", "./app.css", "./tokens.css", "./manifest.webmanifest",
  "./app.js", "./auth.js", "./graph.js", "./queue.js", "./note.js", "./config.js",
  "./alma-enso.jpg",
  "./icons/icon-192.png", "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  // cache:"reload" bypasses the HTTP cache so a new SW always precaches fresh files.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// --- minimal IndexedDB access (duplicated from queue.js; SW can't import modules here) ---
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open("threads-intake", 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("shares")) db.createObjectStore("shares", { keyPath: "id", autoIncrement: true });
      if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function storeShare(payload) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction("shares", "readwrite");
    payload.createdAt = Date.now();
    t.objectStore("shares").add(payload);
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

async function handleShare(request) {
  const form = await request.formData();
  const file = form.get("media");
  const payload = {
    title: form.get("title") || "",
    text: form.get("text") || "",
    url: form.get("url") || "",
  };
  if (file && file.size) {
    payload.fileBlob = file;
    payload.fileType = file.type;
    payload.fileName = file.name;
  }
  await storeShare(payload);
  const clients = await self.clients.matchAll({ type: "window" });
  clients.forEach((c) => c.postMessage("share-received"));
  return Response.redirect("./?share=1", 303);
}

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);

  if (e.request.method === "POST" && url.pathname.endsWith("/share-target/")) {
    e.respondWith(handleShare(e.request));
    return;
  }

  if (e.request.method !== "GET") return;
  // Never intercept auth/Graph traffic.
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
