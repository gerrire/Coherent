function askClient(client, message, timeout = 1000) {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, timeout);
    channel.port1.onmessage = event => {
      clearTimeout(timer); channel.port1.close(); resolve(event.data?.handled === true);
    };
    try { client.postMessage(message, [channel.port2]); }
    catch { clearTimeout(timer); channel.port1.close(); resolve(false); }
  });
}
self.addEventListener("push", event => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* Empty push. */ }
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const visible = windows.filter(client => client.visibilityState === "visible");
    const handled = await Promise.all(visible.map(client => askClient(client, { type: "coherent-push", message })));
    if (handled.some(Boolean)) return;
    await self.registration.showNotification(message.title || "Когерент", {
      body: message.body || "Новое событие", icon: "/favicon.svg", badge: "/favicon.svg",
      tag: message.tag || "coherent-event", data: { url: message.url || "/" },
    });
  })());
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/", self.location.origin);
  if (destination.origin !== self.location.origin) return;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows.find(client => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      if (await askClient(existing, { type: "coherent-navigate", url: destination.href })) return;
    }
    return self.clients.openWindow(destination.href);
  })());
});
