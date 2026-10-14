// Keeps the reader working offline. Network first, so a new version reaches the
// phone the next time it is online; the cached copy is the fallback. Requests to
// other origins (Google) are never touched.
const CACHE = 'markpad-reader-v3';
const SHELL = [
  './', './index.html', './style.css', './app.js', './config.js', './marked.umd.js',
  './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true })
        .then((hit) => hit || caches.match('./'))),
  );
});
