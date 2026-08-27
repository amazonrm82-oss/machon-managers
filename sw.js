// Service worker for מכון פוירשטיין.
//
// Deliberately does NOT cache index.html or any app files — this app pushes
// fixes frequently and correctness has repeatedly depended on every client
// picking up the latest code right away. A caching layer here would risk
// silently serving a stale, already-fixed bug back to users. The only jobs
// of this worker are: (1) satisfy PWA installability criteria on Android/iOS,
// and (2) receive and display Web Push notifications.

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// No caching — every request just goes to the network as normal. Present so
// browsers that still require a fetch handler for installability see one.
self.addEventListener('fetch', () => {});

self.addEventListener('push', (event) => {
  let payload = { title: 'מכון פוירשטיין', body: 'יש עדכון חדש במערכת', url: './' };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch (e) { /* ignore malformed payloads */ }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: 'icon-192.png',
      badge: 'icon-192.png',
      dir: 'rtl',
      lang: 'he',
      data: { url: payload.url || './' },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
    })
  );
});
