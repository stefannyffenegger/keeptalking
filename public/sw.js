const CACHE = 'keep-talking-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/engine.js', '/store.js', '/content.js', '/speech.js', '/packs/index.json', '/packs/th.json', '/packs/he.json', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('push', (event) => {
  let message = { title: 'Keep Talking', body: 'Got a few minutes to keep talking?' };
  try { message = { ...message, ...event.data.json() }; } catch { /* use the default text */ }
  event.waitUntil(self.registration.showNotification(message.title, { body: message.body, icon: '/icon.svg', tag: 'daily-reminder' }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
    const open = windows.find((client) => 'focus' in client);
    return open ? open.focus() : self.clients.openWindow('/');
  }));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(event.request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      event.waitUntil(caches.open(CACHE).then((cache) => cache.put(event.request, copy)));
    }
    return response;
  }).catch(async () => (await caches.match(event.request)) ?? (event.request.mode === 'navigate' ? caches.match('/index.html') : Response.error())));
});
