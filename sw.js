// Offline-Hülle: App-Dateien cachen (Netz zuerst, Cache als Rückfall). VERSION bei jedem Update erhöhen.
const VERSION = 'v2';
const FILES = ['./', './index.html', './css/app.css', './js/app.js', './js/state.js', './js/model.js', './js/strava.js', './js/store.js', './js/wind.js', './js/routing.js', './js/sync.js', './manifest.webmanifest'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(VERSION).then(x => x.put(e.request, c)); return r; }).catch(() => caches.match(e.request)));
});
