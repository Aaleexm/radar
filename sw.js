// Cachea la app para que abra rápido y sin conexión (el mapa y los radares necesitan red).
const CACHE = 'radar-v10';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/app.js',
  'js/style.js',
  'js/icons.js',
  'js/radars.js',
  'js/places.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

// App: primero red, si falla caché. Tiles/fuentes del mapa: caché primero (ahorra datos).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'tiles.openfreemap.org') {
    e.respondWith(
      caches.open('radar-tiles').then(async (c) => {
        const hit = await c.match(e.request);
        if (hit) return hit;
        const res = await fetch(e.request);
        if (res.ok) c.put(e.request, res.clone());
        return res;
      }),
    );
    return;
  }
  if (url.origin === location.origin || url.hostname === 'unpkg.com') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request)),
    );
  }
});
