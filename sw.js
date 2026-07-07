const CACHE_NAME = 'ollo-cache-v3';
const ASSETS = [
  './',
  'index.html',
  'app.js',
  'manifest.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

// Bersihkan cache versi lama supaya update tidak "nyangkut"
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Jangan cache request API ke Worker — data harus selalu live
  if (url.origin !== self.location.origin) return;

  // Network-first untuk HTML/JS agar update cepat terlihat, fallback ke cache saat offline
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const clone = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
