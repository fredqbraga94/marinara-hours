/* Retirement of the legacy caching worker. Private responses must never be
   intercepted or stored. Existing installations receive this on SW update. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(key => key.startsWith("marinara-hours-shell-"))
      .map(key => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", () => { /* network only */ });
