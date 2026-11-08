// 08/11/2026: the collector moved into בית עלמא (one collector, two windows). This worker
// replaces the old cache-first one: it clears every cache, unregisters itself, and reloads
// open pages, so they reach the redirect in index.html instead of the old cached app.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const pages = await self.clients.matchAll({ type: "window" });
    pages.forEach((c) => c.navigate(c.url));
  })());
});
