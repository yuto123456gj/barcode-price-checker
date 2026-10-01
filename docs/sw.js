/* 売り場は電波が悪いので、アプリ本体をキャッシュしてオフラインでも開けるようにする。
   記録は localStorage なので、オフラインでもスキャンから保存まで通る。 */

var CACHE = 'tanka-watch-v4';
var ASSETS = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'logic.js',
  'vendor/zxing.min.js',
  'manifest.webmanifest',
  'icon-192.png',
  'icon-512.png',
  'apple-touch-icon.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) { return cache.addAll(ASSETS); })
      .then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys()
      .then(function (keys) {
        return Promise.all(keys.filter(function (k) { return k !== CACHE; })
          .map(function (k) { return caches.delete(k); }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  // 同一オリジンはキャッシュ優先。フォントなど外部は素通し（失敗しても代替フォントで動く）。
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(function (hit) {
      if (hit) return hit;
      return fetch(request).then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(request, copy); });
        }
        return response;
      }).catch(function () {
        return caches.match('index.html');
      });
    })
  );
});
