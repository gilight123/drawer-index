/* Drawer Index service worker — enables install + offline app shell.
   Online always fetches fresh HTML/API; cache is the offline fallback. */
var CACHE = 'drawer-index-v2';
var ASSETS = ['/', '/vendor/qrcode.min.js', '/vendor/jspdf.umd.min.js', '/manifest.json', '/icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);

  // Live data: always go to the network, fall back to cache only if offline.
  if (url.pathname.indexOf('/api/') === 0 || url.pathname.indexOf('/uploads/') === 0) {
    e.respondWith(fetch(req).catch(function () { return caches.match(req); }));
    return;
  }

  // Page navigations (including /d/* and /s/* deep links): network-first so
  // updates land immediately; cached app shell when offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(function () { return caches.match('/'); }));
    return;
  }

  // Static assets (vendor libs, icon, manifest): cache-first, fill on miss.
  e.respondWith(
    caches.match(req).then(function (cached) {
      return cached || fetch(req).then(function (res) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
        return res;
      });
    })
  );
});
