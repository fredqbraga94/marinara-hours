/* Marinara Hours: phone notifications only. No caching and no fetch handling,
   so the app always loads fresh from the server exactly as before. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (_) { data = { body: event.data ? event.data.text() : "" }; }
  const title = data.title || "Marinara Hours";
  // Number on the app icon (time-off requests still waiting).
  if (typeof data.badge === "number") {
    try {
      const nav = self.navigator;
      if (data.badge > 0 && nav.setAppBadge) nav.setAppBadge(data.badge).catch(() => {});
      else if (data.badge === 0 && nav.clearAppBadge) nav.clearAppBadge().catch(() => {});
    } catch (_) { /* not supported */ }
  }
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "",
    tag: data.tag || undefined,
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: data.url || "./" },
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if ("focus" in client) {
        try { if ("navigate" in client) await client.navigate(url); } catch (_) {}
        return client.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
