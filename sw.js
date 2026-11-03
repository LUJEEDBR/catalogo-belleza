// Service worker: la app abre sin internet; datos de Supabase siempre van a la red.
const VERSION = 'cb-v4';
const APP = ['/', '/index.html', '/app.js', '/config.js', '/db.js', '/sync.js', '/styles.css',
             '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== 'cb-fotos').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Fotos de productos (Storage público): cache primero para que se vean sin internet
  if (url.hostname.endsWith('supabase.co') && url.pathname.startsWith('/storage/v1/object/public/')) {
    e.respondWith(caches.open('cb-fotos').then(async c => {
      const hit = await c.match(e.request, { ignoreSearch: false });
      if (hit) return hit;
      const res = await fetch(e.request); if (res.ok || res.type === 'opaque') c.put(e.request, res.clone()); return res;
    }));
    return;
  }
  if (url.hostname.endsWith('supabase.co') || url.hostname.includes('openbeautyfacts')) return; // datos: red directa

  // Librerías CDN (supabase-js, ZXing): cache primero, luego red
  if (url.origin !== location.origin) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) c.put(e.request, res.clone());
      return res;
    }));
    return;
  }

  // Archivos de la app: red primero (para actualizaciones), cache si no hay internet
  e.respondWith(fetch(e.request)
    .then(res => { caches.open(VERSION).then(c => c.put(e.request, res.clone())); return res; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html'))));
});
