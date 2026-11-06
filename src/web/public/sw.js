// Keeps the app itself available with no network. API calls are never cached here: the page
// decides what to do when they fail, so offline behaviour stays honest and visible.
const CACHE = 'koottu-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  if (e.data?.type === 'CACHE') caches.open(CACHE).then((c) => Promise.all(e.data.urls.map((u) => c.add(u).catch(() => {}))));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // The simulation under /sim/ has its own service worker and cache.
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/sim/')) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(e.request, { ignoreSearch: true });
      const fresh = fetch(e.request).then(async (res) => {
        if (res.ok) await cache.put(e.request, res.clone());
        return res;
      }).catch(() => hit ?? cache.match('/'));
      return hit ?? fresh;
    }),
  );
});
