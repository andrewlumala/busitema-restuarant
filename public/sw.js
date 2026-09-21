// Minimal service worker: caches the app shell (student.html itself) so the page still
// loads with no connection, and caches menu/API GET responses briefly so a flaky connection
// doesn't mean a blank menu. Ordering itself still needs a live connection — this just
// keeps the app from being a blank white screen when signal drops.

const CACHE_NAME = 'busitema-restaurant-v1';
const APP_SHELL = ['/student.html'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never cache API calls that change state (orders, auth, payments) — only GET requests,
  // and even those are "network first" so real-time data always wins when online.
  if (url.pathname.startsWith('/api/')) {
    if (event.request.method !== 'GET') return; // let it hit the network untouched
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // App shell and static assets: cache-first, so the page itself loads instantly offline
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
