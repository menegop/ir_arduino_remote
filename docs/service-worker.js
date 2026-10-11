const STATIC_CACHE = 'ir-remote-lab-static-v12.0.0';
const SCOPE_URL = new URL('./', self.registration.scope);
const INDEX_URL = new URL('index.html', SCOPE_URL).href;
const STATIC_ASSETS = [
  './',
  './index.html',
  './styles.css?v=12.0.0',
  './remotes_db.js?v=12.0.0',
  './external_db.js?v=12.0.0',
  './usb_serial.js?v=12.0.0',
  './app.js?v=12.0.0',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
].map(path => new URL(path, SCOPE_URL).href);

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(STATIC_ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key.startsWith('ir-remote-lab-static-') && key !== STATIC_CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(response => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(STATIC_CACHE).then(cache => cache.put(INDEX_URL, copy)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(INDEX_URL))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then(response => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(STATIC_CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() => caches.match(request))
  );
});
