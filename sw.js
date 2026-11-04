// Service worker: la app abre sin internet; datos de Supabase siempre van a la red.
const VERSION = 'cb-v13';
const APP = ['/', '/index.html', '/app.js', '/config.js', '/db.js', '/sync.js', '/styles.css', '/vendor/supabase.js',
             '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/logo.jpg'];

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

  // Archivos de la app: cache primero (abre al instante) y se actualiza en segundo plano
  const red = fetch(e.request).then(res => {
    if (res.ok) { const copia = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); }
    return res;
  });
  e.respondWith(caches.match(e.request, { ignoreSearch: e.request.mode === 'navigate' }).then(hit => {
    if (hit) { e.waitUntil(red.catch(() => {})); return hit; }
    return red.catch(() => caches.match('/index.html'));
  }));
});
