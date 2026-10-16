/* Service worker Github-Uploader.
   Strategi:
   - Navigasi halaman : jaringan dulu, cadangan cache, lalu halaman offline.
   - /_next/static/*  : cache dulu (nama file sudah berhash, aman).
   - Ikon dan manifest: jaringan dulu, cadangan cache.
   - Lainnya (API GitHub, lintas domain, non-GET) tidak disentuh. */

const VERSION = 'v5';
const CACHE_PREFIX = 'github-uploader-';
const STATIC_CACHE = CACHE_PREFIX + 'static-' + VERSION;
const PAGES_CACHE = CACHE_PREFIX + 'pages-' + VERSION;
const OFFLINE_URL = '/offline.html';

const PRECACHE_URLS = [
  OFFLINE_URL,
  '/manifest.json',
  '/icon-192x192.png',
  '/icon-512x512.png',
  '/icon-maskable-512x512.png',
  '/apple-touch-icon.png'
];

function isCacheable(response) {
  return Boolean(response) && response.status === 200 && response.type === 'basic';
}

self.addEventListener('install', (event) => {
  // Versi baru langsung aktif tanpa menunggu tab lama ditutup
  self.skipWaiting();
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) =>
        cache.addAll(PRECACHE_URLS.map((url) => new Request(url, { cache: 'reload' })))
      )
      .then(() => caches.open(PAGES_CACHE))
      .then((cache) => cache.add(new Request('/', { cache: 'reload' })).catch(() => {}))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) =>
                (key.indexOf(CACHE_PREFIX) === 0 || key.indexOf('githubupps-') === 0) &&
                key !== STATIC_CACHE &&
                key !== PAGES_CACHE
            )
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function storeCopy(event, cacheName, request, response) {
  const copy = response.clone();
  event.waitUntil(
    caches
      .open(cacheName)
      .then((cache) => cache.put(request, copy))
      .catch(() => {})
  );
}

async function networkFirst(event, request, cacheName) {
  try {
    const response = await fetch(request, { cache: 'no-store' });
    if (isCacheable(response)) {
      storeCopy(event, cacheName, request, response);
    }
    return response;
  } catch (error) {
    const cached = await caches.match(request);
    if (cached) return cached;
    throw error;
  }
}

async function cacheFirst(event, request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (isCacheable(response)) {
    storeCopy(event, cacheName, request, response);
  }
  return response;
}

async function handleNavigation(event) {
  try {
    return await networkFirst(event, event.request, PAGES_CACHE);
  } catch (error) {
    const page = await caches.match(event.request);
    if (page) return page;
    const home = await caches.match('/');
    if (home) return home;
    const offline = await caches.match(OFFLINE_URL);
    if (offline) return offline;
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  if (request.headers.has('range')) return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/sw.js') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigation(event));
    return;
  }

  if (url.pathname.indexOf('/_next/static/') === 0) {
    event.respondWith(cacheFirst(event, request, STATIC_CACHE));
    return;
  }

  if (PRECACHE_URLS.indexOf(url.pathname) !== -1) {
    event.respondWith(networkFirst(event, request, STATIC_CACHE));
  }
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
