self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data?.text?.() || '' }; }
  const title = data.title || 'طريق الحنابلة';
  const options = { body: data.body || 'لديك إشعار جديد', icon: '/icon-192.png', badge: '/icon-192.png', dir: 'rtl', lang: 'ar', tag: data.notificationId || `hanabila-${Date.now()}`, data: { url: data.url || '/' }, renotify: true };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const existing = list.find(client => client.url.startsWith(self.location.origin));
    if (existing) return existing.focus();
    return clients.openWindow(url);
  }));
});
